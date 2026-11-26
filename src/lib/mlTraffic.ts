// Drift on live traffic (R545).
//
// A batch run measures drift on the rows it scored, and so does a direct
// prediction of ten rows or more. A warm endpoint answers one row at a time,
// so the traffic a served model actually sees was never measured at all: a
// model behind an API could drift for months and say nothing.
//
// Each online request is binned against its version's training distribution
// (the same bins the batch path uses) and only the COUNTS are kept, on the
// request's own prediction row. A window of requests is summed and measured
// with the batch path's formula. No value a caller sent is stored: a number
// becomes "one more in bin 4", a category one more for a value the training
// data already held, or one more "other".
//
// ONE DEFINITION. The formula is `_drift` in src/utils/ml/pyTrain.ts, and
// tests/fixtures/trafficDriftParity.json is that function's own output on
// awkward rows; the test holds this file to it. Summing per-request counts and
// measuring the sum is exactly measuring all the rows at once.
//
// Pure: no database, no network.
import { ML_DRIFT_MODERATE } from "@/utils/ml/types";

/** How far back live traffic is measured. */
export const TRAFFIC_WINDOW_HOURS = 24;
/** Fewer rows than this in the window and there is no verdict, only a count. */
export const TRAFFIC_MIN_ROWS = 200;
/** At most this many requests are read for one version's window. */
export const TRAFFIC_MAX_REQUESTS = 5_000;
/** The batch path's own floor: a number seen fewer times than this is not compared. */
const MIN_NUMERIC_VALUES = 10;

export type NumericStat = { kind: "numeric"; edges: number[]; props: number[]; n?: number };
export type CategoricalStat = {
  kind: "categorical";
  props: Record<string, number>;
  other?: number;
  n?: number;
};
export type FeatureStats = Record<string, NumericStat | CategoricalStat>;

/**
 * What one request (or a window of them) looked like, against one version's
 * bins: per feature the count in each bin, and for a category the count of
 * each training value in the stats' own key order, then "other". A feature
 * is present when any row carried its key, even empty: the batch path counts
 * a column that exists and is all empty as all "other".
 */
export type TrafficProfile = { v: 1; rows: number; f: Record<string, number[]> };

/** The stats a version row holds, or null when it is missing or not that shape. */
export function featureStatsOf(value: unknown): FeatureStats | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: FeatureStats = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const st = raw as { kind?: unknown; edges?: unknown; props?: unknown; other?: unknown } | null;
    if (!st || typeof st !== "object") continue;
    if (
      st.kind === "numeric" &&
      Array.isArray(st.edges) &&
      Array.isArray(st.props) &&
      st.edges.length >= 2 &&
      st.edges.every((e) => typeof e === "number" && Number.isFinite(e)) &&
      st.props.every((p) => typeof p === "number")
    ) {
      out[name] = { kind: "numeric", edges: st.edges as number[], props: st.props as number[] };
    } else if (st.kind === "categorical" && st.props && typeof st.props === "object") {
      const props = st.props as Record<string, unknown>;
      if (!Object.values(props).every((p) => typeof p === "number")) continue;
      out[name] = {
        kind: "categorical",
        props: props as Record<string, number>,
        other: typeof st.other === "number" ? st.other : 0,
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A value as `pd.to_numeric(errors='coerce')` reads it: a number, a boolean as
 * 1 or 0, numeric text (spaces around it allowed); anything else is missing.
 */
export function numericValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (!NUMERIC_TEXT.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A value as `astype(str)` writes it, for matching a training category:
 * True/False as Python spells them. Null is missing. (A whole number written
 * as 3.0 in JSON arrives here as 3; categories are nearly always text.)
 */
export function categoryText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isNaN(v)) return null;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * numpy.histogram's bin for a value clipped into [first edge, last edge]: the
 * last edge itself falls in the last bin, which the search's upper bound
 * already gives.
 */
function binOf(edges: number[], v: number): number {
  const x = Math.min(Math.max(v, edges[0]), edges[edges.length - 1]);
  let lo = 0;
  let hi = edges.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Bin some rows against a version's training distribution. */
export function profileRows(stats: FeatureStats, rows: Record<string, unknown>[]): TrafficProfile {
  const f: Record<string, number[]> = {};
  for (const [name, st] of Object.entries(stats)) {
    const present = rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, name));
    if (!present) continue;
    if (st.kind === "numeric") {
      const counts = new Array(st.edges.length - 1).fill(0);
      for (const r of rows) {
        const n = numericValue(r?.[name]);
        if (n !== null) counts[binOf(st.edges, n)]++;
      }
      f[name] = counts;
    } else {
      const cats = Object.keys(st.props);
      const index = new Map(cats.map((c, i) => [c, i] as const));
      const counts = new Array(cats.length + 1).fill(0);
      for (const r of rows) {
        const t = categoryText(r?.[name]);
        if (t === null) continue;
        counts[index.get(t) ?? cats.length]++;
      }
      f[name] = counts;
    }
  }
  return { v: 1, rows: rows.length, f };
}

/** A stored profile, or null when the value is not one. */
export function profileOf(value: unknown): TrafficProfile | null {
  const p = value as Partial<TrafficProfile> | null;
  if (!p || typeof p !== "object" || p.v !== 1 || typeof p.rows !== "number") return null;
  if (!p.f || typeof p.f !== "object") return null;
  for (const counts of Object.values(p.f)) {
    if (!Array.isArray(counts) || !counts.every((c) => typeof c === "number")) return null;
  }
  return p as TrafficProfile;
}

/** Two windows' counts as one. Features of different lengths (another version's bins) are dropped. */
export function mergeProfiles(a: TrafficProfile, b: TrafficProfile): TrafficProfile {
  const f: Record<string, number[]> = { ...a.f };
  for (const [name, counts] of Object.entries(b.f)) {
    const was = f[name];
    if (!was) f[name] = [...counts];
    else if (was.length === counts.length) f[name] = was.map((c, i) => c + counts[i]);
  }
  return { v: 1, rows: a.rows + b.rows, f };
}

export type TrafficDrift = { score: number; features: Record<string, number>; rows: number };

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

function psiOf(actual: number[], expected: number[]): number {
  let s = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = Math.max(actual[i], 1e-4);
    const e = Math.max(expected[i], 1e-4);
    s += (a - e) * Math.log(a / e);
  }
  return s;
}

/**
 * The population stability index per feature, exactly as the batch path
 * computes it: the highest is the score. Null when no feature could be
 * compared.
 */
export function trafficDrift(stats: FeatureStats, profile: TrafficProfile): TrafficDrift | null {
  const out: Record<string, number> = {};
  for (const [name, st] of Object.entries(stats)) {
    const counts = profile.f[name];
    if (!counts) continue;
    let actual: number[];
    let expected: number[];
    if (st.kind === "numeric") {
      const total = counts.reduce((x, y) => x + y, 0);
      if (total < MIN_NUMERIC_VALUES) continue;
      actual = counts.map((c) => c / total);
      expected = st.props;
    } else {
      const cats = Object.keys(st.props);
      const total = counts.reduce((x, y) => x + y, 0);
      const known = cats.map((_, i) => (total ? (counts[i] ?? 0) / total : 0));
      const seen = known.reduce((x, y) => x + y, 0);
      actual = [...known, Math.max(0, 1 - seen)];
      expected = [...cats.map((c) => st.props[c]), st.other ?? 0];
    }
    if (actual.length !== expected.length) continue;
    out[name] = psiOf(actual, expected);
  }
  const ranked = Object.entries(out).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  return {
    score: round4(ranked[0][1]),
    features: Object.fromEntries(ranked.map(([k, v]) => [k, round4(v)])),
    rows: profile.rows,
  };
}

export type DriftBand = "stable" | "moderate" | "high";

/** The bands a run's Drift badge uses: below 0.1 stable, then moderate, high from 0.25. */
export function driftBand(score: number): DriftBand {
  if (score >= 0.25) return "high";
  if (score >= ML_DRIFT_MODERATE) return "moderate";
  return "stable";
}

/** "region 2.05, amount 1.37, plan 0.96": the three that moved most. */
export function topFeaturesLine(d: TrafficDrift, n = 3): string {
  return Object.entries(d.features)
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ");
}

/** The day a window ends on, so a version alerts at most once a day for its traffic. */
export function trafficAlertKey(versionId: string, now: Date): string {
  return `traffic:${versionId}:${now.toISOString().slice(0, 10)}`;
}
