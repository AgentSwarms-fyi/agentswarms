// The invariant this milestone exists to establish, checked in the source.
//
// A reader module can be perfect while the trainer quietly goes on selecting
// on the holdout, and nothing about that failure is visible: the screen
// renders, the folds are recorded, and the published number is still the
// maximum of a dozen noisy estimates. The only way to catch it is to assert on
// the shape of the training program itself.
//
// The load-bearing test here is "selection never reads the holdout". It works
// by listing every line between the split and the metrics call that mentions
// the holdout at all, and requiring that list to be exactly the one line
// entitled to — so a new use trips it rather than blending in.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TRAIN = readFileSync("src/utils/ml/pyTrain.ts", "utf8");
const SERVER = readFileSync("src/utils/ml/train.server.ts", "utf8");
const CONFIG = readFileSync("src/utils/notebookRuntime/config.server.ts", "utf8");
const ADMIN_FN = readFileSync("src/utils/notebookRuntimeAdmin.functions.ts", "utf8");
const ADMIN_UI = readFileSync("src/components/admin/RuntimeTab.tsx", "utf8");

/** The Python program, out of the String.raw template it lives in. */
const TRAIN_PY = (() => {
  const start = TRAIN.indexOf("String.raw`") + "String.raw`".length;
  const end = TRAIN.indexOf("`;", start);
  expect(start).toBeGreaterThan(10);
  expect(end).toBeGreaterThan(start);
  return TRAIN.slice(start, end);
})();

/** _train_tabular, from its def to the next top-level def. */
const TABULAR = (() => {
  const start = TRAIN_PY.indexOf("def _train_tabular(");
  expect(start).toBeGreaterThan(0);
  const rest = TRAIN_PY.slice(start + 10);
  const next = rest.search(/\n(?:def |# ── )/);
  return rest.slice(0, next > 0 ? next : rest.length);
})();

describe("selection never reads the holdout", () => {
  it("the region between the split and the metrics call is identifiable", () => {
    expect(TABULAR).toContain("cv_plan = _cv_plan(");
    expect(TABULAR).toContain("metrics = _full_metrics(");
    expect(TABULAR.indexOf("cv_plan = _cv_plan(")).toBeLessThan(
      TABULAR.indexOf("metrics = _full_metrics("),
    );
  });

  it("and never reads the held-out answers while choosing", () => {
    // THE GUARD, and the line it draws is exact: selection may know HOW MANY
    // rows are held back — the planner needs that count to decide whether
    // folds are worth their cost, and the run log prints it — but it may never
    // see what is in them. So len(Xva) is allowed and yva is not, anywhere
    // between the plan and the metrics call.
    //
    // The single exception hands both to _calibrate, which decides on a slice
    // of the TRAINING rows and touches the holdout only to measure the figures
    // a reader is shown.
    const region = TABULAR.slice(
      TABULAR.indexOf("cv_plan = _cv_plan("),
      TABULAR.indexOf("metrics = _full_metrics("),
    );
    const CALIBRATE =
      "best, calibration = _calibrate(best, Xtr, ytr, splits, Xva, yva, classes or [], warnings_)";
    const lines = region
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#") && l !== CALIBRATE);

    // Not one mention of the held-out answers.
    expect(lines.filter((l) => /\byva\b/.test(l))).toEqual([]);
    // And the held-out rows only ever counted, never indexed or scored.
    const usesXva = lines.filter((l) => /\bXva\b/.test(l));
    expect(usesXva.length).toBeGreaterThan(0); // the guard is guarding something
    for (const l of usesXva) {
      expect(l.replace(/len\(Xva\)/g, "").includes("Xva")).toBe(false);
    }
    // And the permitted line is really there, so this cannot pass by absence.
    expect(region).toContain(CALIBRATE);
  });

  it("candidates are scored by the plan, not against the holdout", () => {
    expect(TABULAR).toContain("cvres = _cv_score(pipe, Xtr, ytr, splits, task)");
    expect(TABULAR).not.toContain("score = _primary(task, pipe, Xva, yva)");
  });

  it("the winner is refit on every training row before it ships", () => {
    // The folds existed to measure. A model shipped as the fit from one fold
    // would have seen a fraction of the data selection was entitled to use.
    const loop = TABULAR.slice(TABULAR.indexOf("cvres = _cv_score("));
    expect(loop.slice(0, 400)).toContain("pipe.fit(Xtr, ytr)");
  });

  it("the tuner is handed the splits and never the holdout", () => {
    expect(TRAIN_PY).toContain(
      "def _tune(task, ranked, prep, Xtr, ytr, splits, budget, mode, leaderboard, warnings_):",
    );
    // To the NEXT def, not to a named one: _fold_detail happens to sit above
    // _tune, and slicing to it produced an empty string that contained
    // nothing — including nothing to fail on.
    const after = TRAIN_PY.slice(TRAIN_PY.indexOf("def _tune(") + 10);
    const tune = after.slice(0, after.indexOf("\ndef "));
    expect(tune.length).toBeGreaterThan(500);
    expect(tune).not.toMatch(/\bXva\b|\byva\b/);
    expect(tune).toContain("cv=splits");
  });

  it("tuned and untuned scores are the same currency", () => {
    // best_score_ is the mean over the SAME folds the untuned candidate was
    // scored on. Comparing a 3-fold mean against a single-split score is how a
    // tuned model gets adopted for being measured differently.
    expect(TRAIN_PY).toContain(
      "score = float(search.best_score_) if higher else -float(search.best_score_)",
    );
  });

  it("calibration decides on training rows, not on what it reports", () => {
    const cal = TRAIN_PY.slice(
      TRAIN_PY.indexOf("def _calibrate("),
      TRAIN_PY.indexOf("def _threshold_sweep("),
    );
    expect(cal).toContain("fit_idx, sel_idx = _first_fold(splits, Xtr, ytr)");
    // The accept/reject test reads the inner numbers and nothing else.
    expect(cal).toContain("if after_d is None or after_d['brier'] >= before_d['brier']");
    expect(cal).toContain("after_d, before_d = inner_after, inner_before");
  });
});

describe("time-ordered rows are never shuffled", () => {
  it("an ordered split replaces the random one when a time column is given", () => {
    expect(TABULAR).toContain("tcol = cfg.get('time_column')");
    expect(TABULAR).toContain("order = np.argsort(tvals.to_numpy(), kind='stable')");
    expect(TABULAR).toContain("if not temporal:");
  });

  it("the most recent rows are the ones kept back", () => {
    expect(TABULAR).toContain("Xtr, Xva, ytr, yva = X.iloc[:cut], X.iloc[cut:], y[:cut], y[cut:]");
  });

  it("and a column holding no dates degrades loudly", () => {
    // Silently splitting at random after being told the rows are ordered is
    // the version of this bug nobody would ever find.
    expect(TABULAR).toContain("holds no readable dates");
  });

  it("time-series folds beat every other consideration", () => {
    const plan = TRAIN_PY.slice(
      TRAIN_PY.indexOf("def _cv_plan("),
      TRAIN_PY.indexOf("def _cv_splits("),
    );
    // The temporal branch is first and UNCONDITIONAL, so no holdout size can
    // route around it.
    //
    // Both lines are asserted to exist before their positions are compared.
    // Without that, qualifying the branch to `if temporal and n_holdout < ...`
    // makes indexOf return -1, and -1 is less than any real position — so the
    // guard passes by the very absence it exists to detect. A mutation check
    // caught exactly that.
    expect(plan).toContain("if temporal:");
    expect(plan).toContain("if n_holdout >= int(min_holdout_rows):");
    expect(plan.indexOf("if temporal:")).toBeLessThan(
      plan.indexOf("if n_holdout >= int(min_holdout_rows):"),
    );
  });
});

describe("a person can actually reach the ordered split", () => {
  const WIZARD = readFileSync("src/routes/_authenticated/ml_.new.tsx", "utf8");

  it("the wizard offers a time column for classification and regression", () => {
    // FOUND BY READING THE WIZARD, not by a failing test. The trainer read
    // cfg['time_column'] for tabular tasks, the folds were written, the docs
    // described it — and the wizard sent `task === "forecast" ? timeColumn :
    // undefined`, so the whole path was unreachable from the interface. A
    // feature only the API can switch on is a feature that did not ship.
    expect(WIZARD).toContain("Are these rows ordered in time?");
    expect(WIZARD).toContain('(task === "classification" || task === "regression") &&');
  });

  it("and sends it, rather than dropping it on the way to the trainer", () => {
    const send = WIZARD.slice(WIZARD.indexOf("time_column:"), WIZARD.indexOf("time_column:") + 400);
    expect(send).toContain('task === "classification" || task === "regression"');
    expect(send).toContain("? orderedBy");
    expect(send).not.toMatch(/time_column: task === "forecast" \? timeColumn : undefined/);
  });

  it("with an explicit way to say the rows are NOT ordered, and that is the default", () => {
    // Defaulting a date column to "ordered" would decide a fact about the
    // world on the user's behalf, the same rule the favourable label follows.
    //
    // This needs its OWN state: profiling a table sets timeColumn to the first
    // date column, which forecasting requires — and binding this control to
    // that would have silently opted every model on a dated table into a
    // temporal split. Caught by reading the pre-selected value on screen.
    expect(WIZARD).toContain('<option value="">No — rows are independent</option>');
    expect(WIZARD).toContain('const [orderedBy, setOrderedBy] = useState("");');
    expect(WIZARD).toContain('setOrderedBy("");');
    // The control must not read the forecast default.
    const block = WIZARD.slice(WIZARD.indexOf("Are these rows ordered in time?"));
    expect(block.slice(0, 900)).toContain("value={orderedBy}");
    expect(block.slice(0, 900)).not.toContain("value={timeColumn}");
  });

  it("and the choice is confirmed before training starts", () => {
    expect(WIZARD).toContain('<Row k="Row order" v={`in time, by ${orderedBy}`} />');
  });

  it("and the server STORES it instead of nulling it on the way in", () => {
    // The third link in the same chain, and the one that actually broke. The
    // wizard sent the column, the validator accepted it, the review step told
    // the user "in time, by signed_up_on" — and the insert read
    // `task === "forecast" ? ... : null`, so the model was created with a
    // null and the trainer shuffled the rows anyway.
    //
    // Nothing failed. The version simply came back stratified instead of
    // time-ordered, which is only visible if you read the row back after a
    // real run. So the store is pinned here, one assertion per task that is
    // allowed to have one.
    const FUNCTIONS = readFileSync("src/utils/ml.functions.ts", "utf8");
    const insert = FUNCTIONS.slice(
      FUNCTIONS.indexOf("time_column:", FUNCTIONS.indexOf('.from("ml_models")')),
      FUNCTIONS.indexOf('horizon: data.task === "forecast"'),
    );
    expect(insert).toContain('data.task === "forecast" ||');
    expect(insert).toContain('data.task === "classification" ||');
    expect(insert).toContain('data.task === "regression"');
    expect(insert).not.toMatch(
      /time_column: data\.task === "forecast" \? \(data\.time_column \?\? null\) : null/,
    );
  });

  it("and the validator lets it through for those tasks", () => {
    const FUNCTIONS = readFileSync("src/utils/ml.functions.ts", "utf8");
    // Optional, not forecast-gated: a required field here would break every
    // classification model that has no dates at all.
    expect(FUNCTIONS).toContain("time_column: IDENT.optional(),");
  });
});

describe("the evidence reaches the version", () => {
  it("under the key the reader looks for", () => {
    expect(TABULAR).toContain("metrics['cross_validation'] = {");
    for (const key of ["'strategy'", "'folds'", "'reason'", "'scores'", "'holdout_value'"]) {
      expect(TABULAR).toContain(key);
    }
  });

  it("with the holdout value kept separate from the fold mean", () => {
    // Two numbers on two sets of rows. Collapsing them is the bug.
    expect(TABULAR).toContain("'holdout_value': _safe_float(metrics.get(metric))");
    expect(TABULAR).toContain("'mean': (best_cv or {}).get('mean')");
  });
});

describe("the cost knob is wired everywhere it has to be", () => {
  it("named in the explicit SELECT list, or it silently never applies", () => {
    // getPlatformResources selects columns by name. A knob missing from that
    // list reads as null for ever and the default wins in silence.
    const select = CONFIG.slice(
      CONFIG.indexOf("lakehouse_memory_limit"),
      CONFIG.indexOf("document_vision_max_pages"),
    );
    expect(select).toContain("ml_cv_min_holdout_rows");
  });

  it("read with an env fallback and a default", () => {
    expect(CONFIG).toContain('envInt("ML_CV_MIN_HOLDOUT_ROWS")');
    expect(CONFIG).toContain("mlCvMinHoldoutRows: number;");
  });

  it("passed to the training program", () => {
    expect(SERVER).toContain("cv_min_holdout_rows: resources.mlCvMinHoldoutRows");
  });

  it("and the trainer still works if it never arrives", () => {
    expect(TABULAR).toContain("cfg.get('cv_min_holdout_rows') or 2000");
  });

  it("with a control an administrator can actually reach", () => {
    expect(ADMIN_FN).toContain("ml_cv_min_holdout_rows: number;");
    expect(ADMIN_FN).toContain("ml_cv_min_holdout_rows: row.ml_cv_min_holdout_rows ?? 2000");
    expect(ADMIN_UI).toContain('set("ml_cv_min_holdout_rows", n)');
  });
});
