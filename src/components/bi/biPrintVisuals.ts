// Seven visuals drawn for paper (R511): cards, range, word cloud, pictogram,
// small multiples, bar race and point map.
//
// On screen these are laid out by the browser (HTML, CSS grids, flex wrap) or
// animated, so the server render a scheduled PDF uses had no single chart
// SVG to draw, and the PDF printed "drawn in the app only" in their place.
// Here each is laid out again as one SVG, from the same rows and the same
// helpers the card uses (biDrawHelpers), with text measured in the PDF's own
// font, and drawn by lib/svgPdf like every other chart.
//
// Sizes are CSS px, as on screen: the caller renders at the card's size in
// px and the PDF scales the drawing to the box.
import { PIE_COLORS, fmtBiNumber, fmtBiValue } from "@/components/bi/biChartData";
import {
  colorForKey,
  fitView,
  mapPoints,
  PICTOGRAM_ICONS,
  pictogramData,
  pictogramUnit,
  raceFrames,
  rangeItems,
  smallMultipleColumns,
  smallMultipleGroups,
  tileUrl,
  toScreen,
  visibleTiles,
  wordCloudSize,
  wordCloudTerms,
} from "@/components/bi/biDrawHelpers";
import { toBiNumber } from "@/components/bi/biChartData";
import type { ChartSpec } from "@/lib/biAgent";
import { cardLine, cardLines, type CardSegment } from "@/lib/biCardTemplate";
import { safeImageSrc } from "@/lib/safeUrl";

export const PRINTED_VISUALS = [
  "cards",
  "range",
  "wordcloud",
  "pictogram",
  "smallmultiples",
  "barrace",
  "pointmap",
] as const;
export type PrintedVisual = (typeof PRINTED_VISUALS)[number];

export function isPrintedVisual(type: string | undefined): type is PrintedVisual {
  return (PRINTED_VISUALS as readonly string[]).includes(type ?? "");
}

/** A string's width at a size in px, in the font the PDF draws it in. */
export type PrintMeasure = (text: string, size: number, bold: boolean) => number;

/** A street tile under a point map: where it goes, and its picture as a data URL. */
export type PrintTile = { href: string; left: number; top: number; size: number };

export type PrintInput = {
  chart: ChartSpec;
  rows: Record<string, unknown>[];
  width: number;
  height: number;
  measure: PrintMeasure;
  /** A picture's https address → its data URL, fetched by the caller (printPictureUrls). */
  pictures?: Map<string, string>;
  /** Street tiles under a point map, fetched by the caller (printMapTiles). */
  tiles?: PrintTile[];
  /** The credit the tile server asks for. */
  mapCredit?: string;
};

/**
 * The visual as markup: one SVG, with a caption paragraph after it where the
 * paper needs to say something the screen shows by moving (a bar race).
 */
export function printVisualSvg(input: PrintInput): string {
  const w = Math.max(40, Math.round(input.width));
  const h = Math.max(30, Math.round(input.height));
  const p = { ...input, width: w, height: h };
  switch (input.chart.type) {
    case "cards":
      return printCards(p, input.chart);
    case "range":
      return printRange(p, input.chart);
    case "wordcloud":
      return printWordCloud(p, input.chart);
    case "pictogram":
      return printPictogram(p, input.chart);
    case "smallmultiples":
      return printSmallMultiples(p, input.chart);
    case "barrace":
      return printBarRace(p, input.chart);
    case "pointmap":
      return printPointMap(p, input.chart);
    default:
      return message(w, h, "This visual is drawn in the app only.");
  }
}

/** The https pictures a visual shows, for the caller to fetch before drawing. */
export function printPictureUrls(chart: ChartSpec, rows: Record<string, unknown>[]): string[] {
  if (chart.type !== "cards") return [];
  const fields = [chart.imageField, ...(chart.iconFields ?? [])].filter((f): f is string => !!f);
  const out = new Set<string>();
  for (const row of shownCards(chart, rows)) {
    for (const f of fields) {
      const src = safeImageSrc(row[f]);
      if (/^https:\/\//i.test(src)) out.add(src);
    }
  }
  return [...out];
}

/**
 * The street tiles under a point map at this size, for the caller to fetch,
 * with where each is drawn. Empty for any other visual.
 */
export function printMapTiles(
  chart: ChartSpec,
  rows: Record<string, unknown>[],
  width: number,
  height: number,
  template: string,
): { url: string; left: number; top: number; size: number }[] {
  if (chart.type !== "pointmap") return [];
  const { points } = mapPoints(rows, chart);
  if (points.length === 0) return [];
  const w = Math.max(40, Math.round(width));
  const h = Math.max(30, Math.round(height));
  const v = fitView(
    points.map((pt) => pt.p),
    w,
    h,
  );
  return visibleTiles(v, w, h)
    .slice(0, 24)
    .map((t) => ({ url: tileUrl(template, t), left: t.left, top: t.top, size: t.size }));
}

// ── Markup helpers ──────────────────────────────────────────────────────────

const n = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function svgRoot(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-print="1">${body}</svg>`;
}

type TextOpts = {
  size: number;
  bold?: boolean;
  anchor?: "start" | "middle" | "end";
  fill?: string;
  opacity?: number;
};

function text(x: number, y: number, s: string, o: TextOpts): string {
  const t = s.trim();
  if (!t) return "";
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `font-size="${n(o.size)}"`,
    o.bold ? `font-weight="bold"` : "",
    o.anchor && o.anchor !== "start" ? `text-anchor="${o.anchor}"` : "",
    `fill="${o.fill ?? "var(--foreground)"}"`,
    o.opacity !== undefined && o.opacity < 1 ? `fill-opacity="${n(o.opacity)}"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${esc(t)}</text>`;
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  o: { fill?: string; stroke?: string; rx?: number; opacity?: number; strokeWidth?: number },
): string {
  if (!(w > 0 && h > 0)) return "";
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `width="${n(w)}"`,
    `height="${n(h)}"`,
    o.rx ? `rx="${n(Math.min(o.rx, w / 2, h / 2))}"` : "",
    `fill="${o.fill ?? "none"}"`,
    o.opacity !== undefined && o.opacity < 1 ? `fill-opacity="${n(o.opacity)}"` : "",
    o.stroke ? `stroke="${o.stroke}" stroke-width="${n(o.strokeWidth ?? 1)}"` : "",
  ].filter(Boolean);
  return `<rect ${attrs.join(" ")}/>`;
}

/** A line of text cut to a width, with an ellipsis. */
export function fitText(
  measure: PrintMeasure,
  s: string,
  size: number,
  bold: boolean,
  maxW: number,
): string {
  const t = s.trim();
  if (measure(t, size, bold) <= maxW) return t;
  if (measure("…", size, bold) > maxW) return "";
  let out = t;
  while (out.length > 0 && measure(`${out}…`, size, bold) > maxW) out = out.slice(0, -1);
  return out ? `${out.trimEnd()}…` : "";
}

/** A baseline that centres text of a size on a line at y. */
const mid = (y: number, size: number) => y + size * 0.35;

function message(w: number, h: number, s: string): string {
  return svgRoot(
    w,
    h,
    text(w / 2, mid(h / 2, 12), s, { size: 12, anchor: "middle", fill: "var(--muted-foreground)" }),
  );
}

/**
 * A card template's line, bold where it says **…**, cut to a width and set
 * from x by its anchor. Each run is its own text, placed by measuring the
 * ones before it.
 */
function segmentLine(
  m: PrintMeasure,
  segs: CardSegment[],
  x: number,
  y: number,
  size: number,
  anchor: "start" | "middle" | "end",
  fill: string,
  maxW: number,
): string {
  const parts = segs.map((s) => ({ ...s }));
  const width = () => parts.reduce((t, p) => t + m(p.text, size, p.bold), 0);
  if (width() > maxW) {
    const dots = m("…", size, false);
    while (parts.length && width() + dots > maxW) {
      const last = parts[parts.length - 1];
      if (last.text.length <= 1) parts.pop();
      else last.text = last.text.slice(0, -1);
    }
    if (parts.length) parts[parts.length - 1].text = `${parts[parts.length - 1].text.trimEnd()}…`;
  }
  const total = width();
  let cx = anchor === "middle" ? x - total / 2 : anchor === "end" ? x - total : x;
  return parts
    .map((p) => {
      // The PDF trims each run, so a leading space is a step, not a glyph.
      const lead = /^\s*/.exec(p.text)![0];
      cx += m(lead, size, p.bold);
      const body = p.text.slice(lead.length);
      const out = text(cx, y, body, { size, bold: p.bold, fill });
      cx += m(body, size, p.bold);
      return out;
    })
    .join("");
}

function image(href: string, x: number, y: number, w: number, h: number): string {
  if (!(w > 1 && h > 1)) return "";
  return `<image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="xMidYMid meet" href="${esc(href)}"/>`;
}

function pictureHref(src: unknown, pictures: Map<string, string> | undefined): string {
  const url = safeImageSrc(src);
  if (!url) return "";
  if (url.startsWith("data:")) return url;
  return pictures?.get(url) ?? "";
}

// ── Cards ───────────────────────────────────────────────────────────────────

type CardsChart = Extract<ChartSpec, { type: "cards" }>;

function shownCards(chart: CardsChart, rows: Record<string, unknown>[]) {
  const layout = chart.layout ?? "tiles";
  return rows.slice(0, Math.max(1, chart.max ?? (layout === "rows" ? 6 : 4)));
}

function printCards(p: PrintInput, chart: CardsChart): string {
  const { width: w, height: h, measure: m } = p;
  const fmt = (v: unknown) => fmtBiValue(v, chart);
  const shown = shownCards(chart, p.rows);
  if (shown.length === 0) return message(w, h, "No rows to show.");
  const icons = (chart.iconFields ?? []).filter(Boolean);
  const primary = "var(--primary)";
  const out: string[] = [];

  if ((chart.layout ?? "tiles") === "rows") {
    const gap = 6;
    const rowH = (h - gap * (shown.length - 1)) / shown.length;
    const wide = w >= 384; // the card's own @sm breakpoint
    const pad = wide ? 12 : 8;
    shown.forEach((row, i) => {
      const top = i * (rowH + gap);
      out.push(rect(0, top, w, rowH, { fill: "var(--foreground)", opacity: 0.06, rx: 6 }));
      const body = cardLines(chart.body, row, fmt);
      // Type that fits the strip: a title and its lines, as on screen at most.
      const k = Math.min(1, (rowH - 6) / (25 + body.length * 16));
      const titleSize = (wide ? 20 : 16) * k;
      const lineSize = 12 * k;
      let x = pad;
      const cy = top + rowH / 2;
      if (chart.lead) {
        const leadW = wide ? 32 : 24;
        const size = (wide ? 24 : 18) * Math.max(k, 0.6);
        out.push(
          segmentLine(
            m,
            cardLine(chart.lead, row, fmt),
            x + leadW / 2,
            mid(cy, size),
            size,
            "middle",
            "var(--foreground)",
            leadW + 8,
          ),
        );
        x += leadW + (wide ? 12 : 8);
      }
      if (wide) {
        for (const f of icons) {
          const href = pictureHref(row[f], p.pictures);
          if (href) out.push(image(href, x, cy - 14, 40, 28));
          x += 40 + 12;
        }
      }
      if (chart.imageField) {
        const s = Math.min(wide ? 48 : 40, rowH - 6);
        const href = pictureHref(row[chart.imageField], p.pictures);
        if (href) out.push(image(href, x, cy - s / 2, s, s));
        x += s + (wide ? 12 : 8);
      }
      let right = w - pad;
      if (chart.value) {
        const segs = cardLine(chart.value, row, fmt);
        const vw = segs.reduce((t, s) => t + m(s.text, titleSize, s.bold), 0);
        out.push(
          segmentLine(
            m,
            segs,
            right,
            mid(cy, titleSize),
            titleSize,
            "end",
            "var(--foreground)",
            w / 3,
          ),
        );
        right -= Math.min(vw, w / 3) + 12;
      }
      const textW = Math.max(20, right - x);
      const blockH = titleSize * 1.25 + body.length * lineSize * 1.4;
      let y = cy - blockH / 2;
      out.push(
        segmentLine(
          m,
          cardLine(chart.title, row, fmt),
          x,
          y + titleSize,
          titleSize,
          "start",
          primary,
          textW,
        ),
      );
      y += titleSize * 1.25;
      for (const segs of body) {
        out.push(
          segmentLine(
            m,
            segs,
            x,
            y + lineSize,
            lineSize,
            "start",
            "var(--muted-foreground)",
            textW,
          ),
        );
        y += lineSize * 1.4;
      }
    });
    return svgRoot(w, h, out.join(""));
  }

  // Tiles, side by side.
  const gap = 12;
  const colW = (w - gap * (shown.length - 1)) / shown.length;
  shown.forEach((row, i) => {
    const x0 = i * (colW + gap);
    const cx = x0 + colW / 2;
    const body = cardLines(chart.body, row, fmt);
    const titleSize = Math.min(20, colW / 8);
    const lineSize = 12;
    let y = 0;
    if (chart.heading) {
      out.push(
        segmentLine(
          m,
          cardLine(chart.heading, row, fmt),
          cx,
          y + titleSize,
          titleSize,
          "middle",
          "var(--foreground)",
          colW,
        ),
      );
      y += titleSize * 1.25 + 6;
    }
    const below = titleSize * 1.25 + 6 + body.length * (lineSize * 1.375 + 6);
    const picH = Math.max(0, h - y - below);
    if (chart.imageField && picH > 8) {
      const href = pictureHref(row[chart.imageField], p.pictures);
      const ph = Math.min(picH, 160);
      if (href) out.push(image(href, cx - (colW * 0.7) / 2, y + (picH - ph) / 2, colW * 0.7, ph));
    }
    if (icons.length && picH > 8) {
      const iw = 36;
      const ih = 24;
      const stack = icons.length * ih + (icons.length - 1) * 6;
      let iy = y + (picH - stack) / 2;
      for (const f of icons) {
        const href = pictureHref(row[f], p.pictures);
        if (href) out.push(image(href, x0 + colW * 0.92 - iw, iy, iw, ih));
        iy += ih + 6;
      }
    }
    y += picH + 6;
    out.push(
      segmentLine(
        m,
        cardLine(chart.title, row, fmt),
        cx,
        y + titleSize,
        titleSize,
        "middle",
        primary,
        colW,
      ),
    );
    y += titleSize * 1.25 + 6;
    for (const segs of body) {
      out.push(
        segmentLine(m, segs, cx, y + lineSize, lineSize, "middle", "var(--foreground)", colW),
      );
      y += lineSize * 1.375 + 6;
    }
  });
  return svgRoot(w, h, out.join(""));
}

// ── Range: start → finish ───────────────────────────────────────────────────

type RangeChart = Extract<ChartSpec, { type: "range" }>;

function printRange(p: PrintInput, chart: RangeChart): string {
  const { width: w, height: h, measure: m } = p;
  const items = rangeItems(p.rows, chart);
  const nums = items.flatMap((i) => [i.s, i.e]).filter((v): v is number => v !== null);
  if (nums.length === 0) return message(w, h, "No start and end values to draw.");
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const higher = chart.higherIsBetter === true;
  const labelW = 80;
  const gap = 8;
  const extraW = chart.labelField ? Math.min(144, w / 4) : 0;
  const x0 = labelW + gap;
  const tw = Math.max(20, w - x0 - (extraW ? extraW + gap : 0));
  const rowH = (h - 8) / items.length;
  const ph = Math.min(14, rowH * 0.85);
  const fs = Math.min(10, rowH * 0.8);
  // The better end is on the right: position 1 sits at the right edge.
  const xOf = (v: number) => (higher ? (v - lo) / span : (hi - v) / span) * tw;
  const out: string[] = [];
  items.forEach((it, i) => {
    const cy = 4 + rowH * (i + 0.5);
    out.push(
      text(labelW, mid(cy, fs), fitText(m, it.cat, fs, false, labelW), {
        size: fs,
        anchor: "end",
        fill: "var(--muted-foreground)",
      }),
    );
    if (extraW) {
      out.push(
        text(x0 + tw + gap, mid(cy, fs), fitText(m, it.label, fs, false, extraW), { size: fs }),
      );
    }
    if (it.s === null || it.e === null) return;
    const better = higher ? it.e > it.s : it.e < it.s;
    const worse = higher ? it.e < it.s : it.e > it.s;
    const color = better ? "#16a34a" : worse ? "#dc2626" : "var(--muted-foreground)";
    const a = Math.min(xOf(it.s), xOf(it.e));
    const b = Math.max(xOf(it.s), xOf(it.e));
    const nsize = Math.min(9, ph * 0.7);
    if (better || worse) {
      const bw = Math.max(b - a, ph * 2);
      const left = Math.min(x0 + a, x0 + tw - bw);
      out.push(rect(left, cy - ph / 2, bw, ph, { fill: color, rx: ph / 2 }));
      // The worse number on the left, the better on the right.
      const [lv, rv] = xOf(it.s) <= xOf(it.e) ? [it.s, it.e] : [it.e, it.s];
      out.push(
        text(left + 4, mid(cy, nsize), fmtBiNumber(lv), {
          size: nsize,
          bold: true,
          fill: "#ffffff",
        }),
      );
      out.push(
        text(left + bw - 4, mid(cy, nsize), fmtBiNumber(rv), {
          size: nsize,
          bold: true,
          anchor: "end",
          fill: "#ffffff",
        }),
      );
    } else {
      out.push(`<circle cx="${n(x0 + a)}" cy="${n(cy)}" r="${n(ph / 2)}" fill="${color}"/>`);
      out.push(
        text(x0 + a, mid(cy, nsize * 0.9), fmtBiNumber(it.s), {
          size: nsize * 0.9,
          bold: true,
          anchor: "middle",
          fill: "#ffffff",
        }),
      );
    }
  });
  return svgRoot(w, h, out.join(""));
}

// ── Word cloud ──────────────────────────────────────────────────────────────

type WordCloudChart = Extract<ChartSpec, { type: "wordcloud" }>;

/**
 * Words set in centred lines, as the card's flex wrap sets them, shrunk
 * together until every line fits the box (to a third of their size; past
 * that the smallest words are left off).
 */
export function layoutWordCloud(
  words: { term: string; size: number }[],
  w: number,
  h: number,
  m: PrintMeasure,
): { term: string; size: number; x: number; y: number; index: number }[] {
  const gapX = 12;
  const gapY = 4;
  const pad = 8;
  const place = (k: number) => {
    const lines: { items: { i: number; w: number; size: number }[]; w: number; h: number }[] = [];
    let cur: (typeof lines)[number] = { items: [], w: 0, h: 0 };
    words.forEach((wd, i) => {
      const size = wd.size * k;
      const ww = m(wd.term, size, true);
      const add = cur.items.length ? gapX + ww : ww;
      if (cur.items.length && cur.w + add > w - 2 * pad) {
        lines.push(cur);
        cur = { items: [], w: 0, h: 0 };
      }
      cur.w += cur.items.length ? gapX + ww : ww;
      cur.h = Math.max(cur.h, size * 1.25);
      cur.items.push({ i, w: ww, size });
    });
    if (cur.items.length) lines.push(cur);
    const total = lines.reduce((t, l) => t + l.h, 0) + gapY * Math.max(0, lines.length - 1);
    return { lines, total };
  };
  let k = 1;
  let laid = place(k);
  while (laid.total > h - 2 * pad && k > 0.34) {
    k *= 0.9;
    laid = place(k);
  }
  const out: { term: string; size: number; x: number; y: number; index: number }[] = [];
  let y = Math.max(pad, (h - laid.total) / 2);
  for (const line of laid.lines) {
    if (y + line.h > h + 0.5) break;
    let x = (w - line.w) / 2;
    for (const it of line.items) {
      out.push({
        term: words[it.i].term,
        size: it.size,
        x,
        y: y + line.h / 2 + it.size * 0.35,
        index: it.i,
      });
      x += it.w + gapX;
    }
    y += line.h + gapY;
  }
  return out;
}

function printWordCloud(p: PrintInput, chart: WordCloudChart): string {
  const { width: w, height: h, measure: m } = p;
  const terms = wordCloudTerms(p.rows, chart.textField, chart.valueField);
  if (terms.length === 0) return message(w, h, "No words to show.");
  const max = Math.max(...terms.map((t) => t.weight));
  const min = Math.min(...terms.map((t) => t.weight));
  const placed = layoutWordCloud(
    terms.map((t) => ({ term: t.term, size: wordCloudSize(t.weight, min, max) })),
    w,
    h,
    m,
  );
  return svgRoot(
    w,
    h,
    placed
      .map((pl) =>
        text(pl.x, pl.y, pl.term, {
          size: pl.size,
          bold: true,
          fill: PIE_COLORS[pl.index % PIE_COLORS.length],
          opacity: 0.75 + 0.25 * (terms[pl.index].weight / max),
        }),
      )
      .join(""),
  );
}

// ── Pictogram ───────────────────────────────────────────────────────────────

type PictogramChart = Extract<ChartSpec, { type: "pictogram" }>;

function printPictogram(p: PrintInput, chart: PictogramChart): string {
  const { width: w, height: h, measure: m } = p;
  const data = pictogramData(p.rows, chart.categoryField, chart.valueField);
  if (data.length === 0) return message(w, h, "No values to draw.");
  const max = Math.max(...data.map(([, v]) => v));
  const unit = chart.unit && chart.unit > 0 ? chart.unit : pictogramUnit(max);
  const path = PICTOGRAM_ICONS[chart.icon ?? "person"];
  const capSize = 10;
  const capH = 16;
  const labelW = Math.min(96, w / 4);
  const valueW = 64;
  const gap = 8;
  const areaW = Math.max(24, w - labelW - valueW - 2 * gap);
  const counts = data.map(([, v]) => {
    const full = Math.floor(v / unit);
    const part = v / unit - full;
    return Math.min(full, 200) + (part > 0.05 && full < 200 ? 1 : 0);
  });
  // The pictures' size: 20px as on screen, smaller until every row fits.
  let s = 20;
  const heightAt = (size: number) => {
    const per = Math.max(1, Math.floor((areaW + 2) / (size + 2)));
    return (
      capH +
      counts.reduce((t, c) => t + Math.max(1, Math.ceil(c / per)) * (size + 2), 0) +
      gap * (data.length - 1)
    );
  };
  while (s > 6 && heightAt(s) > h) s -= 1;
  const per = Math.max(1, Math.floor((areaW + 2) / (s + 2)));
  const out: string[] = [
    text(0, capSize, `Each picture is ${fmtBiValue(unit, chart)}.`, {
      size: capSize,
      fill: "var(--muted-foreground)",
    }),
  ];
  const defs: string[] = [];
  let y = capH;
  const fs = Math.min(12, Math.max(7, s * 0.6));
  data.forEach(([label, v], i) => {
    const full = Math.min(Math.floor(v / unit), 200);
    const part = v / unit - Math.floor(v / unit);
    const lines = Math.max(1, Math.ceil(counts[i] / per));
    const rowH = lines * (s + 2);
    const color = PIE_COLORS[i % PIE_COLORS.length];
    out.push(
      text(0, mid(y + Math.min(rowH, s + 2) / 2, fs), fitText(m, label, fs, false, labelW), {
        size: fs,
      }),
    );
    out.push(
      text(w, mid(y + Math.min(rowH, s + 2) / 2, fs), fmtBiValue(v, chart), {
        size: fs,
        anchor: "end",
      }),
    );
    const k = s / 24;
    for (let j = 0; j < counts[i]; j++) {
      const gx = labelW + gap + (j % per) * (s + 2);
      const gy = y + Math.floor(j / per) * (s + 2);
      const partial = j === full && part > 0.05;
      const clip = partial ? `pc${i}` : "";
      if (partial) {
        defs.push(
          `<clipPath id="${clip}"><rect x="0" y="0" width="${n(24 * part)}" height="24"/></clipPath>`,
        );
      }
      out.push(
        `<g transform="translate(${n(gx)} ${n(gy)}) scale(${n(k * 1000) / 1000})">` +
          `<path d="${path}" fill="none" stroke="var(--border)" stroke-width="1.6" stroke-linecap="round"/>` +
          `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"${clip ? ` clip-path="url(#${clip})"` : ""}/>` +
          `</g>`,
      );
    }
    y += rowH + gap;
  });
  return svgRoot(w, h, `<defs>${defs.join("")}</defs>${out.join("")}`);
}

// ── Small multiples ─────────────────────────────────────────────────────────

type SmallMultiplesChart = Extract<ChartSpec, { type: "smallmultiples" }>;

function printSmallMultiples(p: PrintInput, chart: SmallMultiplesChart): string {
  const { width: w, height: h, measure: m } = p;
  const { groups, max } = smallMultipleGroups(p.rows, chart);
  if (groups.length === 0) return message(w, h, "No rows to split.");
  const cols = smallMultipleColumns(groups.length);
  const rowsN = Math.ceil(groups.length / cols);
  const gap = 8;
  const pw = (w - gap * (cols - 1)) / cols;
  const ph = (h - gap * (rowsN - 1)) / rowsN;
  const out: string[] = [];
  groups.forEach((g, i) => {
    const x = (i % cols) * (pw + gap);
    const y = Math.floor(i / cols) * (ph + gap);
    const color = PIE_COLORS[i % PIE_COLORS.length];
    out.push(rect(x, y, pw, ph, { stroke: "var(--border)", rx: 6 }));
    out.push(
      text(x + 8, y + 4 + 10, fitText(m, g.key, 10, true, pw - 16), { size: 10, bold: true }),
    );
    // The plot, below its title, inside the panel's padding.
    const px = x + 4;
    const py = y + 4 + 14 + 4;
    const pww = Math.max(4, pw - 8 - 4);
    const phh = Math.max(4, ph - 8 - 18);
    const vals = g.rows.map((r) => toBiNumber(r[chart.yField]) ?? 0);
    const band = pww / Math.max(1, vals.length);
    const yOf = (v: number) => py + phh * (1 - (max > 0 ? Math.max(0, v) / max : 0));
    if (chart.kind === "bar") {
      vals.forEach((v, j) => {
        const top = yOf(v);
        out.push(
          rect(px + j * band + band * 0.1, top, band * 0.8, py + phh - top, { fill: color }),
        );
      });
    } else if (vals.length) {
      const pts = vals.map((v, j) => `${n(px + (j + 0.5) * band)},${n(yOf(v))}`).join(" ");
      out.push(
        `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round"/>`,
      );
    }
  });
  return svgRoot(w, h, out.join(""));
}

// ── Bar race: its last frame ────────────────────────────────────────────────

type BarRaceChart = Extract<ChartSpec, { type: "barrace" }>;

function printBarRace(p: PrintInput, chart: BarRaceChart): string {
  const { width: w, height: h, measure: m } = p;
  const topN = chart.topN ?? 12;
  const frames = raceFrames(p.rows, chart.xField, chart.yField, chart.timeField, topN);
  if (frames.length === 0) return message(w, h, "No values to plot.");
  // Paper cannot play it: the last frame, where the race ends.
  const cur = frames[frames.length - 1];
  const max = Math.max(...cur.entries.map((e) => e[1]), 1e-9);
  const rowH = h / topN;
  const labelW = Math.min(96, w / 4);
  const barX = 4 + labelW + 6;
  const barW = Math.max(10, w - barX - 4);
  const fs = Math.min(10, rowH * 0.7);
  const fmt = (v: number) => fmtBiValue(v, chart);
  const out: string[] = [];
  cur.entries.forEach(([cat, val], rank) => {
    const top = rank * rowH;
    const cy = top + rowH / 2;
    const bh = rowH * 0.68;
    const pct = val / max;
    const bw = Math.max(pct, 0.005) * barW;
    out.push(
      text(4 + labelW, mid(cy, fs), fitText(m, cat, fs, false, labelW), {
        size: fs,
        anchor: "end",
        fill: "var(--muted-foreground)",
      }),
    );
    out.push(rect(barX, cy - bh / 2, bw, bh, { fill: colorForKey(cat), rx: 2 }));
    out.push(
      pct > 0.82
        ? text(barX + bw - 4, mid(cy, fs), fmt(val), { size: fs, anchor: "end", fill: "#ffffff" })
        : text(barX + bw + 4, mid(cy, fs), fmt(val), { size: fs }),
    );
  });
  out.push(
    text(w - 8, h - 6, cur.frame, {
      size: 24,
      bold: true,
      anchor: "end",
      fill: "var(--muted-foreground)",
      opacity: 0.3,
    }),
  );
  const svg = svgRoot(w, h, out.join(""));
  const caption =
    frames.length > 1
      ? `The last of ${frames.length} frames: ${cur.frame}. The app plays them all.`
      : "";
  return caption ? `<div>${svg}<p>${esc(caption)}</p></div>` : svg;
}

// ── Point map ───────────────────────────────────────────────────────────────

type PointMapChart = Extract<ChartSpec, { type: "pointmap" }>;

function printPointMap(p: PrintInput, chart: PointMapChart): string {
  const { width: w, height: h, measure: m } = p;
  const { points, colors } = mapPoints(p.rows, chart);
  if (points.length === 0) return message(w, h, "No rows with a latitude and longitude to place.");
  const v = fitView(
    points.map((pt) => pt.p),
    w,
    h,
  );
  const out: string[] = [];
  const tiles = p.tiles ?? [];
  // The ground and the points are clipped to the map: tiles overhang its
  // edges, which a browser hides at the svg's edge and a PDF does not. On the
  // first Bike Share PDF the street tiles covered the page around the card.
  out.push(`<clipPath id="pm"><rect x="0" y="0" width="${n(w)}" height="${n(h)}"/></clipPath>`);
  out.push(`<g clip-path="url(#pm)">`);
  if (tiles.length) {
    out.push(rect(0, 0, w, h, { fill: "var(--muted)" }));
    for (const t of tiles) out.push(image(t.href, t.left, t.top, t.size + 0.5, t.size + 0.5));
  } else {
    // The plain ground the card draws without a tile server: a light grid.
    out.push(rect(0, 0, w, h, { fill: "var(--muted)", opacity: 0.45 }));
    for (let x = 0; x <= w; x += 40) {
      out.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="var(--border)" stroke-width="1"/>`,
      );
    }
    for (let y = 0; y <= h; y += 40) {
      out.push(
        `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`,
      );
    }
  }
  for (const pt of points) {
    const [x, y] = toScreen(pt.p, v, w, h);
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
    out.push(
      `<circle cx="${n(x)}" cy="${n(y)}" r="${n(pt.r)}" fill="${pt.color}" fill-opacity="0.78" stroke="#ffffff" stroke-opacity="0.7" stroke-width="0.6"/>`,
    );
  }
  out.push(`</g>`);
  const legend = [...colors.entries()].slice(0, 8);
  if (legend.length > 1) {
    const lw =
      Math.min(120, Math.max(...legend.map(([cat]) => m(cat || "(blank)", 10, false)))) + 24;
    out.push(
      rect(8, 8, lw, legend.length * 14 + 8, { fill: "var(--background)", opacity: 0.8, rx: 6 }),
    );
    legend.forEach(([cat, color], i) => {
      const cy = 8 + 4 + 7 + i * 14;
      out.push(`<circle cx="${n(18)}" cy="${n(cy)}" r="4" fill="${color}"/>`);
      out.push(text(28, mid(cy, 10), fitText(m, cat || "(blank)", 10, false, 120), { size: 10 }));
    });
  }
  if (tiles.length && p.mapCredit) {
    const cw = m(p.mapCredit, 9, false) + 12;
    out.push(rect(0, h - 15, cw, 15, { fill: "var(--background)", opacity: 0.75 }));
    out.push(text(6, h - 4, p.mapCredit, { size: 9, fill: "var(--muted-foreground)" }));
  }
  return svgRoot(w, h, out.join(""));
}
