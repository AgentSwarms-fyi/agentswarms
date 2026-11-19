// Four visuals added in R502:
//   pareto          bars largest first, the running share as a line, 80% marked
//   calendar        a square per day, a column per week, coloured by the value
//   smallmultiples  one small chart per value of a column, on one shared scale
//   pictogram       rows of pictures, one per unit of the value
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ResponsiveContainer } from "@/components/bi/biChartBox";

import { PIE_COLORS, fmtBiValue } from "@/components/bi/biChartData";
import {
  calendarCells,
  paretoRows,
  PICTOGRAM_ICONS,
  pictogramData,
  pictogramUnit,
  smallMultipleColumns,
  smallMultipleGroups,
} from "@/components/bi/biDrawHelpers";
import type { ChartSpec } from "@/lib/biAgent";

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 11,
  color: "var(--popover-foreground)",
};
const tick = { fontSize: 10, fill: "var(--muted-foreground)" };

// ── Pareto ───────────────────────────────────────────────────────────────────

type ParetoChart = Extract<ChartSpec, { type: "pareto" }>;
const MAX_PARETO_BARS = 40;

export function BiPareto({
  chart,
  rows,
  onElementClick,
}: {
  chart: ParetoChart;
  rows: Record<string, unknown>[];
  /** A bar's category, as a click (R503): filter the page or open another. */
  onElementClick?: (column: string, value: string) => void;
}) {
  const all = useMemo(
    () => paretoRows(rows, chart.categoryField, chart.valueField),
    [rows, chart.categoryField, chart.valueField],
  );
  // Up to 40 bars; the running share is still of the whole total.
  const data = all.slice(0, MAX_PARETO_BARS);
  if (data.length === 0) return <Empty text="No positive values to rank." />;
  // How many categories make up 80% of the total: the sentence a Pareto is
  // for, counted over every category, not only the bars drawn.
  const cut = all.findIndex((d) => d.cumPct >= 80) + 1;
  return (
    <div className="flex h-full flex-col">
      <p className="px-1 pb-1 text-[11px] text-muted-foreground">
        {cut > 0 && (
          <>
            <strong className="text-foreground">{cut}</strong> of {all.length} make up 80% of the
            total.
          </>
        )}
        {all.length > data.length && ` The largest ${data.length} are drawn.`}
      </p>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="category"
              tick={tick}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis
              yAxisId="v"
              tick={tick}
              axisLine={false}
              tickLine={false}
              width={48}
              tickFormatter={(v) => fmtBiValue(v, chart)}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              domain={[0, 100]}
              tick={tick}
              axisLine={false}
              tickLine={false}
              width={36}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: unknown, name: unknown) =>
                name === "cumPct"
                  ? [`${Number(v).toFixed(1)}%`, "Running share"]
                  : [fmtBiValue(v, chart), chart.valueField]
              }
            />
            <Bar
              yAxisId="v"
              dataKey="value"
              fill="var(--primary)"
              radius={[3, 3, 0, 0]}
              cursor={onElementClick ? "pointer" : undefined}
              onClick={
                onElementClick
                  ? (d: { payload?: { category?: unknown } }) => {
                      const c = d?.payload?.category;
                      if (c !== undefined && c !== null) {
                        onElementClick(chart.categoryField, String(c));
                      }
                    }
                  : undefined
              }
            />
            <Line
              yAxisId="pct"
              dataKey="cumPct"
              stroke="#E15759"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <ReferenceLine
              yAxisId="pct"
              y={80}
              stroke="#E15759"
              strokeDasharray="4 4"
              label={{ value: "80%", position: "insideTopRight", fontSize: 10, fill: "#E15759" }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────

type CalendarChart = Extract<ChartSpec, { type: "calendar" }>;
const WEEKDAYS = ["Sun", "", "Tue", "", "Thu", "", "Sat"];

export function BiCalendar({
  chart,
  rows,
}: {
  chart: CalendarChart;
  rows: Record<string, unknown>[];
}) {
  const { cells, weeks, months } = useMemo(
    () => calendarCells(rows, chart.dateField, chart.valueField),
    [rows, chart.dateField, chart.valueField],
  );
  const [hover, setHover] = useState<string | null>(null);
  if (cells.length === 0) return <Empty text="No dates to place on the calendar." />;
  const vals = cells.map((c) => c.value).filter((v): v is number => v !== null);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const S = 12;
  const G = 2;
  const W = 28 + weeks * (S + G);
  const H = 18 + 7 * (S + G);
  const shown = hover ? cells.find((c) => c.date === hover) : null;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-full w-full"
          preserveAspectRatio="xMinYMid meet"
          role="img"
        >
          {months.map((m) => (
            <text
              key={`${m.week}-${m.label}`}
              x={28 + m.week * (S + G)}
              y={10}
              fontSize={9}
              fill="var(--muted-foreground)"
            >
              {m.label}
            </text>
          ))}
          {WEEKDAYS.map((d, i) =>
            d ? (
              <text
                key={i}
                x={0}
                y={18 + i * (S + G) + S - 2}
                fontSize={8}
                fill="var(--muted-foreground)"
              >
                {d}
              </text>
            ) : null,
          )}
          {cells.map((c) => {
            const t = c.value === null || max === min ? 0 : (c.value - min) / (max - min);
            return (
              <rect
                key={c.date}
                x={28 + c.week * (S + G)}
                y={18 + c.weekday * (S + G)}
                width={S}
                height={S}
                rx={2}
                fill={
                  c.value === null
                    ? "var(--muted)"
                    : `color-mix(in oklab, var(--primary) ${Math.round(12 + t * 88)}%, var(--muted))`
                }
                onPointerEnter={() => setHover(c.date)}
                onPointerLeave={() => setHover((h) => (h === c.date ? null : h))}
              >
                <title>{`${c.date}: ${c.value === null ? "no data" : fmtBiValue(c.value, chart)}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center justify-between px-1 pt-1 text-[10px] text-muted-foreground">
        <span className="tabular-nums">
          {shown
            ? `${shown.date}: ${shown.value === null ? "no data" : fmtBiValue(shown.value, chart)}`
            : `${cells.length} days`}
        </span>
        <span className="flex items-center gap-1">
          {fmtBiValue(min, chart)}
          <span
            className="h-2 w-16 rounded-sm"
            style={{
              background:
                "linear-gradient(90deg, color-mix(in oklab, var(--primary) 12%, var(--muted)), var(--primary))",
            }}
          />
          {fmtBiValue(max, chart)}
        </span>
      </div>
    </div>
  );
}

// ── Small multiples ──────────────────────────────────────────────────────────

type SmallMultiplesChart = Extract<ChartSpec, { type: "smallmultiples" }>;

export function BiSmallMultiples({
  chart,
  rows,
}: {
  chart: SmallMultiplesChart;
  rows: Record<string, unknown>[];
}) {
  // Each panel adds up rows that share an x value, as a line or a column
  // chart does (R507). It plotted them one by one, so rows of orders drew a
  // spike per order instead of each month's total; and a query that already
  // groups by x is unchanged by it, which is what lets the panels aggregate
  // in SQL.
  // One scale for every panel: comparing panels is the point.
  const { groups, max } = useMemo(() => smallMultipleGroups(rows, chart), [rows, chart]);
  if (groups.length === 0) return <Empty text="No rows to split." />;
  const cols = smallMultipleColumns(groups.length);
  return (
    <div
      className="grid h-full gap-2"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: "minmax(0, 1fr)",
      }}
    >
      {groups.map((g, i) => (
        <div key={g.key} className="flex min-h-0 flex-col rounded-md border border-border/50 p-1">
          <div className="truncate px-1 text-[10px] font-semibold">{g.key}</div>
          <div className="min-h-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              {chart.kind === "bar" ? (
                <BarChart data={g.rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <XAxis dataKey={chart.xField} hide />
                  <YAxis domain={[0, max]} hide />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: unknown) => fmtBiValue(v, chart)}
                  />
                  <Bar dataKey={chart.yField} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                </BarChart>
              ) : (
                <LineChart data={g.rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <XAxis dataKey={chart.xField} hide />
                  <YAxis domain={[0, max]} hide />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: unknown) => fmtBiValue(v, chart)}
                  />
                  <Line
                    dataKey={chart.yField}
                    stroke={PIE_COLORS[i % PIE_COLORS.length]}
                    strokeWidth={1.75}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Pictogram ────────────────────────────────────────────────────────────────

type PictogramChart = Extract<ChartSpec, { type: "pictogram" }>;

export function BiPictogram({
  chart,
  rows,
}: {
  chart: PictogramChart;
  rows: Record<string, unknown>[];
}) {
  const data = useMemo(
    () => pictogramData(rows, chart.categoryField, chart.valueField),
    [rows, chart.categoryField, chart.valueField],
  );
  if (data.length === 0) return <Empty text="No values to draw." />;
  const max = Math.max(...data.map(([, v]) => v));
  const unit = chart.unit && chart.unit > 0 ? chart.unit : pictogramUnit(max);
  const path = PICTOGRAM_ICONS[chart.icon ?? "person"];
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto px-1">
      <p className="text-[10px] text-muted-foreground">
        Each picture is {fmtBiValue(unit, chart)}.
      </p>
      {data.map(([label, v], i) => {
        const full = Math.floor(v / unit);
        const part = v / unit - full;
        const color = PIE_COLORS[i % PIE_COLORS.length];
        return (
          <div key={label} className="flex items-center gap-2">
            <div className="w-24 shrink-0 truncate text-xs" title={label}>
              {label}
            </div>
            <div
              className="flex min-w-0 flex-1 flex-wrap gap-0.5"
              aria-label={`${label}: ${fmtBiValue(v, chart)}`}
            >
              {Array.from({ length: Math.min(full, 200) }, (_, k) => (
                <Pict key={k} path={path} color={color} />
              ))}
              {/* The remainder as part of a picture, clipped from the left. */}
              {part > 0.05 && full < 200 && <Pict path={path} color={color} fraction={part} />}
            </div>
            <div className="w-16 shrink-0 text-right text-xs tabular-nums">
              {fmtBiValue(v, chart)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pict({ path, color, fraction = 1 }: { path: string; color: string; fraction?: number }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden>
      <defs>
        {fraction < 1 && (
          <clipPath id={`pf-${Math.round(fraction * 100)}`}>
            <rect x={0} y={0} width={24 * fraction} height={24} />
          </clipPath>
        )}
      </defs>
      <path
        d={path}
        fill="none"
        stroke="var(--border)"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        clipPath={fraction < 1 ? `url(#pf-${Math.round(fraction * 100)})` : undefined}
      />
    </svg>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}
