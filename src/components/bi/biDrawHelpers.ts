// Pure helpers behind R500's visuals, kept out of the component files so that
// those export only components (fast refresh) and so tests need no renderer.
import { toBiNumber } from "@/components/bi/biChartData";
import type { ChartSpec } from "@/lib/biAgent";

/**
 * Ranks held between the points a series has (R500), in x order: a rank
 * stays until the next row says it changed, and nothing is drawn before a
 * series' first point or after its last (not started, or retired).
 *
 * FOUND IN R500: a race lap by lap is 22 drivers × 71 laps, three times the
 * 500-row snapshot cap, so the chart stopped a third of the way in. A rank
 * chart only needs the laps where a rank changes (and a series' first and
 * last); this draws those exactly as the full table would.
 */
export function fillRanks(
  data: Record<string, unknown>[],
  xField: string,
  series: string[],
): Record<string, unknown>[] {
  const numeric = data.every((d) => toBiNumber(d[xField]) !== null);
  const sorted = numeric
    ? [...data].sort((a, b) => (toBiNumber(a[xField]) ?? 0) - (toBiNumber(b[xField]) ?? 0))
    : data;
  const out = sorted.map((d) => ({ ...d }) as Record<string, unknown>);
  for (const s of series) {
    const has = out.map((d) => (toBiNumber(d[s]) ?? 0) > 0);
    const first = has.indexOf(true);
    const last = has.lastIndexOf(true);
    let held: number | null = null;
    out.forEach((d, i) => {
      if (first < 0 || i < first || i > last) {
        d[s] = null;
        return;
      }
      if (has[i]) held = toBiNumber(d[s]);
      else d[s] = held;
    });
  }
  return out;
}

export type EndLabel = { name: string; x: unknown; value: number; color?: string };

/**
 * Moves wanted y positions apart by at least `gap`, keeping each cluster of
 * colliding labels centred on where its labels wanted to be, and inside
 * [top, bottom] when they fit. Returns the positions in the input's order.
 */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  type Group = { start: number; members: { y: number; i: number }[] };
  const groups: Group[] = [];
  for (const o of order) {
    groups.push({ start: o.y, members: [o] });
    // Merge the newest group into the one above while they overlap.
    while (groups.length > 1) {
      const b = groups[groups.length - 1];
      const a = groups[groups.length - 2];
      if (a.start + a.members.length * gap <= b.start) break;
      const members = [...a.members, ...b.members];
      const mean = members.reduce((s, m) => s + m.y, 0) / members.length;
      groups.splice(groups.length - 2, 2, {
        start: mean - ((members.length - 1) * gap) / 2,
        members,
      });
    }
  }
  const placed = groups.flatMap((g) => g.members.map((m, k) => ({ i: m.i, y: g.start + k * gap })));
  // Keep inside the plot: push down from the top, then up from the bottom;
  // the top wins when there are more labels than room.
  for (let k = 0; k < placed.length; k++) {
    placed[k].y = Math.max(placed[k].y, k === 0 ? top : placed[k - 1].y + gap);
  }
  for (let k = placed.length - 1; k >= 0; k--) {
    const limit = k === placed.length - 1 ? bottom : placed[k + 1].y - gap;
    placed[k].y = Math.max(Math.min(placed[k].y, limit), top + k * gap);
  }
  const out = new Array<number>(ys.length);
  for (const p of placed) out[p.i] = p.y;
  return out;
}

/** Each line's last drawn point: where its name goes. */
export function lastPoints(
  data: Record<string, unknown>[],
  xField: string,
  series: string[],
  name: (s: string) => string,
  colors: Map<string, string>,
): EndLabel[] {
  const out: EndLabel[] = [];
  for (const s of series) {
    for (let i = data.length - 1; i >= 0; i--) {
      const v = data[i][s];
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out.push({ name: name(s), x: data[i][xField], value: n, color: colors.get(s) });
      break;
    }
  }
  return out;
}

/**
 * A single line break is a new line, as it is where it was typed. Markdown
 * runs such lines into one paragraph — FOUND IN R500's UI test, a circuit's
 * name, place and lap count printed as one run-on line.
 */
export function hardBreaks(text: string): string {
  return text.replace(/([^\n])\n(?!\n)/g, "$1  \n");
}

/**
 * The measure and the category the visual itself shows, so suggested
 * narratives are about what the chart draws (R500): a points race is about
 * points, not about the round each point was scored in.
 */
export function visualFields(chart: ChartSpec | undefined): {
  measure?: string;
  category?: string;
} {
  if (!chart) return {};
  const s = chart as unknown as Record<string, unknown>;
  const pick = (keys: string[]) =>
    keys.map((k) => s[k]).find((v): v is string => typeof v === "string" && v !== "");
  return {
    measure: pick(["yField", "valueField", "barField", "sizeField"]),
    category: pick(["seriesField", "nameField", "categoryField", "xField"]),
  };
}
