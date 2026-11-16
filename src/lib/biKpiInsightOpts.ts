// Builder state for the R498 visuals and the spec fields it produces: a KPI's
// period comparison and the narrative widget. Pure, so the builder's option
// components export only components (and these can be tested on their own).
import type { BiInsightKind, BiKpiCompare, ChartSpec } from "@/lib/biAgent";

export type KpiOpts = {
  dateField: string;
  compareTo: BiKpiCompare;
  sparkline: boolean;
  lowerIsBetter: boolean;
};

export const KPI_OPTS_DEFAULT: KpiOpts = {
  dateField: "",
  compareTo: "previous",
  sparkline: true,
  lowerIsBetter: false,
};

export type InsightOpts = {
  kind: BiInsightKind;
  categoryField: string;
  dateField: string;
  topN: string;
  periods: string;
  template: string;
  lowerIsBetter: boolean;
  /** R501: the figures' colour (#rrggbb, empty for the standard look). */
  valueColor: string;
  hideIcon: boolean;
};

export const INSIGHT_OPTS_DEFAULT: InsightOpts = {
  kind: "top",
  categoryField: "",
  dateField: "",
  topN: "3",
  periods: "",
  template: "",
  lowerIsBetter: false,
  valueColor: "",
  hideIcon: false,
};

export function kpiOptsFrom(c: ChartSpec | undefined): KpiOpts {
  if (c?.type !== "kpi") return KPI_OPTS_DEFAULT;
  return {
    dateField: c.dateField ?? "",
    compareTo: c.compareTo ?? "previous",
    // An existing tile keeps the look it had: no line unless it asked for one.
    sparkline: c.dateField ? Boolean(c.sparkline) : true,
    lowerIsBetter: Boolean(c.lowerIsBetter),
  };
}

export function insightOptsFrom(c: ChartSpec | undefined): InsightOpts {
  if (c?.type !== "insight") return INSIGHT_OPTS_DEFAULT;
  return {
    kind: c.kind,
    categoryField: c.categoryField ?? "",
    dateField: c.dateField ?? "",
    topN: c.topN !== undefined ? String(c.topN) : "3",
    periods: c.periods !== undefined ? String(c.periods) : "",
    template: c.template ?? "",
    lowerIsBetter: Boolean(c.lowerIsBetter),
    valueColor: c.valueColor ?? "",
    hideIcon: Boolean(c.hideIcon),
  };
}

/** The KPI spec fields these options add (nothing without a date column). */
export function kpiSpecFields(o: KpiOpts): Partial<Extract<ChartSpec, { type: "kpi" }>> {
  if (!o.dateField) return {};
  return {
    dateField: o.dateField,
    compareTo: o.compareTo === "previous" ? undefined : o.compareTo,
    sparkline: o.sparkline || undefined,
    lowerIsBetter: o.lowerIsBetter || undefined,
  };
}

export const insightNeedsCategory = (k: BiInsightKind) =>
  k === "top" || k === "bottom" || k === "movers";
export const insightNeedsDate = (k: BiInsightKind) =>
  k !== "top" && k !== "bottom" && k !== "figures";

/** The insight spec, or null while a field it needs is unset. */
export function insightSpec(
  valueField: string,
  label: string,
  o: InsightOpts,
): Extract<ChartSpec, { type: "insight" }> | null {
  if (!valueField) return null;
  if (insightNeedsCategory(o.kind) && !o.categoryField) return null;
  if (insightNeedsDate(o.kind) && !o.dateField) return null;
  const topN = Number(o.topN);
  const periods = Number(o.periods);
  return {
    type: "insight",
    kind: o.kind,
    valueField,
    categoryField: insightNeedsCategory(o.kind) ? o.categoryField : undefined,
    dateField: insightNeedsDate(o.kind) ? o.dateField : undefined,
    topN:
      insightNeedsCategory(o.kind) && o.topN.trim() && Number.isFinite(topN)
        ? Math.max(1, Math.min(10, Math.round(topN)))
        : undefined,
    periods:
      o.kind === "growth" && o.periods.trim() && Number.isFinite(periods) && periods >= 1
        ? Math.round(periods)
        : undefined,
    label: label.trim() || undefined,
    template: o.template.trim() || undefined,
    lowerIsBetter: o.lowerIsBetter || undefined,
    valueColor: /^#[0-9a-f]{6}$/i.test(o.valueColor) ? o.valueColor : undefined,
    hideIcon: o.hideIcon || undefined,
  };
}
