// The parts a pure-module test cannot reach.
//
// src/lib/mlCalibration.ts can be perfect while the feature does nothing: the
// trainer might not call _calibrate, the threshold might never leave the
// database, the panel might never be mounted. Every one of those is a silent
// failure — the screen renders, the numbers look plausible, and the line is
// simply never applied.
//
// The explanations feature shipped broken in exactly this way and was caught
// from the UI, not from a test. These are source-level assertions about the
// chain, so the next break is caught before the UI is reached.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

const TRAIN = read("src/utils/ml/pyTrain.ts");
const PREDICT = read("src/utils/ml/predict.server.ts");
const FUNCTIONS = read("src/utils/ml.functions.ts");
const PANEL = read("src/components/ml/CalibrationPanel.tsx");
const PAGE = read("src/routes/_authenticated/ml_.$modelId.tsx");

/** The Python program, extracted from the String.raw template it lives in. */
const TRAIN_PY = (() => {
  const start = TRAIN.indexOf("String.raw`") + "String.raw`".length;
  const end = TRAIN.indexOf("`;", start);
  expect(start).toBeGreaterThan(10);
  expect(end).toBeGreaterThan(start);
  return TRAIN.slice(start, end);
})();

describe("the trainer actually measures it", () => {
  it("defines the four functions the metrics block depends on", () => {
    for (const fn of ["_reliability", "_calibration_scores", "_calibrate", "_threshold_sweep"]) {
      expect(TRAIN_PY).toContain(`def ${fn}(`);
    }
  });

  it("calls _calibrate BEFORE computing the metrics it stores", () => {
    // Order is the whole point: metrics measured on the pre-calibration model
    // would describe a model that was not saved.
    const calibrate = TRAIN_PY.indexOf("best, calibration = _calibrate(");
    const metrics = TRAIN_PY.indexOf("metrics = _full_metrics(");
    expect(calibrate).toBeGreaterThan(0);
    expect(metrics).toBeGreaterThan(calibrate);
  });

  it("writes the block the reader looks for, under the keys it looks for", () => {
    // src/lib/mlCalibration.ts reads metrics.calibration and
    // metrics.threshold_sweep. A rename on either side is silent otherwise.
    expect(TRAIN_PY).toContain("metrics['calibration'] = calibration");
    expect(TRAIN_PY).toContain("metrics['threshold_sweep'] = sweep");
    for (const key of ["'brier'", "'calibration_error'", "'curve'", "'best_f1_threshold'"]) {
      expect(TRAIN_PY).toContain(key);
    }
  });

  it("keeps a calibration only when BOTH figures improve", () => {
    // The rule came out of a 90-row probe where the Brier score improved while
    // the calibration error got worse. Kept on Brier alone, that ships a model
    // whose probabilities are worse at the one job the step exists to do.
    expect(TRAIN_PY).toContain("after['calibration_error'] > before['calibration_error']");
  });

  it("measures the sweep at the value it reports", () => {
    // np.arange lands on 0.7000000000000001. Rounding only the stored number
    // meant the row labelled 0.70 described a threshold production would never
    // use — the table promised 30 rows where _predict would act on 32.
    expect(TRAIN_PY).toContain("t = round(float(raw_t), 2)");
    expect(TRAIN_PY).toContain("'threshold': t,");
    expect(TRAIN_PY).not.toContain("'threshold': round(float(t), 2),");
  });
});

describe("the threshold reaches the prediction", () => {
  it("travels in the program config, read fresh from the version", () => {
    expect(PREDICT).toContain("decision_threshold: b.version.decision_threshold");
    expect(PREDICT).toContain("positive_label: b.version.positive_label");
  });

  it("and the program applies it instead of argmax", () => {
    expect(TRAIN_PY).toContain("thr = cfg.get('decision_threshold')");
    expect(TRAIN_PY).toContain("hit = proba[:, pos] >= float(thr)");
  });

  it("reports the probability OF THE ANSWER, not of the positive class", () => {
    // A row declined at 0.45 must not report 0.55 confidence in a decision
    // nobody made.
    expect(TRAIN_PY).toContain(
      "out['probability'] = np.where(hit, proba[:, pos], proba[:, other])",
    );
  });

  it("records the operating point on the scored rows", () => {
    // Provenance: six months later, "why was this row declined" is answerable
    // from the row itself rather than from whatever the setting happens to be
    // by then. The output table is CREATE OR REPLACE, so the extra column
    // cannot collide with an existing schema.
    expect(TRAIN_PY).toContain("out['threshold_applied'] = float(thr)");
    expect(TRAIN_PY).toContain("CREATE OR REPLACE TABLE");
  });

  it("leaves multiclass and unset models on argmax", () => {
    expect(TRAIN_PY).toContain("if thr is not None and len(classes) == 2:");
  });
});

describe("a person can move the line", () => {
  it("the server function exists and is guarded by the write ACL", () => {
    expect(FUNCTIONS).toContain("export const mlSetDecisionThreshold");
    const fn = FUNCTIONS.slice(
      FUNCTIONS.indexOf("export const mlSetDecisionThreshold"),
      FUNCTIONS.indexOf("export const mlSetDecisionThreshold") + 2000,
    );
    // Not merely "loads the model": the write flag is what separates a reader
    // from someone entitled to change what production does.
    expect(fn).toContain("loadModelForUser(version.model_id, userId, { write: true })");
  });

  it("and the change is audited with the value, not just the fact", () => {
    const fn = FUNCTIONS.slice(
      FUNCTIONS.indexOf("export const mlSetDecisionThreshold"),
      FUNCTIONS.indexOf("export const mlSetDecisionThreshold") + 2000,
    );
    expect(fn).toContain('action: "ml.threshold.set"');
    expect(fn).toContain("threshold: data.threshold");
  });

  it("the threshold is bounded to a probability", () => {
    expect(FUNCTIONS).toContain("threshold: z.number().min(0).max(1).nullable()");
  });

  it("the panel is mounted on the page", () => {
    expect(PAGE).toContain('import { CalibrationPanel } from "@/components/ml/CalibrationPanel"');
    expect(PAGE).toContain("<CalibrationPanel");
  });

  it("and changing production's behaviour asks first", () => {
    // Every other destructive or outward-facing control on this page asks.
    // Moving the line changes what tomorrow's batch decides.
    expect(PANEL).toContain("confirmAsk(");
    expect(PANEL).toContain("This applies from the next prediction onwards");
  });

  it("a shared (read-only) viewer gets no controls", () => {
    expect(PANEL).toContain("disabled={shared}");
    expect(PANEL).toContain("{!shared ? (");
  });

  it("a retrain that drops the line is surfaced, not carried forward", () => {
    // The threshold lives on the version, so a scheduled retrain that promotes
    // when the metric improves produces a version with no line and quietly
    // puts production back on argmax — a change in what the business does,
    // made by nobody. Copying it forward would be worse: a line only means the
    // same thing across versions whose probabilities do. So it is reported.
    expect(FUNCTIONS).toContain('.not("decision_threshold", "is", null)');
    expect(FUNCTIONS).toContain('.lt("version", v.version)');
    expect(PANEL).toContain("state?.inherited");
    expect(PANEL).toContain("was drawing the line at");
    // And the fact is only reported when this version genuinely has none.
    expect(FUNCTIONS).toContain("if (v.decision_threshold === null) {");
  });

  it("the operating point is a real radio group, not a clickable row", () => {
    // A <tr onClick> is mouse-only: not in the tab order, no Enter or Space,
    // and never announced as a control. The repo's keyboardOperable guard
    // caught exactly that here. Picking one of nineteen points IS a radio
    // group, so it is one — arrow keys included.
    expect(PANEL).toContain('type="radio"');
    expect(PANEL).toContain('name="ml-operating-point"');
    expect(PANEL).toContain("onChange={() => setPicked(row.threshold)}");
    expect(PANEL).not.toMatch(/<tr\b[^>]*\sonClick=/);
  });

  it("the panel computes no metric of its own", () => {
    // Everything shown is read from the version's metrics. A figure invented
    // in the display layer would be a second, quieter source of truth — and
    // this is the file where that temptation lives.
    //
    // The rule is narrow enough to be checkable: a score may be READ and
    // formatted, never put on either side of an arithmetic operator. The first
    // assertion keeps this from going vacuous if the fields are ever renamed —
    // a guard over an expression that no longer appears is a test that passes
    // by not looking, which is how a literal \b in a regex once made a whole
    // assertion match nothing at all.
    // String.raw, not a plain string: "\." in a double-quoted literal is just
    // ".", and "\s" in a template literal is just "s". Both collapse silently
    // and leave a regex that matches nothing — which is how the first version
    // of this guard let a mutant through.
    const SCORE = String.raw`(?:scores|before|after)\.(?:brier|calibration_error)`;
    expect(PANEL).toMatch(new RegExp(SCORE));
    expect(PANEL).not.toMatch(new RegExp(SCORE + String.raw`\s*[-+*/]`));
    expect(PANEL).not.toMatch(new RegExp(String.raw`[-+*/]\s*` + SCORE));
    expect(PANEL).not.toContain("reduce((");
  });
});
