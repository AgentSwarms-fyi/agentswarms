// Shared recharts renderer for BI chart specs. Used by the Data & SQL BI
// chat (compact + enlarged) and by BI dashboard widgets (fill mode).
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

export const PIE_COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
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
  const heightClass = fill ? "h-full" : large ? "h-[60vh]" : "h-56";
  const tickSize = large ? 12 : 10;
  const labelSize = large ? 12 : 10;
  // NOTE: design tokens in this project are raw oklch() values, not HSL
  // channels — so wrap with var() directly, never hsl(var(--token)).
  const tooltipStyle = {
    fontSize: tickSize + 1,
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: 6,
  } as const;
  const labelStyle = { color: "var(--popover-foreground)" } as const;
  const gridStroke = "var(--border)";
  const axisStroke = "var(--muted-foreground)";
  const primaryStroke = "var(--primary)";

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
          className={`uppercase tracking-wider text-slate-500 ${large ? "text-sm" : "text-[10px]"}`}
        >
          {chart.label || chart.valueField}
        </span>
        <span
          className={`font-semibold text-indigo-600 dark:text-indigo-400 mt-1 ${
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
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey={chart.xField}
              tick={{ fontSize: tickSize, fill: axisStroke }}
              stroke={axisStroke}
            />
            <YAxis
              tick={{ fontSize: tickSize, fill: axisStroke }}
              stroke={axisStroke}
              tickFormatter={fmtBiNumber}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              cursor={{ fill: "var(--accent)", opacity: 0.3 }}
            />
            <Bar dataKey={chart.yField} fill={primaryStroke} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "line") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey={chart.xField}
              tick={{ fontSize: tickSize, fill: axisStroke }}
              stroke={axisStroke}
            />
            <YAxis
              tick={{ fontSize: tickSize, fill: axisStroke }}
              stroke={axisStroke}
              tickFormatter={fmtBiNumber}
            />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Line
              type="monotone"
              dataKey={chart.yField}
              stroke={primaryStroke}
              strokeWidth={2}
              dot={{ r: 3, fill: primaryStroke }}
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
          <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey={chart.xField}
              tick={{ fontSize: tickSize, fill: axisStroke }}
              stroke={axisStroke}
            />
            <YAxis
              tick={{ fontSize: tickSize, fill: axisStroke }}
              stroke={axisStroke}
              tickFormatter={fmtBiNumber}
            />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Area
              type="monotone"
              dataKey={chart.yField}
              stroke={primaryStroke}
              fill={primaryStroke}
              fillOpacity={0.2}
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
              outerRadius={large || fill ? "70%" : 75}
              label={(entry: Record<string, unknown>) => `${entry[chart.nameField]}`}
              labelLine={false}
            >
              {rows.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Legend wrapperStyle={{ fontSize: labelSize, color: axisStroke }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return null;
}
