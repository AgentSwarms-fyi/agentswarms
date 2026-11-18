// What a KPI tile states, worked out once (R509).
//
// The tile in a card and the KPI in a scheduled PDF must say the same thing:
// the same value, period, change and target. The tile draws these as styled
// spans; the PDF, which has no browser, draws them as text. Both read them
// from here, so a fix to how a period compares lands in both.
import type { ChartSpec } from "@/lib/biAgent";
import { unshownRows } from "@/lib/biChartFields";
import { comparePeriods, periodSeries, prettyPeriod } from "@/lib/biPeriods";
import { fmtBiValue, toBiNumber } from "@/components/bi/biChartData";

export type KpiSpec = Extract<ChartSpec, { type: "kpi" }>;

/** Change as a percentage with a sign; null when there is nothing to divide by. */
export function pctLabel(p: number | null | undefined): string | null {
  if (p === null || p === undefined || !Number.isFinite(p)) return null;
  const a = Math.abs(p * 100);
  return `${a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`;
}

export type KpiFigures = {
  label: string;
  /** The headline, formatted. */
  value: string;
  /** The raw headline, for the tile's own arithmetic. */
  raw: unknown;
  /** The latest period's name, in period mode. */
  period: string | null;
  /** The change against the period compared with, in period mode. */
  change:
    | {
        arrow: "▲" | "▼" | "■";
        /** "12.5%", or the absolute change when there is no percentage. */
        main: string;
        /** "(+1,250)" beside a percentage; null without one. */
        detail: string | null;
        against: string;
        tone: "good" | "bad" | "flat";
        /** For the tile's tooltip: the previous period and its value. */
        previousTitle: string;
      }
    | { none: string }
    | null;
  /** Progress toward a target, when the spec names one and it is not 0. */
  target: { text: string; tone: "good" | "bad"; share: number | null } | null;
  /** The periods behind the headline, oldest first, for a sparkline. */
  spark: { label: string; value: number }[] | null;
  /** "No <date> dates with a value — showing the first row." */
  noDates: string | null;
  /** How many rows came back when the tile draws only the first. */
  ofRows: number | null;
};

export function kpiFigures(chart: KpiSpec, rows: Record<string, unknown>[]): KpiFigures {
  const fmt = (v: unknown) => fmtBiValue(v, chart);
  let period: {
    series: ReturnType<typeof periodSeries>;
    cmp: ReturnType<typeof comparePeriods> | null;
    target: number | undefined;
  } | null = null;
  if (chart.dateField) {
    const series = periodSeries(rows, chart.dateField, chart.valueField, chart.dateGrain ?? "auto");
    if (series.points.length > 0) {
      const compareTo = chart.compareTo ?? "previous";
      const cmp = compareTo === "none" ? null : comparePeriods(series, compareTo);
      let target: number | undefined;
      if (chart.targetField) {
        const t = periodSeries(rows, chart.dateField, chart.targetField, series.grain);
        const last = series.points[series.points.length - 1].label;
        target = t.points.find((p) => p.label === last)?.value;
      }
      period = { series, cmp, target };
    }
  }

  const raw = period
    ? period.series.points[period.series.points.length - 1].value
    : rows[0]?.[chart.valueField];
  const num = toBiNumber(raw);
  // A KPI without a date draws row zero. When the query returned more, the
  // card is showing one slice of a breakdown in the type size reserved for a
  // headline — so it says so (see unshownRows).
  const ofRows = period ? null : unshownRows(rows, chart.valueField);
  const target = period
    ? period.target
    : chart.targetField
      ? (toBiNumber(rows[0]?.[chart.targetField]) ?? undefined)
      : undefined;
  const vsTarget =
    target !== undefined && target !== 0 && num !== null ? num / target - 1 : undefined;
  const good = (delta: number) => delta >= 0 !== Boolean(chart.lowerIsBetter);

  const cmp = period?.cmp ?? null;
  let change: KpiFigures["change"] = null;
  if (cmp) {
    if (cmp.previous && cmp.change !== undefined) {
      const p = pctLabel(cmp.changePct);
      change = {
        arrow: cmp.change > 0 ? "▲" : cmp.change < 0 ? "▼" : "■",
        main: p ?? fmt(Math.abs(cmp.change)),
        detail: p ? `(${cmp.change >= 0 ? "+" : "−"}${fmt(Math.abs(cmp.change))})` : null,
        against: `vs ${prettyPeriod(cmp.previousLabel)}`,
        tone: cmp.change === 0 ? "flat" : good(cmp.change) ? "good" : "bad",
        previousTitle: `${prettyPeriod(cmp.previousLabel)}: ${fmt(cmp.previous.value)}`,
      };
    } else {
      change = { none: `No data for ${prettyPeriod(cmp.previousLabel)} to compare with` };
    }
  }

  return {
    label: chart.label || chart.valueField,
    value: fmt(raw),
    raw,
    period: period
      ? prettyPeriod(period.series.points[period.series.points.length - 1].label)
      : null,
    change,
    target:
      vsTarget !== undefined && target !== undefined
        ? {
            text: `${vsTarget >= 0 ? "▲" : "▼"} ${Math.abs(vsTarget * 100).toFixed(1)}% vs target (${fmt(target)})`,
            tone: good(vsTarget) ? "good" : "bad",
            share: num !== null && target > 0 && num >= 0 ? Math.min(1, num / target) : null,
          }
        : null,
    spark:
      period && chart.sparkline && period.series.points.length >= 2
        ? period.series.points.slice(-60).map((p) => ({ label: p.label, value: p.value }))
        : null,
    noDates:
      chart.dateField && !period
        ? `No ${chart.dateField} dates with a value — showing the first row.`
        : null,
    ofRows,
  };
}
