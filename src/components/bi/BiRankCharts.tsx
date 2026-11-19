// Charts about ranks and standings (R500):
//   range      where each row started and finished — positions gained or lost
//   radialbar  concentric arcs, longest for the leader
//   bump       rank over time, 1 at the top, every line named at both ends
// Colours come from the rows (`colorField`, a team's livery) where given.
import { useMemo } from "react";
import {
  Cell,
  Line,
  LineChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ReferenceArea,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ResponsiveContainer } from "@/components/bi/biChartBox";

import {
  PIE_COLORS,
  fmtBiNumber,
  pivotSeries,
  seriesColors,
  toBiNumber,
} from "@/components/bi/biChartData";
import { fillRanks, rangeItems } from "@/components/bi/biDrawHelpers";
import type { ChartSpec } from "@/lib/biAgent";

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 11,
  color: "var(--popover-foreground)",
};

// ── Range: start → finish ────────────────────────────────────────────────────

type RangeChart = Extract<ChartSpec, { type: "range" }>;

export function BiRangeBars({
  chart,
  rows,
}: {
  chart: RangeChart;
  rows: Record<string, unknown>[];
}) {
  const items = useMemo(() => rangeItems(rows, chart), [rows, chart]);
  const nums = items.flatMap((i) => [i.s, i.e]).filter((v): v is number => v !== null);
  if (nums.length === 0) {
    return (
      <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No start and end values to draw.
      </p>
    );
  }
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const higher = chart.higherIsBetter === true;
  // The better end is on the right: position 1 sits at the right edge.
  const xOf = (v: number) => (higher ? (v - lo) / span : (hi - v) / span) * 100;

  return (
    <div className="flex h-full flex-col justify-between gap-px overflow-y-auto py-1">
      {items.map((it, i) => {
        const done = it.s !== null && it.e !== null;
        const better = done && (higher ? it.e! > it.s! : it.e! < it.s!);
        const worse = done && (higher ? it.e! < it.s! : it.e! > it.s!);
        const a = done ? Math.min(xOf(it.s!), xOf(it.e!)) : 0;
        const b = done ? Math.max(xOf(it.s!), xOf(it.e!)) : 0;
        const color = better ? "#16a34a" : worse ? "#dc2626" : "var(--muted-foreground)";
        return (
          <div key={i} className="flex min-h-0 flex-1 items-center gap-2 text-[10px]">
            <span
              className="w-20 shrink-0 truncate text-right text-muted-foreground"
              title={it.cat}
            >
              {it.cat}
            </span>
            <div className="relative h-full min-h-3 flex-1">
              {done && (better || worse) ? (
                <div
                  className="absolute top-1/2 flex h-3.5 -translate-y-1/2 items-center justify-between rounded-full px-1 text-[9px] font-semibold text-white"
                  style={{ left: `${a}%`, width: `max(${b - a}%, 1.75rem)`, background: color }}
                  title={`${it.cat}: ${it.s} → ${it.e}`}
                >
                  {/* The worse number on the left, the better on the right. */}
                  <span>{fmtBiNumber(xOf(it.s!) <= xOf(it.e!) ? it.s! : it.e!)}</span>
                  <span>{fmtBiNumber(xOf(it.s!) <= xOf(it.e!) ? it.e! : it.s!)}</span>
                </div>
              ) : done ? (
                <div
                  className="absolute top-1/2 flex h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[8px] font-semibold text-background"
                  style={{ left: `${a}%`, background: color }}
                  title={`${it.cat}: held ${it.s}`}
                >
                  {fmtBiNumber(it.s!)}
                </div>
              ) : null}
            </div>
            {chart.labelField && (
              <span className="w-36 shrink-0 truncate" title={it.label}>
                {it.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Radial bars ──────────────────────────────────────────────────────────────

type RadialChart = Extract<ChartSpec, { type: "radialbar" }>;

/** The ring geometry recharts hands a radial bar's label. */
type RingBox = { cx?: number; cy?: number; innerRadius?: number; outerRadius?: number };

export function BiRadialBars({
  chart,
  rows,
}: {
  chart: RadialChart;
  rows: Record<string, unknown>[];
}) {
  const data = useMemo(() => {
    const colors = seriesColors(rows, chart.nameField, chart.colorField);
    return rows
      .map((r, i) => {
        const name = String(r[chart.nameField] ?? "—");
        return {
          name,
          value: toBiNumber(r[chart.valueField]) ?? 0,
          fill: colors.get(name) ?? PIE_COLORS[i % PIE_COLORS.length],
        };
      })
      .slice(0, 30)
      .sort((a, b) => a.value - b.value); // the first is innermost: leader outside
  }, [rows, chart.nameField, chart.valueField, chart.colorField]);
  // The longest bar sweeps three quarters of a turn, leaving the quarter
  // left of 12 o'clock clear for the names; a full ring hid its own label.
  const max = (Math.max(...data.map((d) => d.value), 1) * 4) / 3;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RadialBarChart
        data={data}
        innerRadius="12%"
        outerRadius="98%"
        startAngle={90}
        endAngle={-270}
        barCategoryGap="18%"
      >
        <PolarAngleAxis type="number" domain={[0, max]} tick={false} axisLine={false} />
        <RadialBar
          dataKey="value"
          cornerRadius={4}
          background={{ fill: "var(--muted)", fillOpacity: 0.35 }}
          isAnimationActive={false}
          label={(p: { index?: number; viewBox?: RingBox }) => {
            // The ring's radii arrive only inside viewBox: recharts keeps
            // just valid SVG attributes on the label's own props, so cx/cy
            // survive there but innerRadius/outerRadius do not — FOUND IN
            // R500's UI test, every name drawn on top of the others at the
            // centre.
            const d = data[p.index ?? -1];
            const v = p.viewBox;
            if (!d || v?.cx === undefined || v.cy === undefined) return <g />;
            const r = ((v.innerRadius ?? 0) + (v.outerRadius ?? 0)) / 2;
            if (r <= 0) return <g />;
            return (
              <text
                x={v.cx - 5}
                y={v.cy - r}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={8}
                fill="var(--muted-foreground)"
              >
                {d.name}
              </text>
            );
          }}
        >
          {data.map((d) => (
            <Cell key={d.name} fill={d.fill} />
          ))}
        </RadialBar>
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: unknown, _n: unknown, item: { payload?: { name?: string } }) => [
            fmtBiNumber(Number(v)),
            item?.payload?.name ?? "",
          ]}
          labelFormatter={() => ""}
        />
      </RadialBarChart>
    </ResponsiveContainer>
  );
}

// ── Bump: rank over time ─────────────────────────────────────────────────────

type BumpChart = Extract<ChartSpec, { type: "bump" }>;

export function BiBumpChart({
  chart,
  rows,
}: {
  chart: BumpChart;
  rows: Record<string, unknown>[];
}) {
  const { data, series, colors, startAt, endAt, maxRank, numericX } = useMemo(() => {
    const p = pivotSeries(rows, chart.xField, chart.yField, chart.seriesField, 40);
    const colors = seriesColors(rows, chart.seriesField, chart.colorField);
    const data = fillRanks(p.data, chart.xField, p.series);
    // Who held each rank at the first and the last x: the axis labels.
    const startAt = new Map<number, string>();
    const endAt = new Map<number, string>();
    let maxRank = 1;
    for (const s of p.series) {
      const pts = data.map((d) => toBiNumber(d[s])).filter((v): v is number => v !== null && v > 0);
      if (pts.length === 0) continue;
      maxRank = Math.max(maxRank, ...pts);
      if (!startAt.has(pts[0])) startAt.set(pts[0], s);
      if (!endAt.has(pts[pts.length - 1])) endAt.set(pts[pts.length - 1], s);
    }
    const numericX = data.every((d) => toBiNumber(d[chart.xField]) !== null);
    return { data, series: p.series, colors, startAt, endAt, maxRank, numericX };
  }, [rows, chart.xField, chart.yField, chart.seriesField, chart.colorField]);

  const ticks = Array.from({ length: maxRank }, (_, i) => i + 1);
  const tick = (map: Map<number, string>, side: "left" | "right") =>
    function RankTick(props: { x?: number; y?: number; payload?: { value?: number } }) {
      const v = Number(props.payload?.value);
      const name = map.get(v) ?? "";
      return (
        <text
          x={props.x}
          y={props.y}
          dy={3}
          textAnchor={side === "left" ? "end" : "start"}
          fontSize={9}
          fill="var(--muted-foreground)"
        >
          {side === "left" ? `${name}  ${v}` : `${v}  ${name}`}
        </text>
      );
    };

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 14, right: 8, bottom: 4, left: 8 }}>
        <XAxis
          dataKey={chart.xField}
          type={numericX ? "number" : "category"}
          domain={numericX ? ["dataMin", "dataMax"] : undefined}
          allowDecimals={false}
          tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          interval="preserveStartEnd"
          minTickGap={18}
        />
        <YAxis
          yAxisId="l"
          reversed
          domain={[1, maxRank]}
          ticks={ticks}
          interval={0}
          width={88}
          tickLine={false}
          axisLine={false}
          tick={tick(startAt, "left")}
        />
        <YAxis
          yAxisId="r"
          orientation="right"
          reversed
          domain={[1, maxRank]}
          ticks={ticks}
          interval={0}
          width={88}
          tickLine={false}
          axisLine={false}
          tick={tick(endAt, "right")}
        />
        {(chart.xBands ?? []).map((b, i) => (
          <ReferenceArea
            key={i}
            yAxisId="l"
            x1={b.from}
            x2={b.to}
            fill="var(--foreground)"
            fillOpacity={0.06}
            stroke="none"
            label={
              b.label
                ? {
                    value: b.label,
                    position: "insideTop",
                    fontSize: 9,
                    fill: "var(--muted-foreground)",
                  }
                : undefined
            }
          />
        ))}
        <Tooltip
          contentStyle={tooltipStyle}
          itemSorter={(item: { value?: unknown }) => Number(item.value)}
          formatter={(v: unknown, name: unknown) => [`P${v}`, String(name)]}
        />
        {series.map((s, i) => (
          <Line
            key={s}
            yAxisId="l"
            type="bumpX"
            dataKey={s}
            name={s}
            stroke={colors.get(s) ?? PIE_COLORS[i % PIE_COLORS.length]}
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
        {/* The right axis needs a series to draw against; this one is empty. */}
        <Line yAxisId="r" dataKey="__none" legendType="none" tooltipType="none" dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
