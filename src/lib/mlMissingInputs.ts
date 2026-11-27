// Inputs that stop arriving (R549).
//
// Drift (the PSI on every batch run, and on live traffic since R545) measures
// the values that DID arrive. A feed that stops sending a field, or a join that
// starts leaving it empty, is invisible there: the few values still coming in
// look like training, the badge says stable, and every other row is scored on
// the value the pipeline fills in for a blank. That is the commonest way a
// served model quietly breaks, and retraining does not fix it.
//
// So each feature the training data described is also counted for how often
// it arrived with no usable value (absent, empty, or for a number not a
// number), and compared with how often it was empty in training.
//
// ONE COUNT, THREE PLACES. Training records the rate (`_feature_stats`), a
// batch run counts its rows (`_missing_rates`), both in
// src/utils/ml/pyTrain.ts; an online request's counts are already in its
// profile (R545): every value lands in some bin, so the rows NOT in any bin are
// the missing ones. tests/fixtures/trafficDriftParity.json holds the three to
// the same figures.
//
// Pure: no database, no network.
import type { FeatureStats, TrafficProfile } from "@/lib/mlTraffic";

/** Flagged at this many points above training's own rate: 0.1 is ten. */
export const MISSING_RISE = 0.1;
/**
 * A version trained before R549 has no training rate. Its features are named
 * only when they stopped arriving almost entirely, which a feature the model
 * learned from was very unlikely to do in training.
 */
export const MISSING_UNKNOWN_FLOOR = 0.95;
/**
 * Fewer rows than this and there is no verdict. A single share settles far
 * sooner than a distribution over ten bins, so this is lower than drift's 200:
 * at 100 rows a ten-point rise is over four standard deviations from a 5%
 * training rate.
 */
export const MISSING_MIN_ROWS = 100;

/** How often each feature arrived empty: only features with any missing row are listed. */
export type MissingRates = { rows: number; rates: Record<string, number> };

/** One feature arriving empty more often than in training. */
export type MissingInput = {
  feature: string;
  /** Share of the measured rows with no usable value. */
  rate: number;
  /** Share in training, or null for a version trained before it was recorded. */
  training: number | null;
};

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * The missing rates of a window of online requests, from their counts alone.
 * A feature in the stats but in no request's counts was sent by none of them:
 * every row is missing it.
 */
export function missingFromProfile(stats: FeatureStats, profile: TrafficProfile): MissingRates {
  const rates: Record<string, number> = {};
  const rows = profile.rows;
  if (rows <= 0) return { rows: 0, rates };
  for (const name of Object.keys(stats)) {
    const counts = profile.f[name];
    const have = counts ? counts.reduce((x, y) => x + y, 0) : 0;
    if (have < rows) rates[name] = round4(1 - have / rows);
  }
  return { rows, rates };
}

/** A batch run's rates as the trainer returned them, or null when they are not that shape. */
export function missingRatesOf(value: unknown): MissingRates | null {
  const m = value as Partial<MissingRates> | null;
  if (!m || typeof m !== "object" || typeof m.rows !== "number" || m.rows < 0) return null;
  if (!m.rates || typeof m.rates !== "object" || Array.isArray(m.rates)) return null;
  const rates: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.rates)) {
    if (typeof v === "number" && v >= 0 && v <= 1) rates[k] = v;
  }
  return { rows: m.rows, rates };
}

/**
 * The features arriving empty markedly more often than in training, the
 * largest rise first. Null when too few rows were measured to say; an empty
 * list means every feature arrived about as often as in training.
 */
export function missingInputs(stats: FeatureStats, m: MissingRates): MissingInput[] | null {
  if (m.rows < MISSING_MIN_ROWS) return null;
  const out: MissingInput[] = [];
  for (const [feature, st] of Object.entries(stats)) {
    const rate = m.rates[feature] ?? 0;
    const training = typeof st.missing === "number" ? st.missing : null;
    // A hair under the rise, so a rate rounded to four places on both sides
    // is not refused for the rounding.
    const flagged =
      training === null ? rate >= MISSING_UNKNOWN_FLOOR : rate - training >= MISSING_RISE - 1e-9;
    if (flagged) out.push({ feature, rate, training });
  }
  const rise = (x: MissingInput) => x.rate - (x.training ?? 0);
  return out.sort((a, b) => rise(b) - rise(a) || a.feature.localeCompare(b.feature));
}

/** A share as a person reads it: "38%", "under 1%", "100%". */
export function sharePct(x: number): string {
  if (x <= 0) return "0%";
  if (x < 0.01) return "under 1%";
  if (x > 0.99 && x < 1) return "over 99%";
  return `${Math.round(x * 100)}%`;
}

/** "income empty in 38% of rows (2% in training), region in 100% (not recorded at training)". */
export function missingLine(list: MissingInput[], n = 3): string {
  const parts = list.slice(0, n).map((x, i) => {
    const was =
      x.training === null ? "not recorded at training" : `${sharePct(x.training)} in training`;
    return `${x.feature} ${i === 0 ? "empty in " : "in "}${sharePct(x.rate)}${i === 0 ? " of rows" : ""} (${was})`;
  });
  const more = list.length > n ? `, and ${list.length - n} more` : "";
  return parts.join(", ") + more;
}
