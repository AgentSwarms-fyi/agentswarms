// A measure per period, and the comparisons a KPI tile and a narrative make
// from it: this period against the one before, or against the same period a
// year earlier (R498).
//
// Every dashboard demo that shows a headline number shows it this way — the
// latest month, an arrow, the change, and a line of the months behind it. A
// tile that only shows a total cannot say whether the number is good news.
//
// Pure: rows in, numbers out. The tile and the narrative widgets both read
// from here, so the sentence under a chart and the arrow on a tile cannot
// disagree about what "last month" was.
import { bucketDate, nextBucketLabel, parseDateValue, type DateGrain } from "@/lib/biChartMath";

export type PeriodPoint = { label: string; value: number };

export type PeriodSeries = {
  grain: DateGrain;
  points: PeriodPoint[];
  /** Rows whose date or value could not be read, and so are not counted. */
  dropped: number;
};

const DAY = 86_400_000;

/**
 * A period value as a date: everything parseDateValue reads, plus the two
 * labels SQL hands back constantly and `new Date` cannot read — "2026-Q3"
 * (the quarter's first day) and "2026-W05" (that ISO week's Monday).
 */
export function parsePeriodValue(v: unknown): Date | null {
  if (typeof v === "string") {
    const s = v.trim();
    let m = /^(\d{4})-?Q([1-4])$/i.exec(s);
    if (m) return new Date(Date.UTC(Number(m[1]), (Number(m[2]) - 1) * 3, 1));
    m = /^(\d{4})-?W(\d{2})$/i.exec(s);
    if (m) {
      const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
      const day = jan4.getUTCDay() || 7;
      return new Date(jan4.getTime() + ((Number(m[2]) - 1) * 7 - (day - 1)) * DAY);
    }
  }
  return parseDateValue(v);
}

/**
 * The grain the rows are ALREADY at, from the median gap between distinct
 * dates.
 *
 * This is what "auto" means for a period comparison, and it is deliberately
 * not autoDateGrain (which picks the finest grain that keeps an axis readable,
 * and so would happily sum 700 daily rates into weekly ones). Summing within a
 * bucket is the identity when the rows are one per bucket, which is the shape
 * a query grouped by month returns — so a rate, an average or a balance per
 * month comes through untouched.
 */
export function inferGrain(dates: Date[]): DateGrain {
  const times = [...new Set(dates.map((d) => d.getTime()))].sort((a, b) => a - b);
  if (times.length < 2) return "month";
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY);
  gaps.sort((a, b) => a - b);
  const mid = gaps[Math.floor(gaps.length / 2)];
  if (mid <= 1.5) return "day";
  if (mid <= 8) return "week";
  if (mid <= 32) return "month";
  if (mid <= 93) return "quarter";
  return "year";
}

/**
 * One value per period, oldest first.
 *
 * Values in the same bucket are SUMMED. With an explicit grain coarser than
 * the rows that is the point (daily orders into months); with "auto" each row
 * is its own bucket and nothing is added together.
 */
export function periodSeries(
  rows: Record<string, unknown>[],
  dateField: string,
  valueField: string,
  grain: DateGrain | "auto" = "auto",
): PeriodSeries {
  const parsed: { date: Date; value: number }[] = [];
  let dropped = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = parsePeriodValue(r?.[dateField]);
    const raw = r?.[valueField];
    const v = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!d || raw === null || raw === "" || !Number.isFinite(v)) {
      dropped++;
      continue;
    }
    parsed.push({ date: d, value: v });
  }
  const g: DateGrain = grain === "auto" ? inferGrain(parsed.map((p) => p.date)) : grain;
  const sums = new Map<string, number>();
  for (const p of parsed) {
    const label = bucketDate(p.date, g);
    if (label === null) {
      dropped++;
      continue;
    }
    sums.set(label, (sums.get(label) ?? 0) + p.value);
  }
  const points = [...sums.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { grain: g, points, dropped };
}

/** The label one period before, or the same period one year before. */
export function comparisonLabel(
  label: string,
  grain: DateGrain,
  compareTo: "previous" | "year",
): string | null {
  if (compareTo === "previous" || grain === "year") return nextBucketLabel(label, -1);
  // Same position, one year back: 2026-07 → 2025-07, 2026-Q3 → 2025-Q3,
  // 2026-W27 → 2025-W27. A 29 February has no twin, and the 28th stands in.
  const m = /^(\d{4})(.*)$/.exec(label);
  if (!m) return null;
  const prev = `${Number(m[1]) - 1}${m[2]}`;
  return /-02-29$/.test(prev) ? prev.replace(/-02-29$/, "-02-28") : prev;
}

export type PeriodComparison = {
  current: PeriodPoint;
  /** Absent when the period compared with has no data at all. */
  previous?: PeriodPoint;
  /** The label that was looked for, so "no data for Oct 2026" can be said. */
  previousLabel: string | null;
  change?: number;
  /** null when the previous value is 0: a change from nothing has no percent. */
  changePct?: number | null;
};

/**
 * The latest period against the one it is compared with.
 *
 * A missing comparison period is reported as missing — never quietly
 * replaced by the nearest period that has data, which would compare November
 * with August and call it "vs last month".
 */
export function comparePeriods(
  series: PeriodSeries,
  compareTo: "previous" | "year",
): PeriodComparison | null {
  const pts = series.points;
  if (pts.length === 0) return null;
  const current = pts[pts.length - 1];
  const previousLabel = comparisonLabel(current.label, series.grain, compareTo);
  const previous = previousLabel ? pts.find((p) => p.label === previousLabel) : undefined;
  if (!previous) return { current, previousLabel };
  const change = current.value - previous.value;
  return {
    current,
    previous,
    previousLabel,
    change,
    changePct: previous.value === 0 ? null : change / Math.abs(previous.value),
  };
}

const MONTHS_UTC = (locale: string | undefined, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
  }
};

/** "2026-11" → "Nov 2026", "2026-Q3" → "Q3 2026", "2026-W05" → "Week 5, 2026". */
export function prettyPeriod(label: string | null | undefined, locale?: string): string {
  if (!label) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return MONTHS_UTC(locale, { day: "numeric", month: "short", year: "numeric" }).format(d);
  }
  m = /^(\d{4})-(\d{2})$/.exec(label);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    return MONTHS_UTC(locale, { month: "short", year: "numeric" }).format(d);
  }
  m = /^(\d{4})-Q([1-4])$/.exec(label);
  if (m) return `Q${m[2]} ${m[1]}`;
  m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (m) return `Week ${Number(m[2])}, ${m[1]}`;
  return label;
}

/**
 * The number a KPI tile shows: the latest period's value when it has a date
 * column, else row zero's — so the e-mailed digest and the change log say
 * what the card says, not the value of whichever month sorted first.
 */
export function kpiHeadlineValue(
  chart: { valueField?: string; dateField?: string; dateGrain?: string } | undefined,
  rows: Record<string, unknown>[] | undefined,
): unknown {
  if (!chart?.valueField || !Array.isArray(rows) || rows.length === 0) return undefined;
  if (chart.dateField) {
    const grain = (["day", "week", "month", "quarter", "year"] as const).find(
      (g) => g === chart.dateGrain,
    );
    const s = periodSeries(rows, chart.dateField, chart.valueField, grain ?? "auto");
    if (s.points.length > 0) return s.points[s.points.length - 1].value;
  }
  return rows[0]?.[chart.valueField];
}

/**
 * Columns that hold dates, for picking a KPI's or a narrative's period
 * column by default.
 *
 * Stricter than isMostlyDates on purpose: that reads any integer above 999
 * as epoch seconds, so a revenue column passes it. Here a value counts only
 * when it is a Date, an epoch in milliseconds, or text that starts like an
 * ISO date ("2026", "2026-07", "2026-Q3", "2026-07-04 00:00:00").
 */
export function dateLikeColumns(columns: string[], rows: Record<string, unknown>[]): string[] {
  const sample = (Array.isArray(rows) ? rows : []).slice(0, 50);
  return columns.filter((c) => {
    let seen = 0;
    let dates = 0;
    for (const r of sample) {
      const v = r?.[c];
      if (v === null || v === undefined || v === "") continue;
      seen++;
      if (v instanceof Date) dates++;
      else if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 1e11) dates++;
      else if (
        typeof v === "string" &&
        /^\d{4}(-(\d{2}|Q[1-4]|W\d{2}))?(-\d{2})?([ T]\d{2}:\d{2}.*)?$/.test(v.trim()) &&
        parsePeriodValue(v) !== null
      ) {
        dates++;
      }
    }
    return seen > 0 && dates / seen >= 0.8;
  });
}

/** The unit a grain is counted in, for "the 4-month growth rate". */
export function grainNoun(grain: DateGrain, plural = false): string {
  const word = grain === "day" ? "day" : grain;
  return plural ? `${word}s` : word;
}
