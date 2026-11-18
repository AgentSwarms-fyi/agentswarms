// KPI tile: the headline number, and since R498 the period it belongs to,
// its change against the period before (or a year before), a line of the
// periods behind it, and progress toward a target.
//
// Two modes, chosen by the spec rather than guessed from the rows:
//   • plain — `rows[0][valueField]`, as KPIs always drew;
//   • period — `dateField` is set, the rows are a series, and the tile shows
//     the LATEST period. This is the tile every dashboard demo leads with.
//
// What it states is worked out in biKpiFigures (R509), which a scheduled
// report's PDF draws from too, so the two cannot disagree.
import { useId, useMemo } from "react";
import { Area, AreaChart, Tooltip, XAxis } from "recharts";
import { ResponsiveContainer } from "@/components/bi/biChartBox";
import { kpiFigures, type KpiSpec } from "@/components/bi/biKpiFigures";
import { prettyPeriod } from "@/lib/biPeriods";
import { fmtBiValue } from "@/components/bi/biChartData";

const GOOD = "text-emerald-600 dark:text-emerald-400";
const BAD = "text-red-600 dark:text-red-400";

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
  const f = useMemo(() => kpiFigures(chart, rows), [chart, rows]);
  const centered = large || fill;
  const change = f.change;

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
        {f.label}
      </span>
      <span
        className={`mt-1 font-semibold tracking-tight text-foreground tabular-nums ${
          large ? "text-7xl" : fill ? "text-4xl" : "text-3xl"
        }`}
      >
        {f.value}
      </span>
      {f.period && (
        <span className={`mt-0.5 text-muted-foreground ${large ? "text-sm" : "text-[11px]"}`}>
          {f.period}
        </span>
      )}
      {change &&
        ("none" in change ? (
          <span className={`mt-1 text-muted-foreground ${large ? "text-xs" : "text-[10px]"}`}>
            {change.none}
          </span>
        ) : (
          <span
            className={`mt-1 flex flex-wrap items-center justify-center gap-1 font-medium tabular-nums ${
              large ? "text-sm" : "text-xs"
            } ${change.tone === "flat" ? "text-muted-foreground" : change.tone === "good" ? GOOD : BAD}`}
            title={change.previousTitle}
          >
            <span aria-hidden>{change.arrow}</span>
            {change.main}
            {change.detail && <span className="opacity-80">{change.detail}</span>}
            <span className="font-normal text-muted-foreground">{change.against}</span>
          </span>
        ))}
      {f.target && (
        <div
          className={`mt-1.5 flex w-full flex-col items-center gap-1 ${fill ? "max-w-[85%]" : ""}`}
        >
          <span
            className={`flex items-center gap-1 text-xs font-medium tabular-nums ${
              f.target.tone === "good" ? GOOD : BAD
            }`}
          >
            {f.target.text}
          </span>
          {f.target.share !== null && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Progress toward target"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(f.target.share * 100)}
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${f.target.share * 100}%` }}
              />
            </div>
          )}
        </div>
      )}
      {f.spark && (
        <div className={`mt-1.5 w-full ${large ? "h-20" : "h-10"} ${fill ? "max-w-[92%]" : ""}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={f.spark} margin={{ top: 3, right: 3, bottom: 1, left: 3 }}>
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
      {f.noDates && <span className="mt-1 text-[10px] text-muted-foreground">{f.noDates}</span>}
      {f.ofRows !== null && (
        <span
          className={`mt-1 cursor-help text-muted-foreground ${large ? "text-xs" : "text-[10px]"}`}
          title={
            `This query returned ${f.ofRows} rows and a single-value chart draws the first. ` +
            "The other rows are not on this card — pick a date column to show the latest period " +
            "against the one before, or pick a bar chart to see the whole breakdown."
          }
        >
          1 of {f.ofRows} rows
        </span>
      )}
    </div>
  );
}
