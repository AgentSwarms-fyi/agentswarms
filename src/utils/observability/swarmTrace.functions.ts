// Server functions to record swarm execution traces.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { bodyJson, bodyText } from "@/utils/observability/redaction.server";

const startRunSchema = z.object({
  swarmId: z.string().uuid().nullable().optional(),
  swarmName: z.string().optional(),
  inputPrompt: z.string().optional(),
  swarmSnapshot: z.any().optional(),
});

export const startSwarmRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => startRunSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("swarm_runs")
      .insert({
        user_id: userId,
        swarm_id: data.swarmId ?? null,
        swarm_name: data.swarmName ?? null,
        input_prompt: bodyText(data.inputPrompt ?? null),
        swarm_snapshot: data.swarmSnapshot ?? {},
        status: "running",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { runId: row.id as string };
  });

const startStepSchema = z.object({
  runId: z.string().uuid(),
  nodeId: z.string(),
  nodeLabel: z.string().optional(),
  nodeKind: z.string().optional(),
  agentId: z.string().uuid().nullable().optional(),
  parentStepId: z.string().uuid().nullable().optional(),
  input: z.any().optional(),
});

export const startSwarmStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => startStepSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("swarm_run_steps")
      .insert({
        run_id: data.runId,
        user_id: userId,
        node_id: data.nodeId,
        node_label: data.nodeLabel ?? null,
        node_kind: data.nodeKind ?? "agent",
        agent_id: data.agentId ?? null,
        parent_step_id: data.parentStepId ?? null,
        input: bodyJson(data.input ?? {}),
        status: "running",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { stepId: row.id as string };
  });

const finishStepSchema = z.object({
  stepId: z.string().uuid(),
  status: z.enum(["success", "error", "skipped", "awaiting_approval"]),
  output: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  toolCalls: z.array(z.any()).optional(),
  memoryUsed: z.array(z.any()).optional(),
  ragChunks: z.array(z.any()).optional(),
  dataExtractions: z.array(z.any()).optional(),
  llmProvider: z.string().optional(),
  llmModel: z.string().optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  errorMessage: z.string().nullable().optional(),
});

export const finishSwarmStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => finishStepSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("swarm_run_steps")
      .update({
        status: data.status,
        output: bodyText(data.output ?? null),
        thinking: bodyText(data.thinking ?? null),
        tool_calls: data.toolCalls ?? [],
        memory_used: data.memoryUsed ?? [],
        rag_chunks: data.ragChunks ?? [],
        data_extractions: data.dataExtractions ?? [],
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
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const recordEdgeSchema = z.object({
  runId: z.string().uuid(),
  sourceStepId: z.string().uuid().nullable().optional(),
  targetStepId: z.string().uuid().nullable().optional(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  payloadPreview: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
});

export const recordSwarmEdge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => recordEdgeSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("swarm_run_edges").insert({
      run_id: data.runId,
      user_id: userId,
      source_step_id: data.sourceStepId ?? null,
      target_step_id: data.targetStepId ?? null,
      source_node_id: data.sourceNodeId,
      target_node_id: data.targetNodeId,
      payload_preview: data.payloadPreview ?? null,
      bytes: data.bytes ?? 0,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const finishRunSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["success", "error", "cancelled"]),
  finalOutput: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});

export const finishSwarmRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => finishRunSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Aggregate step totals.
    const { data: steps } = await supabase
      .from("swarm_run_steps")
      .select("latency_ms, tokens_in, tokens_out, cost_usd, status")
      .eq("run_id", data.runId)
      .eq("user_id", userId);

    const totals = (steps ?? []).reduce(
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

    const { error } = await supabase
      .from("swarm_runs")
      .update({
        status: data.status,
        final_output: bodyText(data.finalOutput ?? null),
        error_message: data.errorMessage ?? null,
        finished_at: new Date().toISOString(),
        total_latency_ms: totals.lat,
        total_tokens_in: totals.tin,
        total_tokens_out: totals.tout,
        total_cost_usd: totals.cost,
        step_count: totals.count,
        error_count: totals.errors,
      })
      .eq("id", data.runId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
