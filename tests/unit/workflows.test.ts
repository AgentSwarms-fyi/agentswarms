// One graph over work that kept four separate clocks.
//
// The decisions worth pinning are the ones a chain could never make: fan-out
// (two steps start at once), fan-in (a step waits for BOTH parents), and what
// happens downstream of a failure. The last one is where a naive runner does
// the wrong thing quietly — it either hangs forever waiting on a node that
// will never run, or calls the whole run green because the last step it
// happened to reach was fine.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EMPTY_GRAPH,
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
    expect(src).toContain('.update({ state: "running", started_at: new Date().toISOString() })');
    expect(src).toContain('.eq("state", "pending")');
    // And the scheduler claim is the clock advance, as everywhere else.
    expect(src).toContain("nextWorkflowRunAt(workflow.schedule)");
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
    expect(page).toMatch(/Workflow deleted[\s\S]{0,400}setGraph\(\{ nodes: \[\], edges: \[\] \}\)/);
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
