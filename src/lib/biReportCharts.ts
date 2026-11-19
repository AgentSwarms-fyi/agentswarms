// Charts in a PDF laid out on the server (R509).
//
// The browser exports a report with its charts rasterised from the preview.
// A scheduled report has no browser, so the server renders the SAME chart
// component to markup at the block's size (see utils/bi/reportCharts.server)
// and this module draws what came back:
//
//   svg    — most visuals are one SVG; drawn as vectors by svgPdf, with the
//            legend (HTML in the markup) drawn in a strip reserved for it and
//            any caption under the chart printed below it.
//   table  — the heatmap, the pivot and a data table (R510) are HTML
//            tables; drawn as a grid, header and totals kept.
//   text   — a narrative is a sentence; drawn as wrapped text.
//   kpi    — the KPI tile's figures, from the same function the tile uses.
//
// A visual not in SCHEDULED_DRAW is not drawn. The block says so in words
// where the chart would be, and the designer warns before anyone schedules
// it, because a PDF with a silent hole reads as "no data", which is untrue.
import { rgb, type Color } from "pdf-lib";

import {
  drawLegend,
  drawSvg,
  findAll,
  hasClass,
  isElement,
  legendExtent,
  parseCssColor,
  parseMarkup,
  PRINT_TOKENS,
  readLegend,
  textContent,
  toPdfColor,
  type MElement,
  type SvgDrawContext,
  type SvgPicture,
} from "@/lib/svgPdf";
import { dataUrlBytes, sniffImageType, svgPicture } from "@/lib/biReportImages";
import { SCHEDULED_DRAW } from "@/lib/biReportSchedule";

export { SCHEDULED_DRAW, scheduledDrawProblem, type ScheduledDraw } from "@/lib/biReportSchedule";

/** CSS pixels per PDF point: a chart is rendered as if printed at true size. */
export const PX_PER_PT = 4 / 3;

export type KpiPrint = {
  label: string;
  value: string;
  period: string | null;
  change:
    | {
        arrow: "▲" | "▼" | "■";
        main: string;
        detail: string | null;
        against: string;
        tone: "good" | "bad" | "flat";
      }
    | { none: string }
    | null;
  target: { text: string; tone: "good" | "bad"; share: number | null } | null;
  spark: { value: number }[] | null;
  noDates: string | null;
  ofRows: number | null;
};

export type ServerVisual =
  /** `bodyRows`: how many data rows a table really has, when its markup shows one page. */
  | { kind: "markup"; html: string; bodyRows?: number }
  | { kind: "kpi"; figures: KpiPrint }
  | { kind: "none"; reason: string };

/** Renders the block's visual at a size in CSS pixels. */
export type RenderVisual = (size: { width: number; height: number }) => Promise<ServerVisual>;

export type ChartDrawContext = SvgDrawContext & { ink: Color; muted: Color };

const GOOD = rgb(0.02, 0.59, 0.41);
const BAD = rgb(0.86, 0.15, 0.15);

type Box = { x: number; top: number; w: number; h: number };

function placeholder(ctx: ChartDrawContext, box: Box, text: string) {
  const size = 8.5;
  const s = ctx.encode(text);
  const w = ctx.regular.widthOfTextAtSize(s, size);
  ctx.page.drawRectangle({
    x: box.x,
    y: box.top - box.h,
    width: box.w,
    height: box.h,
    borderColor: rgb(0.8, 0.81, 0.84),
    borderWidth: 0.6,
    borderDashArray: [3, 3],
  });
  ctx.page.drawText(s, {
    x: box.x + Math.max(4, (box.w - w) / 2),
    y: box.top - box.h / 2 - size * 0.35,
    size,
    font: ctx.regular,
    color: ctx.muted,
  });
}

/** Whether `target` sits inside an element `pred` accepts. */
function within(root: MElement, target: MElement, pred: (e: MElement) => boolean): boolean {
  const path: MElement[] = [];
  const dfs = (el: MElement): boolean => {
    for (const c of el.children) {
      if (!isElement(c)) continue;
      path.push(c);
      if (c === target || dfs(c)) return true;
      path.pop();
    }
    return false;
  };
  dfs(root);
  return path.slice(0, -1).some(pred);
}

const isChrome = (e: MElement) =>
  (e.attrs.class ?? "").includes("recharts-tooltip") ||
  hasClass(e, "recharts-legend-wrapper") ||
  hasClass(e, "sr-only");

/** The one SVG that is the chart, or null when there is not exactly one. */
export function mainSvg(root: MElement): MElement | null {
  const svgs = findAll(root, (e) => e.tag === "svg").filter(
    (s) => !within(root, s, (p) => p.tag === "svg" || p.tag === "li" || isChrome(p)),
  );
  return svgs.length === 1 ? svgs[0] : null;
}

/** Captions a card prints as paragraphs around a chart, in order. */
export function captionLines(root: MElement): string[] {
  const out: string[] = [];
  for (const p of findAll(root, (e) => e.tag === "p")) {
    if (within(root, p, (a) => a.tag === "svg" || isChrome(a))) continue;
    const t = textContent(p).replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The text of a narrative, without its icon. */
export function narrativeText(root: MElement): string {
  const strip = (el: MElement): string =>
    el.children
      .map((c) => {
        if (!isElement(c)) return c;
        if (c.tag === "svg" || isChrome(c)) return "";
        const inner = strip(c);
        return c.tag === "p" || c.tag === "div" || c.tag === "li" ? ` ${inner} ` : inner;
      })
      .join("");
  return strip(root).replace(/\s+/g, " ").trim();
}

/** Draw a markup visual (svg / table / text) or a KPI into the box. */
export async function drawServerVisual(
  ctx: ChartDrawContext,
  chartType: string,
  box: Box,
  render: RenderVisual,
  wrap: (text: string, size: number, width: number) => string[],
): Promise<void> {
  const mode = SCHEDULED_DRAW[chartType];
  if (!mode) {
    placeholder(ctx, box, `This visual is drawn in the app only (${chartType}).`);
    return;
  }
  const px = (pt: number) => Math.max(40, Math.round(pt * PX_PER_PT));
  const first = await render({ width: px(box.w), height: px(box.h) });
  if (first.kind === "none") {
    placeholder(ctx, box, first.reason);
    return;
  }
  if (first.kind === "kpi") {
    drawKpi(ctx, first.figures, box);
    return;
  }
  const root = parseMarkup(first.html);
  if (mode === "text") {
    drawWrapped(ctx, narrativeText(root), box, wrap);
    return;
  }
  if (mode === "table") {
    const table = findAll(root, (e) => e.tag === "table")[0];
    if (!table) {
      placeholder(ctx, box, "This table could not be drawn.");
      return;
    }
    drawHtmlTable(ctx, table, box, { bodyRows: first.bodyRows });
    return;
  }

  // svg: legend and captions first, because they take room from the chart.
  const legend0 = readLegend(root);
  const legend = legend0 ? { ...legend0, fontSize: legend0.fontSize / PX_PER_PT } : null;
  const captions = captionLines(root);
  const capSize = 7.5;
  const capLines = captions.flatMap((c) => wrap(c, capSize, box.w));
  const capH = capLines.length ? capLines.length * (capSize + 3) + 3 : 0;
  let chartBox: Box = { ...box, h: box.h - capH };
  let strip: Box | null = null;
  if (legend) {
    const ext = legendExtent(legend, ctx.regular, ctx.encode, chartBox);
    if (legend.position === "top") {
      strip = { x: box.x, top: chartBox.top, w: box.w, h: ext };
      chartBox = { ...chartBox, top: chartBox.top - ext, h: chartBox.h - ext };
    } else if (legend.position === "bottom") {
      strip = { x: box.x, top: chartBox.top - (chartBox.h - ext), w: box.w, h: ext };
      chartBox = { ...chartBox, h: chartBox.h - ext };
    } else if (legend.position === "right") {
      strip = { x: box.x + box.w - ext, top: chartBox.top, w: ext, h: chartBox.h };
      chartBox = { ...chartBox, w: chartBox.w - ext };
    } else {
      strip = { x: box.x, top: chartBox.top, w: ext, h: chartBox.h };
      chartBox = { ...chartBox, x: box.x + ext, w: chartBox.w - ext };
    }
  }
  let svgRoot = root;
  if (legend || capH > 0) {
    // Draw the chart again at the size left for it, as the card would after
    // measuring its legend.
    const again = await render({ width: px(chartBox.w), height: px(chartBox.h) });
    if (again.kind === "markup") svgRoot = parseMarkup(again.html);
  }
  const svg = mainSvg(svgRoot);
  if (!svg) {
    placeholder(ctx, box, "This visual could not be drawn here.");
    return;
  }
  const pictures = await embedPictures(ctx, svg);
  drawSvg(pictures.size ? { ...ctx, pictures } : ctx, svg, chartBox);
  if (legend && strip) drawLegend(ctx, legend, strip);
  let y = box.top - (box.h - capH) - 3;
  for (const line of capLines) {
    ctx.page.drawText(line, {
      x: box.x,
      y: y - capSize,
      size: capSize,
      font: ctx.regular,
      color: ctx.muted,
    });
    y -= capSize + 3;
  }
}

/**
 * The pictures a drawing's <image> elements show (R511: a card's photo and
 * logos, a map's street tiles), embedded in the PDF once each. Only data URLs:
 * the server fetched any address before laying the drawing out. A picture
 * that is not a PNG, a JPEG or an SVG with a size is left out.
 */
async function embedPictures(
  ctx: ChartDrawContext,
  svg: MElement,
): Promise<Map<string, SvgPicture>> {
  const out = new Map<string, SvgPicture>();
  for (const el of findAll(svg, (e) => e.tag === "image")) {
    const href = el.attrs.href ?? el.attrs["xlink:href"];
    if (!href || out.has(href) || !href.startsWith("data:")) continue;
    const bytes = dataUrlBytes(href);
    const type = bytes ? sniffImageType(bytes) : null;
    if (!bytes || !type) continue;
    try {
      if (type === "svg") {
        const pic = svgPicture(bytes);
        if (pic) out.set(href, { kind: "svg", svg: pic.svg, w: pic.w, h: pic.h });
      } else {
        const image =
          type === "png" ? await ctx.page.doc.embedPng(bytes) : await ctx.page.doc.embedJpg(bytes);
        out.set(href, { kind: "raster", image, w: image.width, h: image.height });
      }
    } catch {
      // A picture that will not decode is left out, like one that would not load.
    }
  }
  return out;
}

function drawWrapped(
  ctx: ChartDrawContext,
  text: string,
  box: Box,
  wrap: (text: string, size: number, width: number) => string[],
) {
  const size = 10;
  const leading = size + 4;
  const lines = wrap(text, size, box.w);
  const fit = Math.max(1, Math.floor(box.h / leading));
  let y = box.top;
  lines.slice(0, fit).forEach((line, i) => {
    const last = i === fit - 1 && lines.length > fit;
    ctx.page.drawText(last ? `${line.replace(/.{0,2}$/, "")}…` : line, {
      x: box.x,
      y: y - size,
      size,
      font: ctx.regular,
      color: ctx.ink,
    });
    y -= leading;
  });
}

function triangle(ctx: ChartDrawContext, x: number, midY: number, up: boolean, color: Color) {
  const d = up ? "M0,4 L3.5,-2.5 L7,4 Z" : "M0,-2.5 L3.5,4 L7,-2.5 Z";
  ctx.page.drawSvgPath(d, { x, y: midY, color, scale: 1 });
}

/** The KPI tile's figures, centred in the box. */
export function drawKpi(ctx: ChartDrawContext, f: KpiPrint, box: Box) {
  type Line = { h: number; draw: (top: number) => void };
  const lines: Line[] = [];
  const centred = (text: string, size: number, font = ctx.regular, color = ctx.ink): Line => ({
    h: size + 4,
    draw: (top) => {
      const s = ctx.encode(text);
      const w = font.widthOfTextAtSize(s, size);
      ctx.page.drawText(s, {
        x: box.x + (box.w - w) / 2,
        y: top - size,
        size,
        font,
        color,
      });
    },
  });
  lines.push(centred(f.label.toUpperCase(), 7.5, ctx.regular, ctx.muted));
  const valueSize = Math.min(30, Math.max(14, box.h / 4));
  lines.push(centred(f.value, valueSize, ctx.bold));
  if (f.period) lines.push(centred(f.period, 8, ctx.regular, ctx.muted));
  if (f.change) {
    if ("none" in f.change) {
      lines.push(centred(f.change.none, 7.5, ctx.regular, ctx.muted));
    } else {
      const c = f.change;
      const tone = c.tone === "good" ? GOOD : c.tone === "bad" ? BAD : ctx.muted;
      const main = ctx.encode([c.main, c.detail].filter(Boolean).join(" "));
      const against = ctx.encode(` ${c.against}`);
      const size = 8.5;
      lines.push({
        h: size + 5,
        draw: (top) => {
          const wMain = ctx.bold.widthOfTextAtSize(main, size);
          const wAgainst = ctx.regular.widthOfTextAtSize(against, size);
          const mark = c.arrow === "■" ? 0 : 10;
          let x = box.x + (box.w - (mark + wMain + wAgainst)) / 2;
          if (mark) {
            triangle(ctx, x, top - size / 2 - 1, c.arrow === "▲", tone);
            x += mark;
          }
          ctx.page.drawText(main, { x, y: top - size, size, font: ctx.bold, color: tone });
          ctx.page.drawText(against, {
            x: x + wMain,
            y: top - size,
            size,
            font: ctx.regular,
            color: ctx.muted,
          });
        },
      });
    }
  }
  if (f.target) {
    const t = f.target;
    lines.push(
      centred(
        t.text.replace(/^[▲▼]\s*/, t.tone === "good" ? "+" : "-"),
        8,
        ctx.regular,
        t.tone === "good" ? GOOD : BAD,
      ),
    );
    if (t.share !== null) {
      const share = t.share;
      lines.push({
        h: 8,
        draw: (top) => {
          const w = box.w * 0.7;
          const x = box.x + (box.w - w) / 2;
          const muted = parseCssColor(PRINT_TOKENS.muted)!;
          const primary = parseCssColor(PRINT_TOKENS.primary)!;
          ctx.page.drawRectangle({ x, y: top - 5, width: w, height: 3, color: toPdfColor(muted) });
          ctx.page.drawRectangle({
            x,
            y: top - 5,
            width: w * share,
            height: 3,
            color: toPdfColor(primary),
          });
        },
      });
    }
  }
  if (f.spark && f.spark.length >= 2) {
    const pts = f.spark.map((p) => p.value).filter(Number.isFinite);
    if (pts.length >= 2) {
      const h = Math.min(28, Math.max(12, box.h * 0.22));
      lines.push({
        h: h + 4,
        draw: (top) => {
          const w = box.w * 0.8;
          const x0 = box.x + (box.w - w) / 2;
          const lo = Math.min(...pts);
          const hi = Math.max(...pts);
          const span = hi - lo || 1;
          const d = pts
            .map((v, i) => {
              const x = (i / (pts.length - 1)) * w;
              const y = ((hi - v) / span) * h;
              return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(" ");
          ctx.page.drawSvgPath(d, {
            x: x0,
            y: top - 2,
            scale: 1,
            borderColor: toPdfColor(parseCssColor(PRINT_TOKENS.primary)!),
            borderWidth: 1.2,
          });
        },
      });
    }
  }
  if (f.noDates) lines.push(centred(f.noDates, 7, ctx.regular, ctx.muted));
  if (f.ofRows !== null) lines.push(centred(`1 of ${f.ofRows} rows`, 7, ctx.regular, ctx.muted));

  const total = lines.reduce((t, l) => t + l.h, 0);
  let top = box.top - Math.max(0, (box.h - total) / 2);
  for (const l of lines) {
    if (top - l.h < box.top - box.h - 0.5) break;
    l.draw(top);
    top -= l.h;
  }
}

type Cell = {
  text: string;
  span: number;
  head: boolean;
  /** A totals row (tfoot): bold, numbers still right-aligned. */
  foot: boolean;
  bg: ReturnType<typeof parseCssColor>;
};

const BACKGROUND = /background(?:-color)?\s*:\s*([^;]+)/i;

function cellsOf(tr: MElement, foot = false): Cell[] {
  // A whole-row rule tints the <tr> (R498), not each cell.
  const rowBg = BACKGROUND.exec(tr.attrs.style ?? "");
  return tr.children.filter(isElement).flatMap((c) => {
    if (c.tag !== "td" && c.tag !== "th") return [];
    const bgm = BACKGROUND.exec(c.attrs.style ?? "") ?? rowBg;
    const cls = c.attrs.class ?? "";
    return [
      {
        text: textContent(c).replace(/\s+/g, " ").trim(),
        span: Math.max(1, Number(c.attrs.colspan ?? c.attrs.colSpan ?? 1) || 1),
        head: foot || c.tag === "th" || /font-(semibold|bold)/.test(cls),
        foot,
        bg: bgm ? parseCssColor(bgm[1]) : null,
      },
    ];
  });
}

const NUMBERISH = /^[\s(+\-−$€£¥]*[\d.,]+\s*[%kKmMbB)]*$/;
/** The smallest a table's numbers are set before a cell is left to its colour. */
const MIN_NUMBER_SIZE = 4.5;
/** Side padding of a number set smaller to fit. */
const NUMBER_PAD = 1;

/**
 * An HTML table (the heatmap, the pivot, a data table) as a grid that fits
 * the box. When rows have to go, the header and the totals row stay, and the
 * line in between says how many were left out: of `bodyRows` when the caller
 * knows the real count (a data table renders one page of 50 on screen).
 */
export function drawHtmlTable(
  ctx: ChartDrawContext,
  table: MElement,
  box: Box,
  opts: { bodyRows?: number } = {},
) {
  const footTrs = new Set(
    findAll(table, (e) => e.tag === "tfoot").flatMap((f) => findAll(f, (e) => e.tag === "tr")),
  );
  const headTrs = new Set(
    findAll(table, (e) => e.tag === "thead").flatMap((h) => findAll(h, (e) => e.tag === "tr")),
  );
  const parsed = findAll(table, (e) => e.tag === "tr")
    .map((tr) => ({ tr, cells: cellsOf(tr, footTrs.has(tr)) }))
    .filter((r) => r.cells.length > 0);
  const all = parsed.map((r) => r.cells);
  if (all.length === 0) {
    placeholder(ctx, box, "This table has no rows.");
    return;
  }
  const headRows = parsed.filter((r) => headTrs.has(r.tr)).map((r) => r.cells);
  const footRows = parsed.filter((r) => footTrs.has(r.tr)).map((r) => r.cells);
  const bodyRows = parsed
    .filter((r) => !headTrs.has(r.tr) && !footTrs.has(r.tr))
    .map((r) => r.cells);
  const rows = all;
  const size = 7;
  const rowH = 11;
  const pad = 3;
  const ncols = Math.max(...rows.map((r) => r.reduce((t, c) => t + c.span, 0)));
  const natural = new Array<number>(ncols).fill(18);
  for (const r of rows) {
    let col = 0;
    for (const c of r) {
      if (c.span === 1 && col < ncols) {
        const font = c.head ? ctx.bold : ctx.regular;
        const w = font.widthOfTextAtSize(ctx.encode(c.text), size) + pad * 2;
        natural[col] = Math.max(natural[col], Math.min(w, 160));
      }
      col += c.span;
    }
  }
  const total = natural.reduce((a, b) => a + b, 0);
  const k = total > box.w ? box.w / total : 1;
  const widths = natural.map((w) => w * k);
  // A number is never cut short (R511): cut to fit, a lap heatmap printed
  // "1." for 1.5 and "-1.0" for -1.09, other values than the cells held.
  // Numbers that do not fit are set smaller instead, one size for the whole
  // table, down to MIN_NUMBER_SIZE; one that still does not fit is left to its
  // cell's colour, as a dense heatmap is on screen. Words take an ellipsis.
  // The narrower padding comes first: on 8080 "-1.09" fitted a heatmap cell at
  // full size once the padding was 1, and was left blank while it was 3.
  let numberSize = size;
  let tight = false;
  for (const r of rows) {
    let col = 0;
    for (const c of r) {
      const w = widths.slice(col, col + c.span).reduce((a, b) => a + b, 0);
      if (NUMBERISH.test(c.text)) {
        const font = c.head ? ctx.bold : ctx.regular;
        const perPoint = font.widthOfTextAtSize(ctx.encode(c.text), 1);
        if (perPoint * size > w - pad * 2) {
          tight = true;
          numberSize = Math.min(
            numberSize,
            Math.max(MIN_NUMBER_SIZE, (w - NUMBER_PAD * 2) / perPoint),
          );
        }
      }
      col += c.span;
    }
  }
  const numberPad = tight ? NUMBER_PAD : pad;
  const ellipsis = ctx.encode("…");
  const fit = Math.max(1, Math.floor(box.h / rowH));
  const totalBody = Math.max(bodyRows.length, opts.bodyRows ?? 0);
  let shown: Cell[][];
  let more = 0;
  let tail: Cell[][] = [];
  if (rows.length <= fit && totalBody <= bodyRows.length) {
    shown = rows;
  } else {
    // Header and totals stay; one line says what is missing.
    const room = Math.max(0, fit - headRows.length - footRows.length - 1);
    const keep = bodyRows.slice(0, room);
    shown = [...headRows, ...keep];
    more = totalBody - keep.length;
    tail = footRows;
  }
  const border = toPdfColor(parseCssColor(PRINT_TOKENS.border)!);
  let top = box.top;
  const drawRow = (r: Cell[]) => {
    let x = box.x;
    let col = 0;
    for (const c of r) {
      const w = widths.slice(col, col + c.span).reduce((a, b) => a + b, 0);
      if (c.bg && c.bg.a > 0.01) {
        ctx.page.drawRectangle({
          x,
          y: top - rowH,
          width: w,
          height: rowH,
          color: toPdfColor(c.bg),
          opacity: c.bg.a,
        });
      }
      const font = c.head ? ctx.bold : ctx.regular;
      const numeric = NUMBERISH.test(c.text);
      const sz = numeric ? numberSize : size;
      const p = numeric ? numberPad : pad;
      const room = w - p * 2;
      let s = ctx.encode(c.text);
      if (font.widthOfTextAtSize(s, sz) > room) {
        if (numeric || font.widthOfTextAtSize(ellipsis, sz) > room) {
          s = "";
        } else {
          while (s.length > 0 && font.widthOfTextAtSize(`${s}${ellipsis}`, sz) > room) {
            s = s.slice(0, -1);
          }
          s = s ? `${s.trimEnd()}${ellipsis}` : "";
        }
      }
      const tw = font.widthOfTextAtSize(s, sz);
      // A total is bold but still a number, lined up with the column.
      const right = (!c.head || c.foot) && numeric;
      if (s) {
        ctx.page.drawText(s, {
          x: right ? x + w - p - tw : x + p,
          y: top - rowH + (rowH - sz) / 2 + 1,
          size: sz,
          font,
          color: ctx.ink,
        });
      }
      x += w;
      col += c.span;
    }
    ctx.page.drawLine({
      start: { x: box.x, y: top - rowH },
      end: { x: box.x + widths.reduce((a, b) => a + b, 0), y: top - rowH },
      thickness: 0.4,
      color: border,
    });
    top -= rowH;
  };
  for (const r of shown) drawRow(r);
  if (more > 0) {
    ctx.page.drawText(ctx.encode(`… ${more} more ${more === 1 ? "row" : "rows"} not shown`), {
      x: box.x + pad,
      y: top - rowH + (rowH - size) / 2 + 1,
      size,
      font: ctx.regular,
      color: ctx.muted,
    });
    top -= rowH;
  }
  for (const r of tail) drawRow(r);
}
