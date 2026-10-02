// A read that found nothing must not fail the run.
//
// Found live. A Kafka pipeline — topic → filter → lakehouse — loaded 90 of 120
// messages on its first run, correctly. Its SECOND run, with the cursor at the
// high-water mark and nothing new to read, FAILED:
//
//   [etl] stream: 0 message(s)
//   KeyError: 'status'
//   ...pandas/core/computation/expr.py, line 541, in visit_BinOp
//
// The source did the right thing — it reported zero messages and left the
// offsets where they were. What it hands back is a frame with ZERO ROWS and
// its five metadata columns (_stream_topic, _stream_partition, _stream_offset,
// _stream_key, _stream_timestamp) — never the payload's. So
// `df.query("status == 'paid'")` raises rather than returning nothing, and
// every quiet tick of a caught-up stream was a failed run: on a schedule, a
// failure every interval once the backlog drains.
//
// The first guard written for this tested "no rows AND no columns" and did
// NOT fire, because those five metadata columns are columns. The live run
// failed again, identically, and said so. Row count is the honest test.
//
// The lakehouse target has skipped empty batches since it shipped; its own
// comment names the case ("a stream with nothing new"). The steps between the
// source and the target did not.
import { execFile, execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { compileGraph, compilePreview, type EtlGraph } from "@/utils/etl/codegen";

/**
 * A way to run pandas, or nothing.
 *
 * The host interpreter usually has no pandas, and the claim being checked is
 * about pandas' behaviour — so the runtime image, which is where the emitted
 * program actually runs, is the faithful place to check it. Tried in order:
 * a local interpreter that can import pandas, then the runtime image over
 * stdin, then skip loudly.
 */
const RUNNER: { cmd: string; args: string[] } | null = (() => {
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["-c", "import pandas"], { stdio: "ignore" });
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
      // `--entrypoint python` and not a trailing "python": the image has its
      // own entrypoint, and appending to it hangs waiting for something else.
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
 * Run a snippet where pandas exists, returning stdout; null when it cannot.
 *
 * Asynchronously, and that is the whole point of the shape. `execFileSync`
 * blocks the worker's event loop for as long as python runs, so vitest's own
 * RPC back to the main thread goes unanswered and birpc gives up with
 * `Timeout calling "onTaskUpdate"`. Every test still passed and the run still
 * exited non-zero, which is a confusing way to fail. Spawning leaves the loop
 * free to answer while the container works.
 */
function runPython(code: string): Promise<string | null> {
  const runner = RUNNER;
  if (!runner) return Promise.resolve(null);
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

const KAFKA = {
  type: "kafka",
  brokers: "redpanda-test.local:9092",
  topic: "orders_stream",
  format: "json",
  start: "earliest",
  max_messages: 10000,
  idle_ms: 5000,
  security: "plaintext",
  sasl_mechanism: "PLAIN",
  username_secret: "",
  password_secret: "",
};

/** The graph that failed: stream → filter → lakehouse. */
const streamGraph = (): EtlGraph =>
  ({
    nodes: [
      { id: "n1", kind: "source", label: "orders topic", config: KAFKA },
      {
        id: "n2",
        kind: "transform",
        label: "paid only",
        config: { type: "filter", expr: "status == 'paid'" },
      },
      {
        id: "n3",
        kind: "target",
        label: "out",
        config: {
          type: "lakehouse",
          schema: "analytics",
          table: "kafka_orders",
          write_mode: "append",
        },
      },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("the guard the emitted program carries", () => {
  it("defines _empty by ROW COUNT, not by the absence of columns", () => {
    // The distinction this file exists for: a stream source with nothing
    // new still carries its metadata columns.
    const code = compileGraph(streamGraph());
    expect(code).toContain("def _empty(df):");
    expect(code).toContain("return len(df.index) == 0");
    expect(code).not.toContain("len(df.columns) == 0");
  });

  it("wraps the step that would have raised", () => {
    const code = compileGraph(streamGraph());
    // The skip keeps the input's columns: no rows, shape intact.
    expect(code).toMatch(/if _empty\(f_n1\):\s*\n\s*f_n2 = f_n1\.iloc\[0:0\]/);
    expect(code).toMatch(/else:\s*\n\s*f_n2 = /);
  });

  it("is emitted by the PREVIEW compiler too", () => {
    // The preview is a second compiler over the same nodes, and the comment in
    // compilePreview says so: anything the steps depend on has to be emitted
    // by both, or the preview dies with a NameError on a graph that runs.
    const code = compilePreview(streamGraph(), "n2");
    expect(code).toContain("def _empty(df):");
    expect(code).toContain("if _empty(f_n1):");
  });
});

/**
 * Every pandas fact this file needs, from ONE interpreter start.
 *
 * Where pandas lives is a container, and starting one costs about twenty
 * seconds — three of them is a suite that times out on its own default. The
 * probe runs once, lazily, and the tests read parts of its output.
 */
let PROBE: Promise<string | null> | undefined;
function probe(): Promise<string | null> {
  if (PROBE === undefined) {
    PROBE = runPython(
      [
        "import pandas as pd",
        "",
        "def _empty(df):",
        "    return len(df.index) == 0",
        "",
        "# EXACTLY what the Kafka source returns with nothing new: zero rows,",
        "# and only the five metadata columns — never the payload's.",
        "quiet = pd.DataFrame(",
        "    [],",
        "    columns=['_stream_topic', '_stream_partition', '_stream_offset',",
        "             '_stream_key', '_stream_timestamp'],",
        ")",
        "print('columns present:', len(quiet.columns), 'rows:', len(quiet))",
        "",
        "# The guard that did NOT fire, and why.",
        "print('old guard fires?', len(quiet.columns) == 0 and len(quiet.index) == 0)",
        "print('new guard fires?', _empty(quiet))",
        "",
        "try:",
        "    quiet.query(\"status == 'paid'\")",
        "    print('UNGUARDED: no error')",
        "except Exception as e:",
        "    print('UNGUARDED:', type(e).__name__)",
        "",
        "if _empty(quiet):",
        "    out = quiet.iloc[0:0]",
        "else:",
        "    out = quiet.query(\"status == 'paid'\")",
        "print('GUARDED rows:', len(out), 'cols:', len(out.columns))",
        "",
        "df = pd.DataFrame({'status': ['refunded'], 'amount': [1.0]})",
        "kept = df.query(\"status == 'paid'\")",
        "print('cols kept:', list(kept.columns), 'rows:', len(kept))",
        "",
        "some = pd.DataFrame({'a': [1, 2, 3]})",
        "print('concat rows:', len(pd.concat([pd.DataFrame(), some], ignore_index=True)))",
      ].join("\n"),
    );
  }
  return PROBE;
}

describe("what the guard actually does, run as Python", () => {
  it(
    "fires on the frame a quiet stream actually returns",
    { timeout: RUNNER_TIMEOUT_MS },
    async () => {
      const out = await probe();
      if (out === null) {
        console.warn("no pandas and no runtime image; the guard was not exercised");
        return;
      }
      // The frame really does carry columns — which is why the first guard,
      // written against `pd.DataFrame()`, never fired and the live run failed a
      // second time in exactly the same way.
      expect(out).toContain("columns present: 5 rows: 0");
      expect(out).toContain("old guard fires? False");
      expect(out).toContain("new guard fires? True");
    },
  );

  it(
    "stops the step that would have raised, keeping the shape",
    { timeout: RUNNER_TIMEOUT_MS },
    async () => {
      const out = await probe();
      if (out === null) return;
      // Unguarded, that line is what the live run died on. Its traceback ended
      // in `KeyError: 'status'`; pandas re-raises it as UndefinedVariableError,
      // and which surfaces depends on the version. What matters is that it
      // RAISES where an empty result was wanted.
      expect(out).not.toContain("UNGUARDED: no error");
      expect(out).toMatch(/UNGUARDED: (KeyError|UndefinedVariableError)/);
      expect(out).toContain("GUARDED rows: 0 cols: 5");
    },
  );

  it(
    "leaves an ordinary empty result alone — zero rows WITH columns",
    { timeout: RUNNER_TIMEOUT_MS },
    async () => {
      // A filter that matched nothing must still behave like a filter: the
      // columns are known, so the step runs and the result keeps them.
      const out = await probe();
      if (out === null) return;
      expect(out).toContain("cols kept: ['status', 'amount'] rows: 0");
    },
  );
});

describe("union is deliberately not guarded", () => {
  it(
    "keeps concat, which already handles a schemaless side",
    { timeout: RUNNER_TIMEOUT_MS },
    async () => {
      // Guarding a union would throw away the branch that DID have rows.
      const g = {
        nodes: [
          { id: "n1", kind: "source", label: "a", config: KAFKA },
          {
            id: "n2",
            kind: "source",
            label: "b",
            config: {
              type: "lakehouse",
              schema: "analytics",
              mode: "table",
              table: "revenue_facts",
            },
          },
          { id: "n3", kind: "transform", label: "both", config: { type: "union" } },
          {
            id: "n4",
            kind: "target",
            label: "out",
            config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "append" },
          },
        ],
        edges: [
          { id: "e1", from: "n1", to: "n3" },
          { id: "e2", from: "n2", to: "n3" },
          { id: "e3", from: "n3", to: "n4" },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const code = compileGraph(g);
      expect(code).toContain("f_n3 = pd.concat(");
      expect(code).not.toMatch(/if _empty\(f_n1\) or _empty\(f_n2\):/);

      const out = await probe();
      if (out === null) return;
      expect(out).toContain("concat rows: 3");
    },
  );
});
