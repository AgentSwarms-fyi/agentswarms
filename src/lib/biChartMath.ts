// Pure chart-analytics helpers: category drill-down, date bucketing,
// running totals, prior-period overlays, linear trend and forecasting.
// Everything operates on widget snapshot rows, so it works identically in
// the editor, shared views and the public page.

import type { BiCondFormat, BiCondRule } from "@/lib/biAgent";

export type DrillEntry = { field: string; value: string };

// ── Conditional cell formatting (pivot/matrix) ──────────────────────────

export const COND_COLORS: Record<string, { label: string; hex: string }> = {
  emerald: { label: "Emerald", hex: "#59A14F" },
  rose: { label: "Rose", hex: "#E15759" },
  amber: { label: "Amber", hex: "#F28E2B" },
  blue: { label: "Blue", hex: "#4E79A7" },
  violet: { label: "Violet", hex: "#B07AA1" },
  teal: { label: "Teal", hex: "#76B7B2" },
  slate: { label: "Slate", hex: "#9c755f" },
};

export function condRuleMatches(v: number, r: BiCondRule): boolean {
  switch (r.op) {
    case "gt":
      return v > r.value;
    case "gte":
      return v >= r.value;
    case "lt":
      return v < r.value;
    case "lte":
      return v <= r.value;
    case "eq":
      return v === r.value;
    case "neq":
      return v !== r.value;
    case "between":
      return v >= r.value && v <= (r.value2 ?? r.value);
  }
}

/**
 * Cell colours for a value under the given conditional format.
 * Rules: first matching rule wins (tinted background + coloured text).
 * Scale: background intensity from min→max (text colour untouched).
 */
export function condFill(
  v: number,
  cf: BiCondFormat | undefined,
  min: number,
  max: number,
): { bg: string; fg?: string } | null {
  if (!cf || !Number.isFinite(v)) return null;
  if (cf.mode === "rules") {
    for (const r of cf.rules ?? []) {
      const hex = COND_COLORS[r.color]?.hex;
      if (!hex || !Number.isFinite(r.value)) continue;
      if (condRuleMatches(v, r)) {
        return { bg: `color-mix(in oklch, ${hex} 22%, transparent)`, fg: hex };
      }
    }
    return null;
  }
  const hex = COND_COLORS[cf.color ?? "blue"]?.hex ?? COND_COLORS.blue.hex;
  const t = max > min ? (v - min) / (max - min) : 0.5;
  const pct = Math.round(6 + 64 * Math.max(0, Math.min(1, t)));
  return { bg: `color-mix(in oklch, ${hex} ${pct}%, transparent)` };
}

/** Rows matching every step of the drill path (string-compared). */
export function drillRows(
  rows: Record<string, unknown>[],
  path: DrillEntry[],
): Record<string, unknown>[] {
  if (path.length === 0) return rows;
  return rows.filter((r) => path.every((p) => String(r[p.field]) === p.value));
}

export type DateGrain = "day" | "week" | "month" | "quarter" | "year";

export function parseDateValue(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // A NUMERIC year is the year, exactly as the string branch reads "2026".
    // The two branches must agree: the same column arrives as text or number
    // depending on the loader, and a chart that buckets differently for the
    // same data is worse than one that refuses.
    if (Number.isInteger(v) && v >= 1000 && v <= 9999) return new Date(Date.UTC(v, 0, 1));
    // Below 1000 an integer is a month, quarter, day-of-month or a plain
    // count — never an epoch stamp, since that would be the first seconds of
    // 1970. This guard is the whole point of the branch: without it a `year`
    // or `month` column parsed as seconds-since-epoch, isMostlyDates then said
    // "yes, dates" and offered the grain toggle, and bucketDate collapsed
    // EVERY row into 1970 — a flat one-bar chart with nothing reporting an
    // error. The string branch had rejected exactly these values since it was
    // written; the number branch never did.
    if (Number.isInteger(v) && Math.abs(v) < 1000) return null;
    const d = new Date(v > 10_000_000_000 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== "string" || !v.trim()) return null;
  // Reject plain numbers ("2026" is a year but "42" is not a date).
  if (/^\d{1,3}(\.\d+)?$/.test(v.trim())) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when ≥80% of the field's non-null values parse as dates. */
export function isMostlyDates(rows: Record<string, unknown>[], field: string): boolean {
  const vals = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined && v !== "");
  if (vals.length === 0) return false;
  const ok = vals.filter((v) => parseDateValue(v) !== null).length;
  return ok / vals.length >= 0.8;
}

/** ISO-week helper (UTC). */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

/** Bucket label for a date at the given grain, e.g. "2026-07", "2026-Q3". */
export function bucketDate(v: unknown, grain: DateGrain): string | null {
  const d = parseDateValue(v);
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (grain) {
    case "day":
      return `${y}-${String(m + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    case "week": {
      const w = isoWeek(d);
      return `${w.year}-W${String(w.week).padStart(2, "0")}`;
    }
    case "month":
      return `${y}-${String(m + 1).padStart(2, "0")}`;
    case "quarter":
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case "year":
      return String(y);
  }
}

/** Replace a field's values with bucket labels (unparsable rows dropped). */
export function bucketRowsX(
  rows: Record<string, unknown>[],
  field: string,
  grain: DateGrain,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const b = bucketDate(r[field], grain);
    if (b !== null) out.push({ ...r, [field]: b });
  }
  // Buckets sort lexicographically within this label scheme.
  return out.sort((a, b) => String(a[field]).localeCompare(String(b[field])));
}

/** Cumulative sum over `key` (in array order). Returns new objects. */
export function cumulative<T extends Record<string, unknown>>(data: T[], key: string): T[] {
  let acc = 0;
  return data.map((d) => {
    const n = Number(d[key]);
    if (Number.isFinite(n)) acc += n;
    return { ...d, [key]: acc };
  });
}

/** Lag-1 overlay: prior[i] = value[i-1]. */
export function priorPeriodOverlay<T extends Record<string, unknown>>(
  data: T[],
  key: string,
  outKey: string,
): T[] {
  return data.map((d, i) => ({ ...d, [outKey]: i > 0 ? data[i - 1][key] : null }));
}

/** Year-over-year overlay: match each x label against its year−1 twin. */
export function priorYearOverlay<T extends Record<string, unknown>>(
  data: T[],
  xKey: string,
  yKey: string,
  outKey: string,
): T[] {
  const byX = new Map(data.map((d) => [String(d[xKey]), d[yKey]]));
  return data.map((d) => {
    const label = String(d[xKey]);
    const shifted = label.replace(/\d{4}/, (y) => String(Number(y) - 1));
    return { ...d, [outKey]: shifted !== label ? (byX.get(shifted) ?? null) : null };
  });
}

export type LinearFit = { slope: number; intercept: number; sigma: number };

/** Least-squares fit of y over index, with residual std deviation. */
export function linearFit(ys: number[]): LinearFit | null {
  const pts = ys.map((y, i) => [i, y] as const).filter(([, y]) => Number.isFinite(y));
  const n = pts.length;
  if (n < 2) return null;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const resid = pts.map(([x, y]) => y - (slope * x + intercept));
  const sigma = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, n - 2));
  return { slope, intercept, sigma };
}

/**
 * Forecast rows appended after the series: dashed projection with a ±1.96σ
 * corridor. x labels extend the last bucket when possible, else "+n".
 */
export function forecastRows(
  data: Record<string, unknown>[],
  xKey: string,
  yKey: string,
  periods: number,
): { fit: LinearFit; rows: Record<string, unknown>[] } | null {
  const fit = linearFit(data.map((d) => Number(d[yKey])));
  if (!fit || periods <= 0) return null;
  const n = data.length;
  const rows = Array.from({ length: Math.min(periods, 24) }, (_, k) => {
    const i = n + k;
    const y = fit.slope * i + fit.intercept;
    const band = 1.96 * fit.sigma;
    return {
      [xKey]: nextBucketLabel(String(data[n - 1]?.[xKey] ?? ""), k + 1) ?? `+${k + 1}`,
      __forecast: y,
      __lo: y - band,
      __hi: y + band,
    };
  });
  return { fit, rows };
}

/** Extend "2026-07" → "2026-08", "2026-Q3" → "2026-Q4", "2026" → "2027"… */
export function nextBucketLabel(last: string, step: number): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(last);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + step));
    return bucketDate(d, "day");
  }
  m = /^(\d{4})-W(\d{2})$/.exec(last);
  if (m) {
    // Approximate: weeks advance by 7 days from the ISO week's Thursday.
    const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
    const day = jan4.getUTCDay() || 7;
    const week1Mon = new Date(jan4.getTime() - (day - 1) * 86400000);
    const target = new Date(week1Mon.getTime() + ((Number(m[2]) - 1 + step) * 7 + 3) * 86400000);
    return bucketDate(target, "week");
  }
  m = /^(\d{4})-(\d{2})$/.exec(last);
  if (m) {
    const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + step;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
  }
  m = /^(\d{4})-Q([1-4])$/.exec(last);
  if (m) {
    const total = Number(m[1]) * 4 + (Number(m[2]) - 1) + step;
    return `${Math.floor(total / 4)}-Q${(total % 4) + 1}`;
  }
  m = /^(\d{4})$/.exec(last);
  if (m) return String(Number(m[1]) + step);
  return null;
}
