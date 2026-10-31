// Fire-and-forget tracer for an in-page (canvas) swarm run. It records the run
// through the swarm-trace server functions, which write as the service role
// after checking the run is the caller's and still open: since R421
// (VA-2026-10-25-31) a browser can read its runs but no longer write them, so
// a finished run cannot be deleted, zeroed or rewritten from the page.
// Keeps a local map of nodeId -> stepId for the current run so edges and
// step finishers can resolve without round-tripping IDs.
import {
  finishSwarmRun,
  finishSwarmStep,
  recordSwarmEdge,
  startSwarmRun,
  startSwarmStep,
} from "./swarmTrace.functions";

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

/** A count the schema takes: a whole, non-negative number. */
const count = (n: number | undefined) => Math.max(0, Math.round(Number(n) || 0));

export async function createSwarmTracer(opts: {
  swarmId?: string | null;
  swarmName?: string;
  inputPrompt?: string;
  swarmSnapshot?: unknown;
}): Promise<SwarmTracer | null> {
  try {
    // Signed out, the server function refuses and the run simply goes untraced.
    const { runId } = await startSwarmRun({
      data: {
        swarmId: opts.swarmId ?? null,
        swarmName: opts.swarmName,
        inputPrompt: opts.inputPrompt,
        swarmSnapshot: opts.swarmSnapshot ?? {},
      },
    });

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
          startSwarmStep({
            data: {
              runId,
              nodeId: args.nodeId,
              nodeLabel: args.nodeLabel,
              nodeKind: args.nodeKind ?? "agent",
              agentId: args.agentId ?? null,
              input: args.input ?? {},
            },
          }).then(({ stepId }) => {
            stepIdByNode.set(args.nodeId, stepId);
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
            return finishSwarmStep({
              data: {
                stepId,
                status: args.status,
                output: args.output ?? null,
                thinking: args.thinking ?? null,
                toolCalls: args.toolCalls ?? [],
                memoryUsed: args.memoryUsed ?? [],
                ragChunks: args.ragChunks ?? [],
                dataExtractions: args.dataExtractions ?? [],
                llmProvider: args.llmProvider,
                llmModel: args.llmModel,
                tokensIn: count(args.tokensIn),
                tokensOut: count(args.tokensOut),
                costUsd: Math.max(0, Number(args.costUsd) || 0),
                latencyMs: count(latencyMs),
                errorMessage: args.errorMessage ?? null,
              },
            });
          }),
        );
      },
      recordEdge(args) {
        const sourceP = pendingStarts.get(args.sourceNodeId) ?? Promise.resolve();
        const targetP = pendingStarts.get(args.targetNodeId) ?? Promise.resolve();
        track(
          Promise.all([sourceP, targetP]).then(() =>
            recordSwarmEdge({
              data: {
                runId,
                sourceStepId: stepIdByNode.get(args.sourceNodeId) ?? null,
                targetStepId: stepIdByNode.get(args.targetNodeId) ?? null,
                sourceNodeId: args.sourceNodeId,
                targetNodeId: args.targetNodeId,
                payloadPreview: args.payloadPreview?.slice(0, 2000),
                bytes: count(args.bytes),
              },
            }),
          ),
        );
      },
      async finish(args) {
        // Wait for all pending starts/finishes to flush; the server sums the
        // run's totals from its steps (R309's "a cancelled run keeps
        // cancelled and still gets its numbers" is the server's job now).
        await Promise.allSettled(Array.from(pendingStarts.values()));
        await Promise.allSettled(Array.from(pendingWrites));
        try {
          await finishSwarmRun({
            data: {
              runId,
              status: args.status,
              finalOutput: args.finalOutput ?? null,
              errorMessage: args.errorMessage ?? null,
            },
          });
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
