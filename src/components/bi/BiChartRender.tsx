// Shared recharts renderer for BI chart specs. Used by the Data & SQL BI
// chat (compact + enlarged) and by BI dashboard widgets (fill mode).
//
// Styling follows the conventions of professional BI tools: no axis lines,
// horizontal-only gridlines, soft tooltips, gradient area fills and a
// restrained categorical palette.
import { useId } from "react";
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
import type { ChartSpec } from "@/lib/biAgent";

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

export function fmtBiNumber(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v ?? "");
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

export function BiChartRender({
  chart,
  rows,
  large = false,
  fill = false,
}: {
  chart: ChartSpec;
  rows: Record<string, unknown>[];
  /** Enlarged dialog mode (60vh, bigger type). */
  large?: boolean;
  /** Fill the parent's height (dashboard widgets). Parent needs a real height. */
  fill?: boolean;
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
          {fmtBiNumber(v)}
        </span>
        {deltaPct !== undefined && (
          <span
            className={`mt-1.5 flex items-center gap-1 text-xs font-medium tabular-nums ${
              deltaPct >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}% vs target (
            {fmtBiNumber(target)})
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
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis
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
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            <Bar
              dataKey={chart.yField}
              fill={primaryStroke}
              radius={[5, 5, 0, 0]}
              maxBarSize={44}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "line") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
              width={44}
            />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Line
              type="monotone"
              dataKey={chart.yField}
              stroke={primaryStroke}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "area") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primaryStroke} stopOpacity={0.28} />
                <stop offset="100%" stopColor={primaryStroke} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
              width={44}
            />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Area
              type="monotone"
              dataKey={chart.yField}
              stroke={primaryStroke}
              strokeWidth={2.5}
              fill={`url(#${gradientId})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "pie") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey={chart.valueField}
              nameKey={chart.nameField}
              cx="50%"
              cy="50%"
              innerRadius={large || fill ? "42%" : "38%"}
              outerRadius={large || fill ? "72%" : "68%"}
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
            >
              {rows.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
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

  if (chart.type === "hbar") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 8, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
            <XAxis
              type="number"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
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
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            <Bar
              dataKey={chart.yField}
              fill={primaryStroke}
              radius={[0, 5, 5, 0]}
              maxBarSize={22}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "combo") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 12, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="left"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
              width={44}
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
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
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
              tickFormatter={fmtBiNumber}
              width={44}
            />
            {chart.sizeField && (
              <ZAxis dataKey={chart.sizeField} name={chart.sizeField} range={[36, 420]} />
            )}
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              cursor={{ strokeDasharray: "3 3", stroke: axisStroke }}
            />
            <Scatter data={rows} fill={primaryStroke} fillOpacity={0.65} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "funnel") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <FunnelChart margin={{ top: 8, right: 96, left: 8, bottom: 8 }}>
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Funnel dataKey={chart.valueField} nameKey={chart.nameField} data={rows}>
              {rows.map((_, i) => (
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
    const wf = rows.map((r) => {
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
            <YAxis
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
              formatter={(_v, _n, entry) => {
                const p = entry?.payload as { value: number; cum: number } | undefined;
                if (!p) return ["", ""];
                return [
                  `${p.value >= 0 ? "+" : ""}${fmtBiNumber(p.value)} (running ${fmtBiNumber(p.cum)})`,
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
    const data = rows
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
              formatter={(v: number) => [fmtBiNumber(v), ""]}
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
