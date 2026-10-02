// Pressing Run on a graph the editor refused must say what the editor said.
//
// A visual pipeline SAVES even when its graph does not compile — a draft is
// allowed to be half-wired, and the save toast carries the real sentence
// ("Source X uses auto-ingest AND an incremental cursor on updated_at…").
// Four seconds later that toast is gone. Press Run and the answer was
// "Pipeline has no code to run", which reads like the pipeline is empty and
// sends the reader to the code tab of a pipeline that has no code tab.
//
// The graph is still in the row. Recompiling it costs nothing and produces
// the one sentence that names the node and the column.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { analyzeGraph } from "@/utils/etl/codegen";

const service = readFileSync("src/utils/etl/service.server.ts", "utf8");

/** The `source_code` is empty branch of startEtlRun, and only that branch. */
function emptyCodeBranch(): string {
  const start = service.indexOf("export async function startEtlRun");
  expect(start, "startEtlRun was renamed; re-anchor this test").toBeGreaterThan(-1);
  const open = service.indexOf("if (!pipeline.source_code.trim()) {", start);
  expect(open, "the empty-source_code guard moved; re-anchor this test").toBeGreaterThan(-1);
  const end = service.indexOf("Pipeline has no code to run", open);
  expect(end).toBeGreaterThan(open);
  return service.slice(open, end);
}

describe("the run refusal explains itself", () => {
  it("recompiles the visual graph before falling back to the generic line", () => {
    const branch = emptyCodeBranch();
    expect(branch).toContain("normalizeGraph(pipeline.graph)");
    expect(branch).toMatch(/analyzeGraph\(graph\)/);
    expect(branch).toMatch(/return \{ ok: false, error: \(e as Error\)\.message \}/);
  });

  it("keeps the generic line as the fallback, not the first answer", () => {
    // Order matters: a graph that compiles but has no code still gets the
    // old sentence, and a pipeline with no graph at all is unchanged.
    const branch = emptyCodeBranch();
    expect(branch.indexOf("normalizeGraph")).toBeGreaterThan(-1);
    expect(service).toContain('return { ok: false, error: "Pipeline has no code to run" };');
  });
});

describe("what that recompile actually produces", () => {
  const clash = {
    nodes: [
      {
        id: "n1",
        kind: "source",
        label: "Object storage files",
        config: {
          type: "object_storage",
          source_id: "s1",
          path: "raw/revenue/orders/*.csv",
          format: "csv",
          new_files_only: true,
          incremental: { cursor_column: "updated_at" },
        },
      },
      {
        id: "n2",
        kind: "target",
        label: "Storage target",
        config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "append" },
      },
    ],
    edges: [{ from: "n1", to: "n2" }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it("names the node and the column the user actually set", () => {
    // The exact pair read off the canvas in the live round: the node the
    // person clicked and the column they typed.
    expect(() => analyzeGraph(clash)).toThrow(/Object storage files/);
    expect(() => analyzeGraph(clash)).toThrow(/updated_at/);
  });

  it("is a sentence someone can act on, not a status", () => {
    let message = "";
    try {
      analyzeGraph(clash);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/auto-ingest/i);
    expect(message).toMatch(/load only new FILES/);
    expect(message).toMatch(/load only new ROWS/);
    expect(message).not.toBe("Pipeline has no code to run");
  });
});
