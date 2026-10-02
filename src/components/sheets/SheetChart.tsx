// A chart over a range of the sheet, drawn with recharts and redrawn as the
// cells change. The numbers come from charts.ts, which reads a range the way
// Excel does; this only draws them.

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES_COLORS, type ChartData, type ChartDef } from "@/lib/sheets/charts";

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };
const LABEL = { fontSize: 10, fill: "var(--foreground)" };

/** 1234567 → 1.2M, as an axis has room for. */
export function compactNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return String(+n.toFixed(2));
}

export function SheetChart({ def, data }: { def: ChartDef; data: ChartData }) {
  if (data.problem) {
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground"
        data-testid="chart-problem"
      >
        {data.problem}
      </div>
    );
  }
  const rows = data.categories.map((c, i) => {
    const row: Record<string, string | number | null> = { __cat: c };
    data.series.forEach((s, k) => (row[`s${k}`] = s.values[i] ?? null));
    return row;
  });
  const stackId = def.stacked && def.stacked !== "none" ? "a" : undefined;
  const offset = def.stacked === "percent" ? "expand" : undefined;
  const legend =
    def.legend === "none" ? null : (
      <Legend
        verticalAlign={def.legend === "top" ? "top" : def.legend === "right" ? "middle" : "bottom"}
        align={def.legend === "right" ? "right" : "center"}
        layout={def.legend === "right" ? "vertical" : "horizontal"}
        wrapperStyle={{ fontSize: 11 }}
      />
    );
  const color = (k: number) => SERIES_COLORS[k % SERIES_COLORS.length];
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />;
  const tooltip = (
    <Tooltip
      contentStyle={{
        fontSize: 12,
        background: "var(--popover)",
        border: "1px solid var(--border)",
        color: "var(--popover-foreground)",
      }}
    />
  );
  const common = {
    data: rows,
    margin: { top: 12, right: 16, bottom: 4, left: 4 },
    stackOffset: offset,
  } as const;
  const tick = offset
    ? (v: number) => `${Math.round(v * 100)}%`
    : (v: number) => (typeof v === "number" ? compactNumber(v) : String(v));
  const valueAxis = (
    <YAxis
      tick={AXIS}
      width={56}
      tickFormatter={tick}
      label={
        def.yTitle
          ? { value: def.yTitle, angle: -90, position: "insideLeft", style: AXIS }
          : undefined
      }
    />
  );
  const catAxis = (
    <XAxis
      dataKey="__cat"
      tick={AXIS}
      label={
        def.xTitle
          ? { value: def.xTitle, position: "insideBottom", offset: -2, style: AXIS }
          : undefined
      }
    />
  );
  const labels = (k: number) =>
    def.labels ? (
      <LabelList dataKey={`s${k}`} position="top" style={LABEL} formatter={tick} />
    ) : null;

  let chart: React.ReactElement;
  switch (def.type) {
    case "column":
    case "bar": {
      const horizontal = def.type === "bar";
      chart = (
        <BarChart {...common} layout={horizontal ? "vertical" : "horizontal"}>
          {horizontal ? (
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
          ) : (
            grid
          )}
          {/* Direct children: Recharts finds its axes by type and does not look inside a fragment. */}
          {horizontal ? <XAxis type="number" tick={AXIS} tickFormatter={tick} /> : catAxis}
          {horizontal ? (
            <YAxis type="category" dataKey="__cat" tick={AXIS} width={96} />
          ) : (
            valueAxis
          )}
          {tooltip}
          {legend}
          {data.series.map((s, k) => (
            <Bar
              key={k}
              dataKey={`s${k}`}
              name={s.name}
              fill={color(k)}
              stackId={stackId}
              isAnimationActive={false}
            >
              {def.labels && (
                <LabelList
                  dataKey={`s${k}`}
                  position={horizontal ? "right" : "top"}
                  style={LABEL}
                  formatter={tick}
                />
              )}
            </Bar>
          ))}
        </BarChart>
      );
      break;
    }
    case "line":
      chart = (
        <LineChart {...common}>
          {grid}
          {catAxis}
          {valueAxis}
          {tooltip}
          {legend}
          {data.series.map((s, k) => (
            <Line
              key={k}
              type={def.smooth ? "monotone" : "linear"}
              dataKey={`s${k}`}
              name={s.name}
              stroke={color(k)}
              strokeWidth={2}
              dot={rows.length <= 40}
              connectNulls={false}
              isAnimationActive={false}
            >
              {labels(k)}
            </Line>
          ))}
        </LineChart>
      );
      break;
    case "area":
      chart = (
        <AreaChart {...common}>
          {grid}
          {catAxis}
          {valueAxis}
          {tooltip}
          {legend}
          {data.series.map((s, k) => (
            <Area
              key={k}
              type={def.smooth ? "monotone" : "linear"}
              dataKey={`s${k}`}
              name={s.name}
              stroke={color(k)}
              fill={color(k)}
              fillOpacity={0.35}
              stackId={stackId}
              isAnimationActive={false}
            >
              {labels(k)}
            </Area>
          ))}
        </AreaChart>
      );
      break;
    case "pie":
    case "doughnut": {
      const s = data.series[0];
      const slices = data.categories
        .map((c, i) => ({ name: c, value: s?.values[i] ?? 0 }))
        .filter((x) => typeof x.value === "number" && x.value > 0);
      const total = slices.reduce((a, x) => a + (x.value as number), 0) || 1;
      chart = (
        <PieChart>
          {tooltip}
          {legend}
          <Pie
            data={slices}
            dataKey="value"
            nameKey="name"
            innerRadius={def.type === "doughnut" ? "50%" : 0}
            outerRadius="78%"
            label={
              def.labels
                ? ({ value }: { value: number }) => `${Math.round((value / total) * 100)}%`
                : false
            }
            labelLine={def.labels}
            isAnimationActive={false}
          >
            {slices.map((_, i) => (
              <Cell key={i} fill={color(i)} stroke="var(--background)" />
            ))}
          </Pie>
        </PieChart>
      );
      break;
    }
    case "scatter":
      chart = (
        <ScatterChart margin={common.margin}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="x"
            name={def.xTitle || "x"}
            tick={AXIS}
            tickFormatter={tick}
            domain={["auto", "auto"]}
            label={
              def.xTitle
                ? { value: def.xTitle, position: "insideBottom", offset: -2, style: AXIS }
                : undefined
            }
          />
          <YAxis
            type="number"
            dataKey="y"
            name={def.yTitle || "y"}
            tick={AXIS}
            width={56}
            tickFormatter={tick}
            domain={["auto", "auto"]}
            label={
              def.yTitle
                ? { value: def.yTitle, angle: -90, position: "insideLeft", style: AXIS }
                : undefined
            }
          />
          {tooltip}
          {legend}
          {data.series.map((s, k) => (
            <Scatter
              key={k}
              name={s.name}
              fill={color(k)}
              isAnimationActive={false}
              data={(data.xs ?? [])
                .map((x, i) => ({ x, y: s.values[i] }))
                .filter((p) => p.x !== null && p.y !== null && p.y !== undefined)}
            />
          ))}
        </ScatterChart>
      );
      break;
    case "combo":
      chart = (
        <ComposedChart {...common}>
          {grid}
          {catAxis}
          {valueAxis}
          {tooltip}
          {legend}
          {data.series.map((s, k) =>
            k === 0 ? (
              <Bar
                key={k}
                dataKey={`s${k}`}
                name={s.name}
                fill={color(k)}
                isAnimationActive={false}
              >
                {labels(k)}
              </Bar>
            ) : (
              <Line
                key={k}
                type={def.smooth ? "monotone" : "linear"}
                dataKey={`s${k}`}
                name={s.name}
                stroke={color(k)}
                strokeWidth={2}
                isAnimationActive={false}
              >
                {labels(k)}
              </Line>
            ),
          )}
        </ComposedChart>
      );
      break;
    case "radar":
      chart = (
        <RadarChart data={rows} outerRadius="72%">
          <PolarGrid stroke="var(--border)" />
          <PolarAngleAxis dataKey="__cat" tick={AXIS} />
          <PolarRadiusAxis tick={AXIS} tickFormatter={tick} />
          {tooltip}
          {legend}
          {data.series.map((s, k) => (
            <Radar
              key={k}
              dataKey={`s${k}`}
              name={s.name}
              stroke={color(k)}
              fill={color(k)}
              fillOpacity={0.25}
              isAnimationActive={false}
            />
          ))}
        </RadarChart>
      );
      break;
  }
  return (
    <div className="flex h-full flex-col" data-chart-type={def.type}>
      {def.title && (
        <div
          className="truncate px-3 pt-2 text-center text-sm font-semibold"
          data-testid="chart-title"
        >
          {def.title}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
