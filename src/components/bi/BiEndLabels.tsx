// Names at the ends of a line chart's lines (R500), spread apart so that lines
// finishing close together stay readable. Drawn as one layer with the chart's
// own scales: each line labelling only its own point cannot see the others,
// and five drivers within 33 points of each other printed on top of one
// another — FOUND IN R500's UI test.
import { fmtBiNumber } from "@/components/bi/biChartData";
import { spreadLabels, type EndLabel } from "@/components/bi/biDrawHelpers";

/** Pixels between the baselines of two end labels. */
const LABEL_GAP = 11;

type Scale = ((v: unknown) => number | undefined) & { bandwidth?: () => number };
type AxisMap = Record<string, { scale?: Scale }>;

/** Rendered through recharts' Customized, which passes the chart's axes. */
export function BiEndLabels({
  labels,
  xAxisMap,
  yAxisMap,
  offset,
}: {
  labels: EndLabel[];
  xAxisMap?: AxisMap;
  yAxisMap?: AxisMap;
  offset?: { top?: number; height?: number };
}) {
  const xs = Object.values(xAxisMap ?? {})[0]?.scale;
  const ys = Object.values(yAxisMap ?? {})[0]?.scale;
  if (!xs || !ys || !offset) return null;
  const band = typeof xs.bandwidth === "function" ? xs.bandwidth() / 2 : 0;
  const top = (offset.top ?? 0) + 4;
  const bottom = (offset.top ?? 0) + (offset.height ?? 0) - 4;
  const points = labels
    .map((l) => ({ ...l, px: xs(l.x), py: ys(l.value) }))
    .filter(
      (p): p is typeof p & { px: number; py: number } =>
        typeof p.px === "number" && typeof p.py === "number" && Number.isFinite(p.py),
    );
  // Labels collide only with others ending at the same x.
  const byX = new Map<number, typeof points>();
  for (const p of points) byX.set(p.px, [...(byX.get(p.px) ?? []), p]);
  return (
    <g className="bi-end-labels">
      {[...byX.values()].flatMap((group) => {
        const placed = spreadLabels(
          group.map((p) => p.py),
          LABEL_GAP,
          top,
          bottom,
        );
        return group.map((p, k) => (
          <text
            key={p.name}
            x={p.px + band + 4}
            y={placed[k]}
            dy={3}
            fontSize={9}
            fill={p.color ?? "var(--muted-foreground)"}
          >
            {`${p.name} ${fmtBiNumber(p.value)}`}
          </text>
        ));
      })}
    </g>
  );
}
