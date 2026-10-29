// Asking an ontology a question: the one implementation.
//
// Used by the Ask tab and by the `ontology` agent tool, so a question asked in
// Agent Chat is answered exactly as it is on the page. The steps:
//
//   1. A VERIFIED question that matches closely enough answers without a
//      model call (the owner checked that plan's answer once; it is reused,
//      re-run on today's data, and labelled verified).
//   2. Otherwise the model reads the catalog (hidden properties left out) and
//      returns a plan; the plan is compiled. If the plan names something the
//      model does not have, the compile error goes back to the model ONCE.
//   3. The compiled SQL runs through the governed lakehouse path as the
//      asker, and the answer carries a TRUST ENVELOPE: which types, links and
//      metric it used and whether the metric is certified, which tables it
//      read, which share restrictions applied, open rule violations on those
//      types from the last run, and whether the answer was verified.
//
// The model call goes through llmJsonServer: the asker's own provider
// credentials, their IAM model rules, the budget gate, and a trace under
// "Ontology: Ask" with its cost.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { llmJsonServer } from "@/utils/bi/llmJson.server";
import { runCount, runRows, type ObjectRow } from "@/utils/ontology/run.server";
import type { OntologyAccess } from "@/utils/ontology/access.server";
import {
  aiCatalog,
  askPlanSchema,
  askSystemPrompt,
  examplePlans,
  parseAskPlan,
  questionSimilarity,
  tidyPlan,
  type AskPlan,
} from "@/lib/ontology/catalog";
import {
  compileMetric,
  compileObjectSet,
  impliedRules,
  resolveStep,
  type ColumnMeta,
  type CompileOpts,
  type GroupBy,
  type PathStep,
} from "@/lib/ontology/compile";
import { describeOntologyPolicy } from "@/lib/ontology/policy";
import { findObjectType, type ObjectType, type OntologySpec } from "@/lib/ontology/spec";

export type TrustEnvelope = {
  /** Always the ontology: there is no free-form SQL fallback. */
  path: "ontology";
  /** null = the owner's draft (revision), else the published version asked. */
  version: number | null;
  revision: number;
  objectTypes: string[];
  links: string[];
  metric: { name: string; label: string; certified: boolean; expression: string } | null;
  tables: string[];
  /** The asker's share restrictions that applied, in words. */
  restrictions: string[];
  /** Open rule violations on the types the answer used, from the last rule run. */
  openViolations: { rule: string; objectType: string; violations: number; severity: string }[];
  lastRuleRunAt: string | null;
  verified: { questionId: string; question: string } | null;
  model: string | null;
  rows: number;
  truncated: boolean;
};

export type AskAnswer = {
  ok: true;
  kind: "objects" | "metric";
  explanation: string;
  plan: AskPlan;
  columns: ColumnMeta[];
  rows: ObjectRow[];
  total: number | null;
  sql: string;
  trust: TrustEnvelope;
};

export type AskRefusal = {
  ok: true;
  kind: "refuse";
  reason: string;
  trust: null;
  /** The model that refused, or failed to plan; absent when none was asked. */
  model?: string | null;
};

const VERIFIED_MATCH = 0.82;

function typesAndLinks(spec: OntologySpec, start: string, paths: PathStep[][]) {
  const types = new Set<string>([start]);
  const links = new Set<string>();
  const t0 = findObjectType(spec, start);
  for (const path of paths) {
    let at: ObjectType | undefined = t0;
    for (const step of path) {
      if (!at) break;
      try {
        const { link, next } = resolveStep(spec, at, step);
        links.add(`${link.from}.${link.name}`);
        types.add(next.name);
        at = next;
      } catch {
        break;
      }
    }
  }
  return { types: [...types], links: [...links] };
}

async function lastRun(spec: OntologySpec, ontologyId: string, types: string[]) {
  const { data } = await supabaseAdmin
    .from("ontology_rule_runs")
    .select("finished_at, results")
    .eq("ontology_id", ontologyId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return { at: null, open: [] as TrustEnvelope["openViolations"] };
  const wanted = new Set(types.map((t) => t.toLowerCase()));
  const results =
    (data.results as unknown as {
      id?: string;
      name: string;
      objectType: string;
      violations: number | null;
      severity: string;
    }[]) ?? [];
  // A rule is named as the model names it now (its wording may have changed
  // since the run); the stored name stands in for a rule since removed.
  const current = new Map([...spec.rules, ...impliedRules(spec)].map((r) => [r.id, r.name]));
  return {
    at: data.finished_at,
    open: results
      .filter((r) => wanted.has(r.objectType.toLowerCase()) && (r.violations ?? 0) > 0)
      .map((r) => ({
        rule: (r.id && current.get(r.id)) || r.name,
        objectType: r.objectType,
        violations: r.violations ?? 0,
        severity: r.severity,
      }))
      .slice(0, 10),
  };
}

/** Run a plan (already validated) and build its trust envelope. */
export async function runPlan(
  userId: string,
  access: OntologyAccess,
  opts: CompileOpts,
  plan: Exclude<AskPlan, { kind: "refuse" }>,
  extra: { verified: TrustEnvelope["verified"]; model: string | null },
): Promise<AskAnswer> {
  const { spec } = access;
  const rowCap = Math.min(opts.maxRows ?? 5000, 1000);
  let columns: ColumnMeta[];
  let rows: ObjectRow[];
  let total: number | null = null;
  let sql: string;
  let truncated = false;
  let start: string;
  let paths: PathStep[][];
  let metric: TrustEnvelope["metric"] = null;
  if (plan.kind === "objects") {
    const c = compileObjectSet(spec, { ...plan.query, limit: plan.query.limit ?? 50 }, opts);
    const [r, n] = await Promise.all([
      runRows(userId, c.sql, c.columns, { rowCap, via: "ontology:ask" }),
      c.countSql ? runCount(userId, c.countSql, "ontology:ask") : Promise.resolve(null),
    ]);
    ({ rows, truncated } = r);
    columns = c.columns;
    total = n;
    sql = c.sql;
    start = plan.query.objectType;
    paths = [plan.query.path ?? []];
  } else {
    const c = compileMetric(spec, plan.query, opts);
    const r = await runRows(userId, c.sql, c.columns, { rowCap, via: "ontology:ask" });
    ({ rows, truncated } = r);
    columns = c.columns;
    sql = c.sql;
    start = plan.query.objectType;
    paths = (plan.query.groupBy ?? []).map((g: GroupBy) => g.path ?? []);
    const t = findObjectType(spec, start);
    const m = t?.metrics.find((x) => x.name === plan.query.metric);
    if (m)
      metric = {
        name: m.name,
        label: m.label ?? m.name,
        certified: !!m.certified,
        expression: m.expression,
      };
  }
  const { types, links } = typesAndLinks(spec, start, paths);
  const run = await lastRun(spec, access.row.id, types);
  return {
    ok: true,
    kind: plan.kind,
    explanation: plan.explanation,
    plan,
    columns,
    rows,
    total,
    sql,
    trust: {
      path: "ontology",
      version: access.version,
      revision: access.row.revision,
      objectTypes: types,
      links,
      metric,
      tables: [
        ...new Set(
          types.map((n) => findObjectType(spec, n)?.source?.table).filter((x): x is string => !!x),
        ),
      ],
      restrictions: access.policy ? describeOntologyPolicy(access.policy) : [],
      openViolations: run.open,
      lastRuleRunAt: run.at,
      verified: extra.verified,
      model: extra.model,
      rows: rows.length,
      truncated,
    },
  };
}

export async function askOntology(args: {
  userId: string;
  access: OntologyAccess;
  opts: CompileOpts;
  question: string;
  provider?: string;
  model?: string;
  surface?: string;
}): Promise<AskAnswer | AskRefusal | { ok: false; error: string }> {
  const { userId, access, opts, question } = args;

  // 1. A verified question answers without a model call.
  const { data: verified } = await supabaseAdmin
    .from("ontology_questions")
    .select("id, question, query")
    .eq("ontology_id", access.row.id)
    .limit(500);
  const best = (verified ?? [])
    .map((v) => ({ v, score: questionSimilarity(v.question, question) }))
    .sort((a, b) => b.score - a.score)[0];
  if (best && best.score >= VERIFIED_MATCH) {
    const parsed = askPlanSchema.safeParse(best.v.query);
    if (parsed.success && parsed.data.kind !== "refuse") {
      try {
        return await runPlan(userId, access, opts, parsed.data, {
          verified: { questionId: best.v.id, question: best.v.question },
          model: null,
        });
      } catch {
        // The verified plan no longer compiles against this model (a property
        // was renamed): fall through to planning it afresh.
      }
    }
  }

  // 2. Plan with the model, once more if the plan does not compile.
  const system = askSystemPrompt(
    aiCatalog(access.spec, opts),
    new Date().toISOString().slice(0, 10),
    examplePlans(access.spec, opts),
  );
  let prompt = `QUESTION: ${question}`;
  let model: string | null = args.model ?? null;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llmJsonServer({
      userId,
      iamClient: supabaseAdmin as unknown as Parameters<typeof llmJsonServer>[0]["iamClient"],
      systemPrompt: system,
      userPrompt: prompt,
      provider: args.provider,
      model: args.model,
      temperature: 0,
      maxTokens: 1500,
      surface: args.surface ?? "Ontology: Ask",
    });
    if (!res.ok) return { ok: false, error: res.error };
    // The model that actually planned it, even when the asker left the choice
    // to the server default.
    model = res.model ?? model;
    const parsed = parseAskPlan(res.result);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problem = `${issue?.path.join(".") || "the plan"}: ${issue?.message ?? "not a plan"}`;
      prompt = `QUESTION: ${question}\n\nYour previous answer was not a valid plan (${problem}). Return one valid JSON object.`;
      continue;
    }
    const plan = tidyPlan(access.spec, parsed.data);
    if (plan.kind === "refuse")
      return { ok: true, kind: "refuse", reason: plan.reason, trust: null, model };
    try {
      return await runPlan(userId, access, opts, plan, { verified: null, model });
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt === 1) {
        return {
          ok: true,
          kind: "refuse",
          reason: `The ontology could not answer that as planned: ${msg}`,
          trust: null,
          model,
        };
      }
      prompt = `QUESTION: ${question}\n\nYour plan ${JSON.stringify(plan)} failed: ${msg}\nFix the plan using only catalog names, or refuse if the ontology cannot answer.`;
    }
  }
  // Say what was wrong: "no valid plan" alone reads as the ontology lacking
  // something, when it is usually the model not following the shape.
  return {
    ok: true,
    kind: "refuse",
    reason: `The model did not return a usable plan, twice (last: ${problem}). A stronger model may answer it.`,
    trust: null,
    model,
  };
}

/** A digest of an answer, to tell later whether a verified question still returns the same. */
export function answerDigest(rows: ObjectRow[]): { rows: number; hash: string } {
  const text = JSON.stringify(rows.slice(0, 200));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return { rows: rows.length, hash: h.toString(16).padStart(8, "0") };
}
