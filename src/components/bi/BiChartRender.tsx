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
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
      </div>
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

  return null;
}
