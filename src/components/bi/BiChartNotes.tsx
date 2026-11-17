// Notes pinned to a chart (R505): a dot on the mark, a short stem and the
// note above it. Drawn as one layer with the chart's own scales, like the end
// labels, so notes can see each other: two notes side by side take separate
// rows, and a note near an edge is kept inside the chart.
import { noteRows, type PlacedNote } from "@/components/bi/biDrawHelpers";

/** Pixels between the rows that notes side by side take. */
const ROW = 12;
/** About the width of a character at 10px. */
const CHAR = 5.6;

type Scale = ((v: unknown) => number | undefined) & { bandwidth?: () => number };
type AxisMap = Record<string, { scale?: Scale }>;

/** Rendered through recharts' Customized, which passes the chart's axes. */
export function BiChartNotes({
  notes,
  floor = 10,
  xAxisMap,
  yAxisMap,
  offset,
}: {
  notes: PlacedNote[];
  /** The highest a note's text may sit, in px from the top: under a top legend. */
  floor?: number;
  xAxisMap?: AxisMap;
  yAxisMap?: AxisMap;
  offset?: { top?: number; left?: number; width?: number; height?: number };
}) {
  const xs = Object.values(xAxisMap ?? {})[0]?.scale;
  const ys = Object.values(yAxisMap ?? {})[0]?.scale;
  if (!xs || !ys || !offset) return null;
  const band = typeof xs.bandwidth === "function" ? xs.bandwidth() / 2 : 0;
  const left = offset.left ?? 0;
  const right = left + (offset.width ?? 0);
  const placed = notes
    .map((n) => ({ ...n, px: xs(n.x), py: ys(n.y) }))
    .filter(
      (p): p is typeof p & { px: number; py: number } =>
        typeof p.px === "number" &&
        Number.isFinite(p.px) &&
        typeof p.py === "number" &&
        Number.isFinite(p.py),
    )
    .map((p) => {
      const cx = p.px + band;
      const w = p.text.length * CHAR;
      // Kept inside the chart: a note at the last point reads leftwards.
      const anchor: "start" | "middle" | "end" =
        cx + w / 2 > right ? "end" : cx - w / 2 < left ? "start" : "middle";
      const l = anchor === "start" ? cx - 4 : anchor === "end" ? cx + 4 - w : cx - w / 2;
      return { ...p, cx, anchor, span: [l, l + w] as [number, number] };
    });
  const rows = noteRows(placed.map((p) => p.span));
  return (
    <g className="bi-chart-notes">
      {placed.map((p, i) => {
        // Above the mark, a row higher for each note it would overlap, and
        // never off the top of the picture or into a legend above it (the
        // chart leaves room for two rows).
        const ty = Math.max(floor, p.py - 10 - rows[i] * ROW);
        const tx = p.anchor === "start" ? p.cx - 4 : p.anchor === "end" ? p.cx + 4 : p.cx;
        return (
          <g key={`${String(p.x)}-${i}`}>
            <line
              x1={p.cx}
              x2={p.cx}
              y1={p.py - 3}
              y2={ty + 2}
              stroke="var(--foreground)"
              strokeOpacity={0.45}
            />
            <circle
              cx={p.cx}
              cy={p.py}
              r={3}
              fill="var(--foreground)"
              stroke="var(--card)"
              strokeWidth={1.5}
            />
            <text
              x={tx}
              y={ty}
              textAnchor={p.anchor}
              fontSize={10}
              fontWeight={600}
              fill="var(--foreground)"
              style={{
                paintOrder: "stroke",
                stroke: "var(--card)",
                strokeWidth: 3,
                strokeLinejoin: "round",
              }}
            >
              {p.text}
            </text>
          </g>
        );
      })}
    </g>
  );
}
