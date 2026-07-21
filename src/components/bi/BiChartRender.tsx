// Shared recharts renderer for BI chart specs. Used by the Data & SQL BI
// chat (compact + enlarged) and by BI dashboard widgets (fill mode).
//
// Styling follows the conventions of professional BI tools: no axis lines,
// horizontal-only gridlines, soft tooltips, gradient area fills and a
// restrained categorical palette. Bar/line/area support multi-series via
// `seriesField` (long → wide pivot, palette-coloured, optional stacking),
// numeric output honours the spec's `format` (currency / percent), and
// bar/pie/hbar elements are clickable for dashboard cross-filtering.
import { useEffect, useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { BoxPlot, GaugeChart, HeatmapGrid, MatrixTable } from "@/components/bi/BiChartParts";
import { BiGeoMap } from "@/components/bi/BiGeoMap";
import { OntologyGraph } from "@/components/bi/OntologyGraph";
import type { BiNumberFormat, BiRefLine, ChartSpec } from "@/lib/biAgent";
import {
  bucketRowsX,
  cumulative,
  drillRows,
  forecastRows,
  isMostlyDates,
  linearFit,
  priorPeriodOverlay,
  priorYearOverlay,
  type DateGrain,
  type DrillEntry,
} from "@/lib/biChartMath";
import { cn } from "@/lib/utils";

/** Y position for a configured reference line (null = don't draw). */
function refLineY(
  ref: BiRefLine | undefined,
  data: Record<string, unknown>[],
  yKey: string,
): number | null {
  if (!ref) return null;
  if (ref.mode === "value") return Number.isFinite(ref.value) ? (ref.value as number) : null;
  const nums = data.map((d) => Number(d[yKey])).filter((n) => Number.isFinite(n));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

const REF_COLOR = "#e15759";

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

const MAX_SERIES = 12;

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
 *   currency → "$1.2M" (negatives as "-$…")
 *   percent  → "12.3%" (the value is treated as already being in percent
 *              units — 12.3 formats as 12.3%, not 0.12%)
 */
export function fmtBiValue(v: unknown, format?: BiNumberFormat): string {
  const n = toBiNumber(v);
  if (n === null) return fmtBiNumber(v);
  if (format === "currency") {
    return n < 0 ? `-$${fmtBiNumber(Math.abs(n))}` : `$${fmtBiNumber(n)}`;
  }
  if (format === "percent") return `${fmtBiNumber(n)}%`;
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

function BiChartRenderInner({
  chart,
  rows,
  large = false,
  fill = false,
  onElementClick,
}: {
  chart: ChartSpec;
  rows: Record<string, unknown>[];
  /** Enlarged dialog mode (60vh, bigger type). */
  large?: boolean;
  /** Fill the parent's height (dashboard widgets). Parent needs a real height. */
  fill?: boolean;
  /** Cross-filtering: called when a bar / slice is clicked. */
  onElementClick?: (column: string, value: string) => void;
}) {
  const gradientId = useId();
  const heightClass = fill ? "h-full" : large ? "h-[60vh]" : "h-56";
  const tickSize = large ? 12 : 11;
  const labelSize = large ? 12 : 11;
  // NOTE: design tokens in this project are raw oklch() values, not HSL
  // channels — so wrap with var() directly, never hsl(var(--token)).
  const tooltipStyle = {
    fontSize: tickSize,
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgb(0 0 0 / 0.10)",
    padding: "6px 10px",
  } as const;
  const labelStyle = { color: "var(--popover-foreground)" } as const;
  const gridStroke = "var(--border)";
  const axisStroke = "var(--muted-foreground)";
  const primaryStroke = "var(--primary)";
  const tick = { fontSize: tickSize, fill: axisStroke } as const;
  const fmt = (v: unknown) => fmtBiValue(v, chart.format);
  const tooltipFmt = (v: unknown) => fmt(v);
  const clickable = Boolean(onElementClick);

  if (chart.type === "ontology") {
    // Renders from the stored spec — rows are irrelevant for this visual.
    return <OntologyGraph spec={chart.spec} large={large} fill={fill} />;
  }

  if (chart.type === "kpi") {
    const v = rows[0]?.[chart.valueField];
    const target = chart.targetField ? Number(rows[0]?.[chart.targetField]) : undefined;
    const num = Number(v);
    const deltaPct =
      target !== undefined && Number.isFinite(target) && target !== 0 && Number.isFinite(num)
        ? (num / target - 1) * 100
        : undefined;
    const centered = large || fill;
    return (
      <div
        className={`flex flex-col ${
          centered ? "h-full w-full items-center justify-center py-4" : "items-start py-3"
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
            large ? "text-7xl" : fill ? "text-5xl" : "text-3xl"
          }`}
        >
          {fmt(v)}
        </span>
        {deltaPct !== undefined && (
          <span
            className={`mt-1.5 flex items-center gap-1 text-xs font-medium tabular-nums ${
              deltaPct >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}% vs target ({fmt(target)})
          </span>
        )}
      </div>
    );
  }

  if (chart.type === "gauge") {
    const v = Number(rows[0]?.[chart.valueField]);
    const target = chart.targetField ? Number(rows[0]?.[chart.targetField]) : undefined;
    return (
      <GaugeChart
        value={Number.isFinite(v) ? v : 0}
        target={target !== undefined && Number.isFinite(target) ? target : undefined}
        max={chart.max}
        label={chart.label || chart.valueField}
        format={chart.format}
      />
    );
  }

  if (chart.type === "heatmap") {
    return (
      <HeatmapGrid
        rows={rows}
        xField={chart.xField}
        yField={chart.yField}
        valueField={chart.valueField}
      />
    );
  }

  if (chart.type === "boxplot") {
    return <BoxPlot rows={rows} xField={chart.xField} yField={chart.yField} />;
  }

  if (chart.type === "matrix") {
    return (
      <MatrixTable
        rows={rows}
        rowField={chart.rowField}
        colField={chart.colField}
        valueField={chart.valueField}
      />
    );
  }

  if (chart.type === "map" || chart.type === "bubblemap") {
    return (
      <BiGeoMap
        rows={rows}
        locationField={chart.locationField}
        valueField={chart.valueField}
        mode={chart.type === "map" ? "fill" : "bubble"}
      />
    );
  }

  if (chart.type === "bar") {
    const pivoted = chart.seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
      : null;
    const barData = pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField]);
    const handleClick = onElementClick
      ? (data: { payload?: Record<string, unknown> } | Record<string, unknown>) => {
          const payload =
            (data as { payload?: Record<string, unknown> }).payload ??
            (data as Record<string, unknown>);
          const v = payload?.[chart.xField];
          if (v !== undefined) onElementClick(chart.xField, String(v));
        }
      : undefined;
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={barData} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            {(() => {
              const refY = refLineY(chart.refLine, barData, chart.yField);
              return refY !== null ? (
                <ReferenceLine
                  y={refY}
                  stroke={REF_COLOR}
                  strokeDasharray="4 3"
                  label={{
                    value: chart.refLine?.label || (chart.refLine?.mode === "avg" ? "avg" : ""),
                    fontSize: 10,
                    fill: REF_COLOR,
                    position: "insideTopRight",
                  }}
                />
              ) : null;
            })()}
            {pivoted ? (
              <>
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: labelSize }} />
                {pivoted.series.map((s, i) => (
                  <Bar
                    key={s}
                    dataKey={s}
                    fill={PIE_COLORS[i % PIE_COLORS.length]}
                    stackId={chart.stacked ? "stack" : undefined}
                    radius={
                      chart.stacked
                        ? i === pivoted.series.length - 1
                          ? [5, 5, 0, 0]
                          : [0, 0, 0, 0]
                        : [5, 5, 0, 0]
                    }
                    maxBarSize={44}
                    onClick={handleClick}
                    cursor={clickable ? "pointer" : undefined}
                  />
                ))}
              </>
            ) : (
              <Bar
                dataKey={chart.yField}
                fill={primaryStroke}
                radius={[5, 5, 0, 0]}
                maxBarSize={44}
                onClick={handleClick}
                cursor={clickable ? "pointer" : undefined}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "hbar") {
    const handleClick = onElementClick
      ? (data: { payload?: Record<string, unknown> }) => {
          const v = data?.payload?.[chart.xField];
          if (v !== undefined) onElementClick(chart.xField, String(v));
        }
      : undefined;
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={aggregateByField(rows, chart.xField, [chart.yField])}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 8, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
            <XAxis
              type="number"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
            />
            <YAxis
              type="category"
              dataKey={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              width={96}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            <Bar
              dataKey={chart.yField}
              fill={primaryStroke}
              radius={[0, 5, 5, 0]}
              maxBarSize={22}
              onClick={handleClick}
              cursor={clickable ? "pointer" : undefined}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "line") {
    const pivoted = chart.seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
      : null;
    // Analytics overlays apply to single-series lines only.
    let data = pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField]);
    let hasForecast = false;
    if (!pivoted) {
      if (chart.running) data = cumulative(data, chart.yField);
      if (chart.compare === "prior_period") {
        data = priorPeriodOverlay(data, chart.yField, "__prior");
      } else if (chart.compare === "prior_year") {
        data = priorYearOverlay(data, chart.xField, chart.yField, "__prior");
      }
      if (chart.trend) {
        const fit = linearFit(data.map((d) => Number(d[chart.yField])));
        if (fit) data = data.map((d, i) => ({ ...d, __trend: fit.slope * i + fit.intercept }));
      }
      if (chart.forecast && chart.forecast > 0) {
        const fc = forecastRows(data, chart.xField, chart.yField, chart.forecast);
        if (fc) {
          data = [...data, ...fc.rows];
          hasForecast = true;
        }
      }
    }
    const refY = refLineY(chart.refLine, data, chart.yField);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            {refY !== null && (
              <ReferenceLine
                y={refY}
                stroke={REF_COLOR}
                strokeDasharray="4 3"
                label={{
                  value: chart.refLine?.label || (chart.refLine?.mode === "avg" ? "avg" : ""),
                  fontSize: 10,
                  fill: REF_COLOR,
                  position: "insideTopRight",
                }}
              />
            )}
            {!pivoted && chart.compare && (
              <Line
                type="monotone"
                dataKey="__prior"
                name={chart.compare === "prior_year" ? "prior year" : "prior period"}
                stroke="var(--muted-foreground)"
                strokeDasharray="5 4"
                strokeWidth={1.5}
                dot={false}
              />
            )}
            {!pivoted && chart.trend && (
              <Line
                type="linear"
                dataKey="__trend"
                name="trend"
                stroke="#d97706"
                strokeDasharray="6 4"
                strokeWidth={1.5}
                dot={false}
              />
            )}
            {!pivoted && hasForecast && (
              <>
                <Line
                  type="monotone"
                  dataKey="__forecast"
                  name="forecast"
                  stroke={primaryStroke}
                  strokeDasharray="4 4"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="__lo"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="2 4"
                  strokeWidth={1}
                  dot={false}
                  legendType="none"
                />
                <Line
                  type="monotone"
                  dataKey="__hi"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="2 4"
                  strokeWidth={1}
                  dot={false}
                  legendType="none"
                />
              </>
            )}
            {pivoted ? (
              <>
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: labelSize }} />
                {pivoted.series.map((s, i) => (
                  <Line
                    key={s}
                    type="monotone"
                    dataKey={s}
                    stroke={PIE_COLORS[i % PIE_COLORS.length]}
                    strokeWidth={2.25}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                ))}
              </>
            ) : (
              <Line
                type="monotone"
                dataKey={chart.yField}
                stroke={primaryStroke}
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "area") {
    const pivoted = chart.seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
      : null;
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField])}
            margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primaryStroke} stopOpacity={0.28} />
                <stop offset="100%" stopColor={primaryStroke} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            {pivoted ? (
              <>
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: labelSize }} />
                {pivoted.series.map((s, i) => (
                  <Area
                    key={s}
                    type="monotone"
                    dataKey={s}
                    stackId="stack"
                    stroke={PIE_COLORS[i % PIE_COLORS.length]}
                    strokeWidth={1.75}
                    fill={PIE_COLORS[i % PIE_COLORS.length]}
                    fillOpacity={0.25}
                  />
                ))}
              </>
            ) : (
              <Area
                type="monotone"
                dataKey={chart.yField}
                stroke={primaryStroke}
                strokeWidth={2.5}
                fill={`url(#${gradientId})`}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "pie") {
    const pieData = aggregateByField(rows, chart.nameField, [chart.valueField]);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              dataKey={chart.valueField}
              nameKey={chart.nameField}
              cx="50%"
              cy="50%"
              innerRadius={large || fill ? "42%" : "38%"}
              outerRadius={large || fill ? "72%" : "68%"}
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
              // recharts' pie enter-animation can wedge and leave the chart
              // permanently empty (no sector paths) — render statically.
              isAnimationActive={false}
            >
              {pieData.map((r, i) => (
                <Cell
                  key={i}
                  fill={PIE_COLORS[i % PIE_COLORS.length]}
                  cursor={clickable ? "pointer" : undefined}
                  onClick={
                    onElementClick
                      ? () => onElementClick(chart.nameField, String(r[chart.nameField]))
                      : undefined
                  }
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: labelSize, color: axisStroke }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "combo") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={aggregateByField(rows, chart.xField, [chart.barField, chart.lineField])}
            margin={{ top: 12, right: 8, left: 0, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="left"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
              width={48}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
              width={44}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={(v: unknown, name: unknown) =>
                name === chart.barField ? fmt(v) : fmtBiNumber(v)
              }
            />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: labelSize }} />
            <Bar
              yAxisId="left"
              dataKey={chart.barField}
              fill={primaryStroke}
              radius={[5, 5, 0, 0]}
              maxBarSize={36}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey={chart.lineField}
              stroke="#F28E2B"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "scatter") {
    // Points need real numbers on both axes — coerce string numerics.
    const points = rows.map((r) => ({
      ...r,
      [chart.xField]: toBiNumber(r[chart.xField]) ?? r[chart.xField],
      [chart.yField]: toBiNumber(r[chart.yField]) ?? r[chart.yField],
      ...(chart.sizeField
        ? { [chart.sizeField]: toBiNumber(r[chart.sizeField]) ?? r[chart.sizeField] }
        : {}),
    }));
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              type="number"
              dataKey={chart.xField}
              name={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
            />
            <YAxis
              type="number"
              dataKey={chart.yField}
              name={chart.yField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
              width={48}
            />
            {chart.sizeField && (
              <ZAxis dataKey={chart.sizeField} name={chart.sizeField} range={[36, 420]} />
            )}
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              cursor={{ strokeDasharray: "3 3", stroke: axisStroke }}
              formatter={(v: unknown, name: unknown) =>
                name === chart.yField ? fmt(v) : fmtBiNumber(v)
              }
            />
            <Scatter data={points} fill={primaryStroke} fillOpacity={0.65} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "funnel") {
    const funnelData = aggregateByField(rows, chart.nameField, [chart.valueField]);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <FunnelChart margin={{ top: 8, right: 96, left: 8, bottom: 8 }}>
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            <Funnel
              dataKey={chart.valueField}
              nameKey={chart.nameField}
              data={funnelData}
              isAnimationActive={false}
            >
              {funnelData.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
              <LabelList
                dataKey={chart.nameField}
                position="right"
                fill={axisStroke}
                fontSize={labelSize}
                stroke="none"
              />
            </Funnel>
          </FunnelChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "waterfall") {
    let cum = 0;
    const wf = aggregateByField(rows, chart.xField, [chart.yField]).map((r) => {
      const v = Number(r[chart.yField]) || 0;
      const base = v >= 0 ? cum : cum + v;
      cum += v;
      return { name: String(r[chart.xField]), base, delta: Math.abs(v), value: v, cum };
    });
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={wf} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey="name" tick={tick} axisLine={false} tickLine={false} />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={(_v, _n, entry) => {
                const p = entry?.payload as { value: number; cum: number } | undefined;
                if (!p) return ["", ""];
                return [
                  `${p.value >= 0 ? "+" : ""}${fmt(p.value)} (running ${fmt(p.cum)})`,
                  "change",
                ];
              }}
            />
            <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="delta" stackId="wf" radius={[3, 3, 0, 0]} maxBarSize={40}>
              {wf.map((d, i) => (
                <Cell key={i} fill={d.value >= 0 ? "#59A14F" : "#E15759"} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "treemap") {
    const data = aggregateByField(rows, chart.nameField, [chart.valueField])
      .map((r) => ({
        name: String(r[chart.nameField] ?? "—"),
        size: Number(r[chart.valueField]) || 0,
      }))
      .filter((d) => d.size > 0);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={data}
            dataKey="size"
            nameKey="name"
            stroke="var(--card)"
            isAnimationActive={false}
            content={<TreemapCell />}
          >
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={(v: number) => [fmt(v), ""]}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>
    );
  }

  return null;
}

/** Custom treemap cell: palette fill + readable label when the box fits. */
function TreemapCell(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  name?: string;
}) {
  const { x = 0, y = 0, width = 0, height = 0, index = 0, name = "" } = props;
  if (width <= 0 || height <= 0) return null;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={3}
        fill={PIE_COLORS[index % PIE_COLORS.length]}
        fillOpacity={0.85}
        stroke="var(--card)"
        strokeWidth={2}
      />
      {width > 52 && height > 22 && (
        <text
          x={x + 6}
          y={y + 15}
          fontSize={10}
          fontWeight={500}
          fill="#fff"
          style={{ pointerEvents: "none" }}
        >
          {name.length > Math.floor(width / 7) ? `${name.slice(0, Math.floor(width / 7))}…` : name}
        </text>
      )}
    </g>
  );
}

// ── Public renderer: analytics wrapper (drill-down + date grain) ─────────
//
// Wraps the raw renderer with runtime interactions that work on snapshots
// everywhere (editor, shared view, public page): category drill-down with
// breadcrumbs for bar/hbar/pie, and a date-grain toggle for line/area.
export function BiChartRender({
  chart,
  rows,
  large = false,
  fill = false,
  onElementClick,
}: {
  chart: ChartSpec;
  rows: Record<string, unknown>[];
  large?: boolean;
  fill?: boolean;
  onElementClick?: (column: string, value: string) => void;
}) {
  const [drillPath, setDrillPath] = useState<DrillEntry[]>([]);
  const [grainOverride, setGrainOverride] = useState<"auto" | DateGrain | null>(null);

  const drillFields = (chart.drillFields ?? []).filter(Boolean);
  const drillable =
    (chart.type === "bar" || chart.type === "hbar" || chart.type === "pie") &&
    drillFields.length > 1;
  const isTime = chart.type === "line" || chart.type === "area";
  const xKey = "xField" in chart ? chart.xField : "nameField" in chart ? chart.nameField : null;
  const grain = grainOverride ?? chart.dateGrain ?? "auto";

  // Reset the drill when the widget's hierarchy changes.
  const drillKey = drillFields.join("|");
  useEffect(() => setDrillPath([]), [drillKey]);

  const showGrainToggle = useMemo(
    () => Boolean(isTime && xKey && isMostlyDates(rows, xKey)),
    [isTime, xKey, rows],
  );

  const { effChart, effRows } = useMemo(() => {
    let r = rows;
    let c: ChartSpec = chart;
    if (drillable && drillPath.length > 0) {
      r = drillRows(r, drillPath);
      const level = Math.min(drillPath.length, drillFields.length - 1);
      const f = drillFields[level];
      c =
        chart.type === "pie" ? { ...chart, nameField: f } : ({ ...chart, xField: f } as ChartSpec);
    }
    if (isTime && xKey && showGrainToggle && grain !== "auto") {
      r = bucketRowsX(r, xKey, grain as DateGrain);
    }
    return { effChart: c, effRows: r };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, rows, drillable, drillPath, drillKey, isTime, xKey, showGrainToggle, grain]);

  const drillClick = drillable
    ? (column: string, value: string) => {
        if (drillPath.length < drillFields.length - 1) {
          setDrillPath((p) => [...p, { field: drillFields[p.length], value }]);
        } else {
          onElementClick?.(column, value);
        }
      }
    : onElementClick;

  const hasControls = drillable || showGrainToggle;
  const inner = (
    <BiChartRenderInner
      chart={effChart}
      rows={effRows}
      large={large}
      fill={fill}
      onElementClick={drillable || onElementClick ? drillClick : undefined}
    />
  );
  if (!hasControls) return inner;

  return (
    <div className={cn("flex w-full flex-col", fill && "h-full")}>
      <div className="flex h-5 shrink-0 items-center justify-between gap-2 overflow-hidden px-1 text-[10px]">
        {drillable ? (
          <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-muted-foreground">
            <button
              type="button"
              className={cn(
                "hover:text-foreground",
                drillPath.length === 0 && "font-semibold text-foreground",
              )}
              onClick={() => setDrillPath([])}
            >
              All
            </button>
            {drillPath.map((p, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-muted-foreground/50">›</span>
                <button
                  type="button"
                  className={cn(
                    "max-w-28 truncate hover:text-foreground",
                    i === drillPath.length - 1 && "font-semibold text-foreground",
                  )}
                  onClick={() => setDrillPath(drillPath.slice(0, i + 1))}
                >
                  {p.value}
                </button>
              </span>
            ))}
            {drillPath.length < drillFields.length - 1 && (
              <span className="truncate text-muted-foreground/60">
                · click to drill into {drillFields[drillPath.length + 1]}
              </span>
            )}
          </div>
        ) : (
          <span />
        )}
        {showGrainToggle && (
          <div className="flex shrink-0 gap-0.5" title="Date grain">
            {(["auto", "day", "week", "month", "quarter", "year"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGrainOverride(g)}
                className={cn(
                  "rounded px-1 py-0.5 uppercase",
                  grain === g
                    ? "bg-primary/15 font-semibold text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {g === "auto" ? "auto" : g[0]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 w-full flex-1">{inner}</div>
    </div>
  );
}
