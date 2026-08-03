// The swarm execution SEMANTICS, in one place.
//
// There are two executors — the canvas runtime (src/lib/swarmRuntime.ts, runs in
// the browser and streams UI events) and the headless one
// (src/utils/swarmExecute.server.ts, runs deployed/scheduled/API runs). They
// legitimately differ in HOW they call things: a browser fetch to /api/chat
// versus a direct server call. They must NOT differ in what the graph means.
//
// Until now each carried its own copy of the ordering, skip-propagation, retry
// and on-error rules. Those copies happen to agree today — I diffed them — but
// nothing keeps them in step, and "works on the canvas, behaves differently when
// deployed" is the worst class of bug this product can have: you cannot debug it
// from the place you built it. Both executors now drive these functions, so a
// semantic change lands in one file for both.
//
// Deliberately framework-free (a minimal edge shape rather than xyflow's) so it
// is pure and directly unit-testable.

/** Minimal edge shape — both executors' edges structurally satisfy this. */
export type GraphEdge = { id: string; source: string; target: string };
/** Minimal node shape for ordering. */
export type GraphNode = { id: string };

/** Node kinds that choose a branch, and so can never be skipped past on error. */
export const BRANCH_KINDS = new Set(["condition", "router"]);

/** How deep Execute-Swarm nodes may nest before we refuse to recurse further. */
export const MAX_SUBSWARM_DEPTH = 3;

/** Bounds on a node's retry policy. Shared so the two executors can't disagree. */
export const MAX_RETRIES = 5;
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * How many times a Loop node re-runs, and how many items a For-Each covers.
 *
 * Here for the same reason as MAX_RETRIES: both executors enforce these, and
 * they were bare literals written out twice — `Math.min(maxIters ?? 3, 6)` in
 * the canvas runtime and again in the server executor. They agreed when
 * checked, which is the only reason this is a tidy-up rather than a bug
 * report, but nothing made them agree and the two files are edited by
 * different concerns. A loop that runs six times while you watch and three
 * times when deployed is the kind of difference nobody thinks to look for.
 *
 * clampIters is the whole rule — floor of 1, the node's own value, the
 * ceiling — so neither side can re-derive it slightly differently either.
 */
export const LOOP_DEFAULT_ITERS = 3;
export const LOOP_MAX_ITERS = 6;
export const FOREACH_DEFAULT_ITEMS = 25;
export const FOREACH_MAX_ITEMS = 100;

export function clampIters(
  requested: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  return Math.max(1, Math.min(requested ?? fallback, ceiling));
}
export const DEFAULT_RETRY_DELAY_MS = 1000;

export type RetryPolicy = { retries: number; delayMs: number };

/**
 * Clamp a node's configured retry policy into the supported range.
 *
 * Clamping rather than validating on save: a swarm imported from JSON, or
 * written by the AI builder, can carry anything.
 */
export function retryPolicyOf(d: {
  retryCount?: number | null;
  retryDelayMs?: number | null;
}): RetryPolicy {
  const raw = Number(d.retryCount ?? 0);
  const rawDelay = Number(d.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  return {
    retries: Math.max(0, Math.min(Number.isFinite(raw) ? raw : 0, MAX_RETRIES)),
    delayMs: Math.max(
      0,
      Math.min(Number.isFinite(rawDelay) ? rawDelay : DEFAULT_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS),
    ),
  };
}

/**
 * May a failed node be skipped past, leaving its fallback in state?
 *
 * A failed condition/router never chose a branch, so every outgoing edge is
 * still live and BOTH paths would run — an approval branch and its bypass, for
 * example. There is no safe way to continue past an unmade routing decision.
 * A cancelled or out-of-budget run never continues either: that would defeat
 * the very limit that stopped it.
 */
export function canContinueOnError(
  d: { kind?: string; onError?: string | null },
  runState: { aborted?: boolean; expired?: boolean } = {},
): boolean {
  if (runState.aborted || runState.expired) return false;
  if (BRANCH_KINDS.has(String(d.kind ?? ""))) return false;
  return (d.onError ?? "fail") === "continue";
}

/**
 * How concurrent writes to the same state key are combined.
 *
 * "last" reproduces exactly what sequential execution did — the last node in
 * level order wins — so turning parallelism on changes nothing unless a swarm
 * opts into something else. That default is the whole reason parallel levels
 * are safe to enable for existing swarms.
 */
export type StateReducer = "last" | "first" | "concat" | "sum";

export const DEFAULT_REDUCER: StateReducer = "last";

function reduceValues(reducer: StateReducer, values: string[]): string {
  if (values.length === 0) return "";
  switch (reducer) {
    case "first":
      return values[0];
    case "concat":
      return values.join("\n\n");
    case "sum": {
      const total = values.reduce((acc, v) => {
        const n = Number(String(v).replace(/[^0-9eE+.-]/g, ""));
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
      return String(total);
    }
    case "last":
    default:
      return values[values.length - 1];
  }
}

/** One node's pending writes, held until the whole level has finished. */
export type StagedWrites = {
  nodeId: string;
  /** Ordered so a node writing the same key twice keeps its own last value. */
  writes: [string, string][];
  /** The node's own output, or null when it produced none. */
  output: string | null;
};

/**
 * Merge a level's staged writes into state, deterministically.
 *
 * `staged` MUST be in level order, not completion order — that is the entire
 * point. Committing in the order results happened to arrive would make a run's
 * output depend on which model replied first, and the same swarm would give
 * different answers on different days.
 */
export function commitLevelWrites(
  ctx: Record<string, string>,
  staged: StagedWrites[],
  reducers: Record<string, StateReducer> = {},
): { ctx: Record<string, string>; lastOutput: string | null } {
  const byKey = new Map<string, string[]>();
  for (const s of staged) {
    for (const [k, v] of s.writes) {
      const list = byKey.get(k);
      if (list) list.push(v);
      else byKey.set(k, [v]);
    }
  }
  for (const [k, values] of byKey) {
    ctx[k] = reduceValues(reducers[k] ?? DEFAULT_REDUCER, values);
  }
  // The level's "last output" is the last node IN LEVEL ORDER that produced
  // one, so an unconnected downstream node falls back to the same value it
  // would have under sequential execution.
  let lastOutput: string | null = null;
  for (const s of staged) if (s.output !== null) lastOutput = s.output;
  return { ctx, lastOutput };
}

/** Adjacency in both directions, built once per run. */
export type GraphIndex<E extends GraphEdge = GraphEdge> = {
  outgoing: Map<string, E[]>;
  incoming: Map<string, E[]>;
};

export function indexEdges<E extends GraphEdge>(edges: E[]): GraphIndex<E> {
  const outgoing = new Map<string, E[]>();
  const incoming = new Map<string, E[]>();
  for (const e of edges) {
    const o = outgoing.get(e.source);
    if (o) o.push(e);
    else outgoing.set(e.source, [e]);
    const i = incoming.get(e.target);
    if (i) i.push(e);
    else incoming.set(e.target, [e]);
  }
  return { outgoing, incoming };
}

/**
 * Order nodes into dependency levels. Every node in a level depends only on
 * earlier levels, so a level's nodes are independent of each other.
 *
 * Self-edges are ignored for ordering — a loop node points at itself, and that
 * is iteration, not a dependency. Any other cycle is a graph the executor
 * cannot run, and saying so is better than looping forever.
 *
 * An edge whose SOURCE is not in `nodes` is ignored too. A graph can carry one
 * after an import, an AI-authored build, or a node deleted without its edges;
 * counting it as a dependency left its target permanently un-ready, which
 * surfaced as "Swarm has a cycle" — refusing to run the whole swarm and
 * blaming something that isn't there. A dangling edge can never deliver a
 * value, so it cannot gate anything.
 */
export function topoLevelIds(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const incoming = new Map<string, Set<string>>();
  for (const n of nodes) incoming.set(n.id, new Set());
  const known = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!known.has(e.source)) continue;
    incoming.get(e.target)?.add(e.source);
  }
  const levels: string[][] = [];
  const remaining = new Set(nodes.map((n) => n.id));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (incoming.get(id)?.size ?? 0) === 0);
    if (ready.length === 0) throw new Error("Swarm has a cycle that isn't a loop self-edge");
    levels.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      incoming.forEach((set) => set.delete(id));
    }
  }
  return levels;
}

/**
 * Tracks which branches a run has routed away from.
 *
 * A condition/router kills the edges it did not take; a node whose incoming
 * edges are ALL dead can never receive input, so it is skipped, and the skip
 * cascades. The "all incoming" rule is what makes a diamond work: a node that
 * both branches reach still runs when either survives.
 */
export class SkipTracker<E extends GraphEdge = GraphEdge> {
  readonly skipped = new Set<string>();
  readonly deadEdges = new Set<string>();

  constructor(private readonly graph: GraphIndex<E>) {}

  /** Kill specific edges (the branches a condition/router did not choose). */
  killEdges(edgeIds: Iterable<string>): void {
    for (const id of edgeIds) this.deadEdges.add(id);
  }

  isEdgeLive(e: E): boolean {
    return !this.deadEdges.has(e.id) && !this.skipped.has(e.source);
  }

  isSkipped(nodeId: string): boolean {
    return this.skipped.has(nodeId);
  }

  /** Incoming edges that can still deliver a value to this node. */
  liveIncoming(nodeId: string): E[] {
    return (this.graph.incoming.get(nodeId) ?? []).filter((e) => this.isEdgeLive(e));
  }

  /**
   * Mark the given nodes skipped when every route into them is dead, and
   * cascade downstream. Breadth-first with the visited check on the queue, so a
   * diamond or a re-convergent graph terminates.
   */
  propagateSkip(targets: Iterable<string>): void {
    const queue = [...targets];
    while (queue.length > 0) {
      const nid = queue.shift()!;
      const inc = this.graph.incoming.get(nid) ?? [];
      const allDead = inc.every((e) => this.skipped.has(e.source) || this.deadEdges.has(e.id));
      if (!allDead) continue;
      if (this.skipped.has(nid)) continue;
      this.skipped.add(nid);
      for (const e of this.graph.outgoing.get(nid) ?? []) {
        if (!this.skipped.has(e.target)) queue.push(e.target);
      }
    }
  }
}
