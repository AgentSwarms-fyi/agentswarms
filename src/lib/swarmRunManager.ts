// Module-level swarm run manager.
//
// The swarm orchestrator (swarmRuntime.runSwarm) is client-only. Historically
// it ran inside the /swarms canvas component, so navigating away (e.g. the
// "Gallery" back button) unmounted the component and orphaned the run — no way
// to watch it, and no way to cancel it.
//
// This singleton lifts run orchestration OUT of any React component. A run
// started here keeps executing across client-side navigation (a SPA route
// change never reloads the page), and every surface — the canvas, the "Recent
// runs" tab — subscribes to the same store to reflect live state and to cancel.
//
// Note: this is still an in-browser runtime. A full page reload (not a back
// button) ends the JS context and therefore the run; such a run's swarm_runs
// row stays "running" in the DB and can be cleared from the Recent runs tab.
import type { Node, Edge } from "@xyflow/react";
import { supabase } from "@/integrations/supabase/client";
import { runSwarm, type SwarmNodeData, type SwarmRunEvent } from "@/lib/swarmRuntime";

export type RunStatus = "running" | "waiting" | "success" | "error" | "cancelled";
export type NodeStatus = NonNullable<SwarmNodeData["status"]>;

// Immutable view handed to React consumers. Rebuilt on every change so
// useSyncExternalStore sees a new reference exactly when something changed.
export type ManagedRunView = {
  runId: string;
  dbRunId: string | null;
  swarmId: string | null;
  swarmName: string;
  input: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  events: SwarmRunEvent[];
  nodeStatus: Record<string, NodeStatus>;
  nodeOutput: Record<string, string>;
  runningNodeIds: string[];
  finalOutput: string | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Latest shared flow-state snapshot (for the variable inspector). */
  state: Record<string, string>;
};

type InternalRun = {
  view: ManagedRunView;
  abort: AbortController;
  runningNodeIds: Set<string>;
  waitingNodeIds: Set<string>;
  cancelWatch: ReturnType<typeof setInterval> | null;
};

const runs = new Map<string, InternalRun>();
const listeners = new Set<() => void>();
let snapshot: ManagedRunView[] = [];

function rebuildSnapshot() {
  // Newest first.
  snapshot = Array.from(runs.values())
    .map((r) => r.view)
    .sort((a, b) => b.startedAt - a.startedAt);
}

function emit() {
  rebuildSnapshot();
  for (const cb of listeners) cb();
}

function localId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Recompute the overall run status from node/step state (unless terminal). */
function deriveStatus(run: InternalRun): RunStatus {
  const s = run.view.status;
  if (s === "success" || s === "error" || s === "cancelled") return s;
  return run.waitingNodeIds.size > 0 ? "waiting" : "running";
}

/** Mutate a run's view immutably and flag the store dirty (caller emits). */
function patch(run: InternalRun, next: Partial<ManagedRunView>) {
  run.view = { ...run.view, ...next };
}

export type StartRunParams = {
  swarmId: string | null;
  swarmName: string;
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
  input: string;
  traceEnabled: boolean;
  /** Extra flow-state seeded from a typed input form. */
  initialState?: Record<string, string>;
};

/**
 * Start a swarm run. Returns the local run id immediately; the run continues
 * in the background regardless of which component is mounted.
 */
export async function startRun(params: StartRunParams): Promise<string> {
  const runId = localId();
  const abort = new AbortController();
  const nodeStatus: Record<string, NodeStatus> = {};
  for (const n of params.nodes) nodeStatus[n.id] = "idle";

  const run: InternalRun = {
    abort,
    runningNodeIds: new Set(),
    waitingNodeIds: new Set(),
    cancelWatch: null,
    view: {
      runId,
      dbRunId: null,
      swarmId: params.swarmId,
      swarmName: params.swarmName,
      input: params.input,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      events: [],
      nodeStatus,
      nodeOutput: {},
      runningNodeIds: [],
      finalOutput: null,
      error: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      state: {},
    },
  };
  runs.set(runId, run);
  emit();

  // Snapshot the graph so later canvas edits can't mutate a live run.
  const nodes = params.nodes.map((n) => ({ ...n, data: { ...n.data } }));
  const edges = params.edges.map((e) => ({ ...e }));

  void (async () => {
    let tracer: import("@/utils/observability/tracer").SwarmTracer | null = null;
    if (params.traceEnabled) {
      try {
        tracer = await (
          await import("@/utils/observability/tracer")
        ).createSwarmTracer({
          swarmId: params.swarmId ?? null,
          swarmName: params.swarmName,
          inputPrompt: params.input,
          swarmSnapshot: { nodes, edges },
        });
      } catch {
        tracer = null;
      }
    }
    if (tracer) {
      patch(run, { dbRunId: tracer.runId });
      emit();
      startCancelWatch(run);
    }

    let runError: string | null = null;
    let finalText = "";

    await runSwarm(nodes, edges, {
      initialInput: params.input,
      signal: abort.signal,
      tracer,
      dbRunId: tracer?.runId,
      initialState: params.initialState,
      onEvent: (e) => {
        applyEvent(run, e);
        if (e.type === "run_done") finalText = e.finalOutput;
        if (e.type === "run_error") runError = e.error;
      },
    });

    const aborted = abort.signal.aborted;
    const status: RunStatus = aborted ? "cancelled" : runError ? "error" : "success";
    patch(run, {
      status,
      finishedAt: Date.now(),
      finalOutput: finalText || run.view.finalOutput,
      error: runError,
      runningNodeIds: [],
    });
    run.runningNodeIds.clear();
    run.waitingNodeIds.clear();
    stopCancelWatch(run);
    emit();

    if (tracer) {
      void tracer.finish({
        status: aborted ? "cancelled" : runError ? "error" : "success",
        finalOutput: finalText || null,
        errorMessage: runError,
      });
    }
  })();

  return runId;
}

function applyEvent(run: InternalRun, e: SwarmRunEvent) {
  const events = run.view.events.concat(e);
  const nodeStatus = { ...run.view.nodeStatus };
  const nodeOutput = { ...run.view.nodeOutput };
  let { tokensIn, tokensOut, costUsd } = run.view;
  let state = run.view.state;

  switch (e.type) {
    case "node_start":
      run.runningNodeIds.add(e.nodeId);
      nodeStatus[e.nodeId] = "running";
      break;
    case "node_done":
      run.runningNodeIds.delete(e.nodeId);
      run.waitingNodeIds.delete(e.nodeId);
      nodeStatus[e.nodeId] = "done";
      nodeOutput[e.nodeId] = e.output;
      break;
    case "node_skipped":
      run.runningNodeIds.delete(e.nodeId);
      nodeStatus[e.nodeId] = "skipped";
      break;
    case "node_error":
      run.runningNodeIds.delete(e.nodeId);
      run.waitingNodeIds.delete(e.nodeId);
      nodeStatus[e.nodeId] = "error";
      break;
    case "approval_pending":
      run.runningNodeIds.add(e.nodeId);
      run.waitingNodeIds.add(e.nodeId);
      nodeStatus[e.nodeId] = "waiting";
      break;
    case "node_usage":
      tokensIn += e.tokensIn;
      tokensOut += e.tokensOut;
      costUsd += e.costUsd;
      break;
    case "state_snapshot":
      state = e.state;
      break;
    case "run_done":
      patch(run, { finalOutput: e.finalOutput });
      break;
    default:
      break;
  }

  patch(run, {
    events,
    nodeStatus,
    nodeOutput,
    runningNodeIds: Array.from(run.runningNodeIds),
    tokensIn,
    tokensOut,
    costUsd,
    state,
  });
  patch(run, { status: deriveStatus(run) });
  emit();
}

// Poll the DB row so a cancel issued from another tab / the Recent runs list
// reaches the tab that actually owns the AbortController.
function startCancelWatch(run: InternalRun) {
  const dbRunId = run.view.dbRunId;
  if (!dbRunId || run.cancelWatch) return;
  run.cancelWatch = setInterval(async () => {
    if (run.abort.signal.aborted) {
      stopCancelWatch(run);
      return;
    }
    const { data } = await supabase
      .from("swarm_runs")
      .select("cancel_requested")
      .eq("id", dbRunId)
      .maybeSingle();
    if (data?.cancel_requested) {
      run.abort.abort();
      stopCancelWatch(run);
    }
  }, 4000);
}

function stopCancelWatch(run: InternalRun) {
  if (run.cancelWatch) {
    clearInterval(run.cancelWatch);
    run.cancelWatch = null;
  }
}

/** Cancel a live run this tab owns. */
export function cancelRun(runId: string) {
  const run = runs.get(runId);
  if (!run) return;
  run.abort.abort();
  stopCancelWatch(run);
  patch(run, { status: "cancelled", finishedAt: run.view.finishedAt ?? Date.now() });
  emit();
  // Signal + record the cancellation in the DB (best-effort).
  if (run.view.dbRunId) {
    void supabase
      .from("swarm_runs")
      .update({
        cancel_requested: true,
        status: "cancelled",
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.view.dbRunId);
  }
}

/**
 * Request cancellation of a run identified by its DB id. If this tab owns the
 * live run, abort it directly; otherwise just flag the DB row so the owning
 * tab's cancel-watch picks it up (or the row is cleared if the run is orphaned
 * after a reload).
 */
export async function cancelByDbRunId(dbRunId: string) {
  for (const run of runs.values()) {
    if (run.view.dbRunId === dbRunId) {
      cancelRun(run.view.runId);
      return;
    }
  }
  await supabase
    .from("swarm_runs")
    .update({ cancel_requested: true, status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", dbRunId)
    .in("status", ["running"]);
}

/** The newest active (running/waiting) run for a given swarm, if any. */
export function getActiveRunForSwarm(swarmId: string | null): ManagedRunView | null {
  if (!swarmId) return null;
  const active = snapshot.find(
    (r) => r.swarmId === swarmId && (r.status === "running" || r.status === "waiting"),
  );
  return active ?? null;
}

export function getRun(runId: string): ManagedRunView | null {
  return runs.get(runId)?.view ?? null;
}

// ── External store plumbing (useSyncExternalStore) ──────────────────────────
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): ManagedRunView[] {
  return snapshot;
}
