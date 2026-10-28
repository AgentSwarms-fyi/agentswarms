// Server functions behind Data & BI -> Enterprise Ontology: the model itself.
//
// Creating, saving, publishing, versions, proposals and deleting. Data
// (objects, metrics, rules), AI and actions live beside this file in
// ontologyData / ontologyAi / ontologyActions.functions.ts.
//
// Every write is the service role AFTER src/utils/ontology/access.server has
// decided the caller may make it. A save names the revision it read and is
// refused as a conflict when the draft moved on, so two tabs cannot silently
// undo each other. Publishing freezes the draft into an immutable version
// with the diff against the previous one; grantees only ever see published
// versions. Governance events (create, publish, restore, proposal decided,
// delete, share-visible changes) are audited with their detail.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  emailsFor,
  isFail,
  loadOntology,
  ontologyLimits,
  parseStoredSpec,
  resolveCaller,
  type Fail,
  type OntologyRole,
} from "@/utils/ontology/access.server";
import { resolveGrantedResourceIds } from "@/utils/iam.server";
import { lakehouseConnection, lakehouseEnabled } from "@/utils/lakehouse/core.server";
import { listLakehouseTablesForUser } from "@/utils/lakehouse/tables.server";
import { runSql } from "@/utils/ontology/run.server";
import { diffSpecs, type SpecDiff } from "@/lib/ontology/diff";
import { notInstalledMessage } from "@/lib/ontology/install";
import { describeOntologyPolicy } from "@/lib/ontology/policy";
import { SAMPLE_NAME, SAMPLE_SCHEMA_BASE, sampleSpec, sampleSql } from "@/lib/ontology/sample";
import { emptySpec, ontologySpecSchema, type OntologySpec } from "@/lib/ontology/spec";
import { modelCompleteness, validateSpec, type Issue } from "@/lib/ontology/validate";

const token = z.string().min(1);
const id = z.string().uuid();

export type OntologySummary = {
  id: string;
  name: string;
  description: string | null;
  role: OntologyRole;
  revision: number;
  published_version: number | null;
  updated_at: string;
  counts: {
    objectTypes: number;
    linkTypes: number;
    metrics: number;
    rules: number;
    actions: number;
  };
  completeness: number;
  health: { passed: number; failed: number; errored: number; ran_at: string } | null;
  domains: string[];
  sample: boolean;
};

function countsOf(spec: OntologySpec) {
  return {
    objectTypes: spec.objectTypes.length,
    linkTypes: spec.linkTypes.length,
    metrics: spec.objectTypes.reduce((n, t) => n + t.metrics.length, 0),
    rules: spec.rules.length,
    actions: spec.actionTypes.length,
  };
}

function healthOf(raw: Json | null): OntologySummary["health"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.ran_at !== "string") return null;
  return {
    passed: Number(h.passed ?? 0),
    failed: Number(h.failed ?? 0),
    errored: Number(h.errored ?? 0),
    ran_at: h.ran_at,
  };
}

async function sizeProblem(spec: OntologySpec): Promise<string | null> {
  const { maxSpecBytes } = await ontologyLimits();
  const bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
  return bytes > maxSpecBytes
    ? `The ontology is ${Math.ceil(bytes / 1024)} KB; this instance allows ${Math.floor(maxSpecBytes / 1024)} KB (Admin → Developer runtime)`
    : null;
}

/** The names of an owner's ontologies, but for `exceptId`. */
async function ownerNames(userId: string, exceptId?: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("ontologies")
    .select("id, name")
    .eq("user_id", userId);
  if (error) throw new Error(notInstalledMessage(error.message) ?? error.message);
  return (data ?? []).filter((o) => o.id !== exceptId).map((o) => o.name);
}

/**
 * Agents, shares and the agent builder's picker tell ontologies apart by
 * name, so an owner's names are unique (ignoring case). Two called the same
 * left an agent allowed "Northwind Outfitters" reading whichever came first.
 */
async function nameClash(userId: string, name: string, exceptId?: string): Promise<string | null> {
  const want = name.trim().toLowerCase();
  const other = (await ownerNames(userId, exceptId)).find((n) => n.trim().toLowerCase() === want);
  return other
    ? `You already have an ontology called "${other}". Agents and shares tell ontologies apart by name, so give this one another.`
    : null;
}

// ── List ────────────────────────────────────────────────────────────────────

export const ontologyList = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; ontologies: OntologySummary[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const shared = [...(await resolveGrantedResourceIds(supabaseAdmin, caller.userId, "ontology"))];
    const cols =
      "id, user_id, name, description, spec, revision, published_version, health, sample_schema, updated_at";
    const [own, granted] = await Promise.all([
      supabaseAdmin
        .from("ontologies")
        .select(cols)
        .eq("user_id", caller.userId)
        .order("updated_at", { ascending: false }),
      shared.length
        ? supabaseAdmin
            .from("ontologies")
            .select(cols)
            .in("id", shared)
            .not("published_version", "is", null)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (own.error)
      return { ok: false, error: notInstalledMessage(own.error.message) ?? own.error.message };
    if (granted.error) return { ok: false, error: granted.error.message };
    const out: OntologySummary[] = [];
    for (const row of [...(own.data ?? []), ...(granted.data ?? [])]) {
      const role: OntologyRole = row.user_id === caller.userId ? "owner" : "viewer";
      if (role === "viewer" && out.some((o) => o.id === row.id)) continue;
      // A grantee's card describes what they can open: the published version.
      let spec: OntologySpec;
      try {
        if (role === "viewer") {
          const { data: v } = await supabaseAdmin
            .from("ontology_versions")
            .select("spec")
            .eq("ontology_id", row.id)
            .eq("version", row.published_version!)
            .maybeSingle();
          spec = parseStoredSpec(v?.spec, "published version");
        } else spec = parseStoredSpec(row.spec, "draft");
      } catch {
        continue;
      }
      out.push({
        id: row.id,
        name: row.name,
        description: row.description,
        role,
        revision: row.revision,
        published_version: row.published_version,
        updated_at: row.updated_at,
        counts: countsOf(spec),
        completeness: modelCompleteness(spec).score,
        health: healthOf(row.health),
        domains: [
          ...new Set(spec.objectTypes.map((t) => t.domain).filter((d): d is string => !!d)),
        ],
        sample: !!row.sample_schema,
      });
    }
    return { ok: true, ontologies: out };
  });

// ── Create ──────────────────────────────────────────────────────────────────

export const ontologyCreate = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        name: z.string().trim().min(1).max(200),
        description: z.string().max(8000).optional(),
        /** A model to start from: an import, an AI draft, a copy. */
        spec: z.unknown().optional(),
        /** Where it came from, for the audit log. */
        origin: z.enum(["blank", "import", "draft", "copy"]).default("blank"),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string; issues: Issue[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    let spec: OntologySpec;
    if (data.spec !== undefined) {
      const parsed = ontologySpecSchema.safeParse(data.spec);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        return { ok: false, error: `The model is not valid: ${i?.path.join(".")} ${i?.message}` };
      }
      spec = {
        ...parsed.data,
        name: data.name,
        ...(data.description ? { description: data.description } : {}),
      };
    } else {
      spec = emptySpec(data.name, data.description);
    }
    const tooBig = await sizeProblem(spec);
    if (tooBig) return { ok: false, error: tooBig };
    const clash = await nameClash(caller.userId, data.name);
    if (clash) return { ok: false, error: clash };
    const { data: row, error } = await supabaseAdmin
      .from("ontologies")
      .insert({
        user_id: caller.userId,
        name: data.name,
        description: data.description ?? spec.description ?? null,
        spec: spec as unknown as Json,
      })
      .select("id")
      .single();
    if (error || !row)
      return { ok: false, error: error?.message ?? "Could not create the ontology" };
    auditEvent({
      userId: caller.userId,
      action: "ontology.create",
      resourceType: "ontology",
      resourceId: row.id,
      resourceName: data.name,
      detail: { origin: data.origin, ...countsOf(spec) },
    });
    return { ok: true, id: row.id, issues: validateSpec(spec).issues };
  });

/**
 * The sample: a lakehouse schema with six tables, and an ontology bound to
 * them. The schema is claimed like any other (the caller owns it), so the
 * tables are theirs to query, share or drop.
 */
export const ontologyCreateSample = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; id: string; schema: string } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    if (!lakehouseEnabled()) {
      return {
        ok: false,
        error: "The sample needs the lakehouse, which is not configured on this instance",
      };
    }
    // Before anything is made: on a database without the ontology tables the
    // last step would fail and strand a schema of six tables under the name.
    const reachable = await supabaseAdmin.from("ontologies").select("id").limit(1);
    if (reachable.error) {
      return {
        ok: false,
        error:
          notInstalledMessage(reachable.error.message) ??
          `Could not reach the ontology tables: ${reachable.error.message}`,
      };
    }
    // Claim the first free schema name: ontology_sample, ontology_sample_2, …
    let schema = "";
    let schemaId = "";
    for (let i = 1; i <= 50 && !schema; i++) {
      const name = i === 1 ? SAMPLE_SCHEMA_BASE : `${SAMPLE_SCHEMA_BASE}_${i}`;
      const { data: claimed, error } = await supabaseAdmin
        .from("lakehouse_schemas")
        .insert({
          name,
          user_id: caller.userId,
          description: `Tables for the ${SAMPLE_NAME} sample ontology`,
        })
        .select("id")
        .single();
      if (error && error.code !== "23505") {
        return { ok: false, error: `Could not create the sample's schema: ${error.message}` };
      }
      if (!claimed) continue;
      // Claimed in the registry; now made in the catalog. A schema already
      // there (made outside the app, or left by a crash) is not this call's
      // to fill or to drop: release the claim and try the next name.
      try {
        const c = await lakehouseConnection();
        try {
          await c.run(`CREATE SCHEMA ${name}`);
        } finally {
          c.closeSync();
        }
        schema = name;
        schemaId = claimed.id;
      } catch (e) {
        await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", claimed.id);
        if (!/already exists/i.test((e as Error).message)) {
          return {
            ok: false,
            error: `Could not create the sample's schema: ${(e as Error).message}`,
          };
        }
      }
    }
    if (!schema) return { ok: false, error: "Could not find a free name for the sample's schema" };
    // Undo everything this call made (the schema is its own, created above),
    // so a failure at any later step leaves no tables behind and the name
    // free for the next try.
    const rollback = async () => {
      try {
        const c = await lakehouseConnection();
        try {
          await c.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          c.closeSync();
        }
      } catch {
        /* the claim below is released either way */
      }
      await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", schemaId);
    };
    try {
      // The tables are written as the caller, through the governed path,
      // into the schema they now own.
      for (const sql of sampleSql(schema)) {
        await runSql(caller.userId, sql, { rowCap: 1, via: "ontology:sample", timeoutMs: 120_000 });
      }
    } catch (e) {
      await rollback();
      return { ok: false, error: `Could not create the sample's tables: ${(e as Error).message}` };
    }
    // A second sample is "Northwind Outfitters 2": names tell ontologies apart.
    const taken = new Set((await ownerNames(caller.userId)).map((n) => n.trim().toLowerCase()));
    let name = SAMPLE_NAME;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${SAMPLE_NAME} ${i}`;
    const spec = { ...sampleSpec(schema), name };
    const { data: row, error } = await supabaseAdmin
      .from("ontologies")
      .insert({
        user_id: caller.userId,
        name,
        description: spec.description ?? null,
        spec: spec as unknown as Json,
        sample_schema: schema,
      })
      .select("id")
      .single();
    if (error || !row) {
      await rollback();
      return {
        ok: false,
        error:
          notInstalledMessage(error?.message) ??
          error?.message ??
          "Could not create the sample ontology",
      };
    }
    auditEvent({
      userId: caller.userId,
      action: "lakehouse.schema.create",
      resourceType: "lakehouse_schema",
      resourceId: schemaId,
      resourceName: schema,
      detail: { via: "ontology:sample" },
    });
    auditEvent({
      userId: caller.userId,
      action: "ontology.create",
      resourceType: "ontology",
      resourceId: row.id,
      resourceName: name,
      detail: { origin: "sample", schema, ...countsOf(spec) },
    });
    return { ok: true, id: row.id, schema };
  });

// ── Read ────────────────────────────────────────────────────────────────────

export type OntologyDetail = {
  id: string;
  name: string;
  description: string | null;
  role: OntologyRole;
  spec: OntologySpec;
  revision: number;
  /** The version `spec` is (grantees), or null for the owner's draft. */
  version: number | null;
  published_version: number | null;
  issues: Issue[];
  completeness: ReturnType<typeof modelCompleteness>;
  /** For a grantee: what their share hides or limits, in words. */
  restrictions: string[];
  /** For the owner: has the draft changed since the last publish? */
  unpublished_changes: boolean;
  health: OntologySummary["health"];
  sample_schema: string | null;
  open_proposals: number;
  pending_actions: number;
  updated_at: string;
};

export const ontologyGet = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token, id }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; ontology: OntologyDetail } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "read");
    if (isFail(access)) return access;
    const { row, role, spec, version, policy } = access;
    let unpublished = role === "owner";
    if (role === "owner" && row.published_version) {
      const { data: v } = await supabaseAdmin
        .from("ontology_versions")
        .select("spec")
        .eq("ontology_id", row.id)
        .eq("version", row.published_version)
        .maybeSingle();
      unpublished = !v || JSON.stringify(v.spec) !== JSON.stringify(row.spec);
    }
    const [{ count: openProposals }, { count: pendingActions }] = await Promise.all([
      supabaseAdmin
        .from("ontology_proposals")
        .select("id", { count: "exact", head: true })
        .eq("ontology_id", row.id)
        .eq("status", "open"),
      supabaseAdmin
        .from("ontology_actions")
        .select("id", { count: "exact", head: true })
        .eq("ontology_id", row.id)
        .eq("status", "proposed"),
    ]);
    return {
      ok: true,
      ontology: {
        id: row.id,
        name: row.name,
        description: row.description,
        role,
        spec,
        revision: row.revision,
        version,
        published_version: row.published_version,
        issues: validateSpec(spec).issues,
        completeness: modelCompleteness(spec),
        restrictions: policy ? describeOntologyPolicy(policy) : [],
        unpublished_changes: unpublished,
        health: healthOf(row.health),
        sample_schema: role === "owner" ? row.sample_schema : null,
        open_proposals: openProposals ?? 0,
        pending_actions: pendingActions ?? 0,
        updated_at: row.updated_at,
      },
    };
  });

// ── Save the draft ──────────────────────────────────────────────────────────

export const ontologySave = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({ access_token: token, id, revision: z.number().int().min(1), spec: z.unknown() })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; revision: number; issues: Issue[] }
      | Fail
      | { ok: false; conflict: true; error: string }
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const access = await loadOntology(caller.userId, data.id, "own");
      if (isFail(access)) return access;
      const parsed = ontologySpecSchema.safeParse(data.spec);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        return { ok: false, error: `Not saved: ${i?.path.join(".") || "model"} — ${i?.message}` };
      }
      const tooBig = await sizeProblem(parsed.data);
      if (tooBig) return { ok: false, error: tooBig };
      if (parsed.data.name.trim().toLowerCase() !== access.row.name.trim().toLowerCase()) {
        const clash = await nameClash(caller.userId, parsed.data.name, data.id);
        if (clash) return { ok: false, error: `Not saved: ${clash}` };
      }
      // Compare-and-set on the revision: an UPDATE that matches no row means
      // someone saved in between.
      const { data: updated, error } = await supabaseAdmin
        .from("ontologies")
        .update({
          spec: parsed.data as unknown as Json,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          revision: data.revision + 1,
        })
        .eq("id", data.id)
        .eq("revision", data.revision)
        .select("revision")
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!updated) {
        return {
          ok: false,
          conflict: true,
          error:
            "This ontology was changed in another tab or by another session. Reload to see it before saving.",
        };
      }
      return { ok: true, revision: updated.revision, issues: validateSpec(parsed.data).issues };
    },
  );

// ── Publish, versions, restore ──────────────────────────────────────────────

export const ontologyPublish = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        revision: z.number().int().min(1),
        note: z.string().max(4000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; version: number; diff: SpecDiff } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "own");
    if (isFail(access)) return access;
    if (access.row.revision !== data.revision) {
      return {
        ok: false,
        error: "The draft changed since you opened it. Reload, check it, then publish.",
      };
    }
    const result = validateSpec(access.spec);
    if (!result.ok) {
      const first = result.issues.find((i) => i.level === "error");
      return {
        ok: false,
        error: `Fix ${result.issues.filter((i) => i.level === "error").length} problem(s) before publishing. First: ${first?.path} — ${first?.message}`,
      };
    }
    const prev = access.row.published_version;
    let before: OntologySpec | null = null;
    if (prev) {
      const { data: v } = await supabaseAdmin
        .from("ontology_versions")
        .select("spec")
        .eq("ontology_id", data.id)
        .eq("version", prev)
        .maybeSingle();
      before = v ? parseStoredSpec(v.spec, `version ${prev}`) : null;
    }
    const diff = diffSpecs(before ?? emptySpec(access.spec.name), access.spec);
    if (before && diff.changes.length === 0) {
      return { ok: false, error: `Nothing to publish: the draft is the same as version ${prev}` };
    }
    const version = (prev ?? 0) + 1;
    const { error } = await supabaseAdmin.from("ontology_versions").insert({
      ontology_id: data.id,
      version,
      spec: access.spec as unknown as Json,
      note: data.note ?? null,
      diff: {
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        breaking: diff.breaking,
        changes: diff.changes.slice(0, 500),
      } as unknown as Json,
      published_by: caller.userId,
    });
    if (error) {
      return {
        ok: false,
        error:
          error.code === "23505"
            ? "Another publish just happened; reload and try again"
            : error.message,
      };
    }
    await supabaseAdmin.from("ontologies").update({ published_version: version }).eq("id", data.id);
    auditEvent({
      userId: caller.userId,
      action: "ontology.publish",
      resourceType: "ontology",
      resourceId: data.id,
      resourceName: access.row.name,
      detail: {
        version,
        note: data.note ?? null,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        breaking: diff.changes
          .filter((c) => c.breaking)
          .map((c) => c.path)
          .slice(0, 50),
      },
    });
    return { ok: true, version, diff };
  });

export type OntologyVersionRow = {
  version: number;
  note: string | null;
  created_at: string;
  published_by: string | null;
  publisher_email: string | null;
  diff: { added: number; removed: number; changed: number; breaking: number } | null;
};

export const ontologyVersions = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token, id }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; versions: OntologyVersionRow[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "read");
    if (isFail(access)) return access;
    const { data: rows, error } = await supabaseAdmin
      .from("ontology_versions")
      .select("version, note, created_at, published_by, diff")
      .eq("ontology_id", data.id)
      .order("version", { ascending: false })
      .limit(200);
    if (error) return { ok: false, error: error.message };
    const emailOf = await emailsFor((rows ?? []).map((r) => r.published_by));
    return {
      ok: true,
      versions: (rows ?? []).map((r) => {
        const d = r.diff as {
          added?: number;
          removed?: number;
          changed?: number;
          breaking?: number;
        } | null;
        return {
          version: r.version,
          note: r.note,
          created_at: r.created_at,
          published_by: r.published_by,
          publisher_email: r.published_by ? (emailOf.get(r.published_by) ?? null) : null,
          diff: d
            ? {
                added: d.added ?? 0,
                removed: d.removed ?? 0,
                changed: d.changed ?? 0,
                breaking: d.breaking ?? 0,
              }
            : null,
        };
      }),
    };
  });

/** One version's model, and what it changed against the one before. */
export const ontologyVersionGet = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: token, id, version: z.number().int().min(1) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; spec: OntologySpec; diff: SpecDiff } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "read");
    if (isFail(access)) return access;
    // A grantee sees published history up to the version they were given.
    if (access.role === "viewer" && data.version > (access.version ?? 0)) {
      return { ok: false, error: "That version does not exist" };
    }
    const { data: rows } = await supabaseAdmin
      .from("ontology_versions")
      .select("version, spec")
      .eq("ontology_id", data.id)
      .in("version", [data.version, data.version - 1]);
    const cur = rows?.find((r) => r.version === data.version);
    if (!cur) return { ok: false, error: "That version does not exist" };
    const prev = rows?.find((r) => r.version === data.version - 1);
    const spec = parseStoredSpec(cur.spec, `version ${data.version}`);
    const before = prev
      ? parseStoredSpec(prev.spec, `version ${prev.version}`)
      : emptySpec(spec.name);
    return { ok: true, spec, diff: diffSpecs(before, spec) };
  });

/** Compare the draft (or any version) with another version. */
export const ontologyCompare = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        base: z.number().int().min(1),
        target: z.number().int().min(1).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; diff: SpecDiff } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(
      caller.userId,
      data.id,
      data.target === null ? "own" : "read",
    );
    if (isFail(access)) return access;
    const wanted = [data.base, ...(data.target ? [data.target] : [])];
    const { data: rows } = await supabaseAdmin
      .from("ontology_versions")
      .select("version, spec")
      .eq("ontology_id", data.id)
      .in("version", wanted);
    const base = rows?.find((r) => r.version === data.base);
    if (!base) return { ok: false, error: `Version ${data.base} does not exist` };
    const target =
      data.target === null ? access.spec : rows?.find((r) => r.version === data.target)?.spec;
    if (!target) return { ok: false, error: `Version ${data.target} does not exist` };
    return {
      ok: true,
      diff: diffSpecs(
        parseStoredSpec(base.spec, `version ${data.base}`),
        data.target === null
          ? (target as OntologySpec)
          : parseStoredSpec(target, `version ${data.target}`),
      ),
    };
  });

export const ontologyRestore = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        version: z.number().int().min(1),
        revision: z.number().int().min(1),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; revision: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "own");
    if (isFail(access)) return access;
    const { data: v } = await supabaseAdmin
      .from("ontology_versions")
      .select("spec")
      .eq("ontology_id", data.id)
      .eq("version", data.version)
      .maybeSingle();
    if (!v) return { ok: false, error: "That version does not exist" };
    const spec = parseStoredSpec(v.spec, `version ${data.version}`);
    if (spec.name.trim().toLowerCase() !== access.row.name.trim().toLowerCase()) {
      const clash = await nameClash(caller.userId, spec.name, data.id);
      if (clash) return { ok: false, error: `Not restored: ${clash}` };
    }
    const { data: updated, error } = await supabaseAdmin
      .from("ontologies")
      .update({ spec: spec as unknown as Json, name: spec.name, revision: data.revision + 1 })
      .eq("id", data.id)
      .eq("revision", data.revision)
      .select("revision")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!updated) return { ok: false, error: "The draft changed meanwhile; reload and try again" };
    auditEvent({
      userId: caller.userId,
      action: "ontology.restore",
      resourceType: "ontology",
      resourceId: data.id,
      resourceName: access.row.name,
      detail: { version: data.version },
    });
    return { ok: true, revision: updated.revision };
  });

// ── Delete ──────────────────────────────────────────────────────────────────

export const ontologyDelete = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({ access_token: token, id, drop_sample_tables: z.boolean().default(false) })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; dropped_schema: string | null } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "own");
    if (isFail(access)) return access;
    const { error } = await supabaseAdmin.from("ontologies").delete().eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    // Shares of a deleted resource would point at nothing; remove them.
    await supabaseAdmin
      .from("iam_resource_grants")
      .delete()
      .eq("resource_type", "ontology")
      .eq("resource_id", data.id);
    let dropped: string | null = null;
    const schema = access.row.sample_schema;
    if (data.drop_sample_tables && schema) {
      const { data: owned } = await supabaseAdmin
        .from("lakehouse_schemas")
        .select("id")
        .eq("name", schema)
        .eq("user_id", caller.userId)
        .maybeSingle();
      if (owned) {
        const c = await lakehouseConnection();
        try {
          await c.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          c.closeSync();
        }
        await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", owned.id);
        dropped = schema;
        auditEvent({
          userId: caller.userId,
          action: "lakehouse.schema.drop",
          resourceType: "lakehouse_schema",
          resourceId: owned.id,
          resourceName: schema,
          detail: { via: "ontology:sample" },
        });
      }
    }
    auditEvent({
      userId: caller.userId,
      action: "ontology.delete",
      resourceType: "ontology",
      resourceId: data.id,
      resourceName: access.row.name,
      detail: { dropped_schema: dropped },
    });
    return { ok: true, dropped_schema: dropped };
  });

// ── Proposals: a grantee (or the owner) suggests, the owner decides ─────────

export type ProposalRow = {
  id: string;
  title: string;
  note: string | null;
  status: "open" | "merged" | "rejected" | "withdrawn";
  author_id: string | null;
  author_email: string | null;
  base_revision: number;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  diff: SpecDiff;
  stale: boolean;
  mine: boolean;
};

export const ontologyPropose = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        title: z.string().trim().min(1).max(200),
        note: z.string().max(4000).optional(),
        spec: z.unknown(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; proposal_id: string } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "read");
    if (isFail(access)) return access;
    const parsed = ontologySpecSchema.safeParse(data.spec);
    if (!parsed.success)
      return {
        ok: false,
        error: `The proposed model is not valid: ${parsed.error.issues[0]?.message}`,
      };
    const tooBig = await sizeProblem(parsed.data);
    if (tooBig) return { ok: false, error: tooBig };
    const { data: row, error } = await supabaseAdmin
      .from("ontology_proposals")
      .insert({
        ontology_id: data.id,
        author_id: caller.userId,
        title: data.title,
        note: data.note ?? null,
        base_revision: access.row.revision,
        spec: parsed.data as unknown as Json,
      })
      .select("id")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Could not save the proposal" };
    auditEvent({
      userId: caller.userId,
      action: "ontology.proposal.open",
      resourceType: "ontology",
      resourceId: data.id,
      resourceName: access.row.name,
      detail: { proposal_id: row.id, title: data.title },
    });
    return { ok: true, proposal_id: row.id };
  });

export const ontologyProposals = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token, id }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; proposals: ProposalRow[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "read");
    if (isFail(access)) return access;
    let q = supabaseAdmin
      .from("ontology_proposals")
      .select(
        "id, title, note, status, author_id, base_revision, spec, created_at, decided_at, decision_note",
      )
      .eq("ontology_id", data.id)
      .order("created_at", { ascending: false })
      .limit(100);
    // A grantee sees their own proposals; the owner sees all.
    if (access.role !== "owner") q = q.eq("author_id", caller.userId);
    const { data: rows, error } = await q;
    if (error) return { ok: false, error: error.message };
    const emailOf = await emailsFor((rows ?? []).map((r) => r.author_id));
    const draft = parseStoredSpec(access.row.spec, "draft");
    return {
      ok: true,
      proposals: (rows ?? []).map((r) => {
        let diff: SpecDiff;
        try {
          diff = diffSpecs(draft, parseStoredSpec(r.spec, "proposal"));
        } catch {
          diff = { changes: [], added: 0, removed: 0, changed: 0, breaking: 0 };
        }
        return {
          id: r.id,
          title: r.title,
          note: r.note,
          status: r.status as ProposalRow["status"],
          author_id: r.author_id,
          author_email: r.author_id ? (emailOf.get(r.author_id) ?? null) : null,
          base_revision: r.base_revision,
          created_at: r.created_at,
          decided_at: r.decided_at,
          decision_note: r.decision_note,
          diff,
          stale: r.status === "open" && r.base_revision !== access.row.revision,
          mine: r.author_id === caller.userId,
        };
      }),
    };
  });

export const ontologyDecideProposal = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        proposal_id: z.string().uuid(),
        decision: z.enum(["merge", "reject", "withdraw"]),
        note: z.string().max(4000).optional(),
        /** Merge a proposal made against an older draft anyway (its model replaces the draft). */
        force: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; revision?: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const access = await loadOntology(caller.userId, data.id, "read");
    if (isFail(access)) return access;
    const { data: p } = await supabaseAdmin
      .from("ontology_proposals")
      .select("id, author_id, status, base_revision, spec, title")
      .eq("id", data.proposal_id)
      .eq("ontology_id", data.id)
      .maybeSingle();
    if (!p) return { ok: false, error: "That proposal does not exist" };
    if (p.status !== "open") return { ok: false, error: `That proposal is already ${p.status}` };
    if (data.decision === "withdraw") {
      if (p.author_id !== caller.userId)
        return { ok: false, error: "Only its author can withdraw a proposal" };
    } else if (access.role !== "owner") {
      return { ok: false, error: "Only the ontology's owner can merge or reject a proposal" };
    }
    let revision: number | undefined;
    if (data.decision === "merge") {
      if (p.base_revision !== access.row.revision && !data.force) {
        return {
          ok: false,
          error:
            "The draft changed since this proposal was made. Review the difference, then merge anyway to replace the draft with it.",
        };
      }
      const spec = parseStoredSpec(p.spec, "proposal");
      if (spec.name.trim().toLowerCase() !== access.row.name.trim().toLowerCase()) {
        const clash = await nameClash(access.row.user_id, spec.name, data.id);
        if (clash) return { ok: false, error: `Not merged: ${clash}` };
      }
      const { data: updated, error } = await supabaseAdmin
        .from("ontologies")
        .update({
          spec: spec as unknown as Json,
          name: spec.name,
          revision: access.row.revision + 1,
        })
        .eq("id", data.id)
        .eq("revision", access.row.revision)
        .select("revision")
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!updated)
        return { ok: false, error: "The draft changed meanwhile; reload and try again" };
      revision = updated.revision;
    }
    const status =
      data.decision === "merge" ? "merged" : data.decision === "reject" ? "rejected" : "withdrawn";
    await supabaseAdmin
      .from("ontology_proposals")
      .update({
        status,
        decided_by: caller.userId,
        decided_at: new Date().toISOString(),
        decision_note: data.note ?? null,
      })
      .eq("id", p.id);
    auditEvent({
      userId: caller.userId,
      action: `ontology.proposal.${status}`,
      resourceType: "ontology",
      resourceId: data.id,
      resourceName: access.row.name,
      detail: {
        proposal_id: p.id,
        title: p.title,
        author_id: p.author_id,
        note: data.note ?? null,
      },
    });
    return { ok: true, ...(revision ? { revision } : {}) };
  });

// ── The lakehouse, for binding ──────────────────────────────────────────────

export const ontologyTables = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          enabled: boolean;
          tables: { table: string; columns: { name: string; type: string }[] }[];
        }
      | Fail
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const r = await listLakehouseTablesForUser(caller.userId);
      return {
        ok: true,
        enabled: r.enabled,
        tables: r.tables
          .filter(
            (t) =>
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.schema) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.table),
          )
          .map((t) => ({ table: `${t.schema}.${t.table}`, columns: t.columns })),
      };
    },
  );
