// One graph over work that kept four separate clocks.
//
// The decisions worth pinning are the ones a chain could never make: fan-out
// (two steps start at once), fan-in (a step waits for BOTH parents), and what
// happens downstream of a failure. The last one is where a naive runner does
// the wrong thing quietly — it either hangs forever waiting on a node that
// will never run, or calls the whole run green because the last step it
// happened to reach was fine.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EMPTY_GRAPH,
  evaluateCondition,
  NODE_KINDS,
  referencedParams,
  resolveParams,
  formatCondition,
  parseCondition,
  retryDelaySeconds,
  substituteParams,
  MAX_NODES,
  autoLayout,
  isFinished,
  levels,
  newNodeId,
  parentsOf,
  readyNodes,
  runOutcome,
  skippableNodes,
  topoOrder,
  validateWorkflow,
  type NodeStates,
  type WorkflowEdge,
  type WorkflowNodeKind,
  type WorkflowGraph,
  type WorkflowNode,
} from "@/lib/workflows";

const node = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  kind: "pipeline",
  label: id,
  targetId: `t_${id}`,
  ...over,
});

const condNode = (id: string, text: string): WorkflowNode => ({
  id,
  kind: "condition",
  label: id,
  text,
});

const sqlNode = (id: string, text: string): WorkflowNode => ({
  id,
  kind: "sql",
  label: id,
  text,
});

const httpNode = (id: string, http: NonNullable<WorkflowNode["http"]>): WorkflowNode => ({
  id,
  kind: "http",
  label: id,
  http,
});

/** ingest fans out to two transforms, which fan back in to a train step. */
const diamond: WorkflowGraph = {
  nodes: [node("ingest"), node("orders"), node("customers"), node("train")],
  edges: [
    { from: "ingest", to: "orders" },
    { from: "ingest", to: "customers" },
    { from: "orders", to: "train" },
    { from: "customers", to: "train" },
  ],
};

const allPending = (g: WorkflowGraph): NodeStates =>
  Object.fromEntries(g.nodes.map((n) => [n.id, "pending" as const]));

describe("the shape of a graph", () => {
  it("orders every step after its parents", () => {
    const order = topoOrder(diamond) as string[];
    expect(order).toHaveLength(4);
    expect(order.indexOf("ingest")).toBeLessThan(order.indexOf("orders"));
    expect(order.indexOf("orders")).toBeLessThan(order.indexOf("train"));
    expect(order.indexOf("customers")).toBeLessThan(order.indexOf("train"));
  });

  it("refuses a loop rather than running one", () => {
    const loop: WorkflowGraph = {
      nodes: [node("a"), node("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    expect(topoOrder(loop)).toBeNull();
    expect(validateWorkflow({ name: "w", graph: loop })).toMatch(/loop/i);
  });

  it("groups the steps that can run at the same time", () => {
    expect(levels(diamond)).toEqual([["ingest"], ["orders", "customers"], ["train"]]);
  });

  it("knows what each step waits for", () => {
    expect(parentsOf(diamond, "train").sort()).toEqual(["customers", "orders"]);
    expect(parentsOf(diamond, "ingest")).toEqual([]);
  });
});

describe("what runs next", () => {
  it("starts the roots, then fans out to both branches at once", () => {
    const states = allPending(diamond);
    expect(readyNodes(diamond, states)).toEqual(["ingest"]);
    states.ingest = "succeeded";
    expect(readyNodes(diamond, states).sort()).toEqual(["customers", "orders"]);
  });

  it("makes a fan-in wait for BOTH parents — the thing a chain cannot do", () => {
    const states = allPending(diamond);
    states.ingest = "succeeded";
    states.orders = "succeeded";
    // customers is still running: train must not start.
    states.customers = "running";
    expect(readyNodes(diamond, states)).toEqual([]);
    states.customers = "succeeded";
    expect(readyNodes(diamond, states)).toEqual(["train"]);
  });

  it("never starts a step whose parent is still running", () => {
    const states = allPending(diamond);
    states.ingest = "running";
    expect(readyNodes(diamond, states)).toEqual([]);
  });
});

describe("what a failure does downstream", () => {
  it("skips the whole branch below it, not just the next step", () => {
    const states = allPending(diamond);
    states.ingest = "failed";
    // orders and customers cannot run; train cannot run because they cannot.
    expect(skippableNodes(diamond, states).sort()).toEqual(["customers", "orders", "train"]);
  });

  it("skips a fan-in when only ONE parent failed", () => {
    const states = allPending(diamond);
    states.ingest = "succeeded";
    states.orders = "succeeded";
    states.customers = "failed";
    expect(skippableNodes(diamond, states)).toEqual(["train"]);
  });

  it("carries on past a step marked continue-on-failure", () => {
    const g: WorkflowGraph = {
      nodes: [node("load"), node("refresh", { continueOnFailure: true }), node("notify")],
      edges: [
        { from: "load", to: "refresh" },
        { from: "refresh", to: "notify" },
      ],
    };
    const states = allPending(g);
    states.load = "succeeded";
    states.refresh = "failed";
    expect(skippableNodes(g, states)).toEqual([]);
    expect(readyNodes(g, states)).toEqual(["notify"]);
  });

  it("a skipped step still stops everything below it", () => {
    const g: WorkflowGraph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    const states: NodeStates = { a: "failed", b: "skipped", c: "pending" };
    expect(skippableNodes(g, states)).toEqual(["c"]);
  });

  it("reaches an end rather than waiting forever on a step that will never run", () => {
    const states = allPending(diamond);
    states.ingest = "failed";
    expect(isFinished(diamond, states)).toBe(false);
    for (const id of skippableNodes(diamond, states)) states[id] = "skipped";
    expect(isFinished(diamond, states)).toBe(true);
  });
});

describe("what the run amounts to", () => {
  it("is failed when anything failed, even if later steps went fine", () => {
    expect(runOutcome({ a: "failed", b: "skipped", c: "succeeded" })).toBe("failed");
  });

  it("is succeeded only when nothing failed", () => {
    expect(runOutcome({ a: "succeeded", b: "succeeded" })).toBe("succeeded");
  });

  it("is still running while anything is pending or running", () => {
    expect(runOutcome({ a: "succeeded", b: "running" })).toBe("running");
    expect(runOutcome({ a: "succeeded", b: "pending" })).toBe("running");
  });

  it("a skip alone is not a failure", () => {
    // A step skipped because its continue-on-failure parent was fine is not a
    // thing that broke; only an actual failure colours the run red.
    expect(runOutcome({ a: "succeeded", b: "skipped" })).toBe("succeeded");
  });
});

describe("what a workflow refuses to be", () => {
  it("nameless, oversized, or built from steps that collide", () => {
    expect(validateWorkflow({ name: "  ", graph: EMPTY_GRAPH })).toMatch(/name/i);
    const many = {
      nodes: Array.from({ length: MAX_NODES + 1 }, (_, i) => node(`n${i}`)),
      edges: [],
    };
    expect(validateWorkflow({ name: "w", graph: many })).toMatch(/at most/);
    const dupe = { nodes: [node("a"), node("a")], edges: [] };
    expect(validateWorkflow({ name: "w", graph: dupe })).toMatch(/share the id/);
  });

  it("a step with nothing selected to run", () => {
    const g = { nodes: [node("a", { targetId: undefined })], edges: [] };
    expect(validateWorkflow({ name: "w", graph: g })).toMatch(/nothing selected/);
  });

  it("but a SQL models step with no names is fine — that means every model", () => {
    const g = {
      nodes: [node("a", { kind: "sql_models", targetId: undefined, models: [] })],
      edges: [],
    };
    expect(validateWorkflow({ name: "w", graph: g })).toBeNull();
  });

  it("an arrow to a step that is gone, a self-loop, or a duplicate arrow", () => {
    expect(
      validateWorkflow({
        name: "w",
        graph: { nodes: [node("a")], edges: [{ from: "a", to: "ghost" }] },
      }),
    ).toMatch(/gone/);
    expect(
      validateWorkflow({
        name: "w",
        graph: { nodes: [node("a")], edges: [{ from: "a", to: "a" }] },
      }),
    ).toMatch(/itself/);
    expect(
      validateWorkflow({
        name: "w",
        graph: {
          nodes: [node("a"), node("b")],
          edges: [
            { from: "a", to: "b" },
            { from: "a", to: "b" },
          ],
        },
      }),
    ).toMatch(/joined twice/);
  });

  it("accepts the diamond, which is the shape this exists for", () => {
    expect(validateWorkflow({ name: "Nightly", graph: diamond })).toBeNull();
  });
});

describe("laying the canvas out", () => {
  it("places each step by depth and never moves one somebody dragged", () => {
    const placed = autoLayout({
      ...diamond,
      nodes: diamond.nodes.map((n) => (n.id === "train" ? { ...n, x: 999, y: 888 } : n)),
    });
    const by = Object.fromEntries(placed.nodes.map((n) => [n.id, n]));
    expect(by.ingest.x).toBe(0);
    expect(by.orders.x).toBe(260);
    expect(by.customers.x).toBe(260);
    expect(by.orders.y).not.toBe(by.customers.y);
    // Dragged, so left exactly where it was.
    expect(by.train.x).toBe(999);
    expect(by.train.y).toBe(888);
  });

  it("mints ids that do not collide", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newNodeId()));
    expect(ids.size).toBe(200);
  });
});

describe("trigger rules — when a step is allowed to start", () => {
  const g: WorkflowGraph = {
    nodes: [node("a"), node("b"), node("cleanup", { triggerRule: "all_done" })],
    edges: [
      { from: "a", to: "cleanup" },
      { from: "b", to: "cleanup" },
    ],
  };

  it("all_done runs after a failure, which is what a cleanup step is for", () => {
    const states: NodeStates = { a: "failed", b: "succeeded", cleanup: "pending" };
    // The default rule would skip it; all_done does not.
    expect(skippableNodes(g, states)).toEqual([]);
    expect(readyNodes(g, states)).toEqual(["cleanup"]);
  });

  it("all_done still waits for every parent to finish", () => {
    expect(readyNodes(g, { a: "failed", b: "running", cleanup: "pending" })).toEqual([]);
  });

  it("one_success starts on the first parent that lands", () => {
    const any: WorkflowGraph = {
      nodes: [node("a"), node("b"), node("notify", { triggerRule: "one_success" })],
      edges: [
        { from: "a", to: "notify" },
        { from: "b", to: "notify" },
      ],
    };
    expect(readyNodes(any, { a: "succeeded", b: "running", notify: "pending" })).toEqual([
      "notify",
    ]);
    // And is skipped only once EVERY parent has finished without one succeeding.
    expect(skippableNodes(any, { a: "failed", b: "running", notify: "pending" })).toEqual([]);
    expect(skippableNodes(any, { a: "failed", b: "failed", notify: "pending" })).toEqual([
      "notify",
    ]);
  });
});

describe("branching — a condition sends the run one way", () => {
  const g: WorkflowGraph = {
    nodes: [
      condNode("check", "{{ params.full }} == true"),
      node("full"),
      node("incremental"),
      node("publish", { triggerRule: "one_success" }),
    ],
    edges: [
      { from: "check", to: "full", branch: "true" },
      { from: "check", to: "incremental", branch: "false" },
      { from: "full", to: "publish" },
      { from: "incremental", to: "publish" },
    ],
  };

  it("waits at the fork until the condition has decided", () => {
    const states: NodeStates = {
      check: "running",
      full: "pending",
      incremental: "pending",
      publish: "pending",
    };
    expect(readyNodes(g, states, {})).toEqual([]);
    expect(skippableNodes(g, states, {})).toEqual([]);
  });

  it("runs only the branch that was taken, and skips the other", () => {
    const states: NodeStates = {
      check: "succeeded",
      full: "pending",
      incremental: "pending",
      publish: "pending",
    };
    const branches = { check: "true" as const };
    expect(readyNodes(g, states, branches)).toEqual(["full"]);
    expect(skippableNodes(g, states, branches)).toEqual(["incremental"]);
  });

  it("a step downstream of both branches still runs on the live one", () => {
    const states: NodeStates = {
      check: "succeeded",
      full: "succeeded",
      incremental: "skipped",
      publish: "pending",
    };
    expect(readyNodes(g, states, { check: "true" })).toEqual(["publish"]);
  });

  it("refuses a condition that decides nothing", () => {
    const dead = { nodes: [condNode("c", "1 == 1")], edges: [] };
    expect(validateWorkflow({ name: "w", graph: dead })).toMatch(/decides nothing/);
  });

  it("refuses a branch label on an arrow that leaves anything else", () => {
    const bad = {
      nodes: [node("a"), node("b")],
      edges: [{ from: "a", to: "b", branch: "true" as const }],
    };
    expect(validateWorkflow({ name: "w", graph: bad })).toMatch(/Only a condition/);
  });
});

describe("the condition language, which is deliberately tiny", () => {
  it("compares numbers as numbers and text as text", () => {
    expect(evaluateCondition("{{ params.n }} > 5", { n: "10" })).toEqual({ ok: true, value: true });
    expect(evaluateCondition("{{ params.n }} > 5", { n: "2" })).toEqual({ ok: true, value: false });
    expect(evaluateCondition("{{ params.env }} == prod", { env: "prod" })).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateCondition("10 > 5", {})).toEqual({ ok: true, value: true });
  });

  it("reads a bare flag, so a boolean parameter needs no operator", () => {
    expect(evaluateCondition("{{ params.full }}", { full: "true" })).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateCondition("{{ params.full }}", { full: "no" })).toEqual({
      ok: true,
      value: false,
    });
  });

  it("refuses rather than guessing", () => {
    expect(evaluateCondition("{{ params.x }} > yesterday", { x: "3" }).ok).toBe(false);
    expect(evaluateCondition("something odd", {}).ok).toBe(false);
  });
});

describe("parameters", () => {
  it("fills a placeholder and leaves an unknown one visible", () => {
    // Deliberate: a SQL statement that silently loses its date filter and
    // scans all history is worse than one that fails with the placeholder in
    // the error.
    expect(substituteParams("where day >= '{{ params.since }}'", { since: "2026-01-01" })).toBe(
      "where day >= '2026-01-01'",
    );
    expect(substituteParams("{{ params.nope }}", {})).toBe("{{ params.nope }}");
  });

  it("takes declared defaults and lets the run override them", () => {
    const g: WorkflowGraph = {
      nodes: [],
      edges: [],
      params: [
        { name: "since", default: "2026-01-01" },
        { name: "env", default: "dev" },
      ],
    };
    expect(resolveParams(g)).toEqual({ since: "2026-01-01", env: "dev" });
    expect(resolveParams(g, { env: "prod" })).toEqual({ since: "2026-01-01", env: "prod" });
  });

  it("finds every parameter the graph refers to, wherever it hides", () => {
    const g: WorkflowGraph = {
      nodes: [
        sqlNode("s", "select {{ params.col }}"),
        httpNode("h", {
          method: "POST",
          url: "https://x.test/{{ params.path }}",
          headers: { "X-Run": "{{ params.env }}" },
          body: '{"since":"{{ params.since }}"}',
        }),
      ],
      edges: [],
    };
    expect(referencedParams(g)).toEqual(["col", "env", "path", "since"]);
  });
});

describe("conditions are assembled, not typed", () => {
  // The engine still evaluates a string. The builder is the only thing that
  // writes one, so the property that matters is that a saved comparison comes
  // back as the SAME comparison — reopening a step must not quietly change
  // what it tests.
  const trip = (text: string) => formatCondition(parseCondition(text));

  it("round-trips every shape the language admits", () => {
    for (const text of [
      "{{ params.full_refresh }} == true",
      "{{ params.rows }} >= 100",
      "{{ params.a }} != {{ params.b }}",
      "{{ params.env }} == prod",
      "{{ params.full_refresh }}",
      "5 < 10",
    ]) {
      expect(trip(text)).toBe(text);
    }
  });

  it("reads a comparison into parts a form can edit", () => {
    const c = parseCondition("{{ params.rows }} >= 100");
    expect(c).toEqual({
      mode: "compare",
      left: { from: "param", name: "rows" },
      op: ">=",
      right: { from: "value", value: "100" },
    });
  });

  it("reads a bare flag as a flag, not a broken comparison", () => {
    expect(parseCondition("{{ params.full_refresh }}")).toEqual({
      mode: "flag",
      left: { from: "param", name: "full_refresh" },
    });
  });

  it("never loses an expression it cannot take apart", () => {
    // Total on purpose: whatever is in a saved step survives being opened.
    const odd = "something nobody meant";
    expect(parseCondition(odd)).toEqual({ mode: "flag", left: { from: "value", value: odd } });
    expect(trip(odd)).toBe(odd);
  });

  it("quotes a value that would otherwise be re-read as an operator", () => {
    const built = formatCondition({
      mode: "compare",
      left: { from: "param", name: "note" },
      op: "==",
      right: { from: "value", value: "a>b" },
    });
    expect(built).toBe('{{ params.note }} == "a>b"');
    // And the evaluator agrees, which is the whole point of quoting it.
    expect(evaluateCondition(built, { note: "a>b" })).toEqual({ ok: true, value: true });
  });

  it("hands the builder what the evaluator would have parsed", () => {
    // They call ONE splitter. If a step could display one comparison and run
    // another, every guarantee the builder offers is worthless.
    const src = rd("src/lib/workflows.ts");
    expect(src.match(/splitComparison\(/g)?.length).toBe(3); // one definition, two callers
  });

  it("does not let a parameter's value rewrite the comparison", () => {
    // FOUND BY A TEST. The split used to happen AFTER substitution, so a
    // value carrying ">" or "==" turned its own comparison into a different
    // one — the condition equivalent of an injection.
    const expr = "{{ params.env }} == prod";
    expect(evaluateCondition(expr, { env: "prod" })).toEqual({ ok: true, value: true });
    expect(evaluateCondition(expr, { env: "a>b" })).toEqual({ ok: true, value: false });
    expect(evaluateCondition(expr, { env: "x == prod" })).toEqual({ ok: true, value: false });
  });

  it("ignores an operator that is inside a quoted value", () => {
    expect(evaluateCondition('{{ params.note }} == "a>b"', { note: "a>b" })).toEqual({
      ok: true,
      value: true,
    });
  });
});

describe("nothing in the inspector asks for a notation", () => {
  it("builds the condition from controls rather than a text box", () => {
    const src = rd("src/components/workflows/StepInspector.tsx");
    expect(src).toContain("<ConditionBuilder");
    // The old free-text expression field is gone.
    expect(src).not.toContain('label="Expression"');
    expect(src).not.toContain("params.full_refresh }} == true");
  });

  it("edits HTTP headers as rows, and offers secrets by name", () => {
    const src = rd("src/components/workflows/StepInspector.tsx");
    expect(src).toContain("<HeaderRows");
    // Nobody types the `Name: value` shape or the secret spelling any more.
    expect(src).not.toContain("Headers (one per line)");
    expect(src).not.toContain("Bearer {{secret:CI_TOKEN}}");
    const fields = rd("src/components/workflows/inspectorFields.tsx");
    expect(fields).toContain("`{{secret:${s}}}`");
  });

  it("cannot strand a filter with no box left to clear it", () => {
    // FOUND FROM THE UI. The search appears only past a threshold; deleting
    // workflows back below it took the box away and left its text filtering,
    // so the list said "0 of 4" with nothing on screen able to undo it. One
    // flag now gates both the box and the filter.
    const src = rd("src/routes/_authenticated/workflows.tsx");
    expect(src).toContain("const searchable = workflows.length > WORKFLOW_SEARCH_FROM;");
    expect(src).toContain('const q = searchable ? listQuery.trim().toLowerCase() : "";');
    expect(src).toContain("{searchable ? (");
    // And the threshold is not applied anywhere else, which is how they drift.
    expect(src.match(/WORKFLOW_SEARCH_FROM/g)?.length).toBe(2); // the declaration, and one use
  });

  it("never offers the open workflow as its own sub-workflow", () => {
    // FOUND FROM THE UI. The server already excludes it, and `missingTargets`
    // refuses it at save — but a candidates reply for the previous selection
    // could land after this one and put it back in the picker.
    const src = rd("src/routes/_authenticated/workflows.tsx");
    expect(src).toContain("workflows: res.workflows.filter((w) => w.id !== selectedId)");
    // Belt and braces: the save refuses it whatever the picker showed.
    const fns = rd("src/utils/workflows.functions.ts");
    expect(fns).toContain('return "A workflow cannot run itself";');
  });

  it("cannot start a second run of a workflow already running", () => {
    // This is also what bounds an INDIRECT cycle: A -> B -> A finds A's own
    // run still `running` and is refused, so the chain terminates instead of
    // starting runs forever.
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toMatch(
      /\.eq\("workflow_id", workflow\.id\)[\s\S]{0,120}?\.eq\("state", "running"\)/,
    );
    expect(src).toContain('return { ok: false, error: "This workflow is already running" };');
  });

  it("does not let a stale read overwrite a newer selection", () => {
    // FOUND FROM THE UI. Clicking a workflow while the previous one was still
    // loading left whichever response landed last in the editor — one
    // workflow's graph under another's name, and Save would write it over.
    const src = rd("src/routes/_authenticated/workflows.tsx");
    expect(src).toMatch(/let live = true;[\s\S]{0,400}?if \(!live\) return;/);
    expect(src).toMatch(/if \(!live\) return;[\s\S]{0,900}?live = false;/);
  });

  it("does not delete a header row that has no name yet", () => {
    // FOUND FROM THE UI. Choosing the secret before typing the header name
    // made the row disappear, because every edit filtered out blank names.
    const fields = rd("src/components/workflows/inspectorFields.tsx");
    expect(fields).toContain(
      "const write = (next: [string, string][]) => onChange(Object.fromEntries(next));",
    );
    // Safe because the request builder already skips a blank name.
    const http = rd("src/utils/swarmNodes.server.ts");
    expect(http).toContain("if (!h.key.trim()) continue;");
  });

  it("ticks SQL models from the ones that exist", () => {
    const src = rd("src/components/workflows/StepInspector.tsx");
    expect(src).toContain("<ModelPicker");
    expect(src).not.toContain('placeholder="orders_daily, customers"');
    // A selected model that has since been deleted is shown, not dropped.
    const fields = rd("src/components/workflows/inspectorFields.tsx");
    expect(fields).toContain("no longer exists");
  });

  it("offers parameters instead of expecting the placeholder spelling", () => {
    const src = rd("src/components/workflows/StepInspector.tsx");
    // Every free-text field that accepts a parameter uses the templated one.
    for (const label of ["Statement", "Message", "What to ask", "URL", "Body", "Input"]) {
      expect(src).toContain(`label="${label}"`);
    }
    expect(src).toContain("<TemplatedText");
  });

  it("sends secret NAMES to the browser and never a value", () => {
    const src = rd("src/utils/workflows.functions.ts");
    expect(src).toMatch(/from\("user_secrets"\)\s*\.select\("name"\)/);
    expect(src).not.toMatch(/from\("user_secrets"\)[\s\S]{0,80}?select\([^)]*value/);
  });
});

describe("retries", () => {
  it("backs off exponentially and stops doubling at an hour", () => {
    const n = node("a", { retryBackoffSeconds: 60 });
    expect(retryDelaySeconds(n, 1)).toBe(60);
    expect(retryDelaySeconds(n, 2)).toBe(120);
    expect(retryDelaySeconds(n, 3)).toBe(240);
    expect(retryDelaySeconds(n, 20)).toBe(3600);
  });

  it("refuses a retry count nobody meant", () => {
    const g = { nodes: [node("a", { retries: 99 })], edges: [] };
    expect(validateWorkflow({ name: "w", graph: g })).toMatch(/more than 10 retries/);
  });
});

describe("what each new kind of step needs before it can be saved", () => {
  const cases: [WorkflowNodeKind, RegExp][] = [
    ["sql", /no statement/],
    ["condition", /no expression/],
    ["notify", /no message/],
    ["wait", /no duration/],
    ["http", /no URL/],
    ["swarm", /nothing selected/],
    ["dashboard_refresh", /nothing selected/],
    ["sub_workflow", /nothing selected/],
  ];
  for (const [kind, expected] of cases) {
    it(`refuses an unconfigured ${kind} step`, () => {
      const g = { nodes: [{ id: "a", kind, label: "" }], edges: [] };
      expect(validateWorkflow({ name: "w", graph: g })).toMatch(expected);
    });
  }

  it("refuses an HTTP step pointed at something that is not a URL", () => {
    const g = {
      nodes: [httpNode("a", { method: "GET", url: "file:///etc/passwd" })],
      edges: [],
    };
    expect(validateWorkflow({ name: "w", graph: g })).toMatch(/http or https/);
  });

  it("refuses a wait longer than a day", () => {
    const g = {
      nodes: [{ id: "a", kind: "wait" as const, label: "", waitSeconds: 999999 }],
      edges: [],
    };
    expect(validateWorkflow({ name: "w", graph: g })).toMatch(/at most 24 hours/);
  });

  it("accepts a fully configured step of every kind", () => {
    for (const kind of NODE_KINDS) {
      let n: WorkflowNode = { id: "a", kind, label: "", targetId: "t" };
      let nodes: WorkflowNode[] = [n];
      let edges: WorkflowEdge[] = [];
      if (kind === "sql") n = sqlNode("a", "select 1");
      if (kind === "notify") n = { id: "a", kind, label: "", text: "done" };
      if (kind === "wait") n = { id: "a", kind, label: "", waitSeconds: 30 };
      if (kind === "http") n = httpNode("a", { method: "GET", url: "https://example.test/hook" });
      if (kind === "sql_models") n = { id: "a", kind, label: "", models: [] };
      if (kind === "approval") n = { id: "a", kind, label: "Sign off" };
      if (kind === "condition") {
        n = condNode("a", "1 == 1");
        nodes = [n, node("b")];
        edges = [{ from: "a", to: "b" }];
      } else {
        nodes = [n];
      }
      expect(validateWorkflow({ name: "w", graph: { nodes, edges } }), kind).toBeNull();
    }
  });
});

describe("a failure the author declared acceptable does not redden the run", () => {
  it("counts only failures that were not opted out of", () => {
    const g: WorkflowGraph = {
      nodes: [node("load"), node("refresh", { continueOnFailure: true })],
      edges: [{ from: "load", to: "refresh" }],
    };
    expect(runOutcome({ load: "succeeded", refresh: "failed" }, g)).toBe("succeeded");
    expect(runOutcome({ load: "failed", refresh: "succeeded" }, g)).toBe("failed");
    // Without the graph it cannot know, and errs toward red.
    expect(runOutcome({ load: "succeeded", refresh: "failed" })).toBe("failed");
  });
});

const rd = (path: string) => readFileSync(path, "utf8");

describe("the wiring", () => {
  it("owns its tables, owner-only and audited on shape", () => {
    const sql = rd("supabase/migrations/20260893000000_workflows.sql");
    for (const t of ["workflows", "workflow_runs", "workflow_node_runs"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("auth.uid() = user_id");
    expect(sql).toContain("audit_row_change('workflow')");
    // Runs are written by the server only, so a client cannot forge a green
    // one: the owner gets SELECT and nothing else.
    expect(sql).toContain('CREATE POLICY "Users read own workflow runs"');
    expect(sql).toContain("ON public.workflow_runs FOR SELECT");
    // The graph is pinned onto the run, the way a pipeline pins its code.
    expect(sql).toMatch(/workflow_runs[\s\S]*graph jsonb NOT NULL/);
  });

  it("normalises four different words for the same outcome", () => {
    const src = rd("src/utils/workflows/adapters.server.ts");
    // Each subsystem's own vocabulary, mapped in one place.
    expect(src).toContain('["queued", "running", "retrying"]'); // ETL
    expect(src).toContain('status === "success"'); // SQL model build
    expect(src).toContain('["queued", "starting", "ready", "running"]'); // notebook sandbox
    // A partial build is a failure: downstream tables are stale.
    expect(src).toContain("partial");
    // A row that vanished is failed, not "still running" — otherwise the
    // workflow waits forever on something that was deleted under it.
    expect(src).toContain("is no longer there");
  });

  it("polls the right ML table for the kind of job it started", () => {
    const src = rd("src/utils/workflows/adapters.server.ts");
    // runMlSchedule's id is polymorphic, so the kind travels with it.
    expect(src).toContain("`${schedule.kind}:${res.refId}`");
    expect(src).toContain('mlKind === "batch_predict" ? "ml_predictions" : "ml_training_jobs"');
  });

  it("claims each step before starting it, so replicas cannot double-start", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain('state: "running", started_at: new Date().toISOString(), retry_at: null');
    expect(src).toContain('.eq("state", "pending")');
    // And the scheduler claim is the clock advance, as everywhere else.
    expect(src).toContain("next_run_at: nextWorkflowRunAt(");
    expect(src).toContain('claim.eq("next_run_at", workflow.next_run_at)');
  });

  it("gives up on a step that never reports rather than waiting forever", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain("WORKFLOW_STEP_TIMEOUT_MINUTES");
    expect(src).toContain("did not finish in time");
  });

  it("refuses a second run of the same graph while one is in flight", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain("already running");
  });

  it("the database admits every kind the model declares", () => {
    // FOUND FROM THE UI, the hard way. The engine grew from four kinds to
    // fifteen and this CHECK did not come with it, so a graph containing a
    // condition saved happily, drew on the canvas, and failed the instant
    // anybody ran it — with a Postgres constraint name where a reason should
    // have been. The two lists are pinned against each other now.
    const migrations = readdirSync("supabase/migrations")
      .sort()
      .filter((f) =>
        readFileSync(`supabase/migrations/${f}`, "utf8").includes("workflow_node_runs_kind_check"),
      );
    const sql = readFileSync(`supabase/migrations/${migrations[migrations.length - 1]}`, "utf8");
    const block = sql.slice(sql.lastIndexOf("kind IN ("));
    const admitted = new Set(
      [...block.slice(0, block.indexOf(")")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    );
    for (const kind of NODE_KINDS) {
      expect(admitted.has(kind), `the CHECK does not admit "${kind}"`).toBe(true);
    }
    expect(admitted.size).toBe(NODE_KINDS.length);
  });

  it("can start every kind it declares, and poll the ones that need it", () => {
    // A kind in the model with no adapter is a step that saves, draws on the
    // canvas, and fails the moment anybody runs it.
    const src = rd("src/utils/workflows/adapters.server.ts");
    for (const kind of NODE_KINDS) {
      expect(src, `no adapter branch for ${kind}`).toContain(`case "${kind}":`);
    }
  });

  it("does not hold the caller while a long job runs", () => {
    // A swarm or a lakehouse statement resolves only when the whole job is
    // done. Awaiting one inside the advancer would turn "start the run" into a
    // request that hangs for minutes.
    const src = rd("src/utils/workflows/adapters.server.ts");
    expect(src).toContain("function detach(");
    expect(src).toContain("export const DETACHED");
    for (const kind of ["sql", "swarm", "prep_flow", "dashboard_refresh", "data_monitor"]) {
      expect(src, `${kind} should be detached`).toMatch(
        new RegExp(`case "${kind}":[\\s\\S]{0,900}?return detach\\(`),
      );
    }
    // And a detached step is never polled — its own promise settles it.
    expect(src).toContain("if (targetRunId === DETACHED) return { done: false }");
  });

  it("runs a swarm's PUBLISHED graph, not the draft on the canvas", () => {
    const src = rd("src/utils/workflows/adapters.server.ts");
    expect(src).toContain("resolveDeployedGraph");
    // An unattended run has nobody to answer an approval node.
    expect(src).toContain("rejectApprovals: true");
  });

  it("treats a data monitor's alert as a failure, on purpose", () => {
    const src = rd("src/utils/workflows/adapters.server.ts");
    expect(src).toMatch(/case "data_monitor":[\s\S]{0,900}?res\.status === "ok"/);
  });

  it("retries in place, so a step stays one row however many tries", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain("attempt: row.attempt + 1");
    expect(src).toContain("retry_at:");
    // The retry claim is conditional, so two replicas cannot both schedule it.
    expect(src).toMatch(/attempt: row\.attempt \+ 1[\s\S]{0,600}?\.eq\("state", "running"\)/);
    // And a step still inside its backoff is not ready.
    expect(src).toContain("if (row.retry_at && Date.parse(row.retry_at) > nowMs) continue;");
  });

  it("retries a step that failed inside its own start call", () => {
    // FOUND FROM THE UI. An HTTP step with retries=2 pointed at a 500 failed
    // once and stopped, because the three shapes of work did not all fail
    // through the same door: a started-then-polled step reached `settleStep`,
    // but a step that resolves WITHIN `startNode` had its verdict written
    // straight into the patch. The immediate kinds are HTTP, SQL and notify —
    // the very ones a retry is for.
    const src = rd("src/utils/workflows/run.server.ts");
    // The patch that records a start no longer carries a verdict at all.
    const patch = src.slice(
      src.indexOf("const patch: {"),
      src.indexOf("await supabaseAdmin", src.indexOf("const patch: {")),
    );
    expect(patch).not.toContain("state?:");
    expect(patch).not.toContain("finished_at?:");
    // And the settled branch goes through the retry path.
    expect(src).toMatch(
      /if \(started\.settled\)[\s\S]{0,700}?await settleStep\([\s\S]{0,120}?started\.settled\.error/,
    );
  });

  it("gives the whole run a ceiling, not just each step", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain("exceeded its time limit");
    expect(src).toContain("timeout_minutes");
  });

  it("pins the parameters onto the run, as it pins the graph", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain("params: params as unknown as Json");
    expect(src).toContain("resolveParams(graph");
  });

  it("re-runs from the failed step, keeping what already worked", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain("export async function rerunWorkflowRun");
    expect(src).toContain('.filter((s) => s.state === "succeeded")');
    // The repeat uses the ORIGINAL run's parameters, not today's defaults.
    expect(src).toContain("params: (prior.params ?? {}) as Record<string, string>");
  });

  it("understands a cron expression, with its timezone", () => {
    const src = rd("src/utils/workflows/run.server.ts");
    expect(src).toContain("nextCronOccurrence(cronExpr, timezone, from)");
    // A broken expression must not wedge the sweep for everyone else.
    expect(src).toMatch(/catch \{[\s\S]{0,400}?return null;/);
  });

  it("has an API trigger built like the pipeline one, down to the refusals", () => {
    const route = rd("src/routes/api/workflows.run.ts");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain('token.startsWith("wfk_")');
    // ONE undifferentiated 404, so a valid token for A cannot enumerate B.
    expect(route).toMatch(/!workflow \|\|[\s\S]{0,200}?"Not found" \}, 404\)/);
    expect(route).toContain("rateLimitedGlobal");
    expect(route).toContain("202");
    // The plaintext is never stored.
    const adapters = rd("src/utils/workflows/adapters.server.ts");
    expect(adapters).toContain("export function mintTriggerToken");
    expect(adapters).toContain('createHash("sha256")');
    // And never sent back to the browser either.
    const fns = rd("src/utils/workflows.functions.ts");
    expect(fns).toContain("has_trigger_token: Boolean(row.trigger_token_hash)");
    expect(fns).not.toMatch(/trigger_token_hash: (row|String)/);
  });

  it("offers, and re-checks, only the caller's own things", () => {
    const fns = rd("src/utils/workflows.functions.ts");
    for (const table of [
      "etl_pipelines",
      "ml_schedules",
      "user_python_notebooks",
      "swarms",
      "user_prep_flows",
      "bi_dashboards",
      "data_monitors",
    ]) {
      expect(fns, `candidates omit ${table}`).toContain(`.from("${table}")`);
    }
    expect(fns).toContain("missingTargets");
    // A workflow is not offered as its own sub-workflow.
    expect(fns).toContain("A workflow cannot run itself");
  });

  it("lets an arrow be drawn before the steps it joins are configured", () => {
    // FOUND FROM THE UI. onConnect ran the WHOLE validator, so joining two
    // steps was refused because an unrelated step further up the canvas had
    // not been filled in — which is exactly the order people build a graph.
    // A cycle is the one thing this arrow itself causes, so it is the one
    // thing checked here.
    const page = rd("src/routes/_authenticated/workflows.tsx");
    expect(page).toMatch(
      /const onConnect[\s\S]{0,1400}?topoOrder\(\{ \.\.\.graph, edges: next \}\)/,
    );
    expect(page).not.toMatch(/const onConnect[\s\S]{0,1400}?validateWorkflow\(/);
  });

  it("the palette is a grouped column, not a row of fifteen buttons", () => {
    // FOUND FROM THE UI. Fifteen buttons above the canvas wrapped onto three
    // lines, pushed the graph down the screen, and said nothing about which
    // of them belonged together.
    const palette = rd("src/components/workflows/WorkflowPalette.tsx");
    expect(palette).toContain("KIND_GROUPS");
    const styles = rd("src/components/workflows/nodeStyles.ts");
    // Every kind gets its own colour, so a family reads at a glance.
    for (const kind of NODE_KINDS) {
      expect(styles, `no style for ${kind}`).toContain(`${kind}: {`);
    }
    const page = rd("src/routes/_authenticated/workflows.tsx");
    expect(page).toContain("<WorkflowPalette");
    expect(page).toContain("h-canvas");
  });

  it("rides the one scheduler sweep, in both halves", () => {
    const cron = rd("src/utils/bi/refresh.server.ts");
    expect(cron).toContain("processDueWorkflows(force)");
    expect(cron).toContain("advanceLiveWorkflowRuns()");
    // Counted, so an operator can see the sweep doing it.
    expect(cron).toContain("workflow_runs: number;");
    expect(cron).toContain("workflow_steps: number;");
  });

  it("only ever offers, and starts, the caller's own work", () => {
    const fns = rd("src/utils/workflows.functions.ts");
    expect(fns).toContain("resolveCaller");
    expect(fns).toContain("missingTargets");
    const adapters = rd("src/utils/workflows/adapters.server.ts");
    // Every start re-checks ownership at run time too, not just at save.
    expect(adapters.match(/\.eq\("user_id", userId\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("names a step by what it runs, rather than by its type four times over", () => {
    // FOUND FROM THE UI. A new step arrived pre-labelled with its kind, and
    // the picker only fills a label that is empty — so a graph of four SQL
    // model steps was four steps all called "SQL models".
    const page = rd("src/routes/_authenticated/workflows.tsx");
    expect(page).toContain('label: ""');
    expect(page).toContain("{node.label || NODE_KIND_LABEL[node.kind]}");
    // And the run row still gets a readable label rather than a raw id.
    expect(rd("src/utils/workflows/run.server.ts")).toContain(
      "label: n.label || NODE_KIND_LABEL[n.kind]",
    );
  });

  it("clears the editor and the run panel when a workflow is deleted", () => {
    // FOUND FROM THE UI. Deleting left the step editor and the run list of a
    // workflow that no longer exists sitting beside an empty list.
    const page = rd("src/routes/_authenticated/workflows.tsx");
    expect(page).toMatch(
      /Workflow deleted[\s\S]{0,400}setGraph\(\{ nodes: \[\], edges: \[\], params: \[\] \}\)/,
    );
  });

  it("refreshes the list when a run ends, so the card is not stale", () => {
    // FOUND FROM THE UI. The card carries the last run's status; watching a
    // run go green left the card still saying "failed" from the run before.
    const page = rd("src/routes/_authenticated/workflows.tsx");
    expect(page).toMatch(/state !== "running"[\s\S]{0,320}void reload\(\)/);
  });

  it("reaches the UI: a page, a nav entry, and the same canvas the ETL builder uses", () => {
    const nav = rd("src/lib/appNav.ts");
    expect(nav).toContain('{ title: "Workflows", url: "/workflows", icon: Workflow }');
    const page = rd("src/routes/_authenticated/workflows.tsx");
    expect(page).toContain('createFileRoute("/_authenticated/workflows")');
    expect(page).toContain('from "@xyflow/react"');
    // Full-height route: the app shell is min-h-screen, so h-full resolves to
    // nothing and the columns would grow the window.
    expect(page).toContain("h-canvas");
    // The run paints its state onto the same graph the editor draws.
    expect(page).toContain("STATE_STYLE");
  });
});
