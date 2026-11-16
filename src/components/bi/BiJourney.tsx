// One pin per row along a winding road (R501): the days of a week, the stages
// of a trip, each pin holding its value. Rows are drawn in the order the
// query returns them, from the start of the road to its end, so ORDER BY
// decides the route.
import { useMemo } from "react";

import { PIE_COLORS, fmtBiValue, toBiNumber } from "@/components/bi/biChartData";
import { pinPath, roadPoints, stopsAlong } from "@/components/bi/biDrawHelpers";
import type { ChartSpec } from "@/lib/biAgent";
import { hexColor } from "@/lib/biDashboards";

type JourneyChart = Extract<ChartSpec, { type: "journey" }>;

const W = 1000;
const H = 600;
const MAX_STOPS = 12;

export function BiJourney({
  chart,
  rows,
}: {
  chart: JourneyChart;
  rows: Record<string, unknown>[];
}) {
  const road = useMemo(() => roadPoints(W, H), []);
  const stops = useMemo(() => {
    const items = rows.slice(0, MAX_STOPS).map((r, i) => ({
      label: String(r[chart.categoryField] ?? ""),
      value: toBiNumber(r[chart.valueField]),
      color:
        (chart.colorField ? hexColor(r[chart.colorField]) : undefined) ??
        PIE_COLORS[i % PIE_COLORS.length],
    }));
    const at = stopsAlong(road, items.length);
    return items.map((it, i) => ({ ...it, at: at[i] }));
  }, [rows, chart.categoryField, chart.valueField, chart.colorField, road]);

  if (stops.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No rows to place along the road.
      </div>
    );
  }

  const d = road.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  // The top stretch of road is 180 units from the top: a pin of 56 fits above it.
  const r = Math.min(56, 300 / Math.max(stops.length, 4) + 14);
  const [sx, sy] = road[0];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label={stops.map((s) => `${s.label}: ${fmtBiValue(s.value, chart)}`).join(", ")}
    >
      {/* The road: asphalt, a pale edge, a dashed centre line. */}
      <path
        d={d}
        fill="none"
        stroke="#3a3a3a"
        strokeWidth={46}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={d}
        fill="none"
        stroke="#1f1f1f"
        strokeWidth={40}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={d}
        fill="none"
        stroke="#ffffff"
        strokeWidth={3}
        strokeDasharray="16 12"
        strokeLinecap="round"
      />
      {/* A bicycle at the start of the road. */}
      <g
        transform={`translate(${sx - 6} ${sy - 46})`}
        stroke="var(--foreground)"
        strokeWidth={3}
        fill="none"
      >
        <circle cx={0} cy={22} r={11} />
        <circle cx={40} cy={22} r={11} />
        <path
          d="M0 22 L14 4 L32 4 L40 22 M14 4 L22 22 L32 4 M10 0 L18 0 M30 -2 L36 -2"
          strokeLinecap="round"
        />
      </g>
      {stops.map((s, i) => {
        if (!s.at) return null;
        const [x, y] = s.at;
        const tipY = y - 6;
        const headY = tipY - 1.75 * r;
        // Labels face into the picture near its edges, and alternate between.
        const right = x < W * 0.22 ? true : x > W * 0.72 ? false : i % 2 === 0;
        return (
          <g key={i}>
            <title>{`${s.label}: ${fmtBiValue(s.value, chart)}`}</title>
            <ellipse cx={x} cy={y} rx={r * 0.55} ry={r * 0.16} fill="#000000" opacity={0.28} />
            <path d={pinPath(x, tipY, r)} fill={s.color} stroke="#ffffff" strokeWidth={2} />
            <circle cx={x} cy={headY} r={r * 0.66} fill="#ffffff" />
            <text
              x={x}
              y={headY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={r * 0.42}
              fontWeight={700}
              fill="#333333"
            >
              {s.value === null ? "—" : fmtBiValue(s.value, chart)}
            </text>
            <text
              x={x + (right ? r * 0.5 : -r * 0.5)}
              y={y + 30}
              textAnchor={right ? "start" : "end"}
              fontSize={26}
              fontStyle="italic"
              fill="var(--foreground)"
            >
              {s.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
