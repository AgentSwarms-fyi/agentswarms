// A workflow's status vouches only for the graph its last run ran (R184).
//
// FOUND IN R184 (sweep item 2; the ETL chip was R183). Driven: a workflow with
// one SQL step (`SELECT 184 AS r184`) ran and read "succeeded"; its statement
// became `SELECT * FROM analytics.r184_no_such_table`, the save said "Saved",
// and the list still read "succeeded". Each run pins its graph on
// `workflow_runs.graph`, so the list compares that with the graph now, and
// only what a run executes counts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { executableGraph, workflowChangedSinceRun } from "@/lib/workflowDrift";

const RAN = {
  nodes: [
    { id: "a", kind: "sql", label: "Load", text: "SELECT 184 AS r184", x: 60, y: 60 },
    { id: "b", kind: "notify", label: "Tell", text: "done", retries: 2, x: 400, y: 60 },
  ],
  edges: [{ from: "a", to: "b" }],
  params: [{ name: "day", default: "today", description: "Which day" }],
};
const copy = () => JSON.parse(JSON.stringify(RAN)) as typeof RAN;

describe("what does not change a run", () => {
  it("moving a step, renaming it, or describing a parameter", () => {
    const g = copy();
    g.nodes[0].x = 900;
    g.nodes[0].y = 25.69;
    g.nodes[1].label = "Tell the team";
    g.params[0].description = "The day to load";
    expect(workflowChangedSinceRun(g, RAN)).toBe(false);
  });

  it("the order steps, arrows and keys were written in", () => {
    // Two graphs with three arrows, written in the opposite order, keys and
    // all (Postgres gives jsonb its own key order).
    const three = copy();
    three.nodes.push({
      id: "c",
      kind: "notify",
      label: "Also",
      text: "hi",
      retries: 0,
      x: 0,
      y: 0,
    });
    three.edges.push({ from: "a", to: "c" }, { from: "c", to: "b" });
    const reordered = JSON.parse(
      JSON.stringify({
        params: three.params,
        edges: [...three.edges].reverse().map((e) => ({ to: e.to, from: e.from })),
        nodes: [...three.nodes]
          .reverse()
          .map((n) => Object.fromEntries(Object.entries(n).reverse())),
      }),
    );
    expect(executableGraph(reordered)).toBe(executableGraph(three));
    // An arrow with no branch is the same arrow however it is written.
    const branchless = copy();
    branchless.edges = [{ from: "a", to: "b", branch: undefined } as never];
    expect(workflowChangedSinceRun(branchless, RAN)).toBe(false);
  });
});

describe("what does", () => {
  const changed = (edit: (g: ReturnType<typeof copy>) => void) => {
    const g = copy();
    edit(g);
    return workflowChangedSinceRun(g, RAN);
  };

  it("a step's statement (the driven edit)", () => {
    expect(changed((g) => (g.nodes[0].text = "SELECT * FROM analytics.r184_no_such_table"))).toBe(
      true,
    );
  });

  it("a step's retries, kind or what it runs", () => {
    expect(changed((g) => (g.nodes[1].retries = 0))).toBe(true);
    expect(changed((g) => (g.nodes[1].kind = "http"))).toBe(true);
  });

  it("a step added or removed, an arrow added, removed or given a branch", () => {
    expect(changed((g) => g.nodes.push({ ...g.nodes[1], id: "c" }))).toBe(true);
    expect(changed((g) => g.nodes.pop())).toBe(true);
    expect(changed((g) => (g.edges = []))).toBe(true);
    expect(changed((g) => ((g.edges[0] as { branch?: string }).branch = "true"))).toBe(true);
  });

  it("a parameter's default or name", () => {
    expect(changed((g) => (g.params[0].default = "yesterday"))).toBe(true);
    expect(changed((g) => (g.params[0].name = "date"))).toBe(true);
  });
});

describe("with nothing to compare", () => {
  it("claims nothing", () => {
    expect(workflowChangedSinceRun(RAN, null)).toBeNull();
    expect(workflowChangedSinceRun(RAN, undefined)).toBeNull();
  });
});

describe("the list", () => {
  const fns = readFileSync("src/utils/workflows.functions.ts", "utf8");
  const page = readFileSync("src/routes/_authenticated/workflows.tsx", "utf8");
  const list = fns.slice(
    fns.indexOf("export const workflowsList"),
    fns.indexOf("export const workflowGet"),
  );

  it("compares with the latest run started, which is the one the status is about", () => {
    expect(list).toMatch(
      /\.from\("workflow_runs"\)\s*\.select\("graph"\)\s*\.eq\("workflow_id", w\.id\)\s*\.order\("started_at", \{ ascending: false \}\)\s*\.limit\(1\)/,
    );
    expect(list).toMatch(/if \(!w\.last_run_status\) return null;/);
    // A read that failed claims nothing, rather than "unchanged".
    expect(list).toMatch(
      /return runErr \|\| !run \? null : workflowChangedSinceRun\(w\.graph, run\.graph\);/,
    );
    expect(list).toMatch(
      /workflows\.map\(\(w, i\) => \(\{ \.\.\.w, changed_since_last_run: drift\[i\] \}\)\)/,
    );
  });

  it("marks the workflow under its name", () => {
    expect(page).toMatch(/\{w\.changed_since_last_run && \(/);
    expect(page).toContain("changed since this run");
  });
});
