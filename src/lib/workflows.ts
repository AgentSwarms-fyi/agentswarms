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
// A workflow is the graph. Nodes are the things the platform can already run —
// a pipeline, a model build, a retrain, a notebook, a SQL statement, a swarm,
// a dashboard refresh — plus the four an orchestrator has to provide itself:
// a branch, a wait, a human approval and a call out to somebody else's API.
// Edges are "after".
//
// This file is pure. It knows how to validate a graph, order it, and decide
// what to do next given the state so far; it starts nothing and reads no
// database. That is what lets the same decisions be tested exhaustively and
// re-used by the runner, the editor and the run view without drifting.

export const WORKFLOW_NAME_MAX = 120;
export const MAX_NODES = 60;

/**
 * What a node runs.
 *
 * The first group is work the platform already knows how to start. The second
 * is control flow, which every orchestrator has to own itself because it is
 * about the graph rather than about any one system.
 */
export const NODE_KINDS = [
  // Work
  "pipeline",
  "sql_models",
  "ml_schedule",
  "notebook",
  "sql",
  "swarm",
  "prep_flow",
  "dashboard_refresh",
  "data_monitor",
  // Reaching outside
  "http",
  "notify",
  // Control flow
  "condition",
  "wait",
  "approval",
  "sub_workflow",
] as const;
export type WorkflowNodeKind = (typeof NODE_KINDS)[number];

export const NODE_KIND_LABEL: Record<WorkflowNodeKind, string> = {
  pipeline: "ETL pipeline",
  sql_models: "SQL models",
  ml_schedule: "ML schedule",
  notebook: "Notebook",
  sql: "SQL statement",
  swarm: "Swarm",
  prep_flow: "Data prep flow",
  dashboard_refresh: "Refresh dashboard",
  data_monitor: "Data monitor",
  http: "HTTP request",
  notify: "Notify",
  condition: "Condition",
  wait: "Wait",
  approval: "Approval",
  sub_workflow: "Sub-workflow",
};

/** Kinds that decide the shape of the run rather than doing outside work. */
export const CONTROL_KINDS: readonly WorkflowNodeKind[] = [
  "condition",
  "wait",
  "approval",
  "sub_workflow",
];

/** Kinds whose target is one id the caller owns. */
export const TARGET_ID_KINDS: readonly WorkflowNodeKind[] = [
  "pipeline",
  "ml_schedule",
  "notebook",
  "swarm",
  "prep_flow",
  "dashboard_refresh",
  "data_monitor",
  "sub_workflow",
];

/**
 * When a node may start, given how its parents finished.
 *
 * Airflow's names, deliberately: an operator who knows one orchestrator should
 * not have to learn a second vocabulary for the same three ideas.
 */
export const TRIGGER_RULES = ["all_success", "all_done", "one_success"] as const;
export type TriggerRule = (typeof TRIGGER_RULES)[number];

export const TRIGGER_RULE_LABEL: Record<TriggerRule, string> = {
  all_success: "after every parent succeeds",
  all_done: "after every parent finishes, however it finished",
  one_success: "as soon as any one parent succeeds",
};

export type WorkflowNode = {
  /** Stable within the graph; edges refer to it. */
  id: string;
  kind: WorkflowNodeKind;
  /** Shown on the canvas. Falls back to the kind's own name. */
  label: string;
  /**
   * What to run.
   *
   * Most kinds carry one id. `sql_models` carries model NAMES, and an empty
   * list means every active model — the same three-state convention a
   * pipeline's chain already uses, because "build everything" is the common
   * case and a graph should not have to list models it did not write.
   */
  targetId?: string;
  models?: string[];
  /** `sql`: the statement. `condition`: the expression. `notify`: the message. */
  text?: string;
  /** `http`: the request. */
  http?: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    /** Header values may name a secret as {{secret:NAME}}; resolved server-side. */
    headers?: Record<string, string>;
    body?: string;
    /** Response statuses that count as success. Empty = any 2xx. */
    okStatuses?: number[];
  };
  /** `wait`: how long, in seconds. */
  waitSeconds?: number;
  /**
   * Let the workflow carry on when this node fails, instead of skipping
   * everything downstream. For the node that refreshes a dashboard, not for
   * the one that loads the data.
   */
  continueOnFailure?: boolean;
  /** How this node's own parents gate it. Default `all_success`. */
  triggerRule?: TriggerRule;
  /** Attempts after the first. 0 = try once. */
  retries?: number;
  /** Seconds before the first retry; doubles each attempt, capped at an hour. */
  retryBackoffSeconds?: number;
  /** Give up on this node after this long. Falls back to the platform default. */
  timeoutMinutes?: number;
  /** Canvas position. Layout only; the run ignores it. */
  x?: number;
  y?: number;
};

/**
 * "`to` runs after `from`."
 *
 * `branch` is set only on the edges leaving a condition node, and says which
 * side of the branch this edge is. An edge with no branch leaving a condition
 * node is taken whichever way the condition went.
 */
export type WorkflowEdge = { from: string; to: string; branch?: "true" | "false" };

/** A parameter the run takes, with the value used when nobody supplies one. */
export type WorkflowParam = { name: string; default?: string; description?: string };

export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  params?: WorkflowParam[];
};

export const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [], params: [] };

export const MAX_RETRIES = 10;
export const MAX_WAIT_SECONDS = 86_400;

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

/** Which way each condition node that has run decided. */
export type NodeBranches = Record<string, "true" | "false">;

// ── Graph shape ─────────────────────────────────────────────────────────────

/** Every node `id` waits for. */
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

const isFinishedState = (s: WorkflowNodeState) =>
  s === "succeeded" || s === "failed" || s === "skipped";

/**
 * Does an edge from a condition node lead this way?
 *
 * An unbranched edge is always followed, so a condition can also be used as a
 * plain gate. A branched edge is followed only when the condition went that
 * way, and not at all until it has run.
 */
function edgeTaken(
  graph: WorkflowGraph,
  edge: WorkflowEdge,
  branches: NodeBranches,
): boolean | "unknown" {
  if (!edge.branch) return true;
  const decided = branches[edge.from];
  if (!decided) return "unknown";
  return decided === edge.branch;
}

/** The edges into `id` that the run has actually taken. */
function liveEdgesInto(graph: WorkflowGraph, id: string, branches: NodeBranches): WorkflowEdge[] {
  return graph.edges.filter((e) => e.to === id && edgeTaken(graph, e, branches) === true);
}

/** True when every branched edge into `id` has already been decided against. */
function allEdgesRejected(graph: WorkflowGraph, id: string, branches: NodeBranches): boolean {
  const into = graph.edges.filter((e) => e.to === id);
  if (!into.length) return false;
  return into.every((e) => edgeTaken(graph, e, branches) === false);
}

/**
 * Nodes that may start right now.
 *
 * A node is ready when it is still pending and its trigger rule is satisfied
 * by the parents whose edges the run has taken. `all_success` is the default
 * and the strict one; `all_done` lets a cleanup step run whatever happened
 * upstream; `one_success` starts as soon as any single parent lands.
 */
export function readyNodes(
  graph: WorkflowGraph,
  states: NodeStates,
  branches: NodeBranches = {},
): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.nodes
    .filter((n) => (states[n.id] ?? "pending") === "pending")
    .filter((n) => {
      const edges = liveEdgesInto(graph, n.id, branches);
      // A branched edge that has not been decided yet is not "no parent" — it
      // is a parent whose answer has not arrived.
      if (!edges.length) return !graph.edges.some((e) => e.to === n.id);
      const parents = edges.map((e) => e.from);
      const rule = n.triggerRule ?? "all_success";
      if (rule === "all_done") {
        return parents.every((p) => isFinishedState(states[p] ?? "pending"));
      }
      if (rule === "one_success") {
        return parents.some((p) => parentSatisfied(byId.get(p), states[p] ?? "pending"));
      }
      return parents.every((p) => parentSatisfied(byId.get(p), states[p] ?? "pending"));
    })
    .map((n) => n.id);
}

/**
 * Nodes that can never run now, because the branch they sit on was not taken,
 * or because their trigger rule can no longer be met.
 *
 * Transitive on purpose: skipping only the direct children would leave their
 * children pending forever, and a run that never ends is worse than one that
 * reports honestly. `all_done` nodes are never skipped for a failure — waiting
 * for everything to finish is the whole point of that rule.
 */
export function skippableNodes(
  graph: WorkflowGraph,
  states: NodeStates,
  branches: NodeBranches = {},
): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const doomed = new Set<string>();
  for (const n of graph.nodes) {
    const state = states[n.id];
    if (state === "failed" && !n.continueOnFailure) doomed.add(n.id);
    if (state === "skipped") doomed.add(n.id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of graph.nodes) {
      if ((states[n.id] ?? "pending") !== "pending" || out.has(n.id)) continue;
      const rule = n.triggerRule ?? "all_success";
      const into = graph.edges.filter((e) => e.to === n.id);
      if (!into.length) continue;

      // Every way in was branched away from: this node is on the road not
      // taken, which is a skip whatever its trigger rule says.
      if (allEdgesRejected(graph, n.id, branches)) {
        out.add(n.id);
        doomed.add(n.id);
        grew = true;
        continue;
      }
      const live = liveEdgesInto(graph, n.id, branches).map((e) => e.from);
      // A branch still undecided means "wait", not "skip".
      if (into.some((e) => edgeTaken(graph, e, branches) === "unknown")) continue;
      if (!live.length) continue;

      if (rule === "all_done") continue; // waits for everything, skips for nothing
      if (rule === "one_success") {
        // Only doomed once EVERY parent has finished without one succeeding.
        const allFinished = live.every((p) => isFinishedState(states[p] ?? "pending"));
        const anyGood = live.some((p) => parentSatisfied(byId.get(p), states[p] ?? "pending"));
        if (allFinished && !anyGood) {
          out.add(n.id);
          doomed.add(n.id);
          grew = true;
        }
        continue;
      }
      if (live.some((p) => doomed.has(p) || out.has(p))) {
        out.add(n.id);
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  // Keep the graph's own order so a run view lists them the way it draws them.
  return graph.nodes.filter((n) => out.has(n.id)).map((n) => n.id);
}

/**
 * What the whole run amounts to once nothing is left to do.
 *
 * A run with any failure is failed even when later nodes succeeded around it,
 * because the alternative — calling it green because the last node was fine —
 * is how a broken nightly load goes unnoticed for a week. A node marked
 * continue-on-failure is the one exception: its failure was declared
 * acceptable in advance, so it does not colour the run.
 */
export function runOutcome(states: NodeStates, graph?: WorkflowGraph): WorkflowRunState {
  const values = Object.values(states);
  if (values.some((s) => s === "pending" || s === "running")) return "running";
  if (!graph) return values.some((s) => s === "failed") ? "failed" : "succeeded";
  const tolerated = new Set(graph.nodes.filter((n) => n.continueOnFailure).map((n) => n.id));
  const realFailure = Object.entries(states).some(
    ([id, s]) => s === "failed" && !tolerated.has(id),
  );
  return realFailure ? "failed" : "succeeded";
}

/** Is there anything left for the runner to do? */
export function isFinished(
  graph: WorkflowGraph,
  states: NodeStates,
  branches: NodeBranches = {},
): boolean {
  return (
    readyNodes(graph, states, branches).length === 0 &&
    skippableNodes(graph, states, branches).length === 0 &&
    !graph.nodes.some((n) => states[n.id] === "running")
  );
}

/** How long to wait before attempt `attempt` (1 = the first retry). */
export function retryDelaySeconds(node: WorkflowNode, attempt: number): number {
  const base = Math.max(1, node.retryBackoffSeconds ?? 60);
  return Math.min(3600, base * Math.pow(2, Math.max(0, attempt - 1)));
}

// ── Parameters ──────────────────────────────────────────────────────────────

const PARAM_RE = /\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Fill `{{ params.name }}` from the run's parameters.
 *
 * An unknown name is left as it was written rather than replaced with an empty
 * string: a SQL statement that silently loses its date filter and scans all
 * history is worse than one that fails with the placeholder still visible.
 */
export function substituteParams(text: string, params: Record<string, string>): string {
  return text.replace(PARAM_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name] : whole,
  );
}

/** Every parameter name a graph refers to, whether or not it declares it. */
export function referencedParams(graph: WorkflowGraph): string[] {
  const found = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    PARAM_RE.lastIndex = 0;
    for (const m of s.matchAll(PARAM_RE)) found.add(m[1]);
  };
  for (const n of graph.nodes) {
    scan(n.text);
    scan(n.http?.url);
    scan(n.http?.body);
    for (const v of Object.values(n.http?.headers ?? {})) scan(v);
  }
  return [...found].sort();
}

/** The parameters a run starts with: declared defaults, then what was passed. */
export function resolveParams(
  graph: WorkflowGraph,
  supplied: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of graph.params ?? []) out[p.name] = p.default ?? "";
  for (const [k, v] of Object.entries(supplied)) out[k] = v;
  return out;
}

// ── Conditions ──────────────────────────────────────────────────────────────

/**
 * Evaluate a condition node's expression.
 *
 * Deliberately tiny: `left op right`, where each side is a literal or a
 * parameter, and `op` is one of six comparisons. Not a language. An
 * orchestrator that lets a branch run arbitrary code has handed the graph the
 * ability to do anything, and the whole point of a condition node is that you
 * can read it and know what it will do.
 */
/** The comparisons a condition step can make. Said in words in the UI. */
export const CONDITION_OPS = ["==", "!=", ">", "<", ">=", "<="] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** A surrounding pair of quotes is packaging, not part of the value. */
function unquote(s: string): string {
  const t = s.trim();
  const q = t[0];
  if ((q === '"' || q === "'") && t.length > 1 && t[t.length - 1] === q) return t.slice(1, -1);
  return t;
}

/**
 * Find the comparison operator, on the expression as WRITTEN.
 *
 * Two things this must get right, both of which the old one-line regex got
 * wrong. It skips operators inside quotes, so `env == "a>b"` compares against
 * `a>b` rather than splitting on the `>` in the middle of it. And it is
 * applied BEFORE parameters are filled in — splitting afterwards meant a
 * parameter whose value happened to contain `>` or `==` silently rewrote the
 * comparison it was supposed to be an operand of, which is the condition
 * equivalent of an injection.
 */
function splitComparison(text: string): { left: string; op: ConditionOp; right: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
      return { left: text.slice(0, i), op: two, right: text.slice(i + 2) };
    }
    if (c === ">" || c === "<") {
      return { left: text.slice(0, i), op: c, right: text.slice(i + 1) };
    }
  }
  return null;
}

export function evaluateCondition(
  expression: string,
  params: Record<string, string>,
): { ok: true; value: boolean } | { ok: false; error: string } {
  const split = splitComparison((expression ?? "").trim());
  if (!split) {
    // A bare value is truthy-tested, so "{{ params.full_refresh }}" works.
    const bare = unquote(substituteParams(expression, params)).toLowerCase();
    if (["true", "yes", "1"].includes(bare)) return { ok: true, value: true };
    if (["false", "no", "0", ""].includes(bare)) return { ok: true, value: false };
    return { ok: false, error: `Cannot read "${expression}" as a condition` };
  }
  const { op } = split;
  const l = unquote(substituteParams(split.left, params));
  const r = unquote(substituteParams(split.right, params));
  const ln = Number(l);
  const rn = Number(r);
  const numeric = l !== "" && r !== "" && Number.isFinite(ln) && Number.isFinite(rn);
  switch (op) {
    case "==":
      return { ok: true, value: numeric ? ln === rn : l === r };
    case "!=":
      return { ok: true, value: numeric ? ln !== rn : l !== r };
    default:
      if (!numeric) {
        return { ok: false, error: `"${op}" needs numbers, and got "${l}" and "${r}"` };
      }
      return {
        ok: true,
        value: op === ">" ? ln > rn : op === "<" ? ln < rn : op === ">=" ? ln >= rn : ln <= rn,
      };
  }
}

// ── Conditions, as something to assemble rather than to type ────────────────
//
// The engine evaluates a string, because a string is what a run record can
// carry and what a diff can show. Nobody should have to WRITE that string:
// the pieces below are the same comparison in a shape a form can edit, and
// `formatCondition` / `parseCondition` move between the two without loss.
// Round-tripping is the property that matters — reopening a step must show
// exactly the comparison that was saved.

/** Said in words, because the point is that nobody learns the symbols. */
export const CONDITION_OP_LABEL: Record<ConditionOp, string> = {
  "==": "is",
  "!=": "is not",
  ">": "is more than",
  "<": "is less than",
  ">=": "is at least",
  "<=": "is at most",
};

/** One side of a comparison. */
export type ConditionSide = { from: "param"; name: string } | { from: "value"; value: string };

export type Condition =
  /** `left op right` */
  | { mode: "compare"; left: ConditionSide; op: ConditionOp; right: ConditionSide }
  /** A bare flag, truthy-tested. */
  | { mode: "flag"; left: ConditionSide };

const PARAM_REF = /^\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
/** A value that would be re-read as an operator has to be quoted. */
const NEEDS_QUOTING = /[=!<>]/;

function formatSide(side: ConditionSide): string {
  if (side.from === "param") return `{{ params.${side.name} }}`;
  const v = side.value.trim();
  if (v === "") return '""';
  return NEEDS_QUOTING.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}

function parseSide(raw: string): ConditionSide {
  const text = raw.trim();
  const m = PARAM_REF.exec(text);
  if (m) return { from: "param", name: m[1] };
  return { from: "value", value: text.replace(/^["']|["']$/g, "") };
}

/** The comparison as the engine reads it. */
export function formatCondition(c: Condition): string {
  if (c.mode === "flag") return formatSide(c.left);
  return `${formatSide(c.left)} ${c.op} ${formatSide(c.right)}`;
}

/**
 * The comparison as a form edits it.
 *
 * Total on purpose: anything the evaluator would accept comes back as a
 * `Condition`, and anything it would not still comes back as a flag holding
 * the original text, so opening a step can never lose what was in it.
 */
export function parseCondition(expression: string | undefined): Condition {
  const text = (expression ?? "").trim();
  if (!text)
    return {
      mode: "compare",
      left: { from: "value", value: "" },
      op: "==",
      right: { from: "value", value: "" },
    };
  // The SAME splitter the evaluator uses, so a step cannot display one
  // comparison and run another.
  const split = splitComparison(text);
  if (!split) return { mode: "flag", left: parseSide(text) };
  return {
    mode: "compare",
    left: parseSide(split.left),
    op: split.op,
    right: parseSide(split.right),
  };
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
    const named = n.label || NODE_KIND_LABEL[n.kind];
    if ((n.retries ?? 0) < 0 || (n.retries ?? 0) > MAX_RETRIES) {
      return `"${named}" asks for more than ${MAX_RETRIES} retries`;
    }
    if (n.triggerRule && !TRIGGER_RULES.includes(n.triggerRule)) {
      return `"${named}" has an unknown trigger rule`;
    }
    const invalid = validateNodeTarget(n, named);
    if (invalid) return invalid;
  }
  for (const e of edges) {
    if (!seen.has(e.from) || !seen.has(e.to)) return "An arrow points at a step that is gone";
    if (e.from === e.to) return "A step cannot wait for itself";
    if (e.branch && !["true", "false"].includes(e.branch)) return "An arrow has a bad branch";
  }
  // Two arrows between the same pair say nothing extra and would be counted
  // twice by the runner's indegree — unless they are the two sides of a
  // branch, which is a legitimate diamond back onto one step.
  const pairs = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}>${e.to}>${e.branch ?? ""}`;
    if (pairs.has(key)) return "The same two steps are joined twice";
    pairs.add(key);
  }
  // A branch label only means something on an edge leaving a condition.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.branch && byId.get(e.from)?.kind !== "condition") {
      return "Only a condition step has true and false arrows";
    }
  }
  for (const n of nodes) {
    if (n.kind !== "condition") continue;
    const outs = childrenOf(w.graph, n.id);
    if (!outs.length) return `The condition "${n.label || n.id}" decides nothing`;
  }
  for (const p of w.graph.params ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name)) {
      return `"${p.name}" is not a usable parameter name`;
    }
  }
  if (nodes.length && !topoOrder(w.graph)) {
    return "These steps form a loop, so the workflow could never finish";
  }
  return null;
}

/** Why one step has nothing runnable configured, or null. */
export function validateNodeTarget(n: WorkflowNode, named: string): string | null {
  switch (n.kind) {
    case "sql_models":
      return n.models && !Array.isArray(n.models) ? "The SQL models step is malformed" : null;
    case "sql":
    case "condition":
      if (!n.text?.trim()) {
        return n.kind === "sql"
          ? `The SQL step "${named}" has no statement`
          : `The condition "${named}" has no expression`;
      }
      return null;
    case "notify":
      return n.text?.trim() ? null : `The notify step "${named}" has no message`;
    case "wait":
      if (!n.waitSeconds || n.waitSeconds <= 0) return `The wait step "${named}" has no duration`;
      if (n.waitSeconds > MAX_WAIT_SECONDS) {
        return `A wait is at most ${MAX_WAIT_SECONDS / 3600} hours`;
      }
      return null;
    case "approval":
      return null; // the label is the question; a default is fine
    case "http": {
      const url = n.http?.url?.trim();
      if (!url) return `The HTTP step "${named}" has no URL`;
      if (!/^https?:\/\//i.test(substituteParams(url, {}))) {
        return `The HTTP step "${named}" needs an http or https URL`;
      }
      return null;
    }
    default:
      return n.targetId
        ? null
        : `The ${NODE_KIND_LABEL[n.kind].toLowerCase()} step "${named}" has nothing selected`;
  }
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
