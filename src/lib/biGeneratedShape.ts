// Turning a generated widget's result into the R498 visuals the planner
// asked for: a KPI that compares the latest period with the one before, or a
// narrative computed from the rows.
//
// The planner names the visual before any SQL exists, and the chart step is a
// model that has never heard of either. So the shape is decided HERE, from the
// columns that came back, and deterministically: a date column and a number
// make a period KPI; a category and a number make a ranking; a planner wish
// the columns cannot carry leaves the chart the model picked untouched rather
// than drawing an empty frame.
import type { BiInsightKind, BiKpiCompare, ChartSpec } from "@/lib/biAgent";
import { numericColumns } from "@/lib/biChartFields";
import { dateLikeColumns } from "@/lib/biPeriods";

export const INSIGHT_KIND_IDS: BiInsightKind[] = [
  "top",
  "bottom",
  "change",
  "forecast",
  "anomaly",
  "growth",
  "movers",
];

export function parseInsightKind(v: unknown): BiInsightKind | undefined {
  const k = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (INSIGHT_KIND_IDS as string[]).includes(k) ? (k as BiInsightKind) : undefined;
}

export function parseCompare(v: unknown): Exclude<BiKpiCompare, "none"> | undefined {
  const k = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (k === "previous" || k === "prior" || k === "prior_period" || k === "mom") return "previous";
  if (k === "year" || k === "yoy" || k === "prior_year" || k === "year_ago") return "year";
  return undefined;
}

type Wish = {
  chartType: string;
  title?: string;
  compare?: Exclude<BiKpiCompare, "none">;
  insightKind?: BiInsightKind;
};

/** Keep the value formatting the chart step chose; the shape is ours. */
function formatOf(chart: ChartSpec | undefined): Partial<ChartSpec> {
  if (!chart) return {};
  const out: Record<string, unknown> = {};
  for (const k of ["format", "currency", "decimals"] as const) {
    if (chart[k] !== undefined) out[k] = chart[k];
  }
  return out as Partial<ChartSpec>;
}

/**
 * The chart to draw for a generated widget, or `current` unchanged.
 *
 * `title` becomes the KPI's label, since a generated tile titled "Monthly
 * revenue" reads better than its column name `total_revenue`.
 */
export function shapeGeneratedChart(
  wish: Wish,
  columns: string[],
  rows: Record<string, unknown>[],
  current: ChartSpec | undefined,
): ChartSpec | undefined {
  if (!Array.isArray(rows) || rows.length === 0 || columns.length === 0) return current;
  const dates = dateLikeColumns(columns, rows);
  const numbers = [...numericColumns(columns, rows)].filter((c) => !dates.includes(c));
  const labels = columns.filter((c) => !dates.includes(c) && !numbers.includes(c));
  // The measure the model already picked, when it is a number; else the first.
  const picked =
    current && "valueField" in current && typeof current.valueField === "string"
      ? current.valueField
      : current && "yField" in current && typeof current.yField === "string"
        ? current.yField
        : undefined;
  const measure = picked && numbers.includes(picked) ? picked : numbers[0];
  if (!measure) return current;

  if (wish.chartType === "kpi") {
    // A period KPI needs a series. One row is a plain total and stays one.
    if (!wish.compare || dates.length === 0 || rows.length < 2) return current;
    return {
      type: "kpi",
      valueField: measure,
      label: wish.title?.trim() || undefined,
      dateField: dates[0],
      compareTo: wish.compare === "previous" ? undefined : wish.compare,
      sparkline: true,
      ...formatOf(current),
    } as ChartSpec;
  }

  if (wish.chartType === "insight") {
    const kind =
      wish.insightKind ??
      (dates.length > 0 && rows.length >= 2 ? "change" : labels.length > 0 ? "top" : undefined);
    if (!kind) return current;
    const needsDate = kind !== "top" && kind !== "bottom";
    const needsCategory = kind === "top" || kind === "bottom" || kind === "movers";
    if (needsDate && dates.length === 0) return current;
    if (needsCategory && labels.length === 0) return current;
    return {
      type: "insight",
      kind,
      valueField: measure,
      dateField: needsDate ? dates[0] : undefined,
      categoryField: needsCategory ? labels[0] : undefined,
      ...formatOf(current),
    } as ChartSpec;
  }

  return current;
}
