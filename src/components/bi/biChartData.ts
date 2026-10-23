import type { BiNumberFormat } from "@/lib/biAgent";

/**
 * XAxis props for a CATEGORY axis, so labels are never silently dropped.
 *
 * Recharts defaults to `interval="preserveEnd"`, which hides ticks that would
 * overlap. On a chart of eight return reasons that rendered SIX labels and two
 * unlabelled bars — and nothing on screen said a label was missing, so the
 * reader cannot tell which bar is which and has no reason to suspect it.
 * Crowding is a visible problem; a dropped label is an invisible one.
 *
 * So `interval={0}` always, and when the labels cannot fit flat, angle them
 * and give the axis the height to hold them. Truncation is the last resort —
 * the full value is still in the tooltip.
 *
 * Exported for tests: the thresholds are the whole behaviour, and they are not
 * observable from a rendered chart without measuring pixels.
 */
export function categoryAxis(
  values: unknown[],
  tickSize: number,
): {
  interval: 0;
  angle?: number;
  textAnchor?: "end";
  height?: number;
  tickFormatter?: (v: unknown) => string;
  /**
   * Extra left margin the CHART needs, in px — not an XAxis prop.
   *
   * An angled label is anchored at its end and runs up and to the LEFT, so the
   * first one overhangs the plot area. With margin.left of 0 it was clipped:
   * measured 12px of "Wrong item shipped" cut off, which rendered as
   * "rong item shipped" — a label that is present, wrong, and looks
   * deliberate. Spread the axis props onto XAxis and pass this to the chart's
   * margin.
   */
  leftMargin: number;
} {
  const labels = values.map((v) => (v == null ? "" : String(v)));
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  // Rough advance width for the tick font — enough to decide "does this fit",
  // which is all that is needed. Measuring text properly would mean a canvas
  // and a layout pass for a decision with two outcomes.
  const approxCharPx = tickSize * 0.62;
  // Recharts gives each category an equal slice; a label fits flat when it is
  // narrower than its slice. 640px is the typical widget width — deliberately
  // pessimistic, because guessing "it fits" is what produced the bug.
  const sliceWidth = 640 / Math.max(1, labels.length);
  const fitsFlat = longest * approxCharPx <= sliceWidth;

  const truncate =
    longest > MAX_TICK_CHARS
      ? (v: unknown) => {
          const s = v == null ? "" : String(v);
          return s.length > MAX_TICK_CHARS ? `${s.slice(0, MAX_TICK_CHARS - 1)}…` : s;
        }
      : undefined;

  if (fitsFlat)
    return { interval: 0, leftMargin: 0, ...(truncate ? { tickFormatter: truncate } : {}) };

  // Angled. Height has to cover the label's vertical extent at 35°, or the
  // axis clips them instead — which is the same invisible failure in a new
  // costume.
  const shown = Math.min(longest, MAX_TICK_CHARS);
  const labelPx = shown * approxCharPx;
  const height = Math.min(110, Math.round(labelPx * Math.sin(Math.PI / 5)) + 24);

  // How far the FIRST label reaches left of its tick, minus the room already
  // there: the Y axis (48px) plus half a category slice. Derived rather than
  // guessed — with eight categories this yields 12px, which is exactly what
  // was measured as clipped.
  const reach = labelPx * Math.cos(Math.PI / 5);
  const roomBeforeFirstTick = 48 + sliceWidth / 2;
  const leftMargin = Math.min(48, Math.max(0, Math.round(reach - roomBeforeFirstTick)));

  return {
    interval: 0,
    angle: -35,
    textAnchor: "end",
    height,
    leftMargin,
    ...(truncate ? { tickFormatter: truncate } : {}),
  };
}

/** Tableau-style categorical palette — calm, print-safe, colorblind-aware. */
export const PIE_COLORS = [
  "#4E79A7",
  "#F28E2B",
  "#59A14F",
  "#E15759",
  "#76B7B2",
  "#EDC948",
  "#B07AA1",
  "#9DA79E",
];

/** Coerce a value to a finite number — SQL results often carry numerics as
 * strings (warehouse drivers, CSV columns), which must still format/plot. */
export function toBiNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function fmtBiNumber(v: unknown): string {
  const n = toBiNumber(v);
  if (n === null) return String(v ?? "");
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * fmtBiNumber plus the chart's value format:
 *   currency → locale-aware with the widget's currency code ("€1.2M", "¥5万"…)
 *   percent  → "12.3%" (the value is treated as already being in percent
 *              units — 12.3 formats as 12.3%, not 0.12%)
 * `decimals` pins the fraction digits; otherwise large values use compact
 * notation and small ones show up to two trimmed decimals.
 */
export function fmtBiValue(v: unknown, opts?: BiNumberFormat | BiFormatOptions): string {
  const o: BiFormatOptions = typeof opts === "string" ? { format: opts } : (opts ?? {});
  const n = toBiNumber(v);
  if (n === null) return fmtBiNumber(v);
  const decimals =
    typeof o.decimals === "number" && o.decimals >= 0
      ? Math.min(4, Math.round(o.decimals))
      : undefined;
  if (o.format === "currency") {
    const compact = decimals === undefined && Math.abs(n) >= 10_000;
    return intlNumber(n, {
      style: "currency",
      currency: (o.currency || "USD").toUpperCase(),
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: decimals ?? (compact ? 2 : 2),
      minimumFractionDigits: decimals ?? 0,
    });
  }
  if (o.format === "percent") {
    const body =
      decimals === undefined
        ? fmtBiNumber(n)
        : intlNumber(n, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
    return `${body}%`;
  }
  if (decimals !== undefined) {
    return intlNumber(n, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
  }
  return fmtBiNumber(n);
}

/**
 * Group rows by a category field, SUMMING the given value fields — so a
 * result with repeated categories (e.g. two "EU" rows) renders one slice /
 * bar / stage per category instead of duplicates. Value fields are coerced
 * to numbers; first-seen category order is preserved.
 */
export function aggregateByField(
  rows: Record<string, unknown>[],
  keyField: string,
  valueFields: string[],
): Record<string, unknown>[] {
  const order: string[] = [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const k = String(r[keyField]);
    const existing = byKey.get(k);
    if (!existing) {
      const copy: Record<string, unknown> = { ...r };
      for (const f of valueFields) {
        const n = toBiNumber(r[f]);
        if (n !== null) copy[f] = n;
      }
      byKey.set(k, copy);
      order.push(k);
      continue;
    }
    for (const f of valueFields) {
      const add = toBiNumber(r[f]);
      if (add === null) continue;
      existing[f] = (toBiNumber(existing[f]) ?? 0) + add;
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/**
 * Pivot long-format rows (x, series, value) into recharts' wide format:
 * one object per x with a numeric key per series (values summed).
 */
export function pivotSeries(
  rows: Record<string, unknown>[],
  xField: string,
  yField: string,
  seriesField: string,
): { data: Record<string, unknown>[]; series: string[] } {
  const series: string[] = [];
  const byX = new Map<string, Record<string, unknown>>();
  const xOrder: string[] = [];
  for (const r of rows) {
    const s = String(r[seriesField] ?? "—");
    if (!series.includes(s)) {
      if (series.length >= MAX_SERIES) continue;
      series.push(s);
    }
    const xKey = String(r[xField]);
    if (!byX.has(xKey)) {
      byX.set(xKey, { [xField]: r[xField] });
      xOrder.push(xKey);
    }
    const entry = byX.get(xKey)!;
    const v = Number(r[yField]);
    entry[s] = (Number(entry[s]) || 0) + (Number.isFinite(v) ? v : 0);
  }
  return { data: xOrder.map((x) => byX.get(x)!), series };
}

/** Longest label we will print before truncating with an ellipsis. */
const MAX_TICK_CHARS = 18;

const MAX_SERIES = 12;

/** Options accepted by fmtBiValue — ChartSpec is structurally compatible,
 * so call sites can pass the chart itself. */
export type BiFormatOptions = {
  format?: BiNumberFormat | "number";
  /** ISO 4217 code for currency (default USD). */
  currency?: string;
  /** Fixed fraction digits (0-4); undefined = auto/compact. */
  decimals?: number;
};

function intlNumber(n: number, opts: Intl.NumberFormatOptions): string {
  try {
    // Viewer's browser locale drives separators and currency symbols.
    return new Intl.NumberFormat(undefined, opts).format(n);
  } catch {
    // Bad currency codes etc. — fall back to the plain compact formatter.
    return fmtBiNumber(n);
  }
}
