// A compiler fix has to reach the pipelines that already exist.
//
// The generated program is a CACHE of the graph, not the definition of it —
// but a run executed the cache. `source_code` is written by the compiler that
// happened to be running at the last save, and the editor recompiles only on
// save, where the button is disabled when nothing has changed. So after an
// upgrade every existing visual pipeline went on running the previous
// release's program, one by one, until somebody edited it for some other
// reason. Nothing said so; the runs kept succeeding.
//
// Found live, twice in one sitting, both times by a fix that had already been
// deployed and verified:
//
//   * the SQL step moved off ibis onto duckdb — and a pipeline created before
//     the rebuild kept emitting `import ibis`, AND kept asking pip for
//     `ibis-framework`, because the stored requirements were stale too;
//   * the fqn a run reports for an object-storage target was corrected to the
//     filename dlt actually writes — and a pipeline created twenty minutes
//     earlier reported the old one, leaving a `catalog_lineage` edge pointing
//     at a file that does not exist while the asset beside it was right.
//
// The second is the one that shows why "it works after you re-save it" is not
// an answer: nobody had any reason to re-save it, and the symptom was a
// lineage panel that had quietly gone blank.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compilePipeline, pipelineRequirements } from "@/utils/etl/compile";
import type { EtlGraph } from "@/utils/etl/codegen";

const service = readFileSync("src/utils/etl/service.server.ts", "utf8");

/** The body of one exported function in service.server.ts. */
function fn(name: string): string {
  const at = service.indexOf(`export async function ${name}(`);
  expect(at, `${name} was renamed; re-anchor this test`).toBeGreaterThan(-1);
  const end = service.indexOf("\nexport ", at + 10);
  const body = service.slice(at, end > -1 ? end : service.length);
  expect(body.length).toBeGreaterThan(300);
  return body;
}

describe("what a run executes", () => {
  const body = fn("startEtlRun");

  it("recompiles a visual pipeline's graph instead of running the stored program", () => {
    expect(body).toContain('if (pipeline.mode === "visual") {');
    expect(body).toContain("sourceCode = compilePipeline(graph, engineOf(pipeline.engine));");
    // And the recompiled program is what the run row pins — pinning the stale
    // one and compiling for nothing would be the same bug with more steps.
    expect(body).toContain("source_code: sourceCode,");
    expect(body).not.toContain("source_code: pipeline.source_code,");
  });

  it("starts from the stored program, so a code pipeline is untouched", () => {
    // A code-mode pipeline HAS no graph to recompile: its source is what
    // somebody typed, and regenerating it would be an entirely different
    // product. The recompile is gated on the mode for that reason.
    expect(body).toContain("let sourceCode = pipeline.source_code;");
    const at = body.indexOf("let sourceCode = pipeline.source_code;");
    const gate = body.indexOf('if (pipeline.mode === "visual") {');
    expect(at).toBeLessThan(gate);
  });

  it("refuses with the compiler's own sentence when the graph no longer compiles", () => {
    // A graph the CURRENT compiler rejects must not run under rules it now
    // fails — and the message the canvas would have shown is the one worth
    // repeating, which is the same choice the empty-source_code path made.
    const at = body.indexOf("sourceCode = compilePipeline(");
    const after = body.slice(at, at + 220);
    expect(after).toContain("} catch (e) {");
    expect(after).toContain("return { ok: false, error: (e as Error).message };");
  });
});

describe("what a run installs", () => {
  const body = fn("etlEnvFor");

  it("derives a visual pipeline's packages from its graph, for its engine", () => {
    expect(body).toContain('pipeline.mode === "visual" ? normalizeGraph(pipeline.graph) : null');
    expect(body).toContain("pipelineRequirements(graph, engineOf(pipeline.engine))");
  });

  it("leaves a code pipeline's hand-typed list alone", () => {
    expect(body).toContain(': (pipeline.requirements ?? "")');
  });
});

// ── Why the engine has to be part of both answers ───────────────────────────

const graph = (): EtlGraph =>
  ({
    nodes: [
      {
        id: "n1",
        kind: "source",
        label: "facts",
        config: { type: "lakehouse", schema: "analytics", mode: "table", table: "revenue_facts" },
      },
      {
        id: "n2",
        kind: "transform",
        label: "top",
        config: { type: "sql", query: "SELECT * FROM t WHERE orders >= 30" },
      },
      {
        id: "n3",
        kind: "target",
        label: "out",
        config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "replace" },
      },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("the two engines do not want the same things", () => {
  it("compiles one graph two ways", () => {
    const pandas = compilePipeline(graph(), "pandas");
    const spark = compilePipeline(graph(), "spark");
    expect(pandas).toContain("def _sql_over(df, query):");
    expect(spark).not.toContain("def _sql_over(df, query):");
  });

  it("asks pip for different packages, which is why the run derives them", () => {
    // The canvas writes requirements with the PANDAS list on every edit,
    // whatever the engine — `requirementsFor(graph)`, hard-coded at the
    // onChange — so a Spark pipeline's stored list was the wrong one. Deriving
    // at run time, for the engine the run uses, settles it.
    const pandas = pipelineRequirements(graph(), "pandas");
    const spark = pipelineRequirements(graph(), "spark");
    // A lakehouse target on Spark clears its staging prefix through fsspec;
    // the pandas engine never asks for s3fs on this graph.
    expect(spark).toMatch(/^s3fs/m);
    expect(pandas).not.toMatch(/^s3fs/m);
    // And the SQL step's engine is in the pandas list, where the step runs.
    expect(pandas).toMatch(/duckdb/);
  });
});
