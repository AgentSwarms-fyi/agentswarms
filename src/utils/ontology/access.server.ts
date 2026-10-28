// Who may do what with an ontology, and which version of it they see.
//
// Every ontology server function starts here. The OWNER works on the draft:
// edits it, publishes it, runs its rules, decides proposals and approves
// actions. A GRANTEE (an IAM grant of type `ontology`, directly or through a
// group) works on the PUBLISHED version, under the share's policy (property
// masks and row filters, src/lib/ontology/policy.ts); until the owner has
// published once, there is nothing for a grantee to see. Everyone else is told
// the ontology does not exist, which is also what a deleted one says.
//
// Data never comes from here: the caller's queries run through the governed
// lakehouse path as the caller (run.server.ts), so their own schema grants,
// tag policies and row filters on the tables apply on top of the ontology's.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { callerFailure } from "@/utils/callerLookup.server";
import { readApplicableGrants } from "@/utils/iam.server";
import { attributesFor } from "@/utils/semantic/policy.server";
import {
  attributeKeysInGrants,
  policyFromGrants,
  resolveAttributeGrants,
} from "@/lib/semanticPolicy";
import type { OntologyPolicy } from "@/lib/ontology/compile";
import { ontologyPolicyFrom } from "@/lib/ontology/policy";
import { ontologySpecSchema, type OntologySpec } from "@/lib/ontology/spec";

export type OntologyRole = "owner" | "viewer";

export type Fail = { ok: false; error: string };

export async function resolveCaller(
  accessToken: string,
): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: callerFailure(error, "Not signed in") };
  return { ok: true, userId: data.user.id };
}

export type OntologyRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  spec: Json;
  revision: number;
  published_version: number | null;
  health: Json | null;
  sample_schema: string | null;
  created_at: string;
  updated_at: string;
};

export type OntologyAccess = {
  row: OntologyRow;
  role: OntologyRole;
  /** The model this caller works with: the draft for the owner, the published version for a grantee. */
  spec: OntologySpec;
  /** Which version `spec` is: null = the owner's draft. */
  version: number | null;
  /** The share's restrictions, for a grantee whose grant carries any. */
  policy: OntologyPolicy | null;
};

const NOT_FOUND = "That ontology does not exist, or it is not shared with you";

export function parseStoredSpec(raw: unknown, where: string): OntologySpec {
  const parsed = ontologySpecSchema.safeParse(raw);
  if (!parsed.success) {
    // A stored document that no longer parses is a bug or a hand edit; say
    // which, rather than serving half a model.
    throw new Error(
      `The stored ${where} does not match the ontology format: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

/** Does `userId` hold a grant on this ontology (directly or via a group)? */
export async function isGrantee(userId: string, ontologyId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("has_resource_access", {
    rtype: "ontology",
    rid: ontologyId,
    uid: userId,
  });
  if (error) throw new Error(`Could not check access: ${error.message}`);
  return data === true;
}

/** The merged policy of the caller's grants on this ontology, or null for none. */
export async function ontologyPolicyFor(
  userId: string,
  ontologyId: string,
): Promise<OntologyPolicy | null> {
  // FAIL CLOSED: readApplicableGrants throws when grants or memberships cannot
  // be read, and attributesFor throws when an attribute token cannot resolve.
  const mine = await readApplicableGrants(supabaseAdmin, userId, "ontology", [ontologyId]);
  if (!mine.length) return null;
  const attrs = await attributesFor(userId, attributeKeysInGrants(mine));
  const policy = ontologyPolicyFrom(policyFromGrants(resolveAttributeGrants(mine, attrs)));
  return policy.rowFilters?.length || policy.maskedProperties?.length ? policy : null;
}

/**
 * Load an ontology for a caller. `need: "own"` refuses anyone but the owner
 * (with the same not-found message, so ownership is not probeable).
 */
export async function loadOntology(
  userId: string,
  ontologyId: string,
  need: "read" | "own",
): Promise<OntologyAccess | Fail> {
  const { data, error } = await supabaseAdmin
    .from("ontologies")
    .select(
      "id, user_id, name, description, spec, revision, published_version, health, sample_schema, created_at, updated_at",
    )
    .eq("id", ontologyId)
    .maybeSingle();
  if (error) return { ok: false, error: `Could not load the ontology: ${error.message}` };
  if (!data) return { ok: false, error: NOT_FOUND };
  const row = data as OntologyRow;
  if (row.user_id === userId) {
    return {
      row,
      role: "owner",
      spec: parseStoredSpec(row.spec, "draft"),
      version: null,
      policy: null,
    };
  }
  if (need === "own") return { ok: false, error: NOT_FOUND };
  if (!(await isGrantee(userId, ontologyId))) return { ok: false, error: NOT_FOUND };
  if (!row.published_version) {
    return { ok: false, error: "The owner has not published this ontology yet" };
  }
  const { data: v, error: vErr } = await supabaseAdmin
    .from("ontology_versions")
    .select("spec, version")
    .eq("ontology_id", ontologyId)
    .eq("version", row.published_version)
    .maybeSingle();
  if (vErr || !v)
    return {
      ok: false,
      error: `Could not load the published version: ${vErr?.message ?? "missing"}`,
    };
  return {
    row,
    role: "viewer",
    spec: parseStoredSpec(v.spec, `version ${v.version}`),
    version: v.version,
    policy: await ontologyPolicyFor(userId, ontologyId),
  };
}

const emailCache = new Map<string, { at: number; email: string | null }>();

/** Emails for user ids (who published, proposed, asked, approved), cached for ten minutes. */
export async function emailsFor(
  ids: (string | null | undefined)[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const want = [...new Set(ids.filter((x): x is string => !!x))].slice(0, 200);
  await Promise.all(
    want.map(async (id) => {
      const hit = emailCache.get(id);
      if (hit && Date.now() - hit.at < 600_000) {
        out.set(id, hit.email);
        return;
      }
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(id);
        const email = data.user?.email ?? null;
        emailCache.set(id, { at: Date.now(), email });
        out.set(id, email);
      } catch {
        out.set(id, null);
      }
    }),
  );
  return out;
}

export function isFail(x: unknown): x is Fail {
  return !!x && typeof x === "object" && (x as Fail).ok === false;
}

// ── Limits: Admin -> Developer runtime, else env, else the default ──────────

function envInt(name: string): number | undefined {
  const n = Number(process.env[name]?.trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

export type OntologyLimits = { maxRows: number; maxSpecBytes: number };

export async function ontologyLimits(): Promise<OntologyLimits> {
  // Read on its own: a missing column (migration not pushed yet) must not
  // take the other runtime settings down with it.
  const { data } = await supabaseAdmin
    .from("notebook_runtime_settings")
    .select("ontology_max_rows, ontology_max_spec_kb")
    .limit(1)
    .maybeSingle();
  const row = (data ?? {}) as {
    ontology_max_rows?: number | null;
    ontology_max_spec_kb?: number | null;
  };
  const positive = (n: number | null | undefined) => (n && n > 0 ? n : undefined);
  return {
    maxRows: positive(row.ontology_max_rows) ?? envInt("ONTOLOGY_MAX_ROWS") ?? 5000,
    maxSpecBytes:
      (positive(row.ontology_max_spec_kb) ?? envInt("ONTOLOGY_MAX_SPEC_KB") ?? 4096) * 1024,
  };
}
