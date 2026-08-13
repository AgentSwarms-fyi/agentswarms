// Time-series reading for the AI Analyst: what happened, what stands out,
// and — labelled as such — what the trend implies next.
//
// Same split as driver analysis: the model writes the SQL and reads the
// result, the arithmetic happens here. A forecast a language model narrates
// is a sentence; a forecast computed from the series is a number with a
// method behind it, and the difference matters most when someone acts on it.
//
// Two honesty rules run through this file:
//
//   1. A projection is never presented as data. Everything this returns is
//      labelled an estimate with its method named, and the analyst's prose
//      is instructed to say so.
//   2. Too little history means no forecast at all. Three points can be fit
//      by a line perfectly and predict nothing; refusing is the correct
//      answer, not a smaller-print caveat.
//
// Nothing here talks to a database, a model, or React.

export type SeriesPoint = { label: string; value: number };

export type Anomaly = {
  index: number;
  label: string;
  value: number;
  /** Robust z-score: deviations from the median in MAD units. */
  score: number;
  direction: "high" | "low";
};

export type SeriesReading = {
  points: SeriesPoint[];
  first: SeriesPoint;
  last: SeriesPoint;
  /** Ordinary least squares on the index — the slope PER PERIOD. */
  slopePerPeriod: number;
  /** Slope as a fraction of the mean, so it reads as "+3% per period". */
  slopePctPerPeriod: number | null;
  direction: "rising" | "falling" | "flat";
  mean: number;
  median: number;
  anomalies: Anomaly[];
};

export type Forecast = {
  points: SeriesPoint[];
  method: "linear trend";
  /** Mean absolute error of the fit ON THE HISTORY it was fitted to. */
  fitError: number;
  /** What this forecast assumes, in words, for the write-up to repeat. */
  caveat: string;
};

/** Below this, a "trend" is an artefact of having almost no data. */
export const MIN_SERIES_POINTS = 5;

/** Below this, a forecast is a straight line through noise. */
export const MIN_FORECAST_POINTS = 8;

/** How far past the data a linear trend may be pushed before it is fiction. */
export const MAX_FORECAST_PERIODS = 6;

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

/** Least-squares fit of value against index. */
function fitLine(values: number[]): { slope: number; intercept: number } {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * Is this result a time series, and if so, which columns are it?
 *
 * A "time" column is recognised by parseable dates or by an ordered label
 * pattern models produce constantly (2026-01, 2026-Q1, Jan 2026). Order is
 * NOT assumed — a series sorted by value rather than by time would make
 * every trend meaningless, so the points are sorted by their time key here.
 */
export function seriesFrom(
  columns: string[],
  rows: Record<string, unknown>[],
): SeriesPoint[] | null {
  if (rows.length < MIN_SERIES_POINTS) return null;

  // THE TIME COLUMN IS FOUND FIRST, and the measure is chosen from what is
  // left. Doing it the other way round picked the DATE as the measure the
  // moment a date arrived as a number — which is exactly what DuckDB's
  // DATE_TRUNC returns over the wire: 1640995200000, not "2022-01-01".
  const TIME_NAME_RE = /month|date|day|week|quarter|year|period|time|dt$/i;
  const isEpochMs = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && Math.abs(v) >= 1e11 && Math.abs(v) <= 4e12;

  const valuesOf = (c: string) =>
    rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined);

  const looksTemporal = (c: string): boolean => {
    const vals = valuesOf(c);
    if (vals.length === 0) return false;
    // Epoch numbers are only ever a time column when the NAME says so too —
    // a large id or a currency amount must not become an axis.
    if (vals.every(isEpochMs)) return TIME_NAME_RE.test(c);
    return vals.every((v) => {
      if (typeof v === "number") return false;
      const s = String(v).trim();
      // ANCHORED. Unanchored, /^\d{4}/ matched "13946.22" as the year 1394
      // and turned a sales column into a timeline.
      if (/^\d{4}(-\d{2}){0,2}$/.test(s)) return true; // 2026 / 2026-01 / 2026-01-31
      if (/^\d{4}[-/]\d{2}[-/]\d{2}([ T].*)?$/.test(s)) return true; // full timestamps
      if (/^\d{4}[- ]?q[1-4]$/i.test(s)) return true; // 2026-Q1
      if (/^[a-z]{3,9}\s+\d{4}$/i.test(s)) return true; // Jan 2026
      return false;
    });
  };

  const timeCol = columns.find(looksTemporal);
  if (!timeCol) return null;

  const measure = columns.find(
    (c) => c !== timeCol && rows.some((r) => typeof r[c] === "number" && Number.isFinite(r[c])),
  );
  if (!measure) return null;

  const monthNames = "janfebmaraprmayjunjulaugsepoctnovdec";
  const label = (v: unknown): string =>
    isEpochMs(v) ? new Date(v as number).toISOString().slice(0, 10) : String(v);
  const sortKey = (v: unknown): string => {
    if (isEpochMs(v)) return new Date(v as number).toISOString();
    const s = String(v);
    const m = /^([a-z]{3,9})\s+(\d{4})$/i.exec(s);
    if (m) {
      const i = monthNames.indexOf(m[1].slice(0, 3).toLowerCase()) / 3;
      return `${m[2]}-${String(i + 1).padStart(2, "0")}`;
    }
    return s;
  };

  return rows
    .filter((r) => typeof r[measure] === "number")
    .map((r) => ({
      label: label(r[timeCol]),
      value: r[measure] as number,
      key: sortKey(r[timeCol]),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ label: l, value }) => ({ label: l, value }));
}

/**
 * Trend and outliers.
 *
 * Outliers use MEDIAN and MAD, not mean and standard deviation: the outlier
 * inflates the very standard deviation used to judge it, which is how the
 * naive version misses exactly the spike it was written to find.
 */
export function readSeries(points: SeriesPoint[]): SeriesReading | null {
  if (points.length < MIN_SERIES_POINTS) return null;
  const values = points.map((p) => p.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const { slope } = fitLine(values);

  // 0.6745 converts MAD into a standard-deviation-equivalent for a normal
  // distribution, which is what makes a "3 sigma" threshold mean anything.
  const anomalies: Anomaly[] =
    mad === 0
      ? []
      : points
          .map((p, i) => ({
            index: i,
            label: p.label,
            value: p.value,
            score: (0.6745 * (p.value - med)) / mad,
            direction: p.value >= med ? ("high" as const) : ("low" as const),
          }))
          .filter((a) => Math.abs(a.score) >= 3)
          .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  const flatBand = Math.abs(mean) * 0.01;
  return {
    points,
    first: points[0],
    last: points[points.length - 1],
    slopePerPeriod: slope,
    slopePctPerPeriod: mean === 0 ? null : slope / Math.abs(mean),
    direction: slope > flatBand ? "rising" : slope < -flatBand ? "falling" : "flat",
    mean,
    median: med,
    anomalies,
  };
}

/**
 * Project the fitted trend forward — or refuse.
 *
 * Refusal is the interesting branch. With seven monthly points a straight
 * line will extrapolate happily and be worthless, so `null` is returned and
 * the analysis simply says what the data does instead of what it might do.
 */
export function forecastSeries(points: SeriesPoint[], periods = 3): Forecast | null {
  if (points.length < MIN_FORECAST_POINTS) return null;
  const n = Math.max(1, Math.min(periods, MAX_FORECAST_PERIODS));
  const values = points.map((p) => p.value);
  const { slope, intercept } = fitLine(values);
  const fitted = values.map((_, i) => intercept + slope * i);
  const fitError = values.reduce((a, v, i) => a + Math.abs(v - fitted[i]), 0) / values.length;

  return {
    points: Array.from({ length: n }, (_, k) => ({
      label: `+${k + 1}`,
      value: intercept + slope * (values.length + k),
    })),
    method: "linear trend",
    fitError,
    caveat:
      `Projected by fitting a straight line to ${points.length} periods and extending it — ` +
      `it assumes the recent trend simply continues, and knows nothing about seasonality, ` +
      `pipeline, or anything that has not already happened. Mean fit error on the history: ` +
      `${Number(fitError.toFixed(2)).toLocaleString("en-US")}.`,
  };
}

/** The reading (and any projection) as text for the write-up prompt. */
export function describeSeries(reading: SeriesReading, forecast: Forecast | null): string {
  const num = (n: number) => Number(n.toFixed(4)).toLocaleString("en-US");
  const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
  const parts = [
    `SERIES: ${reading.points.length} periods, ${reading.first.label} (${num(
      reading.first.value,
    )}) to ${reading.last.label} (${num(reading.last.value)}). ` +
      `Trend is ${reading.direction} at ${num(reading.slopePerPeriod)} per period ` +
      `(${pct(reading.slopePctPerPeriod)} of the mean).`,
    reading.anomalies.length > 0
      ? `OUTLIERS (median-based, 3+ deviations):\n` +
        reading.anomalies
          .map(
            (a) =>
              `${a.label}: ${num(a.value)} — ${a.direction} outlier, ${a.score.toFixed(1)} deviations`,
          )
          .join("\n")
      : "No periods stand out as outliers.",
    forecast
      ? `PROJECTION (ESTIMATE, NOT MEASURED DATA):\n` +
        forecast.points.map((p) => `${p.label} periods ahead: ${num(p.value)}`).join("\n") +
        `\n${forecast.caveat}\nSay in the write-up that these are projections, not measurements.`
      : `Too few periods to project responsibly (needs ${MIN_FORECAST_POINTS}); ` +
        `report what the data shows and do not extrapolate.`,
  ];
  return parts.join("\n\n");
}
