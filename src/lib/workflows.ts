// One graph over work that used to keep four separate clocks.
//
// A platform's real shape is ingest → transform → train → publish, and until
// now each of those ran on its own schedule. Chaining helped — a pipeline can
// name SQL models and ML schedules to start when it succeeds — but a chain is
// a LINE. It cannot fan out to three things that run at once, and it cannot
// fan in: "train only after BOTH the orders pipeline and the customers model
// have finished" is not expressible as a chain, and the workaround is to
// stagger cron times and hope.
//
// A workflow is the graph. Nodes are the things that already exist — an ETL
// pipeline, a SQL model build, an ML schedule, a notebook — and edges are
// "after". The run is the interesting part: a node starts when EVERY node it
// depends on has succeeded, several nodes run at once when nothing orders
// them, and a node whose dependency failed is not run at all. It is marked
// SKIPPED, which is a different fact from failing and is recorded as one.
//
// This file is pure. It knows how to validate a graph, order it, and decide
// what to do next given the state so far; it starts nothing and reads no
// database. That is what lets the same decisions be tested exhaustively and
// re-used by the runner, the editor and the run view without drifting.

export const WORKFLOW_NAME_MAX = 120;
export const MAX_NODES = 60;

/** What a node runs. Each is something the platform can already start. */
export const NODE_KINDS = ["pipeline", "sql_models", "ml_schedule", "notebook"] as const;
export type WorkflowNodeKind = (typeof NODE_KINDS)[number];

export const NODE_KIND_LABEL: Record<WorkflowNodeKind, string> = {
  pipeline: "ETL pipeline",
  sql_models: "SQL models",
  ml_schedule: "ML schedule",
  notebook: "Notebook",
};

export type WorkflowNode = {
  /** Stable within the graph; edges refer to it. */
  id: string;
  kind: WorkflowNodeKind;
  /** Shown on the canvas. Falls back to the target's own name at save time. */
  label: string;
  /**
   * What to run.
   *
   * `pipeline`, `ml_schedule` and `notebook` carry one id. `sql_models`
   * carries model NAMES, and an empty list means every active model — the
   * same three-state convention a pipeline's chain already uses, because
   * "build everything" is the common case and a graph should not have to
   * list models it did not write.
   */
  targetId?: string;
  models?: string[];
  /**
   * Let the workflow carry on when this node fails, instead of skipping
   * everything downstream. For the node that refreshes a dashboard, not for
   * the one that loads the data.
   */
  continueOnFailure?: boolean;
  /** Canvas position. Layout only; the run ignores it. */
  x?: number;
  y?: number;
};

/** "`to` runs after `from` succeeds." */
export type WorkflowEdge = { from: string; to: string };

export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

export const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

// ── Node run state ──────────────────────────────────────────────────────────

/**
 * `skipped` is deliberately not a failure.
 *
 * A node that never ran because its dependency failed tells you nothing about
 * itself, and folding it into "failed" makes a run report say four things
 * broke when one did. The distinction is the first thing anybody wants when
 * they open a red run.
 */
export const NODE_STATES = ["pending", "running", "succeeded", "failed", "skipped"] as const;
export type WorkflowNodeState = (typeof NODE_STATES)[number];

export const RUN_STATES = ["running", "succeeded", "failed", "cancelled"] as const;
export type WorkflowRunState = (typeof RUN_STATES)[number];

export type NodeStates = Record<string, WorkflowNodeState>;

// ── Graph shape ─────────────────────────────────────────────────────────────

/** Every node that must succeed before `id` may start. */
export function parentsOf(graph: WorkflowGraph, id: string): string[] {
  return graph.edges.filter((e) => e.to === id).map((e) => e.from);
}

/** Every node waiting on `id`. */
export function childrenOf(graph: WorkflowGraph, id: string): string[] {
  return graph.edges.filter((e) => e.from === id).map((e) => e.to);
}

/**
 * Nodes in an order where every node follows its parents, or null if the
 * graph has a cycle.
 *
 * Kahn's algorithm, and the null is the point: a cycle is the one graph the
 * runner can never finish, so it is refused at save time rather than
 * discovered by a run that hangs.
 */
export function topoOrder(graph: WorkflowGraph): string[] | null {
  const indegree = new Map<string, number>();
  for (const n of graph.nodes) indegree.set(n.id, 0);
  for (const e of graph.edges) {
    if (!indegree.has(e.to) || !indegree.has(e.from)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const child of childrenOf(graph, id)) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

/**
 * The nodes grouped into waves: everything in wave 0 can start at once,
 * everything in wave 1 waits only on wave 0, and so on.
 *
 * Used by the editor to lay a graph out and by the run view to show what was
 * concurrent. The runner does NOT use it — it asks `readyNodes` instead,
 * because a wave would make a fast node wait for a slow sibling it does not
 * depend on.
 */
export function levels(graph: WorkflowGraph): string[][] {
  const order = topoOrder(graph);
  if (!order) return [];
  const depth = new Map<string, number>();
  for (const id of order) {
    const parents = parentsOf(graph, id);
    depth.set(id, parents.length ? Math.max(...parents.map((p) => (depth.get(p) ?? 0) + 1)) : 0);
  }
  const out: string[][] = [];
  for (const [id, d] of depth) {
    (out[d] ??= []).push(id);
  }
  return out.map((wave) => wave ?? []);
}

// ── What the runner does next ───────────────────────────────────────────────

/**
 * Has this parent finished in a way that lets its children run?
 *
 * Succeeding is the ordinary answer. Failing counts too when the parent is
 * marked continue-on-failure — that flag would mean nothing if the step after
 * it still waited for a success that is never coming. A SKIPPED parent never
 * ran at all, so it never satisfies anything, whatever its flag says.
 */
function parentSatisfied(node: WorkflowNode | undefined, state: WorkflowNodeState): boolean {
  if (state === "succeeded") return true;
  return state === "failed" && Boolean(node?.continueOnFailure);
}

/**
 * Nodes that may start right now: still pending, and every parent finished in
 * a way that lets them.
 *
 * A node whose parent is still running simply is not ready yet; one whose
 * parent failed is not ready ever, and `skippableNodes` below is what names
 * it.
 */
export function readyNodes(graph: WorkflowGraph, states: NodeStates): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.nodes
    .filter((n) => (states[n.id] ?? "pending") === "pending")
    .filter((n) =>
      parentsOf(graph, n.id).every((p) => parentSatisfied(byId.get(p), states[p] ?? "pending")),
    )
    .map((n) => n.id);
}

/**
 * Nodes that can never run now, because something they depend on failed or
 * was itself skipped.
 *
 * Transitive on purpose: skipping only the direct children would leave their
 * children pending forever, and a run that never ends is worse than one that
 * reports honestly. A failed node whose `continueOnFailure` is set does not
 * skip its children — that is the whole meaning of the flag.
 */
export function skippableNodes(graph: WorkflowGraph, states: NodeStates): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const doomed = new Set<string>();
  for (const n of graph.nodes) {
    const state = states[n.id];
    if (state === "failed" && !n.continueOnFailure) doomed.add(n.id);
    if (state === "skipped") doomed.add(n.id);
  }
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of graph.nodes) {
      if ((states[n.id] ?? "pending") !== "pending") continue;
      if (out.has(n.id)) continue;
      const parents = parentsOf(graph, n.id);
      if (parents.some((p) => doomed.has(p) || out.has(p))) {
        out.add(n.id);
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  // Keep the graph's own order so a run view lists them the way it draws them.
  return graph.nodes.filter((n) => out.has(n.id) && byId.has(n.id)).map((n) => n.id);
}

/**
 * What the whole run amounts to once nothing is left to do.
 *
 * A run with any failure is failed even when later nodes succeeded around it,
 * because the alternative — calling it green because the last node was fine —
 * is how a broken nightly load goes unnoticed for a week.
 */
export function runOutcome(states: NodeStates): WorkflowRunState {
  const values = Object.values(states);
  if (values.some((s) => s === "pending" || s === "running")) return "running";
  return values.some((s) => s === "failed") ? "failed" : "succeeded";
}

/** Is there anything left for the runner to do? */
export function isFinished(graph: WorkflowGraph, states: NodeStates): boolean {
  return (
    readyNodes(graph, states).length === 0 &&
    skippableNodes(graph, states).length === 0 &&
    !graph.nodes.some((n) => states[n.id] === "running")
  );
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Why this graph cannot be saved, or null. */
export function validateWorkflow(w: { name: string; graph: WorkflowGraph }): string | null {
  const { nodes, edges } = w.graph;
  if (!w.name.trim()) return "Give the workflow a name";
  if (w.name.length > WORKFLOW_NAME_MAX) {
    return `A name is at most ${WORKFLOW_NAME_MAX} characters`;
  }
  if (nodes.length > MAX_NODES) {
    return `A workflow holds at most ${MAX_NODES} steps; this one has ${nodes.length}`;
  }
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n.id) return "Every step needs an id";
    if (seen.has(n.id)) return `Two steps share the id ${n.id}`;
    seen.add(n.id);
    if (!NODE_KINDS.includes(n.kind)) return `Unknown step type ${n.kind}`;
    if (n.kind === "sql_models") {
      // An empty list is legitimate — it means every active model.
      if (n.models && !Array.isArray(n.models)) return "The SQL models step is malformed";
    } else if (!n.targetId) {
      return `The ${NODE_KIND_LABEL[n.kind].toLowerCase()} step "${n.label || n.id}" has nothing selected`;
    }
  }
  for (const e of edges) {
    if (!seen.has(e.from) || !seen.has(e.to)) return "An arrow points at a step that is gone";
    if (e.from === e.to) return "A step cannot wait for itself";
  }
  // Two arrows between the same pair say nothing extra and would be counted
  // twice by the runner's indegree.
  const pairs = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    if (pairs.has(key)) return "The same two steps are joined twice";
    pairs.add(key);
  }
  if (nodes.length && !topoOrder(w.graph)) {
    return "These steps form a loop, so the workflow could never finish";
  }
  return null;
}

/** A step id that is stable enough to diff and unique enough to key on. */
export function newNodeId(): string {
  return `n_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Lay a graph out left to right by dependency depth.
 *
 * Only used when a node has no saved position — dragging wins, and a graph
 * somebody arranged is never rearranged behind their back.
 */
export function autoLayout(graph: WorkflowGraph, gapX = 260, gapY = 110): WorkflowGraph {
  const waves = levels(graph);
  const pos = new Map<string, { x: number; y: number }>();
  waves.forEach((wave, col) => {
    wave.forEach((id, row) => pos.set(id, { x: col * gapX, y: row * gapY }));
  });
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (typeof n.x === "number" && typeof n.y === "number") return n;
      const p = pos.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }),
  };
}
