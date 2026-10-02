// Is the confidence number a probability, and where is the line drawn?
//
// NO IMPORTS, like src/lib/mlEvaluation.ts and src/lib/mlFairness.ts, so the
// panel, the tests and anything server-side read one set of rules.
//
// Two questions that the interface has always answered by implication and
// never by measurement:
//
//   IS 0.8 REALLY 80%? A forest that votes 9 trees to 1 reports 0.9, and that
//   number has sat next to the word "confidence" in this product since the
//   first release. It is a RANK, not a frequency — useful for sorting, wrong
//   for a business rule that says "auto-approve above 80%". The reliability
//   curve is what tells the two apart: it puts what the model said beside what
//   actually happened, bin by bin.
//
//   WHERE IS THE LINE? A classifier decides by argmax, which is a threshold of
//   0.5 nobody chose. That is the right default and the wrong one for most
//   real decisions, because declining a good customer and missing a fraudulent
//   order do not cost the same. The trainer MEASURES every operating point;
//   this module reads that table; a person picks the row.
//
// Everything here READS numbers the platform computed during training. Nothing
// here computes a metric of its own — a reliability figure invented by the
// display layer would be a second, quieter source of truth.

/** One bin of the reliability curve: what the model said, what happened. */
export type MlReliabilityBin = {
  from: number;
  to: number;
  n: number;
  /** Mean predicted probability in the bin. */
  predicted: number;
  /** Observed frequency of the event in the bin. */
  observed: number;
};

/** Brier score, expected calibration error and the curve behind them. */
export type MlCalibrationScores = {
  brier: number;
  calibration_error: number;
  curve: MlReliabilityBin[];
};

/** What the trainer did about calibration, and whether it kept the result. */
export type MlCalibrationReport = {
  calibrated: boolean;
  /** "isotonic" | "sigmoid", or null when the attempt raised. */
  method: string | null;
  before: MlCalibrationScores;
  after: MlCalibrationScores | null;
};

/** One operating point, measured on the holdout. */
export type MlSweepRow = {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  /** Rows the model would act on at this threshold. */
  selected: number;
};

/** Every operating point, and the one that maximises F1. */
export type MlThresholdSweep = {
  positive_label: string;
  rows: MlSweepRow[];
  best_f1_threshold: number;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readScores(v: unknown): MlCalibrationScores | null {
  if (!isRecord(v)) return null;
  const brier = num(v.brier);
  const ece = num(v.calibration_error);
  if (brier === null || ece === null) return null;
  const curve: MlReliabilityBin[] = [];
  if (Array.isArray(v.curve)) {
    for (const raw of v.curve) {
      if (!isRecord(raw)) continue;
      const from = num(raw.from);
      const to = num(raw.to);
      const n = num(raw.n);
      const predicted = num(raw.predicted);
      const observed = num(raw.observed);
      if (from === null || to === null || n === null || predicted === null || observed === null)
        continue;
      curve.push({ from, to, n, predicted, observed });
    }
  }
  return { brier, calibration_error: ece, curve };
}

/**
 * Pull the calibration block out of a version's metrics.
 *
 * Returns null rather than a zeroed shape for a version trained before this
 * existed, so the panel can say "not measured" instead of implying perfection.
 */
export function readCalibration(metrics: unknown): MlCalibrationReport | null {
  if (!isRecord(metrics)) return null;
  const block = metrics.calibration;
  if (!isRecord(block)) return null;
  const before = readScores(block.before);
  if (!before) return null;
  return {
    calibrated: block.calibrated === true,
    method: typeof block.method === "string" ? block.method : null,
    before,
    after: readScores(block.after),
  };
}

/** Pull the operating-point table out of a version's metrics. */
export function readThresholdSweep(metrics: unknown): MlThresholdSweep | null {
  if (!isRecord(metrics)) return null;
  const block = metrics.threshold_sweep;
  if (!isRecord(block) || !Array.isArray(block.rows)) return null;
  const rows: MlSweepRow[] = [];
  for (const raw of block.rows) {
    if (!isRecord(raw)) continue;
    const threshold = num(raw.threshold);
    const precision = num(raw.precision);
    const recall = num(raw.recall);
    const f1 = num(raw.f1);
    const selected = num(raw.selected);
    if (
      threshold === null ||
      precision === null ||
      recall === null ||
      f1 === null ||
      selected === null
    )
      continue;
    rows.push({ threshold, precision, recall, f1, selected });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.threshold - b.threshold);
  const best = num(block.best_f1_threshold);
  return {
    positive_label: typeof block.positive_label === "string" ? block.positive_label : "",
    rows,
    // Fall back to the table rather than trusting a missing field: the row with
    // the best F1 is a fact about the rows, recomputable right here.
    best_f1_threshold: best ?? rows.reduce((a, b) => (b.f1 > a.f1 ? b : a), rows[0]).threshold,
  };
}

export type MlCalibrationVerdict = "calibrated" | "rejected" | "unmeasured";

/**
 * What to tell a reader about the confidence column.
 *
 * "rejected" is not a failure. The trainer tries calibration and keeps it only
 * when it improves BOTH the Brier score and the calibration error; a model
 * that was already well calibrated legitimately lands here, and so does one
 * whose holdout was too small to fit a reliable mapping. The distinction a
 * reader needs is between "these are probabilities" and "these are ranks", and
 * the error figure answers that — not the word "rejected".
 */
export function calibrationVerdict(report: MlCalibrationReport | null): MlCalibrationVerdict {
  if (!report) return "unmeasured";
  return report.calibrated ? "calibrated" : "rejected";
}

/** The scores that describe the model as SAVED, not as selected. */
export function effectiveScores(report: MlCalibrationReport): MlCalibrationScores {
  return report.calibrated && report.after ? report.after : report.before;
}

/**
 * How far the confidence column can be off, as a plain-language band.
 *
 * These are display bands, not a standard: expected calibration error is a
 * mean absolute gap in probability, so 0.05 means "typically within five
 * points". Naming the bands keeps a reader from treating 0.04 and 0.004 as
 * meaningfully different decisions.
 */
export function calibrationBand(ece: number): "tight" | "usable" | "loose" {
  if (ece <= 0.05) return "tight";
  if (ece <= 0.15) return "usable";
  return "loose";
}

/** The measured row nearest a chosen threshold, for "what would change". */
export function sweepRowAt(sweep: MlThresholdSweep, threshold: number): MlSweepRow | null {
  if (sweep.rows.length === 0) return null;
  let best = sweep.rows[0];
  let gap = Math.abs(best.threshold - threshold);
  for (const row of sweep.rows) {
    const d = Math.abs(row.threshold - threshold);
    if (d < gap) {
      best = row;
      gap = d;
    }
  }
  return best;
}

/**
 * The row the platform suggests, which is NOT a recommendation.
 *
 * F1 weights a false positive and a false negative equally, and the whole
 * reason this screen exists is that they usually are not equal. So the
 * suggestion is offered as the balanced point and labelled as such: a starting
 * position for a person who knows the ratio.
 */
export function balancedThreshold(sweep: MlThresholdSweep): number {
  return sweep.best_f1_threshold;
}

/** What moving the line from one point to another does, in rows and rates. */
export type MlThresholdChange = {
  from: MlSweepRow;
  to: MlSweepRow;
  /** Change in rows acted on. Negative means fewer. */
  selected_delta: number;
  precision_delta: number;
  recall_delta: number;
};

export function thresholdChange(
  sweep: MlThresholdSweep,
  from: number,
  to: number,
): MlThresholdChange | null {
  const a = sweepRowAt(sweep, from);
  const b = sweepRowAt(sweep, to);
  if (!a || !b) return null;
  return {
    from: a,
    to: b,
    selected_delta: b.selected - a.selected,
    precision_delta: b.precision - a.precision,
    recall_delta: b.recall - a.recall,
  };
}

/**
 * Is a threshold meaningful for this model at all?
 *
 * Only binary classification has one line to draw. A multiclass model has a
 * line per class and no single number to set; a regressor has none. Saying so
 * is better than offering a control that silently does nothing.
 */
export function thresholdApplies(task: string, classCount: number | null): boolean {
  return task === "classification" && classCount === 2;
}

/** The range the trainer actually measured, so the picker cannot leave it. */
export function sweepBounds(sweep: MlThresholdSweep): { min: number; max: number } {
  return {
    min: sweep.rows[0].threshold,
    max: sweep.rows[sweep.rows.length - 1].threshold,
  };
}
