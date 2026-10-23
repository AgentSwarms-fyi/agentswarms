// Unsaved edits in the workflow editor (R268). The editor kept no record of
// what was saved, so picking another workflow loaded it over unsaved steps
// without asking, creating one did the same, and deleting a DIFFERENT workflow
// from the list emptied the editor too.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { savedForm, type WorkflowEditorSettings, type WorkflowGraph } from "@/lib/workflows";

const settings: WorkflowEditorSettings = {
  name: "Nightly load",
  schedule: "daily",
  cronExpr: "",
  timezone: "UTC",
  overlap: "skip",
  notifyOn: "failure",
  timeoutMinutes: 720,
  isActive: true,
};
const graph: WorkflowGraph = {
  nodes: [{ id: "a", kind: "pipeline", label: "Load", targetId: "p1" }],
  edges: [],
};

describe("savedForm", () => {
  const base = savedForm(settings, graph);

  it("is the same for the same workflow, with or without the token flag", () => {
    expect(savedForm({ ...settings }, { ...graph })).toBe(base);
    expect(savedForm({ ...settings, hasToken: true } as WorkflowEditorSettings, graph)).toBe(base);
    // A graph stored without params is the same as one with none.
    expect(savedForm(settings, { ...graph, params: [] })).toBe(base);
  });

  it("changes with anything Save writes", () => {
    const b = { ...graph.nodes[0], id: "b" };
    for (const [what, s, g] of [
      ["a step", settings, { ...graph, nodes: [...graph.nodes, b] }],
      ["an edge", settings, { ...graph, edges: [{ from: "a", to: "a" }] }],
      ["a parameter", settings, { ...graph, params: [{ name: "day" }] }],
      ["the name", { ...settings, name: "Nightly load 2" }, graph],
      ["the schedule", { ...settings, schedule: "hourly" }, graph],
      ["the time limit", { ...settings, timeoutMinutes: 60 }, graph],
      ["switched off", { ...settings, isActive: false }, graph],
    ] as const) {
      expect(savedForm(s, g as WorkflowGraph), what).not.toBe(base);
    }
  });
});

describe("the editor", () => {
  const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/workflows.tsx"), "utf8");

  it("records what was loaded and what a save sent", () => {
    expect(src).toContain("setSavedAs(savedForm(loaded, loadedGraph));");
    expect(src).toContain("const sent = savedForm(settings, graph);");
    expect(src).toContain("setSavedAs(sent);");
  });

  it("asks before picking another workflow or creating one over unsaved edits", () => {
    expect(src).toContain("onClick={() => void pick(w.id)}");
    expect(src).not.toContain("onClick={() => setSelectedId(w.id)}");
    expect(src).toMatch(
      /await mayDiscard\("Creating a workflow[^"]*"\)[^\n]*\n\s*const res = await createFn/,
    );
  });

  it("asks only when something is unsaved, and a cancel keeps the open workflow", () => {
    expect(src).toMatch(
      /async function mayDiscard\(what: string\): Promise<boolean> \{\s*if \(!unsaved\) return true;[^]*?return Boolean\(\s*await confirmAsk\(/,
    );
    expect(src).toMatch(
      /async function pick\(id: string\) \{\s*if \(id === selectedId\) return;\s*if \(!\(await mayDiscard\([^)]*\)\)\) return;\s*setSelectedId\(id\);/,
    );
  });

  it("names the workflow by its saved name, not the edited one", () => {
    expect(src).toContain('title: `Discard the changes to "${savedName}"?`,');
    expect(src).toContain("workflows.find((w) => w.id === selectedId)?.name");
  });

  it("asks before a link leaves the page, and lets the browser ask before the tab closes (R269)", () => {
    expect(src).toMatch(
      /useBlocker\(\{\s*shouldBlockFn: async \(\) => !\(await mayDiscard\("Leaving this page drops them\."\)\),\s*enableBeforeUnload: unsaved,\s*disabled: !unsaved,\s*\}\);/,
    );
  });

  it("empties the editor only when the open workflow is the one deleted", () => {
    expect(src).toMatch(/if \(w\.id === selectedId\) \{\s*setSelectedId\(null\);/);
  });
});
