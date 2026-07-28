// What a swarm run must remember to be resumable, and how to (de)serialise it.
//
// Pure module — no database, no server imports — so the round trip is testable
// on its own. Getting this wrong is expensive in a way tests catch cheaply: a
// checkpoint that loses the routing decisions resumes into branches the run had
// already ruled out, and one that loses the completed set re-runs agent calls
// and HTTP POSTs that already happened.

import { SkipTracker, type GraphEdge, type GraphIndex } from "@/lib/swarmGraph";

/** The mutable half of a run — everything not already in the graph snapshot. */
export type SwarmCheckpoint = {
  /** Variable map every node reads and writes. */
  ctx: Record<string, string>;
  /** Value an unconnected downstream node falls back to. */
  lastOutput: string;
  /** Nodes already executed. Never re-run: side effects are not idempotent. */
  completedNodeIds: string[];
  /** Nodes a condition/router ruled out. */
  skippedNodeIds: string[];
  /** Edges a condition/router killed. */
  deadEdgeIds: string[];
  /** Index into the topological levels — where to pick back up. */
  levelIndex: number;
  /** Node the run is parked at, when it stopped for an approval. */
  suspendedNodeId?: string | null;
};

export function emptyCheckpoint(ctx: Record<string, string>, lastOutput: string): SwarmCheckpoint {
  return {
    ctx: { ...ctx },
    lastOutput,
    completedNodeIds: [],
    skippedNodeIds: [],
    deadEdgeIds: [],
    levelIndex: 0,
  };
}

/**
 * Capture the live run state.
 *
 * `completed` is passed separately rather than inferred from ctx: a node whose
 * output happened to be an empty string is still done, and inferring from the
 * variable map would silently re-run it.
 */
export function captureCheckpoint(args: {
  ctx: Record<string, string>;
  lastOutput: string;
  completed: Iterable<string>;
  flow: SkipTracker;
  levelIndex: number;
  suspendedNodeId?: string | null;
}): SwarmCheckpoint {
  return {
    ctx: { ...args.ctx },
    lastOutput: args.lastOutput,
    completedNodeIds: [...args.completed],
    skippedNodeIds: [...args.flow.skipped],
    deadEdgeIds: [...args.flow.deadEdges],
    levelIndex: args.levelIndex,
    suspendedNodeId: args.suspendedNodeId ?? null,
  };
}

/**
 * Rebuild a tracker from a checkpoint.
 *
 * The dead edges are replayed BEFORE the skipped nodes so the tracker's own
 * invariants hold: a node is skipped because its routes died, and restoring it
 * the other way round would leave a tracker whose two sets disagree.
 */
export function restoreTracker<E extends GraphEdge>(
  graph: GraphIndex<E>,
  cp: Pick<SwarmCheckpoint, "skippedNodeIds" | "deadEdgeIds">,
): SkipTracker<E> {
  const flow = new SkipTracker(graph);
  flow.killEdges(cp.deadEdgeIds);
  for (const id of cp.skippedNodeIds) flow.skipped.add(id);
  return flow;
}

/** Row shape as stored. Kept separate from the runtime shape so a column rename
 *  is a change here rather than everywhere. */
export type CheckpointRow = {
  ctx: unknown;
  last_output: string | null;
  completed_node_ids: string[] | null;
  skipped_node_ids: string[] | null;
  dead_edge_ids: string[] | null;
  level_index: number | null;
  suspended_node_id: string | null;
};

export function toRow(cp: SwarmCheckpoint): Omit<CheckpointRow, "ctx"> & { ctx: unknown } {
  return {
    ctx: cp.ctx,
    last_output: cp.lastOutput,
    completed_node_ids: cp.completedNodeIds,
    skipped_node_ids: cp.skippedNodeIds,
    dead_edge_ids: cp.deadEdgeIds,
    level_index: cp.levelIndex,
    suspended_node_id: cp.suspendedNodeId ?? null,
  };
}

/**
 * Read a stored row back, defensively.
 *
 * Anything malformed degrades to "start from the beginning" rather than
 * throwing: a run that restarts is recoverable, a resume that crashes on its
 * own checkpoint is not.
 */
export function fromRow(row: CheckpointRow | null | undefined): SwarmCheckpoint | null {
  if (!row) return null;
  const ctx: Record<string, string> = {};
  if (row.ctx && typeof row.ctx === "object" && !Array.isArray(row.ctx)) {
    for (const [k, v] of Object.entries(row.ctx as Record<string, unknown>)) {
      ctx[k] = typeof v === "string" ? v : String(v ?? "");
    }
  }
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const level = Number(row.level_index ?? 0);
  return {
    ctx,
    lastOutput: typeof row.last_output === "string" ? row.last_output : "",
    completedNodeIds: strs(row.completed_node_ids),
    skippedNodeIds: strs(row.skipped_node_ids),
    deadEdgeIds: strs(row.dead_edge_ids),
    levelIndex: Number.isFinite(level) && level >= 0 ? Math.floor(level) : 0,
    suspendedNodeId: row.suspended_node_id ?? null,
  };
}
