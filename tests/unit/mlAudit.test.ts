// Every task was audited for results that are technically correct and
// misleading, the way a daily "3 periods" forecast was. What is pinned
// here is that the trainer checks for each of them and says what it found
// on the version - where the model page, the model card and the agent tool
// repeat it - and that the docs explain every warning in the same words.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TRAIN_PY } from "@/utils/ml/pyTrain";
import { versionCaveats } from "@/utils/tools/registry.server";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("supervised tasks: a superb score is questioned", () => {
  it("flags a feature that predicts the target on its own as possible leakage, never failing the job over it", () => {
    expect(TRAIN_PY).toContain(
      "def _leakage_warnings(df, schema, features, target, task, warnings_):",
    );
    expect(TRAIN_PY).toContain("_leakage_warnings(df, schema, features, target, task, warnings_)");
    expect(TRAIN_PY).toContain("_log('leakage check skipped: %s' % str(e)[:160])");
    // categorical purity and a one-feature stump, both judged by balanced accuracy so a lopsided target cannot fake it
    expect(TRAIN_PY).toContain("score = float(balanced_accuracy_score(cls[keep], pred))");
    expect(TRAIN_PY).toContain(
      "DecisionTreeClassifier(max_depth=2, random_state=42).fit(frame, cls[ok])",
    );
    expect(TRAIN_PY).toContain("if score >= 0.98:");
    // regression: variation explained by a category, correlation with a number
    expect(TRAIN_PY).toContain("explained = 1.0 - within / total");
    expect(TRAIN_PY).toContain("if abs(r) >= 0.98:");
    expect(TRAIN_PY).toContain(
      "Possible leakage: %s on its own predicts %s for %.0f%% of rows (balanced accuracy).",
    );
    expect(TRAIN_PY).toContain(
      "Possible leakage: %s moves with %s almost exactly (correlation %.3f).",
    );
    expect(TRAIN_PY).toContain(
      "If it is derived from the target, or not known when you predict, leave it out of the features.",
    );
  });

  it("names the do-nothing baseline of a lopsided target and a regression with no signal", () => {
    expect(TRAIN_PY).toContain("if share >= 0.9:");
    expect(TRAIN_PY).toContain(
      "so %.0f%% accuracy is the do-nothing baseline; judge the model by F1 (macro), the primary metric, and the confusion matrix.",
    );
    expect(TRAIN_PY).toContain(
      "if task != 'classification' and metrics.get('r2') is not None and metrics['r2'] <= 0.05:",
    );
    expect(TRAIN_PY).toContain("predicting the mean would do about as well.");
  });

  it("still stratifies the holdout and masks zeros out of MAPE", () => {
    expect(TRAIN_PY).toContain("stratify = y if counts.min() >= 2 else None");
    expect(TRAIN_PY).toContain(
      "train_test_split(X, y, test_size=frac, random_state=42, stratify=stratify)",
    );
    expect(TRAIN_PY).toContain("mask = yva != 0");
  });
});

describe("distance-based tasks: no column decides on its own", () => {
  it("leaves out a many-valued category and a time column when the features were chosen automatically, and warns when they were picked", () => {
    expect(TRAIN_PY).toContain("_MAX_DISTANCE_CATEGORIES = 20");
    expect(TRAIN_PY).toContain("auto = not (cfg.get('feature_columns') or None)");
    expect(TRAIN_PY).toContain("if nun > _MAX_DISTANCE_CATEGORIES:");
    expect(TRAIN_PY).toContain(
      "categories: rows would be grouped by it rather than compared; select it explicitly to keep it",
    );
    expect(TRAIN_PY).toContain(
      "a time column groups rows by when they happened, not what they are; select it explicitly to keep it",
    );
    expect(TRAIN_PY).toContain("rows sharing a value will tend to fall into the same group.");
    expect(TRAIN_PY).toContain("rows near each other in the calendar will tend to group together.");
    expect(TRAIN_PY).toContain("features = [f for f in features if by[f]['role'] == 'feature']");
  });

  it("says the anomaly rate is the setting, not a finding", () => {
    expect(TRAIN_PY).toContain("if not cfg.get('contamination'):");
    expect(TRAIN_PY).toContain("The anomaly rate is the setting, not a finding");
  });
});

describe("recommendation: strength is not sentiment", () => {
  it("warns when the strength column looks like a rating scale", () => {
    expect(TRAIN_PY).toContain(
      "if 3 <= vals.nunique() <= 11 and vals.min() >= 0 and vals.max() <= 10 and bool((vals == vals.round()).all()):",
    );
    expect(TRAIN_PY).toContain(
      "is used as interaction strength: a bigger value is a stronger like, and a low value still counts as a weak one.",
    );
  });
});

describe("forecast: the history and the projection are honest", () => {
  it("drops an incomplete first period like the last, counts an empty total as 0, holds out at least three periods and floors a non-negative series", () => {
    expect(TRAIN_PY).toContain(
      "if typical > 0 and counts.iloc[0] > 0 and counts.iloc[0] < 0.5 * typical:",
    );
    expect(TRAIN_PY).toContain(
      "The first period (%s) had %d rows against a typical %d and was left out as incomplete.",
    );
    expect(TRAIN_PY).toContain("if agg == 'sum' and empty:");
    expect(TRAIN_PY).toContain("had no rows and count as 0.");
    expect(TRAIN_PY).toContain("y = y.fillna(0.0)");
    expect(TRAIN_PY).toContain("holdout = max(holdout, 3)");
    expect(TRAIN_PY).toContain("nonneg = bool((y >= 0).all())");
    expect(TRAIN_PY).toContain("point, lo, hi = max(point, 0.0), max(lo, 0.0), max(hi, 0.0)");
    expect(TRAIN_PY).toContain(
      "Projected values below 0 were floored at 0: the history never goes below it.",
    );
  });
});

describe("the warnings reach every surface, not only the promoted version", () => {
  it("the Versions tab counts them as notes and opens them; the compare view lists them side by side", () => {
    const page = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(page).toContain('<th className="px-3 py-2 font-medium">Notes</th>');
    expect(page).toContain('{notes.length} {notes.length === 1 ? "note" : "notes"}');
    expect(page).toContain("aria-expanded={notesOpen.has(v.id)}");
    expect(page).toContain("{notesOpen.has(v.id) ? (");
    expect(page).toContain('<td className="py-1.5 pr-3 text-muted-foreground">Warnings</td>');
  });

  it("the agent's prediction tool repeats the caveats that change how an answer is read, not the mechanical ones", () => {
    const caveats = versionCaveats([
      "Dropped column order_id: identifier-like: 836 distinct values in 836 rows",
      "Possible leakage: region on its own predicts plan for 100% of rows (balanced accuracy). If it is derived from the target, or not known when you predict, leave it out of the features.",
      "Prediction intervals are residual-based (holdout spread x 1.96 x sqrt(steps ahead)), not model-derived.",
      "The last period (2026-04-05) had 18 rows against a typical 63 and was left out as incomplete.",
      "The anomaly rate is the setting, not a finding: rows are ranked by how easily they are isolated and the top 2% are flagged. Read the score, and set the share you expect to see.",
    ]);
    expect(caveats).toHaveLength(3);
    expect(caveats[0]).toBe(
      "The trainer warned: Possible leakage: region on its own predicts plan for 100% of rows (balanced accuracy). If it is derived from the target, or not known when you predict, leave it out of the features.",
    );
    expect(caveats[1]).toContain("left out as incomplete");
    expect(caveats[2]).toContain("The anomaly rate is the setting");
    expect(versionCaveats(null)).toEqual([]);
    expect(versionCaveats("not a list")).toEqual([]);
    const registry = rd("src/utils/tools/registry.server.ts");
    expect(registry).toContain("...versionCaveats(version.warnings)");
    expect(registry).toContain("...forecastNotes(version.algorithm, meta),");
  });

  it("the public API lists every version's warnings", () => {
    const api = rd("src/utils/ml/api.server.ts");
    expect(api).toContain("warnings: (production.warnings ?? []) as string[],");
    expect(api).toContain("warnings: (v.warnings ?? []) as string[],");
  });
});

describe("the docs explain every warning", () => {
  it("in the repo docs and the in-app page, with a troubleshooting row for each symptom", () => {
    for (const f of ["docs/ML.md", "src/routes/docs.ml.tsx"]) {
      const doc = rd(f).replace(/\s+/g, " ");
      expect(doc, f).toContain("What the trainer warns about");
      for (const phrase of [
        "Possible leakage",
        "do-nothing baseline",
        "No signal",
        "decide a distance on their own",
        "The anomaly rate is a setting",
        "Strength is not sentiment",
        "floored at zero",
        "A random holdout is not a time split",
        "Every group is one customer / every anomaly a date",
        "Projected values below 0 were floored at 0",
      ]) {
        expect(doc, `${f}: ${phrase}`).toContain(phrase);
      }
    }
  });
});
