// Server-side swarm tracer — the headless counterpart to the browser tracer in
// observability/tracer.ts. Writes the same swarm_runs / swarm_run_steps /
// swarm_run_edges rows so deployed-API and scheduled runs get the same per-node
// observability timeline as canvas runs. Uses the service-role client and an
// explicit owner id (no browser session), and stamps user_id on every row so
// RLS scopes the run to its owner on read.
//
// Everything is best-effort and awaited sequentially (the server executor runs
// nodes sequentially): a tracing failure never breaks a run.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { bodyJson, bodyText } from "@/utils/observability/redaction.server";

type FinishStepArgs = {
  status: "success" | "error" | "skipped";
  output?: string | null;
  errorMessage?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number;
};

export type ServerSwarmTracer = {
  runId: string;
  startStep(args: {
    nodeId: string;
    nodeLabel?: string;
    nodeKind?: string;
    agentId?: string | null;
    input?: unknown;
  }): Promise<void>;
  finishStep(nodeId: string, args: FinishStepArgs): Promise<void>;
  recordEdge(args: {
    sourceNodeId: string;
    targetNodeId: string;
    payloadPreview?: string;
    bytes?: number;
  }): Promise<void>;
  finish(args: {
    status: "success" | "error" | "cancelled";
    finalOutput?: string | null;
    errorMessage?: string | null;
  }): Promise<void>;
};

export async function createServerSwarmTracer(opts: {
  userId: string;
  swarmId?: string | null;
  swarmName?: string;
  inputPrompt?: string;
  swarmSnapshot?: unknown;
}): Promise<ServerSwarmTracer | null> {
  try {
    const { data: runRow, error } = await supabaseAdmin
      .from("swarm_runs")
      .insert({
        user_id: opts.userId,
        swarm_id: opts.swarmId ?? null,
        swarm_name: opts.swarmName ?? null,
        input_prompt: bodyText(opts.inputPrompt ?? null),
        swarm_snapshot: (opts.swarmSnapshot ?? {}) as never,
        status: "running",
      } as never)
      .select("id")
      .single();
    if (error || !runRow?.id) return null;
    const runId = (runRow as { id: string }).id;

    const stepIdByNode = new Map<string, string>();
    const totals = { lat: 0, tin: 0, tout: 0, cost: 0, count: 0, errors: 0 };

    return {
      runId,
      async startStep(args) {
        try {
          const { data } = await supabaseAdmin
            .from("swarm_run_steps")
            .insert({
              run_id: runId,
              user_id: opts.userId,
              node_id: args.nodeId,
              node_label: args.nodeLabel ?? null,
              node_kind: args.nodeKind ?? "agent",
              agent_id: args.agentId ?? null,
              input: bodyJson(args.input ?? {}) as never,
              status: "running",
            } as never)
            .select("id")
            .single();
          if (data?.id) stepIdByNode.set(args.nodeId, (data as { id: string }).id);
        } catch {
          /* best-effort */
        }
      },
      async finishStep(nodeId, args) {
        totals.lat += args.latencyMs ?? 0;
        totals.tin += args.tokensIn ?? 0;
        totals.tout += args.tokensOut ?? 0;
        totals.cost += args.costUsd ?? 0;
        totals.count += 1;
        if (args.status === "error") totals.errors += 1;
        const stepId = stepIdByNode.get(nodeId);
        if (!stepId) return;
        try {
          await supabaseAdmin
            .from("swarm_run_steps")
            .update({
              status: args.status,
              output: bodyText(args.output ?? null),
              error_message: args.errorMessage ?? null,
              llm_model: args.llmModel ?? null,
              llm_provider: args.llmProvider ?? null,
              tokens_in: args.tokensIn ?? 0,
              tokens_out: args.tokensOut ?? 0,
              cost_usd: args.costUsd ?? 0,
              latency_ms: args.latencyMs ?? 0,
              finished_at: new Date().toISOString(),
            } as never)
            .eq("id", stepId);
        } catch {
          /* best-effort */
        }
      },
      async recordEdge(args) {
        try {
          await supabaseAdmin.from("swarm_run_edges").insert({
            run_id: runId,
            user_id: opts.userId,
            source_step_id: stepIdByNode.get(args.sourceNodeId) ?? null,
            target_step_id: stepIdByNode.get(args.targetNodeId) ?? null,
            source_node_id: args.sourceNodeId,
            target_node_id: args.targetNodeId,
            payload_preview: args.payloadPreview ?? null,
            bytes: args.bytes ?? 0,
          } as never);
        } catch {
          /* best-effort */
        }
      },
      async finish(args) {
        try {
          await supabaseAdmin
            .from("swarm_runs")
            .update({
              status: args.status,
              final_output: bodyText(args.finalOutput ?? null),
              error_message: args.errorMessage ?? null,
              finished_at: new Date().toISOString(),
              total_latency_ms: totals.lat,
              total_tokens_in: totals.tin,
              total_tokens_out: totals.tout,
              total_cost_usd: totals.cost,
              step_count: totals.count,
              error_count: totals.errors,
            } as never)
            .eq("id", runId);
        } catch {
          /* best-effort */
        }
      },
    };
  } catch {
    return null;
  }
}
