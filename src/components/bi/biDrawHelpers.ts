// Pure helpers behind R500's visuals, kept out of the component files so that
// those export only components (fast refresh) and so tests need no renderer.
import {
  PIE_COLORS,
  aggregateByField,
  toBiNumber,
  type BiFormatOptions,
} from "@/components/bi/biChartData";
import type {
  BiAnnotation,
  BiLegendPlacement,
  BiNumberFormat,
  BiPictogramIcon,
  ChartSpec,
} from "@/lib/biAgent";
import { MAX_NOTES, NOTE_CHARS } from "@/lib/biVisualOpts";

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

// ── Point map geometry (R501) ────────────────────────────────────────────────

/** A tile is 256 px; at zoom 0 the whole world is one tile. */
export const TILE = 256;

/** Web Mercator: longitude and latitude to pixels at zoom 0. */
export function project(lng: number, lat: number): [number, number] {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * TILE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE];
}

export type MapView = { zoom: number; cx: number; cy: number };

/** The view that fits every point inside w × h with `pad` px to spare. */
export function fitView(points: [number, number][], w: number, h: number, pad = 24): MapView {
  if (points.length === 0) return { zoom: 1, cx: TILE / 2, cy: TILE / 2 };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const dx = Math.max(x1 - x0, 1e-9);
  const dy = Math.max(y1 - y0, 1e-9);
  const fit = Math.log2(Math.min((w - 2 * pad) / dx, (h - 2 * pad) / dy));
  // One point (or several on one spot) would zoom without end: a street's width.
  const zoom = points.length === 1 || !Number.isFinite(fit) ? 14 : Math.max(0, Math.min(18, fit));
  return { zoom, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** A zoom-0 pixel at this view, as a pixel on screen. */
export function toScreen(p: [number, number], v: MapView, w: number, h: number): [number, number] {
  const k = 2 ** v.zoom;
  return [(p[0] - v.cx) * k + w / 2, (p[1] - v.cy) * k + h / 2];
}

/** The tiles that cover the view: their z/x/y and where each is drawn. */
export function visibleTiles(
  v: MapView,
  w: number,
  h: number,
): { z: number; x: number; y: number; left: number; top: number; size: number }[] {
  const z = Math.max(0, Math.min(19, Math.round(v.zoom)));
  const n = 2 ** z;
  const size = TILE * 2 ** (v.zoom - z);
  const k = 2 ** z; // zoom-0 px → tile-zoom px
  const cx = v.cx * k;
  const cy = v.cy * k;
  const scale = size / TILE;
  const x0 = Math.floor((cx - w / 2 / scale) / TILE);
  const x1 = Math.floor((cx + w / 2 / scale) / TILE);
  const y0 = Math.max(0, Math.floor((cy - h / 2 / scale) / TILE));
  const y1 = Math.min(n - 1, Math.floor((cy + h / 2 / scale) / TILE));
  const out = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      out.push({
        z,
        x: ((tx % n) + n) % n,
        y: ty,
        left: (tx * TILE - cx) * scale + w / 2,
        top: (ty * TILE - cy) * scale + h / 2,
        size,
      });
    }
  }
  return out;
}

/** A tile's address from a {z}/{x}/{y} template. */
export function tileUrl(template: string, t: { z: number; x: number; y: number }): string {
  return template
    .replace("{z}", String(t.z))
    .replace("{x}", String(t.x))
    .replace("{y}", String(t.y));
}

/** Where the docs say how to put streets under a point map. */
export const MAP_TILES_DOCS = "/docs/bi#pointmap-tiles";

/**
 * What a point map's lower-left corner says (R504). With street tiles, the
 * credit their server requires. Without, how to add them, but only to the
 * dashboard's owner: an author who saw dots on a blank grid took the map for
 * broken, while a shared link's reader can do nothing about it.
 */
export type MapCorner =
  { kind: "credit"; text: string } | { kind: "setup"; text: string; href: string } | null;

export function pointMapCorner(
  cfg: { mapTilesUrl?: string; mapTilesAttribution?: string },
  canEdit: boolean,
): MapCorner {
  if (cfg.mapTilesUrl) {
    return cfg.mapTilesAttribution ? { kind: "credit", text: cfg.mapTilesAttribution } : null;
  }
  return canEdit
    ? { kind: "setup", text: "No street map: how to add one", href: MAP_TILES_DOCS }
    : null;
}

/**
 * A colour per category: the values' own when every one is a #rrggbb colour,
 * otherwise the palette, most frequent category first.
 */
export function categoryColors(values: unknown[], palette: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const k = v === null || v === undefined ? "" : String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const keys = [...counts.keys()];
  const hex = /^#[0-9a-f]{6}$/i;
  if (keys.length > 0 && keys.every((k) => hex.test(k))) {
    return new Map(keys.map((k) => [k, k]));
  }
  const ordered = keys.sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
  return new Map(ordered.map((k, i) => [k, palette[i % palette.length]]));
}

// ── Journey geometry (R501) ──────────────────────────────────────────────────

/**
 * A winding road through a w × h box, as points every few pixels: three
 * stretches joined by U-turns, starting bottom left and ending top right.
 */
export function roadPoints(w: number, h: number): [number, number][] {
  // The top stretch sits low enough for a pin above it (BiJourney's largest).
  const r = h * 0.15;
  const ys = [h * 0.9, h * 0.9 - 2 * r, h * 0.9 - 4 * r];
  // Turns far enough in that a pin on one stays inside the picture.
  const left = w * 0.17;
  const right = w * 0.8;
  const pts: [number, number][] = [];
  const line = (x0: number, x1: number, y: number) => {
    const n = Math.max(2, Math.ceil(Math.abs(x1 - x0) / 6));
    for (let i = 0; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y]);
  };
  // A U-turn upward around (cx, y - r), on the right (side 1) or left (-1).
  const turn = (cx: number, y: number, side: 1 | -1) => {
    for (let i = 1; i <= 24; i++) {
      const a = Math.PI / 2 - (Math.PI * i) / 24;
      pts.push([cx + side * r * Math.cos(a), y - r + r * Math.sin(a)]);
    }
  };
  line(w * 0.04, right, ys[0]);
  turn(right, ys[0], 1);
  line(right, left, ys[1]);
  turn(left, ys[1], -1);
  line(left, w * 0.96, ys[2]);
  return pts;
}

/** Evenly spaced stops along a polyline: each point and how far along it is. */
export function stopsAlong(pts: [number, number][], n: number): [number, number][] {
  if (pts.length < 2 || n < 1) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const out: [number, number][] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const target = (total * (k + 0.5)) / n;
    while (j < cum.length - 1 && cum[j] < target) j++;
    const t = (target - cum[j - 1]) / Math.max(cum[j] - cum[j - 1], 1e-9);
    out.push([
      pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t,
      pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t,
    ]);
  }
  return out;
}

/** A map pin whose tip touches (x, y): a round head of radius r above it. */
export function pinPath(x: number, y: number, r: number): string {
  const d = 1.75 * r; // tip to the head's centre
  const cy = y - d;
  const b = Math.acos(r / d);
  const lx = x - r * Math.sin(b);
  const rx = x + r * Math.sin(b);
  const ty = cy + r * Math.cos(b);
  const f = (n: number) => n.toFixed(1);
  return `M${f(x)} ${f(y)} L${f(lx)} ${f(ty)} A${f(r)} ${f(r)} 0 1 1 ${f(rx)} ${f(ty)} Z`;
}

// ── R502: moving average, Pareto, calendar, small multiples, pictogram ─────

/**
 * The average of each point and the n−1 before it; null until n points have
 * been seen, so the line starts where a full window does. Missing values are
 * skipped, not counted as zero.
 */
export function movingAverage(values: (number | null)[], n: number): (number | null)[] {
  const w = Math.max(1, Math.round(n));
  return values.map((_, i) => {
    if (i + 1 < w) return null;
    const win = values.slice(i + 1 - w, i + 1).filter((v): v is number => v !== null);
    return win.length ? win.reduce((s, v) => s + v, 0) / win.length : null;
  });
}

/**
 * Categories summed and sorted largest first, each with the running share of
 * the total — a Pareto chart's bars and line. Negative values are left out:
 * a share of a total they reduce means nothing.
 */
export function paretoRows(
  rows: Record<string, unknown>[],
  categoryField: string,
  valueField: string,
): { category: string; value: number; cumPct: number }[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const v = toBiNumber(r[valueField]);
    if (v === null || v < 0) continue;
    const k = String(r[categoryField] ?? "(blank)");
    sums.set(k, (sums.get(k) ?? 0) + v);
  }
  const sorted = [...sums.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  let run = 0;
  return sorted.map(([category, value]) => {
    run += value;
    return { category, value, cumPct: total > 0 ? (run / total) * 100 : 0 };
  });
}

export type CalendarCell = { date: string; week: number; weekday: number; value: number | null };

/**
 * One cell per day from the first date in the rows to the last, Sunday on
 * row 0, a column per week. Values on the same day are added up; a day with
 * no row is null, which is not the same as zero.
 */
export function calendarCells(
  rows: Record<string, unknown>[],
  dateField: string,
  valueField: string,
  maxDays = 400,
): { cells: CalendarCell[]; weeks: number; months: { week: number; label: string }[] } {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const raw = r[dateField];
    const d = raw instanceof Date ? raw : new Date(String(raw ?? "").slice(0, 10) + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const v = toBiNumber(r[valueField]);
    byDay.set(key, (byDay.get(key) ?? 0) + (v ?? 0));
  }
  const days = [...byDay.keys()].sort();
  if (days.length === 0) return { cells: [], weeks: 0, months: [] };
  // The last maxDays days, so a long history shows its latest year.
  const last = new Date(`${days[days.length - 1]}T00:00:00Z`);
  const first = new Date(
    Math.max(new Date(`${days[0]}T00:00:00Z`).getTime(), last.getTime() - (maxDays - 1) * 86400000),
  );
  const start = new Date(first.getTime() - first.getUTCDay() * 86400000);
  const cells: CalendarCell[] = [];
  const months: { week: number; label: string }[] = [];
  let lastMonth = -1;
  for (let t = first.getTime(); t <= last.getTime(); t += 86400000) {
    const d = new Date(t);
    const key = d.toISOString().slice(0, 10);
    const week = Math.floor((t - start.getTime()) / (7 * 86400000));
    if (d.getUTCMonth() !== lastMonth) {
      lastMonth = d.getUTCMonth();
      months.push({ week, label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) });
    }
    cells.push({ date: key, week, weekday: d.getUTCDay(), value: byDay.get(key) ?? null });
  }
  // A month that starts within two columns of the next one has no room for
  // its name: a year from 31 December printed "Dec" over "Jan" (R507). The
  // later month is the one that fills the columns, so it keeps the label.
  const named = months.filter((m, i) => !months[i + 1] || months[i + 1].week - m.week >= 2);
  return { cells, weeks: (cells.at(-1)?.week ?? 0) + 1, months: named };
}

/**
 * Rows split by a column's values, at most `max` groups: largest total of
 * `valueField` first when given (equal-sized groups would otherwise fall back
 * to alphabetical — FOUND IN R502's UI test), else most rows first.
 */
export function splitRows(
  rows: Record<string, unknown>[],
  splitField: string,
  max = 12,
  valueField?: string,
): { key: string; rows: Record<string, unknown>[] }[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = String(r[splitField] ?? "(blank)");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const weight = (rs: Record<string, unknown>[]) =>
    valueField ? rs.reduce((s, r) => s + (toBiNumber(r[valueField]) ?? 0), 0) : rs.length;
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, rows: rs, w: weight(rs) }))
    .sort((a, b) => b.w - a.w || a.key.localeCompare(b.key))
    .slice(0, max)
    .map(({ key, rows: rs }) => ({ key, rows: rs }));
}

/**
 * What one picture stands for when the author gave nothing: a round number
 * (1, 2, 5 × a power of ten) that draws the largest value in at most `most`
 * pictures.
 */
export function pictogramUnit(max: number, most = 20): number {
  if (!(max > 0)) return 1;
  const raw = max / most;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
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

// ── R505: 100% stacks, legend placement, notes, tiles coloured by a measure ──

/**
 * Each part as its share of its row's whole (R505), for a 100% stack: the
 * series values become percentages, and the values themselves are kept under
 * `__raw:<series>` for the tooltip. A part below zero has no share of a whole
 * and is not drawn; a row with nothing in it draws nothing.
 */
export function percentShares(
  data: Record<string, unknown>[],
  series: string[],
): Record<string, unknown>[] {
  return data.map((d) => {
    const out: Record<string, unknown> = { ...d };
    let total = 0;
    for (const s of series) {
      const v = toBiNumber(d[s]);
      if (v !== null && v > 0) total += v;
    }
    for (const s of series) {
      const v = toBiNumber(d[s]);
      out[`__raw:${s}`] = v;
      out[s] = total > 0 && v !== null && v >= 0 ? (v / total) * 100 : null;
    }
    return out;
  });
}

/** Where recharts puts a legend (R505); null leaves it out. */
export function legendPlacement(p: BiLegendPlacement | undefined): {
  layout: "horizontal" | "vertical";
  align: "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
} | null {
  switch (p) {
    case "none":
      return null;
    case "top":
      return { layout: "horizontal", align: "center", verticalAlign: "top" };
    case "right":
      return { layout: "vertical", align: "right", verticalAlign: "middle" };
    default:
      return { layout: "horizontal", align: "center", verticalAlign: "bottom" };
  }
}

/** A note with the point it is pinned to, in the chart's own values. */
export type PlacedNote = { x: string | number; y: number; text: string };

function sameX(a: unknown, b: unknown): boolean {
  if (String(a) === String(b)) return true;
  const na = toBiNumber(a);
  const nb = toBiNumber(b);
  return na !== null && nb !== null && na === nb;
}

/**
 * Where each note goes (R505): at the row whose x matches the note, above the
 * highest mark there, or the top of the stack where the series stack. A note
 * whose x the chart does not show is left out rather than put somewhere else.
 */
export function placeNotes(
  data: Record<string, unknown>[],
  xField: string,
  series: string[],
  notes: BiAnnotation[] | undefined,
  stacked: boolean,
): PlacedNote[] {
  const out: PlacedNote[] = [];
  for (const n of (notes ?? []).slice(0, MAX_NOTES)) {
    const text = String(n.text ?? "")
      .trim()
      .slice(0, NOTE_CHARS);
    if (!text) continue;
    const row = data.find((d) => sameX(d[xField], n.x));
    if (!row) continue;
    const values = series.map((s) => toBiNumber(row[s])).filter((v): v is number => v !== null);
    if (!values.length) continue;
    const y = stacked
      ? values.filter((v) => v > 0).reduce((a, b) => a + b, 0)
      : Math.max(...values);
    out.push({ x: row[xField] as string | number, y, text });
  }
  return out;
}

/**
 * A row for each note so that notes side by side do not print over each
 * other (R505): each takes the lowest row where its span is clear. Spans are
 * [left, right] in pixels, in any order.
 */
export function noteRows(spans: [number, number][], gap = 6): number[] {
  const taken: [number, number][][] = [];
  const order = spans.map((s, i) => i).sort((a, b) => spans[a][0] - spans[b][0]);
  const rows = new Array<number>(spans.length).fill(0);
  for (const i of order) {
    const [l, r] = spans[i];
    let row = 0;
    while ((taken[row] ?? []).some(([tl, tr]) => l < tr + gap && r + gap > tl)) row++;
    (taken[row] ??= []).push([l, r]);
    rows[i] = row;
  }
  return rows;
}

/**
 * A tile's colour from a second measure (R505). "sequential" runs from pale
 * to the full accent across the measure's range; "diverging" splits at zero,
 * green for the good side and red for the bad, deeper further from zero.
 * A tile with no value is muted. Mixed into the pale ground the heatmap uses:
 * mixed into mid-grey, the ends of a range looked alike (R505's UI test).
 */
export function measureTileColor(
  v: number | null,
  range: { min: number; max: number },
  scale: "sequential" | "diverging" | undefined,
  lowerIsBetter = false,
): string {
  if (v === null) return "var(--muted)";
  if (scale === "diverging") {
    const maxAbs = Math.max(Math.abs(range.min), Math.abs(range.max), 1e-9);
    const good = lowerIsBetter ? v < 0 : v > 0;
    const pct = Math.round(15 + Math.min(1, Math.abs(v) / maxAbs) * 85);
    if (v === 0) return "var(--muted)";
    return `color-mix(in oklab, ${good ? "#16a34a" : "#dc2626"} ${pct}%, var(--muted))`;
  }
  const t = (v - range.min) / (range.max - range.min || 1);
  return `color-mix(in oklab, var(--primary) ${Math.round(12 + t * 88)}%, var(--muted))`;
}

/** The amber a combo's first line has always been drawn in. */
export const COMBO_LINE = "#F28E2B";

/**
 * A combo's measures as bars and lines (R506). The bar and line fields come
 * first; each extra measure is a line when `extraLines` names it and bars
 * otherwise. A name already drawn, or one no row carries, is skipped: the
 * same column twice reads as a comparison, and a missing one as a zero.
 */
export function comboSeries(
  chart: { barField: string; lineField: string; extraMeasures?: unknown; extraLines?: unknown },
  rows: Record<string, unknown>[],
): { bars: string[]; lines: string[] } {
  const lineSet = new Set(Array.isArray(chart.extraLines) ? chart.extraLines : []);
  const seen = new Set([chart.barField, chart.lineField]);
  const bars = [chart.barField];
  const lines = [chart.lineField];
  for (const m of Array.isArray(chart.extraMeasures) ? chart.extraMeasures : []) {
    if (typeof m !== "string" || !m || seen.has(m)) continue;
    if (rows.length > 0 && !rows.some((r) => m in r)) continue;
    seen.add(m);
    (lineSet.has(m) ? lines : bars).push(m);
  }
  return { bars, lines };
}

/**
 * The colour of a combo's i-th bar or line. The first bar keeps the theme
 * colour and the first line amber, as a one-measure combo always drew; the
 * rest take the palette in order, without amber, bars before lines, so no
 * two series share a colour until the palette runs out.
 */
export function comboColor(kind: "bar" | "line", i: number, bars: number): string {
  if (i === 0) return kind === "bar" ? "var(--primary)" : COMBO_LINE;
  const rest = PIE_COLORS.filter((c) => c !== COMBO_LINE);
  // rest[0] is a blue that sits too close to most themes' primary.
  const at = kind === "bar" ? i : bars - 1 + i;
  return rest[1 + ((at - 1) % (rest.length - 1))];
}

// ── What a visual draws, for the card and the PDF alike (R511) ──────────────
//
// A scheduled PDF draws these visuals itself (components/bi/biPrintVisuals),
// from the same rows the card draws: the terms, frames, groups and points come
// from here, so the paper and the screen cannot disagree about what is shown.

/** Simple outline pictures for the pictogram, drawn in a 24-unit box. */
export const PICTOGRAM_ICONS: Record<BiPictogramIcon, string> = {
  person: "M12 4a3 3 0 1 1 0 6a3 3 0 1 1 0-6z M6 21v-4a6 6 0 0 1 12 0v4z",
  bike: "M6 17a3.5 3.5 0 1 0 0.01 0z M18 17a3.5 3.5 0 1 0 0.01 0z M6 17l4-7h5l3 7 M10 10l3 7 M9 7h3",
  car: "M3 16v-4l2-5h14l2 5v4z M7 19a1.6 1.6 0 1 0 0.01 0z M17 19a1.6 1.6 0 1 0 0.01 0z",
  house: "M3 11l9-7 9 7 M5 10v10h14V10 M10 20v-6h4v6",
  coin: "M12 3a9 9 0 1 0 0.01 0z M12 7v10 M9 9.5h4.5a2 2 0 0 1 0 4H10a2 2 0 0 0 0 4H15",
  box: "M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10",
};

/** A pictogram's categories and their totals, in row order, at most 12. */
export function pictogramData(
  rows: Record<string, unknown>[],
  categoryField: string,
  valueField: string,
): [string, number][] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const v = toBiNumber(r[valueField]);
    if (v === null) continue;
    const k = String(r[categoryField] ?? "(blank)");
    sums.set(k, (sums.get(k) ?? 0) + v);
  }
  return [...sums.entries()].slice(0, 12);
}

/**
 * Small multiples' panels, at most 12, each adding up the rows that share an
 * x value (R507), and the one maximum every panel is drawn against.
 */
export function smallMultipleGroups(
  rows: Record<string, unknown>[],
  chart: { splitField: string; xField: string; yField: string },
): { groups: { key: string; rows: Record<string, unknown>[] }[]; max: number } {
  const groups = splitRows(rows, chart.splitField, 12, chart.yField).map((g) => ({
    ...g,
    rows: aggregateByField(g.rows, chart.xField, [chart.yField]),
  }));
  const max = Math.max(
    0,
    ...groups.flatMap((g) => g.rows.map((r) => toBiNumber(r[chart.yField]) ?? 0)),
  );
  return { groups, max };
}

/** How many columns of panels a set of small multiples is laid out in. */
export function smallMultipleColumns(n: number): number {
  return n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
}

export type RangeItem = { cat: string; s: number | null; e: number | null; label: string };

/** A range visual's rows: where each started and finished, at most 40. */
export function rangeItems(
  rows: Record<string, unknown>[],
  chart: { categoryField: string; startField: string; endField: string; labelField?: string },
): RangeItem[] {
  return rows
    .map((r) => ({
      cat: String(r[chart.categoryField] ?? "—"),
      s: toBiNumber(r[chart.startField]),
      e: toBiNumber(r[chart.endField]),
      label: chart.labelField ? String(r[chart.labelField] ?? "") : "",
    }))
    .slice(0, 40);
}

export const WORDCLOUD_STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have in is it its of on or that the to was were will with " +
    "this these those i you he she they we not but if then so than too very can just"
  ).split(" "),
);

export type CloudTerm = { key: string; weight: number; term: string };

/**
 * A word cloud's terms, at most 60, in a stable shuffled order. With no
 * value field the text is split into words, counted; with one, each distinct
 * value is a term weighted by the summed measure.
 */
export function wordCloudTerms(
  rows: Record<string, unknown>[],
  textField: string,
  valueField?: string,
): CloudTerm[] {
  const weights = new Map<string, number>();
  const label = new Map<string, string>(); // lowercase key → display term
  if (valueField) {
    for (const r of rows) {
      const term = String(r[textField] ?? "").trim();
      if (!term) continue;
      const v = Number(r[valueField]);
      if (!Number.isFinite(v) || v <= 0) continue;
      const key = term.toLowerCase();
      weights.set(key, (weights.get(key) ?? 0) + v);
      if (!label.has(key)) label.set(key, term);
    }
  } else {
    for (const r of rows) {
      const raw = String(r[textField] ?? "");
      for (const tok of raw.split(/[^\p{L}\p{N}]+/u)) {
        const key = tok.toLowerCase();
        if (key.length < 3 || WORDCLOUD_STOPWORDS.has(key)) continue;
        weights.set(key, (weights.get(key) ?? 0) + 1);
        if (!label.has(key)) label.set(key, tok);
      }
    }
  }
  const arr = [...weights.entries()]
    .map(([key, weight]) => ({ key, weight, term: label.get(key) ?? key }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 60);
  // Deterministic shuffle so the layout is stable across renders.
  return arr
    .map((w, i) => ({ w, r: ((i * 2654435761) % 100) / 100 }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.w);
}

/** A term's size in px: the square root of its weight, from 12 to 46. */
export function wordCloudSize(weight: number, min: number, max: number): number {
  const t =
    max === min ? 0.5 : (Math.sqrt(weight) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min));
  return Math.round(12 + t * 34);
}

export type RaceFrame = { frame: string; entries: [string, number][] };

/** Frames in time order: numbers as numbers, ISO dates as text. */
export function compareFrames(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** A bar race's frames, each with its largest `topN` categories, at most 400. */
export function raceFrames(
  rows: Record<string, unknown>[],
  xField: string,
  yField: string,
  timeField: string,
  topN: number,
): RaceFrame[] {
  const byFrame = new Map<string, Map<string, number>>();
  const order: string[] = [];
  for (const r of rows) {
    const f = String(r[timeField] ?? "");
    const c = String(r[xField] ?? "—");
    const v = toBiNumber(r[yField]);
    if (v === null) continue;
    if (!byFrame.has(f)) {
      byFrame.set(f, new Map());
      order.push(f);
    }
    const m = byFrame.get(f)!;
    m.set(c, (m.get(c) ?? 0) + v);
  }
  order.sort(compareFrames);
  return order.slice(0, 400).map((f) => ({
    frame: f,
    entries: [...byFrame.get(f)!.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN),
  }));
}

/** The palette of the hand-drawn visuals: a bar race, a matrix. */
export const PART_COLORS = [
  "#4E79A7",
  "#F28E2B",
  "#59A14F",
  "#E15759",
  "#76B7B2",
  "#EDC948",
  "#B07AA1",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
  "#86BCB6",
  "#D37295",
];

/** A stable colour for a category name, so a bar keeps it from frame to frame. */
export function colorForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PART_COLORS[h % PART_COLORS.length];
}

export type MapPoint = {
  key: number;
  /** The point at zoom 0, in Web Mercator pixels. */
  p: [number, number];
  label: string;
  cat: string;
  size: number | null;
  r: number;
  color: string;
};

/**
 * A point map's points, biggest first so small ones are never hidden under
 * them, and the colour of each category.
 */
export function mapPoints(
  rows: Record<string, unknown>[],
  chart: {
    latField: string;
    lngField: string;
    colorField?: string;
    sizeField?: string;
    labelField?: string;
  },
): { points: MapPoint[]; colors: Map<string, string> } {
  const valid = rows.filter(
    (r) => toBiNumber(r[chart.latField]) !== null && toBiNumber(r[chart.lngField]) !== null,
  );
  const colors = chart.colorField
    ? categoryColors(
        valid.map((r) => r[chart.colorField!]),
        PIE_COLORS,
      )
    : new Map<string, string>();
  const sizes = chart.sizeField ? valid.map((r) => toBiNumber(r[chart.sizeField!]) ?? 0) : [];
  const max = Math.max(...sizes, 0);
  const points: MapPoint[] = valid.map((r, i) => {
    const cat = chart.colorField ? String(r[chart.colorField] ?? "") : "";
    const s = chart.sizeField ? (toBiNumber(r[chart.sizeField]) ?? 0) : null;
    return {
      key: i,
      p: project(toBiNumber(r[chart.lngField])!, toBiNumber(r[chart.latField])!),
      label: chart.labelField ? String(r[chart.labelField] ?? "") : "",
      cat,
      size: s,
      r: s !== null && max > 0 ? 2.5 + 9 * Math.sqrt(Math.max(0, s) / max) : 4,
      color: colors.get(cat) ?? "var(--primary)",
    };
  });
  points.sort((a, b) => b.r - a.r);
  return { points, colors };
}

// ── A gauge's scale (R511) ──────────────────────────────────────────────────

export type GaugeReading = {
  value: number;
  target?: number;
  max?: number;
  format?: BiNumberFormat | BiFormatOptions;
  /** True when the value was a ratio read against a percentage. */
  rescaled: boolean;
};

/**
 * A gauge's value, target and maximum on one scale.
 *
 * A margin comes back from SQL as a ratio (0.12) and its target is written as
 * a percentage (15): the dial read "0.12 · target 15 · 1%" in R511's UI test,
 * a margin of 12% shown as one percent of its target. When the value is a
 * fraction that, as a percentage, sits within ten times of the target while
 * the raw value is further off than that, the value is the ratio and is read
 * as a percentage. A maximum of exactly 100 says the same without a target.
 * A whole number is never rescaled: one deal against a target of ten is a
 * count, not a ratio.
 */
export function gaugeReading(args: {
  value: number;
  target?: number;
  max?: number;
  format?: BiNumberFormat | BiFormatOptions;
}): GaugeReading {
  const { value, target, max, format } = args;
  const fmt: BiFormatOptions = typeof format === "string" ? { format } : (format ?? {});
  const fraction = Math.abs(value) < 1 && !Number.isInteger(value);
  const near = (a: number, b: number) => b > 0 && a >= b / 10 && a <= b * 10;
  const againstTarget =
    target !== undefined &&
    target > 1 &&
    target <= 100 &&
    near(value * 100, target) &&
    !near(value, target);
  const outOfHundred = target === undefined && max === 100;
  if (fraction && fmt.format !== "currency" && (againstTarget || outOfHundred)) {
    return {
      value: value * 100,
      target,
      max,
      // Already ×100: a format read as ratios (R512) must not scale it again.
      format: { ...fmt, format: "percent", percentOf: "percent" },
      rescaled: true,
    };
  }
  return { value, target, max, format, rescaled: false };
}
