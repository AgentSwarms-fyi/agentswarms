// How the winner was chosen, and how much of its score is luck.
//
// NO IMPORTS, like src/lib/mlEvaluation.ts, src/lib/mlFairness.ts and
// src/lib/mlCalibration.ts, so the panel, the scheduler and the tests read one
// set of rules.
//
// The trainer used to fit every candidate on the training rows, score each on
// the HOLDOUT, keep the best of those scores and publish it. That is the
// maximum of a dozen noisy estimates, and publishing a maximum is publishing a
// number biased upward by exactly the amount of noise the search could
// exploit. Measured over thirty seeds on data where the candidates were
// genuinely equivalent, that bias was +0.046 F1 — against a decay alert that
// fires at a 10% drop, most of the alert budget was spent before the model
// ever ran.
//
// So selection happens inside the training rows and the holdout is read once,
// by code that only reports. This module reads what that left behind: which
// scheme was used, what each fold scored, and therefore how much a single
// number from this model is worth.
//
// Everything here READS. No metric is computed in the display layer.

/** Which scheme scored candidates during selection. */
export type MlCvStrategy = "stratified" | "kfold" | "timeseries" | "inner_split";

/** What the trainer recorded about selection. */
export type MlCrossValidation = {
  strategy: MlCvStrategy;
  folds: number;
  /** Why this scheme, in the trainer's words. */
  reason: string;
  /** "f1_macro" | "rmse" — the primary metric, same name the version uses. */
  metric: string;
  higher_is_better: boolean;
  /** One score per fold. A single inner split leaves exactly one. */
  scores: number[];
  mean: number | null;
  std: number | null;
  holdout_rows: number;
  training_rows: number;
  /** The same metric on the untouched holdout — what the version reports. */
  holdout_value: number | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const STRATEGIES: MlCvStrategy[] = ["stratified", "kfold", "timeseries", "inner_split"];

/**
 * Pull the selection record out of a version's metrics.
 *
 * Null for a version trained before this existed, so the panel can say "not
 * recorded" rather than implying a fold count nobody measured.
 */
export function readCrossValidation(metrics: unknown): MlCrossValidation | null {
  if (!isRecord(metrics)) return null;
  const b = metrics.cross_validation;
  if (!isRecord(b)) return null;
  const strategy = STRATEGIES.find((s) => s === b.strategy);
  const folds = num(b.folds);
  if (!strategy || folds === null) return null;
  const scores: number[] = [];
  if (Array.isArray(b.scores)) {
    for (const raw of b.scores) {
      const v = num(raw);
      if (v !== null) scores.push(v);
    }
  }
  return {
    strategy,
    folds,
    reason: typeof b.reason === "string" ? b.reason : "",
    metric: typeof b.metric === "string" ? b.metric : "",
    higher_is_better: b.higher_is_better !== false,
    scores,
    mean: num(b.mean),
    std: num(b.std),
    holdout_rows: num(b.holdout_rows) ?? 0,
    training_rows: num(b.training_rows) ?? 0,
    holdout_value: num(b.holdout_value),
  };
}

/** Plain words for what the scheme did. */
export function strategyLabel(strategy: MlCvStrategy): string {
  if (strategy === "timeseries") return "Time-ordered folds";
  if (strategy === "stratified") return "Stratified folds";
  if (strategy === "kfold") return "Cross-validated folds";
  return "One inner split";
}

/**
 * Did the folds disagree enough that a single number is not worth much?
 *
 * Expressed relative to the score itself, because a spread of 0.02 means
 * something different on an F1 of 0.95 than on an F1 of 0.15. Null when there
 * is only one fold — a single split has no spread, and inventing one would be
 * worse than admitting it.
 */
export function relativeSpread(cv: MlCrossValidation): number | null {
  if (cv.scores.length < 2 || cv.mean === null || cv.std === null) return null;
  const scale = Math.abs(cv.mean);
  if (scale < 1e-12) return null;
  return cv.std / scale;
}

export type MlSpreadBand = "tight" | "moderate" | "wide" | "unmeasured";

/**
 * How much a single score from this model can be trusted.
 *
 * Display bands, not a standard. Folds varying by a few per cent of the score
 * is ordinary; varying by a fifth of it means the next retrain could land
 * somewhere quite different, and any comparison between two versions that
 * close together is reading noise.
 */
export function spreadBand(cv: MlCrossValidation): MlSpreadBand {
  const rel = relativeSpread(cv);
  if (rel === null) return "unmeasured";
  if (rel <= 0.05) return "tight";
  if (rel <= 0.15) return "moderate";
  return "wide";
}

/**
 * How far the holdout landed from what selection expected.
 *
 * Positive means the holdout was BETTER than the folds, negative worse, in the
 * direction that counts as better for this metric. A large negative gap is the
 * interesting one: the winner looked good on the folds and did not repeat it
 * on rows nothing had touched.
 *
 * Null when either number is missing — this is the one comparison in the
 * product where a fabricated zero would read as reassurance.
 */
export function holdoutGap(cv: MlCrossValidation): number | null {
  if (cv.mean === null || cv.holdout_value === null) return null;
  const raw = cv.holdout_value - cv.mean;
  return cv.higher_is_better ? raw : -raw;
}

/**
 * Is a later measurement outside the range this model's own folds covered?
 *
 * THIS IS CONTEXT, NOT AN ALERT RULE. The decay alert stays exactly what the
 * operator configured — a ratio against the training score — because
 * suppressing an alert somebody asked for on statistical grounds they did not
 * ask for is not the platform's call. What this answers is the question a
 * person asks the moment an alert arrives: is this a real drop, or is it the
 * size of the wobble the model already showed between folds?
 *
 * Returned in standard deviations, so 1.2 means "a little beyond the spread"
 * and 6 means "nothing like the folds". Null when there was no spread to
 * compare against.
 */
export function deviationsFromFolds(cv: MlCrossValidation, observed: number): number | null {
  if (cv.mean === null || cv.std === null || cv.scores.length < 2) return null;
  if (cv.std < 1e-12) return null;
  const worse = cv.higher_is_better ? cv.mean - observed : observed - cv.mean;
  return worse / cv.std;
}

/**
 * Whether selection was allowed to see the rows the version reports from.
 *
 * Always false for anything trained after this shipped, and that is the point:
 * it exists so a version trained BEFORE it cannot quietly present its number as
 * though it had been held to the same rule.
 */
export function selectionTouchedHoldout(cv: MlCrossValidation | null): boolean {
  return cv === null;
}

/** Rows the score was actually computed on, for a reader judging its weight. */
export function holdoutRows(cv: MlCrossValidation): number {
  return cv.holdout_rows;
}
