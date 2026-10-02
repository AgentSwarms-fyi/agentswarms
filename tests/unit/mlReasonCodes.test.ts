// Reason codes beside every scored row.
//
// There is no reader module to unit-test here on purpose: the codes land as
// COLUMNS on the scored lakehouse table, so the thing that consumes them is
// SQL and a BI tool, not TypeScript. What can break is the chain — the flag
// not reaching the program, the cap not being checked, the columns not being
// written before the table is created — and the behaviour of the ablation
// itself, which tests/fixtures/reasonCodesProbe.py exercises against the real
// functions in the runtime.
//
// So these are source-level assertions about the chain, plus one structural
// check on the training program that would have caught a real mistake made
// while writing this: two calls added without their definitions.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TRAIN = readFileSync("src/utils/ml/pyTrain.ts", "utf8");
const PREDICT = readFileSync("src/utils/ml/predict.server.ts", "utf8");
const API = readFileSync("src/utils/ml/api.server.ts", "utf8");
const FUNCTIONS = readFileSync("src/utils/ml.functions.ts", "utf8");
const ROUTE = readFileSync("src/routes/api/ml.predict.batch.ts", "utf8");
const PANEL = readFileSync("src/components/ml/PredictionsPanel.tsx", "utf8");

const TRAIN_PY = (() => {
  const start = TRAIN.indexOf("String.raw`") + "String.raw`".length;
  const end = TRAIN.indexOf("`;", start);
  expect(end).toBeGreaterThan(start);
  return TRAIN.slice(start, end);
})();

describe("the training program is internally complete", () => {
  it("every underscore-prefixed call has a definition", () => {
    // CAUGHT A REAL MISTAKE. A patch script asserted out on a later step
    // BEFORE writing, so two function definitions it had spliced in memory
    // never reached the file — while a second script added the CALLS. The
    // program still compiled, because Python does not resolve names at parse
    // time, and the failure would have been a NameError inside a sandbox
    // halfway through somebody's batch.
    //
    // Two names are legitimately absent from TRAIN_PY's own definitions:
    // _lakehouse_con comes from the prelude train.server.ts prepends, and
    // __import__ is a builtin that happens to start with an underscore.
    const FROM_PRELUDE = new Set(["_lakehouse_con", "__import__"]);
    // Indented defs count: _prep and _label are nested inside _predict, and a
    // pattern anchored to column zero would have reported them missing —
    // a guard that cries wolf gets relaxed, and then it catches nothing.
    const defined = new Set(
      [...TRAIN_PY.matchAll(/^[ \t]*def (_[A-Za-z0-9_]+)\(/gm)].map((m) => m[1]),
    );
    const called = new Set(
      [...TRAIN_PY.matchAll(/(?<![A-Za-z0-9_.])(_[A-Za-z0-9_]+)\(/g)].map((m) => m[1]),
    );
    const missing = [...called].filter((c) => !defined.has(c) && !FROM_PRELUDE.has(c)).sort();
    expect(missing).toEqual([]);
    // And the guard is guarding something: these two are what it was written
    // for, so their absence must fail here rather than pass quietly.
    expect(defined.has("_reason_codes")).toBe(true);
    expect(defined.has("_reason_frame")).toBe(true);
  });
});

describe("one definition of what moved the answer", () => {
  it("reason codes reuse the explanation, rather than a cheaper twin", () => {
    // A batch-only approximation would be a second answer to the same question
    // wearing the same name, free to disagree with the explanation shown on
    // the row's own page. reasonCodesProbe.py checks they agree to 1e-9; this
    // checks the reuse that makes that possible has not been undone.
    const fn = TRAIN_PY.slice(
      TRAIN_PY.indexOf("def _reason_codes("),
      TRAIN_PY.indexOf("def _reason_frame("),
    );
    expect(fn).toContain(
      "got = _explain(art, part, pipe, prep, task, classes, None, len(part), top_k)",
    );
  });

  it("and work in bounded chunks so a big batch cannot blow up the frame", () => {
    const fn = TRAIN_PY.slice(
      TRAIN_PY.indexOf("def _reason_codes("),
      TRAIN_PY.indexOf("def _reason_frame("),
    );
    expect(fn).toContain("step = max(1, int(chunk_rows))");
    expect(fn).toContain("for start in range(0, n, step):");
  });

  it("a short run is reported rather than written as if complete", () => {
    const fn = TRAIN_PY.slice(
      TRAIN_PY.indexOf("def _reason_codes("),
      TRAIN_PY.indexOf("def _reason_frame("),
    );
    expect(fn).toContain("if len(out) != n:");
    expect(fn).toContain("and were left off.");
  });
});

describe("the codes become columns of the scored table", () => {
  it("flat columns, not a JSON blob", () => {
    // These are queried with plain SQL and grouped by in a BI tool.
    // "WHERE reason_1 = 'support_tickets'" has to work without a JSON function.
    const fn = TRAIN_PY.slice(
      TRAIN_PY.indexOf("def _reason_frame("),
      TRAIN_PY.indexOf("def _drift("),
    );
    expect(fn).toContain("cols['reason_%d' % (slot + 1)] = names");
    expect(fn).toContain("cols['reason_%d_effect' % (slot + 1)] = effects");
  });

  it("an empty slot is None, not a blank feature name", () => {
    const fn = TRAIN_PY.slice(
      TRAIN_PY.indexOf("def _reason_frame("),
      TRAIN_PY.indexOf("def _drift("),
    );
    expect(fn).toContain("names.append(None)");
    expect(fn).toContain("effects.append(None)");
  });

  it("written BEFORE the table is created, not joined back later", () => {
    const predict = TRAIN_PY.slice(TRAIN_PY.indexOf("def _predict(cfg, warnings_):"));
    const wrote = predict.indexOf("out[col] = vals");
    const created = predict.indexOf("CREATE OR REPLACE TABLE");
    expect(wrote).toBeGreaterThan(0);
    expect(created).toBeGreaterThan(0);
    expect(wrote).toBeLessThan(created);
  });

  it("a failure loses the reasons, never the scored rows", () => {
    // The rows are the deliverable. An exception computing an addition to them
    // must not throw away a batch that scored.
    const predict = TRAIN_PY.slice(TRAIN_PY.indexOf("def _predict(cfg, warnings_):"));
    expect(predict).toContain("warnings_.append('Reason codes could not be computed: %s'");
  });

  it("and a run that wrote a table does not also duplicate them in the result", () => {
    const predict = TRAIN_PY.slice(TRAIN_PY.indexOf("def _predict(cfg, warnings_):"));
    expect(predict).toContain("if cfg.get('explain') and not cfg.get('output'):");
  });
});

describe("the cost is refused up front, not discovered halfway", () => {
  it("the cap is checked against the count the batch already pays for", () => {
    const fn = API.slice(API.indexOf("export async function startBatchPrediction"));
    expect(fn).toContain("if (args.explain && rows > ML_EXPLAIN_BATCH_MAX_ROWS)");
    // Before a sandbox is started, so nothing is spent finding out.
    expect(fn.indexOf("ML_EXPLAIN_BATCH_MAX_ROWS")).toBeLessThan(
      fn.indexOf("const started = await startPrediction("),
    );
  });

  it("and the refusal names the real number and the way out", () => {
    const fn = API.slice(API.indexOf("export async function startBatchPrediction"));
    expect(fn).toContain("rows is above the");
    expect(fn).toContain("ML_EXPLAIN_BATCH_MAX_ROWS");
    expect(fn).toContain("Narrow the rows with a filter");
  });

  it("every limit is an env knob with a default, not a hard cap", () => {
    expect(PREDICT).toContain('envCount("ML_EXPLAIN_BATCH_MAX_ROWS", 50_000)');
    expect(PREDICT).toContain('envCount("ML_EXPLAIN_BATCH_TOP_K", 3)');
    expect(PREDICT).toContain('envCount("ML_EXPLAIN_CHUNK_ROWS", 2000)');
  });

  it("a batch asks for fewer reasons than the detail view, because each is two columns", () => {
    expect(PREDICT).toContain(
      'explain_top_k: b.prediction.kind === "batch" ? ML_EXPLAIN_BATCH_TOP_K : ML_EXPLAIN_TOP_K',
    );
    expect(PREDICT).toContain("explain_chunk_rows: ML_EXPLAIN_CHUNK_ROWS");
  });
});

describe("a person and an API can both ask for them", () => {
  it("the batch dialog offers it, off by default", () => {
    // Scoped to the batch dialog. The try-it form has an identically worded
    // `explain` state, so a bare toContain was satisfied by THAT one — the
    // batch default could have flipped to true and this would still have
    // passed. A mutation check is what showed it.
    const dialog = PANEL.slice(PANEL.indexOf("const batchFn = useServerFn(mlPredictBatch);"));
    expect(dialog).toContain("const [explain, setExplain] = useState(false);");
    expect(dialog).toContain("Write reason codes beside every row");
    expect(dialog).toContain('type="checkbox"');
    // Both places that offer an explanation are opt-in, and neither is the
    // other: two states, two falses.
    expect(PANEL.match(/const \[explain, setExplain\] = useState\(false\);/g)).toHaveLength(2);
  });

  it("and the dialog actually sends it", () => {
    // The step that was missing three times over in the previous milestone.
    const submit = PANEL.slice(PANEL.indexOf("const submit = async ()"));
    expect(submit.slice(0, 900)).toContain("explain,");
  });

  it("the server function accepts and forwards it", () => {
    expect(FUNCTIONS).toContain("explain: z.boolean().optional(),");
    const call = FUNCTIONS.slice(FUNCTIONS.indexOf("const started = await startBatchPrediction({"));
    expect(call.slice(0, 400)).toContain("explain: data.explain,");
  });

  it("so does the public API", () => {
    expect(ROUTE).toContain("explain: z.boolean().optional(),");
    expect(ROUTE).toContain("explain: parsed.data.explain,");
  });
});
