// Batch evaluations — server functions.
//
// CRUD for datasets/cases/runs plus `runEvalCase`, the unit of execution: the
// client drives the batch with a small concurrent loop of runEvalCase calls
// (one per test case), which keeps long batches free of server-side timeouts
// and makes cancel/resume natural. Each call:
//   1. loads the run + case and re-asserts ownership (service role in play),
//   2. refuses when the run is not `running` (server-enforced cancel) or the
//      case already has a result (idempotent resume),
//   3. executes the swarm's saved graph headlessly (executeSwarmServer),
//   4. scores the output — deterministically or via an LLM judge called
//      through this app's own /api/chat with the internal secret,
//   5. writes the eval_results row and folds the outcome into the run's
//      counters, closing the run when the last case lands.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  deterministicVerdict,
  judgeVerdict,
  parseScorecard,
  validateEvaluator,
  type EvalEvaluator,
  type EvalVerdict,
} from "@/lib/evalScoring";
import { executeSwarmServer } from "@/utils/swarmExecute.server";
import { internalRunSecret, resolveInternalOrigin } from "@/utils/internalOrigin.server";

const evaluatorSchema = z.custom<EvalEvaluator>((v) => {
  if (!v || typeof v !== "object" || typeof (v as { kind?: unknown }).kind !== "string")
    return false;
  return validateEvaluator(v as EvalEvaluator) === null;
}, "invalid evaluator config");

// ── Judge call (internal /api/chat, no tools, temperature 0) ────────────────
async function judgeChat(args: {
  userId: string;
  provider?: string;
  model?: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<string> {
  const secret = internalRunSecret();
  if (!secret) throw new Error("Server is missing the internal run secret");
  const res = await fetch(`${resolveInternalOrigin()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-run-secret": secret },
    body: JSON.stringify({
      internalUserId: args.userId,
      provider: args.provider || "openrouter",
      model: args.model || "google/gemini-3-flash-preview",
      systemPrompt: args.systemPrompt,
      temperature: 0,
      maxTokens: 2048,
      messages: [{ role: "user", content: args.userMessage }],
      memoryOverrides: { stm_enabled: false, ltm_enabled: false, ltm_scope: "none" },
    }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`judge call failed [${res.status}]: ${txt.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let event = "message";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        event = "message";
        continue;
      }
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
          error?: { message?: string };
        };
        if (event === "error") throw new Error(j.error?.message || "judge stream error");
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch (e) {
        if (event === "error") throw e;
      }
    }
  }
  return text;
}

function buildJudgePrompt(
  e: Extract<EvalEvaluator, { kind: "llm_judge" }>,
  caseInput: string,
  expected: string | null,
  output: string,
): { system: string; user: string } {
  const metricsBlock = e.metrics
    .map((m) => `- **${m.name}** (id: "${m.id}", weight: ${m.weight}): ${m.description}`)
    .join("\n");
  const rubric = e.rubric?.trim() ? `\n\n## Evaluation Rubric\n${e.rubric.trim()}` : "";
  const system =
    `You are a strict, impartial LLM evaluation judge. Score the CANDIDATE OUTPUT against each metric on a 0.0-1.0 scale.\n\n` +
    `## Metrics\n${metricsBlock}${rubric}\n\n## Output format\nReturn ONLY valid JSON - no fences:\n` +
    `{\n  "metrics": {\n${e.metrics.map((m) => `    "${m.id}": { "score": <0.0-1.0>, "reason": "<why>" }`).join(",\n")}\n  },\n  "summary": "<2-3 sentences>"\n}`;
  const refBlock = expected?.trim() ? `\n\n## Reference / Expected Answer\n${expected.trim()}` : "";
  const user = `## Task Input\n${caseInput}${refBlock}\n\n## Candidate Output\n${output}\n\nReturn the JSON scorecard.`;
  return { system, user };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export const createEvalDataset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({ name: z.string().min(1).max(120), description: z.string().max(2000).optional() })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("eval_datasets")
      .insert({
        user_id: context.userId,
        name: data.name.trim(),
        description: data.description ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

const caseFields = {
  name: z.string().max(200).default(""),
  input: z.string().max(20000).default(""),
  input_state: z.record(z.string(), z.string()).default({}),
  expected: z.string().max(20000).nullable().default(null),
};

export const addEvalCases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        datasetId: z.string().uuid(),
        cases: z.array(z.object(caseFields)).min(1).max(500),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: ds, error: dsErr } = await context.supabase
      .from("eval_datasets")
      .select("id")
      .eq("id", data.datasetId)
      .single();
    if (dsErr || !ds) throw new Error("Dataset not found");
    const { count } = await context.supabase
      .from("eval_cases")
      .select("id", { count: "exact", head: true })
      .eq("dataset_id", data.datasetId);
    const base = count ?? 0;
    const rows = data.cases.map((c, i) => ({
      dataset_id: data.datasetId,
      user_id: context.userId,
      sort: base + i,
      name: c.name.trim(),
      input: c.input,
      input_state: c.input_state,
      expected: c.expected,
    }));
    const { data: inserted, error } = await context.supabase
      .from("eval_cases")
      .insert(rows)
      .select("*");
    if (error) throw new Error(error.message);
    return inserted;
  });

export const updateEvalCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid(), ...caseFields }).parse(i))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("eval_cases")
      .update({
        name: data.name.trim(),
        input: data.input,
        input_state: data.input_state,
        expected: data.expected,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const startEvalRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        swarmId: z.string().uuid(),
        datasetId: z.string().uuid(),
        label: z.string().max(200).default(""),
        evaluator: evaluatorSchema,
        rejectApprovals: z.boolean().default(true),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const [{ data: swarm, error: sErr }, { data: ds, error: dErr }] = await Promise.all([
      context.supabase.from("swarms").select("id, name").eq("id", data.swarmId).single(),
      context.supabase.from("eval_datasets").select("id, name").eq("id", data.datasetId).single(),
    ]);
    if (sErr || !swarm) throw new Error("Swarm not found");
    if (dErr || !ds) throw new Error("Dataset not found");
    const { count } = await context.supabase
      .from("eval_cases")
      .select("id", { count: "exact", head: true })
      .eq("dataset_id", data.datasetId);
    if (!count) throw new Error("The dataset has no cases.");
    // Latest saved version, for attribution across later edits.
    const { data: ver } = await context.supabase
      .from("swarm_versions")
      .select("id")
      .eq("swarm_id", data.swarmId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: run, error } = await context.supabase
      .from("eval_runs")
      .insert({
        user_id: context.userId,
        swarm_id: swarm.id,
        swarm_name: swarm.name,
        swarm_version_id: ver?.id ?? null,
        dataset_id: ds.id,
        dataset_name: ds.name,
        label: data.label.trim(),
        evaluator: data.evaluator,
        reject_approvals: data.rejectApprovals,
        case_count: count,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return run;
  });

export const cancelEvalRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ runId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("eval_runs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", data.runId)
      .eq("status", "running");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── The unit of execution ───────────────────────────────────────────────────

export const runEvalCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ runId: z.string().uuid(), caseId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    // RLS-scoped reads: both must belong to the caller.
    const [{ data: run, error: rErr }, { data: kase, error: cErr }] = await Promise.all([
      context.supabase.from("eval_runs").select("*").eq("id", data.runId).single(),
      context.supabase.from("eval_cases").select("*").eq("id", data.caseId).single(),
    ]);
    if (rErr || !run) throw new Error("Run not found");
    if (cErr || !kase) throw new Error("Case not found");
    if (run.status !== "running") return { skipped: true as const, reason: run.status };
    const { data: existing } = await context.supabase
      .from("eval_results")
      .select("id")
      .eq("eval_run_id", run.id)
      .eq("case_id", kase.id)
      .maybeSingle();
    if (existing) return { skipped: true as const, reason: "already_scored" };

    if (!run.swarm_id) throw new Error("Swarm no longer exists");
    const { data: swarm, error: sErr } = await context.supabase
      .from("swarms")
      .select("id, name, nodes, edges")
      .eq("id", run.swarm_id)
      .single();
    if (sErr || !swarm) throw new Error("Swarm no longer exists");

    const evaluator = run.evaluator as EvalEvaluator;
    const started = Date.now();
    let output = "";
    let verdict: EvalVerdict | null = null;
    let execError: string | null = null;
    let swarmRunId: string | null = null;
    let costUsd = 0;

    try {
      const result = await executeSwarmServer({
        swarm,
        userId,
        origin: resolveInternalOrigin(),
        input: kase.input ?? "",
        initialState: (kase.input_state ?? {}) as Record<string, string>,
        rejectApprovals: run.reject_approvals,
        source: "api",
      });
      swarmRunId = result.runId;
      if (result.status === "success") output = result.output;
      else if (result.status === "suspended")
        execError =
          "Run suspended at an approval node — enable “auto-reject approvals” or remove the gate for evals.";
      else execError = result.error || "swarm run failed";
    } catch (e) {
      execError = (e as Error).message;
    }

    if (swarmRunId) {
      const { data: sr } = await supabaseAdmin
        .from("swarm_runs")
        .select("total_cost_usd, user_id")
        .eq("id", swarmRunId)
        .maybeSingle();
      if (sr && sr.user_id === userId) costUsd = Number(sr.total_cost_usd) || 0;
    }

    if (!execError) {
      try {
        if (evaluator.kind === "llm_judge") {
          const { system, user } = buildJudgePrompt(
            evaluator,
            kase.input ?? "",
            kase.expected,
            output,
          );
          const raw = await judgeChat({
            userId,
            provider: evaluator.provider,
            model: evaluator.model,
            systemPrompt: system,
            userMessage: user,
          });
          const scorecard = parseScorecard(raw, evaluator.metrics);
          verdict = judgeVerdict(evaluator, scorecard);
        } else {
          verdict = deterministicVerdict(evaluator, output, kase.expected);
        }
      } catch (e) {
        execError = `scoring failed: ${(e as Error).message}`;
      }
    }

    const status: "pass" | "fail" | "error" = execError ? "error" : verdict!.status;
    const { error: insErr } = await supabaseAdmin.from("eval_results").insert({
      eval_run_id: run.id,
      case_id: kase.id,
      user_id: userId,
      case_name: kase.name ?? "",
      case_input: kase.input ?? "",
      case_expected: kase.expected,
      status,
      score: verdict?.score ?? null,
      judge: verdict?.scorecard ?? null,
      output,
      error: execError,
      swarm_run_id: swarmRunId,
      duration_ms: Date.now() - started,
      cost_usd: costUsd,
    });
    // A concurrent driver may have scored this case between our check and this
    // insert. The UNIQUE (eval_run_id, case_id) constraint is the real guard —
    // losing that race is a normal outcome, not an error to shout about.
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505")
        return { skipped: true as const, reason: "already_scored" };
      throw new Error(insErr.message);
    }

    // Fold into the run's counters from the results table itself (idempotent
    // even if two drivers race — the UNIQUE constraint already deduped).
    const { data: all } = await supabaseAdmin
      .from("eval_results")
      .select("status, score, cost_usd")
      .eq("eval_run_id", run.id);
    const rows = all ?? [];
    const done = rows.length;
    const scores = rows.map((r) => Number(r.score)).filter((s) => Number.isFinite(s));
    const patch: {
      done_count: number;
      pass_count: number;
      fail_count: number;
      error_count: number;
      avg_score: number | null;
      total_cost_usd: number;
      status?: string;
      finished_at?: string;
    } = {
      done_count: done,
      pass_count: rows.filter((r) => r.status === "pass").length,
      fail_count: rows.filter((r) => r.status === "fail").length,
      error_count: rows.filter((r) => r.status === "error").length,
      avg_score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      total_cost_usd: rows.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0),
    };
    if (done >= run.case_count) {
      patch.status = "done";
      patch.finished_at = new Date().toISOString();
    }
    await supabaseAdmin.from("eval_runs").update(patch).eq("id", run.id).eq("status", "running");

    return { skipped: false as const, status, score: verdict?.score ?? null };
  });
