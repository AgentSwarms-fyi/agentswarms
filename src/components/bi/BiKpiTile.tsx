// KPI tile: the headline number, and since R498 the period it belongs to,
// its change against the period before (or a year before), a line of the
// periods behind it, and progress toward a target.
//
// Two modes, chosen by the spec rather than guessed from the rows:
//   • plain — `rows[0][valueField]`, as KPIs always drew;
//   • period — `dateField` is set, the rows are a series, and the tile shows
//     the LATEST period. This is the tile every dashboard demo leads with.
import { useId, useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import type { ChartSpec } from "@/lib/biAgent";
import { unshownRows } from "@/lib/biChartFields";
import { comparePeriods, periodSeries, prettyPeriod } from "@/lib/biPeriods";
import { fmtBiValue, toBiNumber } from "@/components/bi/biChartData";

type KpiSpec = Extract<ChartSpec, { type: "kpi" }>;

const GOOD = "text-emerald-600 dark:text-emerald-400";
const BAD = "text-red-600 dark:text-red-400";

/** Change as a percentage with a sign; null when there is nothing to divide by. */
function pctLabel(p: number | null | undefined): string | null {
  if (p === null || p === undefined || !Number.isFinite(p)) return null;
  const a = Math.abs(p * 100);
  return `${a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`;
}

export function BiKpiTile({
  chart,
  rows,
  large = false,
  fill = false,
}: {
  chart: KpiSpec;
  rows: Record<string, unknown>[];
  large?: boolean;
  fill?: boolean;
}) {
  const gradientId = useId().replace(/:/g, "");
  const fmt = (v: unknown) => fmtBiValue(v, chart);

  const period = useMemo(() => {
    if (!chart.dateField) return null;
    const series = periodSeries(rows, chart.dateField, chart.valueField, chart.dateGrain ?? "auto");
    if (series.points.length === 0) return null;
    const compareTo = chart.compareTo ?? "previous";
    const cmp = compareTo === "none" ? null : comparePeriods(series, compareTo);
    let target: number | undefined;
    if (chart.targetField) {
      const t = periodSeries(rows, chart.dateField, chart.targetField, series.grain);
      const last = series.points[series.points.length - 1].label;
      target = t.points.find((p) => p.label === last)?.value;
    }
    return { series, cmp, compareTo, target };
  }, [
    rows,
    chart.dateField,
    chart.valueField,
    chart.targetField,
    chart.dateGrain,
    chart.compareTo,
  ]);

  const value = period
    ? period.series.points[period.series.points.length - 1].value
    : rows[0]?.[chart.valueField];
  const num = toBiNumber(value);
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
  const centered = large || fill;
  const good = (delta: number) => delta >= 0 !== Boolean(chart.lowerIsBetter);

  const cmp = period?.cmp ?? null;
  const currentLabel = period ? period.series.points[period.series.points.length - 1].label : null;
  const spark = period && chart.sparkline && period.series.points.length >= 2;
  const sparkPoints = spark ? period.series.points.slice(-60) : [];

  return (
    <div
      className={`flex flex-col ${
        centered ? "h-full w-full items-center justify-center py-2" : "items-start py-3"
      }`}
    >
      <span
        className={`font-medium uppercase tracking-widest text-muted-foreground ${
          large ? "text-sm" : "text-[10px]"
        }`}
      >
        {chart.label || chart.valueField}
      </span>
      <span
        className={`mt-1 font-semibold tracking-tight text-foreground tabular-nums ${
          large ? "text-7xl" : fill ? "text-4xl" : "text-3xl"
        }`}
      >
        {fmt(value)}
      </span>
      {currentLabel && (
        <span className={`mt-0.5 text-muted-foreground ${large ? "text-sm" : "text-[11px]"}`}>
          {prettyPeriod(currentLabel)}
        </span>
      )}
      {cmp &&
        (cmp.previous && cmp.change !== undefined ? (
          <span
            className={`mt-1 flex flex-wrap items-center justify-center gap-1 font-medium tabular-nums ${
              large ? "text-sm" : "text-xs"
            } ${cmp.change === 0 ? "text-muted-foreground" : good(cmp.change) ? GOOD : BAD}`}
            title={`${prettyPeriod(cmp.previousLabel)}: ${fmt(cmp.previous.value)}`}
          >
            <span aria-hidden>{cmp.change > 0 ? "▲" : cmp.change < 0 ? "▼" : "■"}</span>
            {pctLabel(cmp.changePct) ?? fmt(Math.abs(cmp.change))}
            {pctLabel(cmp.changePct) && (
              <span className="opacity-80">
                ({cmp.change >= 0 ? "+" : "−"}
                {fmt(Math.abs(cmp.change))})
              </span>
            )}
            <span className="font-normal text-muted-foreground">
              vs {prettyPeriod(cmp.previousLabel)}
            </span>
          </span>
        ) : (
          <span className={`mt-1 text-muted-foreground ${large ? "text-xs" : "text-[10px]"}`}>
            No data for {prettyPeriod(cmp.previousLabel)} to compare with
          </span>
        ))}
      {vsTarget !== undefined && target !== undefined && (
        <div
          className={`mt-1.5 flex w-full flex-col items-center gap-1 ${fill ? "max-w-[85%]" : ""}`}
        >
          <span
            className={`flex items-center gap-1 text-xs font-medium tabular-nums ${
              good(vsTarget) ? GOOD : BAD
            }`}
          >
            {vsTarget >= 0 ? "▲" : "▼"} {Math.abs(vsTarget * 100).toFixed(1)}% vs target (
            {fmt(target)})
          </span>
          {num !== null && target > 0 && num >= 0 && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Progress toward target"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(1, num / target) * 100)}
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, (num / target) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}
      {spark && (
        <div className={`mt-1.5 w-full ${large ? "h-20" : "h-10"} ${fill ? "max-w-[92%]" : ""}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkPoints} margin={{ top: 3, right: 3, bottom: 1, left: 3 }}>
              <defs>
                <linearGradient id={`kpi-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" hide />
              <Tooltip
                cursor={{ stroke: "var(--border)" }}
                contentStyle={{
                  fontSize: 11,
                  background: "var(--popover)",
                  color: "var(--popover-foreground)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "4px 8px",
                }}
                labelFormatter={(l) => prettyPeriod(String(l))}
                formatter={(v) => [fmt(v), chart.label || chart.valueField]}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--primary)"
                strokeWidth={1.5}
                fill={`url(#kpi-${gradientId})`}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 2.5 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      {chart.dateField && !period && (
        <span className="mt-1 text-[10px] text-muted-foreground">
          No {chart.dateField} dates with a value — showing the first row.
        </span>
      )}
      {ofRows !== null && (
        <span
          className={`mt-1 cursor-help text-muted-foreground ${large ? "text-xs" : "text-[10px]"}`}
          title={
            `This query returned ${ofRows} rows and a single-value chart draws the first. ` +
            "The other rows are not on this card — pick a date column to show the latest period " +
            "against the one before, or pick a bar chart to see the whole breakdown."
          }
        >
          1 of {ofRows} rows
        </span>
      )}
    </div>
  );
}
