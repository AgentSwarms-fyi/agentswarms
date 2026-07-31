// Fire-and-forget tracer that writes swarm observability rows with the
// browser's signed-in session, so RLS scopes every run to its owner.
// Keeps a local map of nodeId -> stepId for the current run so edges and
// step finishers can resolve without round-tripping IDs.
import { supabase } from "@/integrations/supabase/client";

export type SwarmTracer = {
  runId: string;
  startStep(args: {
    nodeId: string;
    nodeLabel?: string;
    nodeKind?: string;
    agentId?: string | null;
    input?: unknown;
  }): void;
  finishStep(
    nodeId: string,
    args: {
      status: "success" | "error" | "skipped" | "awaiting_approval";
      output?: string | null;
      thinking?: string | null;
      toolCalls?: unknown[];
      memoryUsed?: unknown[];
      ragChunks?: unknown[];
      dataExtractions?: unknown[];
      llmProvider?: string;
      llmModel?: string;
      tokensIn?: number;
      tokensOut?: number;
      costUsd?: number;
      latencyMs?: number;
      errorMessage?: string | null;
    },
  ): void;
  recordEdge(args: {
    sourceNodeId: string;
    targetNodeId: string;
    payloadPreview?: string;
    bytes?: number;
  }): void;
  finish(args: {
    status: "success" | "error" | "cancelled";
    finalOutput?: string | null;
    errorMessage?: string | null;
  }): Promise<void>;
};

const noop = () => {};

const jsonValue = (value: unknown) => value as any;

export async function createSwarmTracer(opts: {
  swarmId?: string | null;
  swarmName?: string;
  inputPrompt?: string;
  swarmSnapshot?: unknown;
}): Promise<SwarmTracer | null> {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return null;

    const { data: runRow, error: runError } = await supabase
      .from("swarm_runs")
      .insert({
        user_id: userId,
        swarm_id: opts.swarmId ?? null,
        swarm_name: opts.swarmName ?? null,
        input_prompt: opts.inputPrompt ?? null,
        swarm_snapshot: jsonValue(opts.swarmSnapshot ?? {}),
        status: "running",
      } as any)
      .select("id")
      .single();
    if (runError || !runRow?.id)
      throw new Error(runError?.message ?? "Could not start swarm trace");

    const runId = runRow.id;

    const stepIdByNode = new Map<string, string>();
    const startedAtByNode = new Map<string, number>();
    const pendingStarts = new Map<string, Promise<void>>();
    const pendingWrites = new Set<Promise<void>>();

    const track = (promise: PromiseLike<unknown>) => {
      const p = Promise.resolve(promise)
        .then(() => undefined)
        .catch(noop)
        .finally(() => pendingWrites.delete(p));
      pendingWrites.add(p);
      return p;
    };

    const tracer: SwarmTracer = {
      runId,
      startStep(args) {
        startedAtByNode.set(args.nodeId, Date.now());
        const p = track(
          supabase
            .from("swarm_run_steps")
            .insert({
              run_id: runId,
              user_id: userId,
              node_id: args.nodeId,
              node_label: args.nodeLabel ?? null,
              node_kind: args.nodeKind ?? "agent",
              agent_id: args.agentId ?? null,
              input: jsonValue(args.input ?? {}),
              status: "running",
            } as any)
            .select("id")
            .single()
            .then(({ data, error }) => {
              if (error || !data?.id)
                throw new Error(error?.message ?? "Could not start swarm step");
              stepIdByNode.set(args.nodeId, data.id);
            }),
        );
        pendingStarts.set(args.nodeId, p);
      },
      finishStep(nodeId, args) {
        const start = pendingStarts.get(nodeId) ?? Promise.resolve();
        const startedAt = startedAtByNode.get(nodeId);
        const latencyMs = args.latencyMs ?? (startedAt ? Date.now() - startedAt : 0);
        track(
          start.then(() => {
            const stepId = stepIdByNode.get(nodeId);
            if (!stepId) return;
            return supabase
              .from("swarm_run_steps")
              .update({
                status: args.status,
                output: args.output ?? null,
                thinking: args.thinking ?? null,
                tool_calls: jsonValue(args.toolCalls ?? []),
                memory_used: jsonValue(args.memoryUsed ?? []),
                rag_chunks: jsonValue(args.ragChunks ?? []),
                data_extractions: jsonValue(args.dataExtractions ?? []),
                llm_provider: args.llmProvider ?? null,
                llm_model: args.llmModel ?? null,
                tokens_in: args.tokensIn ?? 0,
                tokens_out: args.tokensOut ?? 0,
                cost_usd: args.costUsd ?? 0,
                latency_ms: latencyMs,
                error_message: args.errorMessage ?? null,
                finished_at: new Date().toISOString(),
              } as any)
              .eq("id", stepId)
              .eq("user_id", userId);
          }),
        );
      },
      recordEdge(args) {
        const sourceP = pendingStarts.get(args.sourceNodeId) ?? Promise.resolve();
        const targetP = pendingStarts.get(args.targetNodeId) ?? Promise.resolve();
        track(
          Promise.all([sourceP, targetP]).then(() =>
            supabase.from("swarm_run_edges").insert({
              run_id: runId,
              user_id: userId,
              source_step_id: stepIdByNode.get(args.sourceNodeId) ?? null,
              target_step_id: stepIdByNode.get(args.targetNodeId) ?? null,
              source_node_id: args.sourceNodeId,
              target_node_id: args.targetNodeId,
              payload_preview: args.payloadPreview ?? null,
              bytes: args.bytes ?? 0,
            } as any),
          ),
        );
      },
      async finish(args) {
        // Wait for all pending starts/finishes to flush.
        await Promise.allSettled(Array.from(pendingStarts.values()));
        await Promise.allSettled(Array.from(pendingWrites));
        try {
          const { data: steps } = await supabase
            .from("swarm_run_steps")
            .select("latency_ms, tokens_in, tokens_out, cost_usd, status")
            .eq("run_id", runId)
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
          await supabase
            .from("swarm_runs")
            .update({
              status: args.status,
              final_output: args.finalOutput ?? null,
              error_message: args.errorMessage ?? null,
              finished_at: new Date().toISOString(),
              total_latency_ms: totals.lat,
              total_tokens_in: totals.tin,
              total_tokens_out: totals.tout,
              total_cost_usd: totals.cost,
              step_count: totals.count,
              error_count: totals.errors,
            } as any)
            .eq("id", runId)
            .eq("user_id", userId);
        } catch {
          // ignore
        }
      },
    };

    return tracer;
  } catch (error) {
    console.warn("Swarm trace capture failed", error);
    return null;
  }
}
