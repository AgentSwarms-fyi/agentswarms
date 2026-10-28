// Server functions behind Data & BI -> Enterprise Ontology: AI.
//
// Drafting a model from tables, asking it questions, and the verified
// questions that make its answers trustworthy over time. Every model call
// goes through llmJsonServer — the caller's provider credentials, their IAM
// model rules, the budget gate, a trace with its cost under "Ontology: …" —
// and every question is audited with the plan that answered it.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { llmJsonServer } from "@/utils/bi/llmJson.server";
import { listLakehouseTablesForUser } from "@/utils/lakehouse/tables.server";
import {
  emailsFor,
  isFail,
  loadOntology,
  ontologyLimits,
  resolveCaller,
  type Fail,
} from "@/utils/ontology/access.server";
import {
  answerDigest,
  askOntology,
  runPlan,
  type AskAnswer,
  type AskRefusal,
} from "@/utils/ontology/ask.server";
import { friendlyLakehouseError, runCount, runRows } from "@/utils/ontology/run.server";
import { askPlanSchema } from "@/lib/ontology/catalog";
import { compileObjectSet, type CompileOpts } from "@/lib/ontology/compile";
import { inferFromTables } from "@/lib/ontology/infer";
import { linkReading, type OntologySpec } from "@/lib/ontology/spec";

const token = z.string().min(1);
const id = z.string().uuid();

async function ctxFor(accessToken: string, ontologyId: string, need: "read" | "own" = "read") {
  const caller = await resolveCaller(accessToken);
  if (!caller.ok) return caller;
  const a = await loadOntology(caller.userId, ontologyId, need);
  if (isFail(a)) return a;
  const { maxRows } = await ontologyLimits();
  const opts: CompileOpts = {
    seeRestricted: a.role === "owner",
    maxRows,
    ...(a.policy ? { policy: a.policy } : {}),
  };
  return { userId: caller.userId, a, opts };
}

// ── Draft a model from tables ───────────────────────────────────────────────

export type DraftEvidence = {
  keys: {
    objectType: string;
    properties: string[];
    rows: number | null;
    distinct: number | null;
    kept: boolean;
  }[];
  links: {
    objectType: string;
    link: string;
    to: string;
    matchRate: number | null;
    kept: boolean;
  }[];
  ai: "used" | "skipped" | "failed";
  aiError?: string;
};

export const ontologyDraftFromTables = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        name: z.string().trim().min(1).max(200),
        tables: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/))
          .min(1)
          .max(40),
        /** Ask the model for descriptions, labels and synonyms (never structure). */
        enrich: z.boolean().default(true),
        provider: z.string().max(60).optional(),
        model: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; spec: OntologySpec; evidence: DraftEvidence; warnings: string[] } | Fail
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const listing = await listLakehouseTablesForUser(caller.userId);
      if (!listing.enabled)
        return { ok: false, error: "The lakehouse is not configured on this instance" };
      const byName = new Map(
        listing.tables.map((t) => [`${t.schema}.${t.table}`.toLowerCase(), t]),
      );
      const picked = data.tables.map((t) => byName.get(t.toLowerCase()));
      const missing = data.tables.filter((_, i) => !picked[i]);
      if (missing.length)
        return { ok: false, error: `Not found or not yours to read: ${missing.join(", ")}` };
      const draft = inferFromTables(
        data.name,
        picked.map((t) => ({ table: `${t!.schema}.${t!.table}`, columns: t!.columns })),
      );
      const spec = draft.spec;
      const warnings: string[] = [];
      const opts: CompileOpts = { seeRestricted: true, maxRows: 5000 };

      // Measure every guess before it is shown: a key that is not unique and a
      // link that matches nothing are worse than no guess.
      const evidence: DraftEvidence = { keys: [], links: [], ai: "skipped" };
      for (const g of draft.keyGuesses) {
        const t = spec.objectTypes.find((x) => x.name === g.objectType)!;
        try {
          const keys = g.properties.map(
            (p) => `"${t.properties.find((x) => x.name === p)!.column!.replace(/"/g, '""')}"`,
          );
          const r = await runRows(
            caller.userId,
            `SELECT count(*) AS n, count(DISTINCT (${keys.join(", ")})) AS d FROM ${t.source!.table}`,
            null,
            { rowCap: 1, via: "ontology:draft" },
          );
          const n = Number(r.rows[0]?.n ?? 0);
          const d = Number(r.rows[0]?.d ?? 0);
          const kept = n === d;
          evidence.keys.push({
            objectType: t.name,
            properties: g.properties,
            rows: n,
            distinct: d,
            kept,
          });
          if (!kept) {
            warnings.push(
              `${t.name}: ${g.properties.join(", ")} is not unique (${d} distinct in ${n} rows), so it is not used as the key — pick one.`,
            );
            t.primaryKey = [];
          }
        } catch (e) {
          evidence.keys.push({
            objectType: t.name,
            properties: g.properties,
            rows: null,
            distinct: null,
            kept: true,
          });
          warnings.push(`${t.name}: could not check the key (${friendlyLakehouseError(e)})`);
        }
      }
      for (const g of draft.linkGuesses) {
        const l = spec.linkTypes.find((x) => x.from === g.objectType && x.name === g.link)!;
        const target = spec.objectTypes.find((x) => x.name === l.to)!;
        if (!target.primaryKey.length) {
          evidence.links.push({
            objectType: l.from,
            link: l.name,
            to: l.to,
            matchRate: null,
            kept: false,
          });
          spec.linkTypes = spec.linkTypes.filter((x) => x !== l);
          continue;
        }
        try {
          const checked = compileObjectSet(
            spec,
            {
              objectType: l.from,
              filters: l.join.fromProperties.map((p) => ({ property: p, op: "not_null" as const })),
              limit: 1,
            },
            opts,
          );
          const matched = compileObjectSet(
            spec,
            {
              objectType: l.to,
              path: [{ link: linkReading(l, "inverse"), direction: "inverse" }],
              limit: 1,
            },
            opts,
          );
          const [c, m] = await Promise.all([
            runCount(caller.userId, checked.countSql!, "ontology:draft"),
            runCount(caller.userId, matched.countSql!, "ontology:draft"),
          ]);
          const rate = c ? m / c : null;
          const kept = rate !== null && rate >= 0.6;
          evidence.links.push({
            objectType: l.from,
            link: l.name,
            to: l.to,
            matchRate: rate,
            kept,
          });
          if (!kept) {
            spec.linkTypes = spec.linkTypes.filter((x) => x !== l);
            warnings.push(
              `${l.from}.${l.name} → ${l.to} was dropped: only ${rate === null ? "no" : `${Math.round(rate * 100)}% of`} ${l.from} rows match a ${l.to}.`,
            );
          }
        } catch (e) {
          evidence.links.push({
            objectType: l.from,
            link: l.name,
            to: l.to,
            matchRate: null,
            kept: false,
          });
          spec.linkTypes = spec.linkTypes.filter((x) => x !== l);
          warnings.push(`${l.from}.${l.name}: could not be checked (${friendlyLakehouseError(e)})`);
        }
      }

      if (data.enrich) {
        // Three sample values per column help the model say what a column
        // means; they go to the caller's own provider, under their own rules.
        const samples: Record<string, Record<string, unknown[]>> = {};
        for (const t of spec.objectTypes) {
          try {
            const r = await runRows(
              caller.userId,
              `SELECT * FROM ${t.source!.table} LIMIT 3`,
              null,
              { rowCap: 3, via: "ontology:draft" },
            );
            samples[t.name] = Object.fromEntries(
              t.properties.map((p) => [
                p.name,
                r.rows.map((row) => String(row[p.column!] ?? "").slice(0, 40)),
              ]),
            );
          } catch {
            samples[t.name] = {};
          }
        }
        const shape = spec.objectTypes.map((t) => ({
          type: t.name,
          table: t.source?.table,
          properties: t.properties.map((p) => ({
            name: p.name,
            type: p.type,
            samples: samples[t.name]?.[p.name] ?? [],
          })),
          links: spec.linkTypes
            .filter((l) => l.from === t.name)
            .map((l) => ({ name: l.name, to: l.to })),
        }));
        const res = await llmJsonServer({
          userId: caller.userId,
          iamClient: supabaseAdmin as unknown as Parameters<typeof llmJsonServer>[0]["iamClient"],
          systemPrompt:
            "You document a business data model. For each type give a one-sentence description of what one object IS, " +
            "a human label, up to 4 synonyms people use, and for each property a short description and label. For each " +
            'link give a label and a verbalization sentence like "{Order} is placed by {Customer}". Return JSON ' +
            '{"types":[{"type":"…","label":"…","description":"…","synonyms":["…"],"properties":[{"name":"…","label":"…","description":"…"}],"links":[{"name":"…","label":"…","verbalization":"…"}]}]}. ' +
            "Never invent types, properties or links that are not listed. If unsure what a column means, leave its description empty.",
          userPrompt: JSON.stringify({ model: data.name, types: shape }),
          provider: data.provider,
          model: data.model,
          temperature: 0.2,
          maxTokens: 6000,
          surface: "Ontology: Draft",
        });
        if (!res.ok) {
          evidence.ai = "failed";
          evidence.aiError = res.error;
          warnings.push(
            `The AI pass did not run (${res.error}); the draft has names but no descriptions.`,
          );
        } else {
          evidence.ai = "used";
          const out = z
            .object({
              types: z.array(
                z.object({
                  type: z.string(),
                  label: z.string().max(120).optional(),
                  description: z.string().max(1000).optional(),
                  synonyms: z.array(z.string().max(100)).max(10).optional(),
                  properties: z
                    .array(
                      z.object({
                        name: z.string(),
                        label: z.string().max(120).optional(),
                        description: z.string().max(1000).optional(),
                      }),
                    )
                    .optional(),
                  links: z
                    .array(
                      z.object({
                        name: z.string(),
                        label: z.string().max(120).optional(),
                        verbalization: z.string().max(300).optional(),
                      }),
                    )
                    .optional(),
                }),
              ),
            })
            .safeParse(res.result);
          if (out.success) {
            for (const e of out.data.types) {
              const t = spec.objectTypes.find((x) => x.name === e.type);
              if (!t) continue;
              if (e.label?.trim()) t.label = e.label.trim();
              if (e.description?.trim()) t.description = e.description.trim();
              if (e.synonyms?.length) t.synonyms = e.synonyms.filter((s) => s.trim()).slice(0, 4);
              for (const pe of e.properties ?? []) {
                const p = t.properties.find((x) => x.name === pe.name);
                if (!p) continue;
                if (pe.label?.trim()) p.label = pe.label.trim();
                if (pe.description?.trim()) p.description = pe.description.trim();
              }
              for (const le of e.links ?? []) {
                const l = spec.linkTypes.find((x) => x.from === t.name && x.name === le.name);
                if (!l) continue;
                if (le.label?.trim()) l.label = le.label.trim();
                if (le.verbalization?.trim()) l.verbalization = le.verbalization.trim();
              }
            }
          } else {
            evidence.ai = "failed";
            warnings.push(
              "The AI pass returned something that was not the expected shape; names are kept as they were.",
            );
          }
        }
      }
      auditEvent({
        userId: caller.userId,
        action: "ontology.draft",
        resourceType: "ontology",
        resourceName: data.name,
        detail: {
          tables: data.tables,
          types: spec.objectTypes.length,
          links: spec.linkTypes.length,
          ai: evidence.ai,
        },
      });
      return { ok: true, spec, evidence, warnings };
    },
  );

// ── Ask ─────────────────────────────────────────────────────────────────────

export const ontologyAsk = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        question: z.string().trim().min(2).max(1000),
        provider: z.string().max(60).optional(),
        model: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<AskAnswer | AskRefusal | Fail> => {
    const ctx = await ctxFor(data.access_token, data.id);
    if (isFail(ctx)) return ctx;
    try {
      const out = await askOntology({
        userId: ctx.userId,
        access: ctx.a,
        opts: ctx.opts,
        question: data.question,
        provider: data.provider,
        model: data.model,
      });
      auditEvent({
        userId: ctx.userId,
        action: "ontology.ask",
        resourceType: "ontology",
        resourceId: data.id,
        resourceName: ctx.a.row.name,
        detail: {
          question: data.question.slice(0, 500),
          outcome: out.ok ? out.kind : "error",
          ...(out.ok && out.kind !== "refuse"
            ? { plan: out.plan, verified: !!out.trust.verified, rows: out.trust.rows }
            : out.ok
              ? { reason: out.reason }
              : { error: out.error }),
        },
      });
      return out;
    } catch (e) {
      return { ok: false, error: friendlyLakehouseError(e) };
    }
  });

// ── Verified questions ──────────────────────────────────────────────────────

export type VerifiedQuestion = {
  id: string;
  question: string;
  plan: Json;
  expected: { rows: number; hash: string } | null;
  last_result: {
    status: "same" | "changed" | "error";
    rows?: number;
    error?: string;
    ran_at: string;
  } | null;
  verified_by_email: string | null;
  created_at: string;
};

/** The owner marks an answer correct: its plan becomes a verified question. */
export const ontologyVerifyAnswer = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        question: z.string().trim().min(2).max(1000),
        plan: z.unknown(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; question_id: string } | Fail> => {
    const ctx = await ctxFor(data.access_token, data.id, "own");
    if (isFail(ctx)) return ctx;
    const plan = askPlanSchema.safeParse(data.plan);
    if (!plan.success || plan.data.kind === "refuse")
      return { ok: false, error: "Only an answered question can be verified" };
    try {
      const ans = await runPlan(ctx.userId, ctx.a, ctx.opts, plan.data, {
        verified: null,
        model: null,
      });
      const digest = answerDigest(ans.rows);
      const { data: row, error } = await supabaseAdmin
        .from("ontology_questions")
        .insert({
          ontology_id: data.id,
          question: data.question,
          query: plan.data as unknown as Json,
          expected: digest as unknown as Json,
          verified_by: ctx.userId,
          last_result: {
            status: "same",
            rows: digest.rows,
            ran_at: new Date().toISOString(),
          } as unknown as Json,
        })
        .select("id")
        .single();
      if (error || !row) return { ok: false, error: error?.message ?? "Could not save" };
      auditEvent({
        userId: ctx.userId,
        action: "ontology.question.verify",
        resourceType: "ontology",
        resourceId: data.id,
        resourceName: ctx.a.row.name,
        detail: { question_id: row.id, question: data.question.slice(0, 500) },
      });
      return { ok: true, question_id: row.id };
    } catch (e) {
      return { ok: false, error: friendlyLakehouseError(e) };
    }
  });

export const ontologyQuestions = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token, id }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; questions: VerifiedQuestion[] } | Fail> => {
    const ctx = await ctxFor(data.access_token, data.id);
    if (isFail(ctx)) return ctx;
    const { data: rows, error } = await supabaseAdmin
      .from("ontology_questions")
      .select("id, question, query, expected, last_result, verified_by, created_at")
      .eq("ontology_id", data.id)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return { ok: false, error: error.message };
    const emailOf = await emailsFor((rows ?? []).map((r) => r.verified_by));
    return {
      ok: true,
      questions: (rows ?? []).map((r) => ({
        id: r.id,
        question: r.question,
        plan: r.query,
        expected: r.expected as VerifiedQuestion["expected"],
        last_result: r.last_result as VerifiedQuestion["last_result"],
        verified_by_email: r.verified_by ? (emailOf.get(r.verified_by) ?? null) : null,
        created_at: r.created_at,
      })),
    };
  });

export const ontologyDeleteQuestion = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: token, id, question_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const ctx = await ctxFor(data.access_token, data.id, "own");
    if (isFail(ctx)) return ctx;
    const { error } = await supabaseAdmin
      .from("ontology_questions")
      .delete()
      .eq("id", data.question_id)
      .eq("ontology_id", data.id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: ctx.userId,
      action: "ontology.question.delete",
      resourceType: "ontology",
      resourceId: data.id,
      resourceName: ctx.a.row.name,
      detail: { question_id: data.question_id },
    });
    return { ok: true };
  });

/**
 * Re-run every verified question on today's model and data. "same" = the
 * answer still matches what was verified; "changed" = it runs but the answer
 * differs (new data, or a definition changed: look at which); "error" = the
 * plan no longer compiles or runs against the model — a regression.
 */
export const ontologyRunEval = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token, id }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; same: number; changed: number; errors: number; total: number } | Fail
    > => {
      const ctx = await ctxFor(data.access_token, data.id, "own");
      if (isFail(ctx)) return ctx;
      const { data: rows } = await supabaseAdmin
        .from("ontology_questions")
        .select("id, question, query, expected")
        .eq("ontology_id", data.id)
        .limit(500);
      let same = 0;
      let changed = 0;
      let errors = 0;
      for (const q of rows ?? []) {
        const ranAt = new Date().toISOString();
        let result: VerifiedQuestion["last_result"];
        const plan = askPlanSchema.safeParse(q.query);
        if (!plan.success || plan.data.kind === "refuse") {
          result = { status: "error", error: "The stored plan is no longer valid", ran_at: ranAt };
        } else {
          try {
            const ans = await runPlan(ctx.userId, ctx.a, ctx.opts, plan.data, {
              verified: null,
              model: null,
            });
            const d = answerDigest(ans.rows);
            const exp = q.expected as { hash?: string } | null;
            result = {
              status: exp?.hash === d.hash ? "same" : "changed",
              rows: d.rows,
              ran_at: ranAt,
            };
          } catch (e) {
            result = { status: "error", error: (e as Error).message.slice(0, 500), ran_at: ranAt };
          }
        }
        if (result.status === "same") same++;
        else if (result.status === "changed") changed++;
        else errors++;
        await supabaseAdmin
          .from("ontology_questions")
          .update({ last_result: result as unknown as Json })
          .eq("id", q.id);
      }
      auditEvent({
        userId: ctx.userId,
        action: "ontology.eval.run",
        resourceType: "ontology",
        resourceId: data.id,
        resourceName: ctx.a.row.name,
        detail: { same, changed, errors, total: rows?.length ?? 0 },
      });
      return { ok: true, same, changed, errors, total: rows?.length ?? 0 };
    },
  );
