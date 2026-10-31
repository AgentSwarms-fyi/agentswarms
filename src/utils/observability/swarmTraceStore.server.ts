// The writes behind an in-page (canvas) swarm run: the only path by which a
// browser's run reaches swarm_runs / swarm_run_steps / swarm_run_edges.
//
// R421 (VA-2026-10-25-31): the tables were `FOR ALL` to their owner, and the
// canvas tracer wrote them from the browser, so a user could delete a run,
// zero its cost or rewrite its steps over PostgREST whenever they liked. Now a
// client may only read them (migration 20261103000000), and every write here
// runs as the service role after checking, every time, that:
//
//   - the caller owns the run (and the step, for a step write);
//   - the run is still running: nothing is added to a finished run;
//   - a step is finished once: a finished step is never rewritten;
//   - a run's totals are summed here from its steps, never taken from the
//     caller, and a run closes once.
//
// What stays the caller's word is what an in-page run measures itself while
// it runs (a step's tokens, cost and latency): the agent turns run in the
// browser. The cost a budget is held to is execution_traces, written by the
// server for each model call (R383).
//
// Bodies (inputs, outputs, thinking, edge previews) pass the
// PERSIST_PROMPT_BODIES gate here; written from the browser they never did
// (VA-2026-10-25-47). swarmTrace.functions.ts is the authenticated wrapper.
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { bodyJson, bodyText } from "@/utils/observability/redaction.server";

const asJson = (v: unknown) => v as Json;

/** Step states a finish may still move on from; every other state is final. */
export const OPEN_STEP = ["running", "awaiting_approval"];

/** The caller's run, if it is theirs; `running` says whether it may still be written. */
async function ownRun(userId: string, runId: string) {
  const { data, error } = await supabaseAdmin
    .from("swarm_runs")
    .select("id, user_id, status")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the run: ${error.message}`);
  if (!data || data.user_id !== userId) throw new Error("Run not found");
  return { ...data, running: data.status === "running" };
}

export const startRunSchema = z.object({
  swarmId: z.string().uuid().nullable().optional(),
  swarmName: z.string().max(500).optional(),
  inputPrompt: z.string().optional(),
  swarmSnapshot: z.any().optional(),
});

export async function startRun(userId: string, data: z.infer<typeof startRunSchema>) {
  const { data: row, error } = await supabaseAdmin
    .from("swarm_runs")
    .insert({
      user_id: userId,
      swarm_id: data.swarmId ?? null,
      swarm_name: data.swarmName ?? null,
      input_prompt: bodyText(data.inputPrompt ?? null),
      swarm_snapshot: asJson(data.swarmSnapshot ?? {}),
      status: "running",
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "Could not start the run");
  return { runId: row.id };
}

export const startStepSchema = z.object({
  runId: z.string().uuid(),
  nodeId: z.string().min(1).max(200),
  nodeLabel: z.string().max(500).optional(),
  nodeKind: z.string().max(60).optional(),
  agentId: z.string().uuid().nullable().optional(),
  input: z.any().optional(),
});

export async function startStep(userId: string, data: z.infer<typeof startStepSchema>) {
  const run = await ownRun(userId, data.runId);
  if (!run.running) throw new Error("The run has finished");
  const { data: row, error } = await supabaseAdmin
    .from("swarm_run_steps")
    .insert({
      run_id: data.runId,
      user_id: userId,
      node_id: data.nodeId,
      node_label: data.nodeLabel ?? null,
      node_kind: data.nodeKind ?? "agent",
      agent_id: data.agentId ?? null,
      input: asJson(bodyJson(data.input ?? {})),
      status: "running",
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "Could not start the step");
  return { stepId: row.id };
}

export const finishStepSchema = z.object({
  stepId: z.string().uuid(),
  status: z.enum(["success", "error", "skipped", "awaiting_approval"]),
  output: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  toolCalls: z.array(z.any()).optional(),
  memoryUsed: z.array(z.any()).optional(),
  ragChunks: z.array(z.any()).optional(),
  dataExtractions: z.array(z.any()).optional(),
  llmProvider: z.string().max(100).optional(),
  llmModel: z.string().max(300).optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  errorMessage: z.string().nullable().optional(),
});

export async function finishStep(userId: string, data: z.infer<typeof finishStepSchema>) {
  // Only a step not yet in a final state, in a run of the caller's that has
  // not closed as a success or an error: a step is finished once. Waiting on
  // an approval is not final; the step finishes when the node does. A
  // cancelled run still lets its in-flight steps say how they ended.
  const { data: step, error: readErr } = await supabaseAdmin
    .from("swarm_run_steps")
    .select("id, user_id, status, run_id")
    .eq("id", data.stepId)
    .maybeSingle();
  if (readErr) throw new Error(`Could not read the step: ${readErr.message}`);
  if (!step || step.user_id !== userId) throw new Error("Step not found");
  const run = await ownRun(userId, step.run_id);
  if (!run.running && run.status !== "cancelled") throw new Error("The run has finished");
  const { data: updated, error } = await supabaseAdmin
    .from("swarm_run_steps")
    .update({
      status: data.status,
      output: bodyText(data.output ?? null),
      thinking: bodyText(data.thinking ?? null),
      tool_calls: asJson(data.toolCalls ?? []),
      memory_used: asJson(data.memoryUsed ?? []),
      rag_chunks: asJson(data.ragChunks ?? []),
      data_extractions: asJson(data.dataExtractions ?? []),
      llm_provider: data.llmProvider ?? null,
      llm_model: data.llmModel ?? null,
      tokens_in: data.tokensIn ?? 0,
      tokens_out: data.tokensOut ?? 0,
      cost_usd: data.costUsd ?? 0,
      latency_ms: data.latencyMs ?? 0,
      error_message: data.errorMessage ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", data.stepId)
    // The rule itself, in the write: a step that reached a final state, even
    // one that got there after the read above, is not touched.
    .in("status", OPEN_STEP)
    .select("id");
  if (error) throw new Error(error.message);
  if (!updated?.length) throw new Error("The step has already finished");
  return { ok: true };
}

export const recordEdgeSchema = z.object({
  runId: z.string().uuid(),
  sourceStepId: z.string().uuid().nullable().optional(),
  targetStepId: z.string().uuid().nullable().optional(),
  sourceNodeId: z.string().min(1).max(200),
  targetNodeId: z.string().min(1).max(200),
  payloadPreview: z.string().max(2000).optional(),
  bytes: z.number().int().nonnegative().optional(),
});

export async function recordEdge(userId: string, data: z.infer<typeof recordEdgeSchema>) {
  const run = await ownRun(userId, data.runId);
  if (!run.running) throw new Error("The run has finished");
  const { error } = await supabaseAdmin.from("swarm_run_edges").insert({
    run_id: data.runId,
    user_id: userId,
    source_step_id: data.sourceStepId ?? null,
    target_step_id: data.targetStepId ?? null,
    source_node_id: data.sourceNodeId,
    target_node_id: data.targetNodeId,
    payload_preview: bodyText(data.payloadPreview ?? null),
    bytes: data.bytes ?? 0,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export const finishRunSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["success", "error", "cancelled"]),
  finalOutput: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});

/** The run's totals, summed from its own steps here, never taken from a caller. */
async function runTotals(runId: string) {
  const { data: steps, error } = await supabaseAdmin
    .from("swarm_run_steps")
    .select("latency_ms, tokens_in, tokens_out, cost_usd, status")
    .eq("run_id", runId);
  if (error) throw new Error(`Could not read the run's steps: ${error.message}`);
  const t = (steps ?? []).reduce(
    (acc, s) => {
      acc.lat += s.latency_ms ?? 0;
      acc.tin += s.tokens_in ?? 0;
      acc.tout += s.tokens_out ?? 0;
      acc.cost += Number(s.cost_usd ?? 0);
      acc.count += 1;
      if (s.status === "error") acc.errors += 1;
      return acc;
    },
    { lat: 0, tin: 0, tout: 0, cost: 0, count: 0, errors: 0 },
  );
  return {
    total_latency_ms: t.lat,
    total_tokens_in: t.tin,
    total_tokens_out: t.tout,
    total_cost_usd: t.cost,
    step_count: t.count,
    error_count: t.errors,
  };
}

export async function finishRun(userId: string, data: z.infer<typeof finishRunSchema>) {
  const run = await ownRun(userId, data.runId);
  const numbers = await runTotals(data.runId);
  // The close lands only on a run still running (R309). A run cancelled
  // meanwhile (another tab, Recent runs) keeps "cancelled" and still gets the
  // numbers its steps spent; a run already closed is left as it is.
  if (run.running) {
    const { data: closed, error } = await supabaseAdmin
      .from("swarm_runs")
      .update({
        status: data.status,
        final_output: bodyText(data.finalOutput ?? null),
        error_message: data.errorMessage ?? null,
        finished_at: new Date().toISOString(),
        ...numbers,
      })
      .eq("id", data.runId)
      .eq("status", "running")
      .select("id");
    if (error) throw new Error(error.message);
    if (closed?.length) return { ok: true, closed: true };
  }
  const { error } = await supabaseAdmin
    .from("swarm_runs")
    .update(numbers)
    .eq("id", data.runId)
    .eq("status", "cancelled");
  if (error) throw new Error(error.message);
  return { ok: true, closed: false };
}

export const cancelRunSchema = z.object({ runId: z.string().uuid() });

/**
 * Cancel one of the caller's runs that is still running: flag it for the tab
 * that owns it (its cancel watch polls `cancel_requested`) and mark it
 * cancelled. A run that already ended is left alone, so a late click cannot
 * turn a success into a cancellation.
 */
export async function cancelRun(userId: string, data: z.infer<typeof cancelRunSchema>) {
  await ownRun(userId, data.runId);
  const { data: ended, error } = await supabaseAdmin
    .from("swarm_runs")
    .update({
      cancel_requested: true,
      status: "cancelled",
      finished_at: new Date().toISOString(),
    })
    .eq("id", data.runId)
    .eq("user_id", userId)
    .eq("status", "running")
    .select("id");
  if (error) throw new Error(error.message);
  return { cancelled: (ended?.length ?? 0) > 0 };
}
