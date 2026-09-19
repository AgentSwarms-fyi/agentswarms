// The SQL transform runs on DuckDB, not on whatever ibis released this week.
//
// Found live, and it was a total break rather than an edge case: a pipeline
// ending in a SQL step failed with
//
//   File "<notebook>", line 51, in _sql_over
//     con.create_table(...)
//   _duckdb.ParserException: Parser Error: syntax error at end of input
//
// The query was `SELECT * FROM t WHERE orders >= 30 ORDER BY revenue DESC`,
// which DuckDB parses happily. The statement that failed was the one ibis
// generates to MATERIALISE the frame, before the query is ever seen.
// Reproduced outside the product, in the runtime image: ibis-framework 12.0.0
// against the image's pandas 3.0.5 fails on `create_table` for a three-column
// frame of strings, floats and ints.
//
// The requirement was `ibis-framework[duckdb]`, unpinned, so every new sandbox
// pulled whatever ibis had most recently released — the SQL step was broken on
// a fresh install and would have stayed broken.
//
// Pinning ibis would have worked. Dropping it works better: duckdb registers a
// pandas frame natively, is the engine the lakehouse already uses, and is in
// the runtime image, so the fix REMOVES a dependency instead of freezing one.
import { execFile, execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { compileGraph, compilePreview, requirementsFor, type EtlGraph } from "@/utils/etl/codegen";

/** A pandas+duckdb interpreter, or null. */
const RUNNER: { cmd: string; args: string[] } | null = (() => {
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["-c", "import pandas, duckdb"], { stdio: "ignore" });
      return { cmd: c, args: ["-"] };
    } catch {
      /* next */
    }
  }
  try {
    execFileSync("docker", ["image", "inspect", "agentswarms/notebook-runtime:latest"], {
      stdio: "ignore",
    });
    return {
      cmd: "docker",
      args: [
        "run",
        "--rm",
        "-i",
        "--entrypoint",
        "python",
        "agentswarms/notebook-runtime:latest",
        "-",
      ],
    };
  } catch {
    return null;
  }
})();

/**
 * How long the interpreter above is allowed, and it depends which one was found.
 *
 * A local interpreter is already warm: it imports pandas and duckdb into a
 * process that exists. The docker fallback starts a container from the runtime
 * image first, and that is a different order of magnitude — measured at 72s to
 * 79s with only three such files running, and these tests were timing out at
 * 120s under the whole suite in parallel, which is how CI runs them.
 *
 * A single flat number cannot serve both: generous enough for the container and
 * it stops catching a genuinely hung local run; tight enough for local and the
 * container path fails for reasons that have nothing to do with the code under
 * test. So the budget follows the runner, and a timeout here once again means
 * something went wrong rather than that the machine was busy.
 */
const RUNNER_TIMEOUT_MS = RUNNER?.cmd === "docker" ? 300_000 : 45_000;

/**
 * Run a snippet through the interpreter found above, returning its stdout.
 *
 * Asynchronously, and that is the whole point of the shape. `execFileSync`
 * blocks the worker's event loop for as long as python runs, so vitest's own
 * RPC back to the main thread goes unanswered and birpc gives up with
 * `Timeout calling "onTaskUpdate"`. Every test still passed and the run still
 * exited non-zero, which is a confusing way to fail. Spawning leaves the loop
 * free to answer while the container works.
 */
function runPython(runner: { cmd: string; args: string[] }, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      runner.cmd,
      runner.args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout),
    );
    child.stdin?.end(code);
  });
}

const sqlGraph = (): EtlGraph =>
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
        config: {
          type: "sql",
          query: "SELECT * FROM t WHERE orders >= 30 ORDER BY revenue DESC",
        },
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

describe("what the SQL step is built on", () => {
  it("registers the frame with duckdb", () => {
    const code = compileGraph(sqlGraph());
    expect(code).toContain("def _sql_over(df, query):");
    expect(code).toContain("import duckdb");
    expect(code).toContain("con.register('t', df)");
    expect(code).toContain("return con.sql(query).df()");
  });

  it("does not reach for ibis, in either compiler", () => {
    // Both emit `_sql_over`; the preview is a second compiler over the same
    // nodes, and a SQL step previewed through ibis would fail the same way.
    for (const code of [compileGraph(sqlGraph()), compilePreview(sqlGraph(), "n2")]) {
      expect(code).toContain("con.register('t', df)");
      expect(code).not.toContain("import ibis");
      expect(code).not.toContain("ibis.duckdb.connect()");
    }
  });

  it("asks pip for duckdb rather than an unpinned ibis", () => {
    const reqs = requirementsFor(sqlGraph());
    expect(reqs).toMatch(/duckdb/);
    expect(reqs).not.toMatch(/ibis-framework/);
  });
});

describe("the step, run", () => {
  it("answers the query the live pipeline asked", { timeout: RUNNER_TIMEOUT_MS }, async () => {
    if (!RUNNER) {
      console.warn("no pandas+duckdb and no runtime image; the SQL step was not exercised");
      return;
    }
    // The emitted body, verbatim, against a frame shaped like the aggregate
    // output that broke it: a string key, a float measure, an integer count.
    const out = await runPython(
      RUNNER,
      [
        "import pandas as pd",
        "",
        "def _sql_over(df, query):",
        "    import duckdb",
        "    con = duckdb.connect()",
        "    con.register('t', df)",
        "    return con.sql(query).df()",
        "",
        "df = pd.DataFrame({",
        "    'country': ['US', 'JP', 'XX'],",
        "    'revenue': [22587.56, 14860.71, 12.5],",
        "    'orders': [47, 34, 2],",
        "})",
        'got = _sql_over(df, "SELECT * FROM t WHERE orders >= 30 ORDER BY revenue DESC")',
        "print('rows:', len(got))",
        "print('order:', list(got['country']))",
        "print('cols:', list(got.columns))",
        "empty = _sql_over(df.iloc[0:0], 'SELECT * FROM t')",
        "print('empty rows:', len(empty), 'empty cols:', len(empty.columns))",
      ].join("\n"),
    );
    // The filter, the ordering and the shape all survive the round trip.
    expect(out).toContain("rows: 2");
    expect(out).toContain("order: ['US', 'JP']");
    expect(out).toContain("cols: ['country', 'revenue', 'orders']");
    // And a frame with columns but no rows is an ordinary empty result here,
    // not an error — the case the empty-tick guard hands through.
    expect(out).toContain("empty rows: 0 empty cols: 3");
  });
});
