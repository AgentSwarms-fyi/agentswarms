// One forecaster for the whole product.
//
// The BI chart overlay and the AI Analyst each used to fit their own straight
// line, and docs/BUSINESS_INTELLIGENCE.md promises the two "cannot disagree".
// This module is what both call now. It is pure and deterministic (no random
// state, no clock) so a scheduled refresh, a chart, an alert and the Analyst
// all project the same numbers from the same history.
//
// Method selection is deliberately conservative:
//   - a short series, or one with no detectable season, gets exact least
//     squares — the same numbers as before, the same caveat;
//   - a series whose labels or autocorrelation reveal a season, with at least
//     two full cycles, gets additive Holt-Winters (level, trend, season) —
//     but only when that fit beats the line on the history it was fitted to.
// A model that cannot beat a straight line on the past has no business
// projecting the future.
//
// The band is residual-based: 1.96 × the one-step-ahead error spread, widened
// by √k for k steps ahead. It says less the further out it goes, which is the
// honest shape of any projection.

export type ForecastMethod = "linear trend" | "seasonal smoothing";

export type ForecastFit = {
  method: ForecastMethod;
  /** Periods per cycle when the seasonal method won, else null. */
  seasonLength: number | null;
  /** Spread of the one-step-ahead residuals on the history. */
  sigma: number;
  /** Mean absolute error of the fit on the history it was fitted to. */
  fitError: number;
};

export type ForecastPoint = { step: number; value: number; lo: number; hi: number };

export type ForecastResult = { fit: ForecastFit; points: ForecastPoint[] };

/** Season implied by a bucket label's format, when the format says. */
export function seasonForLabel(label: string | null | undefined): number | null {
  const s = String(label ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 7;
  if (/^\d{4}-W\d{2}$/.test(s)) return 52;
  if (/^\d{4}-\d{2}$/.test(s)) return 12;
  if (/^\d{4}-Q[1-4]$/.test(s)) return 4;
  return null;
}

function finite(ys: number[]): number[] {
  return ys.map((y) => Number(y)).filter((y) => Number.isFinite(y));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function std(xs: number[], ddof = 1): number {
  if (xs.length <= ddof) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - ddof));
}

/** Autocorrelation of the detrended series at `lag`. */
function autocorrelation(ys: number[], lag: number): number {
  const n = ys.length;
  if (lag <= 0 || lag >= n - 1) return 0;
  // Detrend by first differences so a strong trend does not masquerade as a
  // season (every lag correlates on a ramp).
  const d = ys.slice(1).map((y, i) => y - ys[i]);
  const m = mean(d);
  let num = 0;
  let den = 0;
  for (let i = 0; i < d.length; i++) den += (d[i] - m) * (d[i] - m);
  for (let i = lag; i < d.length; i++) num += (d[i] - m) * (d[i - lag] - m);
  return den === 0 ? 0 : num / den;
}

/**
 * The season to try, or null. A label hint (monthly labels → 12) is trusted
 * when the history covers two cycles; otherwise common cycle lengths are
 * screened by autocorrelation and the strongest wins if it is strong at all.
 */
export function detectSeason(ys: number[], hint: number | null = null): number | null {
  const n = ys.length;
  const fits = (s: number) => s >= 2 && n >= 2 * s + 2;
  if (hint && fits(hint)) return hint;
  const candidates = [12, 7, 4, 24, 52, 6, 3].filter(fits);
  let best: { s: number; r: number } | null = null;
  for (const s of candidates) {
    const r = autocorrelation(ys, s);
    if (r > 0.3 && (!best || r > best.r)) best = { s, r };
  }
  return best?.s ?? null;
}

type Linear = { slope: number; intercept: number; sigma: number; fitError: number };

function linear(ys: number[]): Linear | null {
  const n = ys.length;
  if (n < 2) return null;
  const sx = ys.reduce((a, _y, i) => a + i, 0);
  const sy = ys.reduce((a, y) => a + y, 0);
  const sxx = ys.reduce((a, _y, i) => a + i * i, 0);
  const sxy = ys.reduce((a, y, i) => a + i * y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const resid = ys.map((y, i) => y - (slope * i + intercept));
  const sigma = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, n - 2));
  const fitError = mean(resid.map((r) => Math.abs(r)));
  return { slope, intercept, sigma, fitError };
}

type HoltWinters = {
  level: number;
  trend: number;
  seasonal: number[];
  sigma: number;
  fitError: number;
  season: number;
};

/** Additive Holt-Winters with a small parameter grid, scored one step ahead. */
function holtWinters(ys: number[], season: number): HoltWinters | null {
  const n = ys.length;
  if (n < 2 * season + 2) return null;
  const first = ys.slice(0, season);
  const second = ys.slice(season, 2 * season);
  const level0 = mean(first);
  const trend0 = (mean(second) - level0) / season;
  const seasonal0 = first.map((y) => y - level0);
  let best: HoltWinters | null = null;
  for (const alpha of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (const beta of [0.01, 0.05, 0.1, 0.2]) {
      for (const gamma of [0.05, 0.2, 0.4, 0.6]) {
        let level = level0;
        let trend = trend0;
        const seasonal = seasonal0.slice();
        const errors: number[] = [];
        for (let t = 0; t < n; t++) {
          const sIdx = t % season;
          const forecast = level + trend + seasonal[sIdx];
          if (t >= season) errors.push(ys[t] - forecast);
          const y = ys[t];
          const prevLevel = level;
          level = alpha * (y - seasonal[sIdx]) + (1 - alpha) * (level + trend);
          trend = beta * (level - prevLevel) + (1 - beta) * trend;
          seasonal[sIdx] = gamma * (y - level) + (1 - gamma) * seasonal[sIdx];
        }
        const fitError = mean(errors.map((e) => Math.abs(e)));
        if (!best || fitError < best.fitError) {
          best = { level, trend, seasonal, sigma: std(errors), fitError, season };
        }
      }
    }
  }
  return best;
}

/**
 * Project `periods` steps past the history. Returns null when there is
 * nothing to fit (fewer than two finite points, or a zero-period request).
 */
export function forecastValues(
  ysRaw: number[],
  periods: number,
  opts: { seasonLength?: number | null; labelHint?: string | null } = {},
): ForecastResult | null {
  const ys = finite(ysRaw);
  const n = ys.length;
  const steps = Math.max(0, Math.floor(periods));
  if (n < 2 || steps === 0) return null;
  const lin = linear(ys);
  if (!lin) return null;

  const hint = opts.seasonLength ?? seasonForLabel(opts.labelHint);
  const season = detectSeason(ys, hint);
  const hw = season ? holtWinters(ys, season) : null;
  // The seasonal model must beat the line on the history, clearly. A tie or
  // a marginal win is noise; a straight line is the more honest projection.
  const useSeasonal = Boolean(hw && hw.fitError < 0.9 * Math.max(lin.fitError, 1e-9));

  const points: ForecastPoint[] = [];
  if (useSeasonal && hw) {
    for (let k = 1; k <= steps; k++) {
      const sIdx = (n + k - 1) % hw.season;
      const value = hw.level + k * hw.trend + hw.seasonal[sIdx];
      const band = 1.96 * hw.sigma * Math.sqrt(k);
      points.push({ step: k, value, lo: value - band, hi: value + band });
    }
    return {
      fit: {
        method: "seasonal smoothing",
        seasonLength: hw.season,
        sigma: hw.sigma,
        fitError: hw.fitError,
      },
      points,
    };
  }
  for (let k = 1; k <= steps; k++) {
    const value = lin.slope * (n + k - 1) + lin.intercept;
    const band = 1.96 * lin.sigma * Math.sqrt(k);
    points.push({ step: k, value, lo: value - band, hi: value + band });
  }
  return {
    fit: { method: "linear trend", seasonLength: null, sigma: lin.sigma, fitError: lin.fitError },
    points,
  };
}

/** The assumption behind a fit, in words a write-up can repeat. */
export function forecastCaveat(fit: ForecastFit, history: number): string {
  const err = Number(fit.fitError.toFixed(2)).toLocaleString("en-US");
  if (fit.method === "seasonal smoothing") {
    return (
      `Projected by exponential smoothing of level, trend and a ${fit.seasonLength}-period season ` +
      `fitted to ${history} periods — it assumes the recent level, trend and seasonal pattern ` +
      `continue, and knows nothing about launches, pricing or anything that has not already ` +
      `happened. Mean fit error on the history: ${err}.`
    );
  }
  return (
    `Projected by fitting a straight line to ${history} periods and extending it — ` +
    `it assumes the recent trend simply continues, and knows nothing about seasonality, ` +
    `pipeline, or anything that has not already happened. Mean fit error on the history: ${err}.`
  );
}

/**
 * A chart's `forecast` setting, old or new shape. The number form is the
 * built-in forecaster; the object form may attach a registry forecast model
 * whose projected points travel inside the spec.
 */
export type ForecastSetting =
  | number
  | {
      periods: number;
      versionId?: string;
      model?: string;
      trainedAt?: string;
      points?: { period: string; yhat: number; lo: number; hi: number }[];
    };

export function forecastPeriods(setting: ForecastSetting | undefined | null): number {
  if (!setting) return 0;
  if (typeof setting === "number") return Math.max(0, Math.round(setting));
  return Math.max(0, Math.round(setting.periods ?? 0));
}

export function forecastVersionId(setting: ForecastSetting | undefined | null): string | null {
  return setting && typeof setting === "object" && setting.versionId ? setting.versionId : null;
}

/** A registry model's stored projection, when one is attached and populated. */
export function forecastModelPoints(
  setting: ForecastSetting | undefined | null,
): { period: string; yhat: number; lo: number; hi: number }[] | null {
  if (!setting || typeof setting !== "object" || !setting.versionId) return null;
  return Array.isArray(setting.points) && setting.points.length ? setting.points : null;
}
