// A dashboard laid out as a PDF on the server (R510).
//
// Export PDF in the editor photographs the grid the browser drew. A dashboard
// sent on a schedule has no browser, so this lays the grid out itself: each
// page of the dashboard becomes landscape sheets, the cards keep their places
// and proportions on the 12-column grid, and every card is drawn as vectors
// and text by the same code a scheduled report uses (lib/biReportCharts).
//
// A sheet breaks only BETWEEN cards: at a grid row that no card crosses. A
// band of cards taller than a sheet, with nowhere clean to break, is shrunk
// onto one sheet rather than cut through a chart; and cards a little taller
// than a sheet (by up to a fifth) are shrunk onto it rather than leave a
// sheet nearly blank (MIN_SHEET_SCALE).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { encLine, wrapText } from "@/lib/biPdf";
import { drawServerVisual, type ChartDrawContext, type RenderVisual } from "@/lib/biReportCharts";
import {
  GRID_COLS,
  GRID_GAP_PX,
  GRID_ROW_PX,
  hexColor,
  TEXT_BASE_PX,
  TEXT_HEADING_SCALE,
  type BiLayoutItem,
  type BiTextStyle,
  type BiWidget,
} from "@/lib/biDashboards";
import { svgPicture } from "@/lib/biReportImages";
import type { ReportImageBytes } from "@/lib/biReportPdf";
import { scheduledDrawProblem } from "@/lib/biReportSchedule";
import { pageGeometry, partialRowsCaveat } from "@/lib/biReports";
import { drawSvg, parseCssColor, shapePath, toPdfColor, type Rgba } from "@/lib/svgPdf";

/** The canvas width the grid is printed as, in CSS pixels: a desktop screen. */
export const DASHBOARD_PRINT_WIDTH_PX = 1200;
/** Landscape sheet margin, in points. */
const MARGIN = 28;

const INK = rgb(0.1, 0.11, 0.14);
const MUTED = rgb(0.42, 0.44, 0.5);
const HAIRLINE = rgb(0.87, 0.885, 0.9);
const WHITE = rgb(1, 1, 1);

/** Text the standard fonts can draw, a typographic minus kept as a sign. */
const printable = (s: string) => encLine(s.replace(/−/g, "-"));

// ── Paging the grid (pure) ──────────────────────────────────────────────────

/** Grid rows [top, bottom) printed on one sheet, and the cards that start in them. */
export type GridBand = { top: number; bottom: number; items: BiLayoutItem[] };

/**
 * How far a sheet's rows may be shrunk, as a share of their height, to keep
 * cards on it rather than start another sheet. Without it a page a row or
 * two taller than a sheet prints as a nearly blank sheet and a full one.
 */
export const MIN_SHEET_SCALE = 0.8;

/**
 * Split a page's grid into bands, one per sheet, breaking only at a row no
 * card crosses. `rowsPerSheet` is how many rows a sheet holds (it may be
 * fractional); a band may run past it as long as it shrinks to no less than
 * `minScale` of its height (1, the default: never), and one card, or a run of
 * overlapping cards, taller than that is a band of its own, shrunk to fit.
 *
 * The breaks give the fewest sheets; of those, the one whose most-shrunk sheet
 * is shrunk least; then the least shrinking in all; then the fuller earlier
 * sheets. Empty rows between bands are skipped, so a gap in the grid is not a
 * blank sheet, and a band ends where its cards do.
 *
 * `gapShare` is the gap between rows as a share of a row and its gap, which
 * makes the shrink exact (a band of n rows has n - 1 gaps, not n).
 */
export function paginateGrid(
  layout: BiLayoutItem[],
  rowsPerSheet: number,
  opts: { minScale?: number; gapShare?: number } = {},
): GridBand[] {
  const items = layout
    .filter((it) => it.w > 0 && it.h > 0)
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (items.length === 0) return [];
  const cap = Math.max(1, rowsPerSheet);
  const minScale = Math.min(1, Math.max(0, opts.minScale ?? 1));
  const g = Math.min(0.99, Math.max(0, opts.gapShare ?? 0));
  const scaleOf = (rows: number) => (rows <= cap ? 1 : (cap - g) / (rows - g));

  // Blocks: the cards between two rows no card crosses. A sheet holds whole
  // blocks; sorted by row, a card starting above a block's bottom is in it.
  const blocks: GridBand[] = [];
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (last && it.y < last.bottom) {
      last.items.push(it);
      last.bottom = Math.max(last.bottom, it.y + it.h);
    } else {
      blocks.push({ top: it.y, bottom: it.y + it.h, items: [it] });
    }
  }

  // best[j]: the best way to print blocks 0..j-1.
  type Plan = { sheets: number; least: number; loss: number; from: number };
  const better = (a: Plan, b: Plan) =>
    a.sheets !== b.sheets
      ? a.sheets < b.sheets
      : Math.abs(a.least - b.least) > 1e-9
        ? a.least > b.least
        : a.loss < b.loss - 1e-9;
  const best: Plan[] = [{ sheets: 0, least: 1, loss: 0, from: -1 }];
  for (let j = 1; j <= blocks.length; j++) {
    let pick: Plan | null = null;
    // Shortest last band first, so a tie keeps the earlier sheets fuller.
    for (let i = j - 1; i >= 0; i--) {
      const s = scaleOf(blocks[j - 1].bottom - blocks[i].top);
      // One block always goes on a sheet; more only within the shrink allowed,
      // and adding earlier blocks only makes the band taller.
      if (i < j - 1 && s < minScale) break;
      const prev = best[i];
      const plan: Plan = {
        sheets: prev.sheets + 1,
        least: Math.min(prev.least, s),
        loss: prev.loss + (1 - s),
        from: i,
      };
      if (!pick || better(plan, pick)) pick = plan;
    }
    best[j] = pick!;
  }

  const bands: GridBand[] = [];
  for (let j = blocks.length; j > 0; j = best[j].from) {
    const run = blocks.slice(best[j].from, j);
    bands.unshift({
      top: run[0].top,
      bottom: run[run.length - 1].bottom,
      items: run.flatMap((b) => b.items),
    });
  }
  return bands;
}

/** Where the grid's cards fall on a sheet of a given content width, in points. */
export function gridGeometry(contentW: number) {
  const s = contentW / DASHBOARD_PRINT_WIDTH_PX;
  const gap = GRID_GAP_PX * s;
  const col = ((DASHBOARD_PRINT_WIDTH_PX - GRID_GAP_PX * (GRID_COLS - 1)) / GRID_COLS) * s;
  const row = GRID_ROW_PX * s;
  return {
    gap,
    col,
    row,
    /** A band's height in points. */
    bandHeight: (rows: number) => rows * (row + gap) - gap,
    x: (gx: number) => gx * (col + gap),
    w: (gw: number) => gw * col + (gw - 1) * gap,
    y: (gy: number) => gy * (row + gap),
    h: (gh: number) => gh * row + (gh - 1) * gap,
  };
}

// ── Text widgets (pure) ─────────────────────────────────────────────────────

export type TextBlock = {
  kind: "h1" | "h2" | "h3" | "p" | "li";
  text: string;
  /** The next line of the paragraph before it, after a single line break: no gap. */
  tight?: boolean;
};

/** Markdown's inline marks taken off, leaving the words. */
export function inlineText(s: string): string {
  // Escaped characters are set aside first, so \* is never read as a mark.
  const hide = (c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0));
  return (
    s
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c: string) => hide(c))
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
      // An underscore inside a word (order_id) is not emphasis.
      .replace(/(^|[^\w])_(\S(?:.*?\S)?)_(?!\w)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000))
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * A text widget's markdown as blocks to set: headings, paragraphs and list
 * items. Tables print as rows of cells; rules and code fences are dropped.
 *
 * `lineBreaks`: a single line break starts a new line, as it does in a styled
 * text widget on screen (BiTextBlock's hardBreaks), rather than running the
 * lines of a paragraph together.
 */
export function markdownBlocks(md: string, opts: { lineBreaks?: boolean } = {}): TextBlock[] {
  const out: TextBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length && opts.lineBreaks) {
      para.forEach((line, i) =>
        out.push({ kind: "p", text: inlineText(line), ...(i > 0 ? { tight: true } : {}) }),
      );
    } else if (para.length) {
      out.push({ kind: "p", text: inlineText(para.join(" ")) });
    }
    para = [];
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const n = h[1].length;
      out.push({ kind: n === 1 ? "h1" : n === 2 ? "h2" : "h3", text: inlineText(h[2]) });
      continue;
    }
    const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      out.push({ kind: "li", text: inlineText(li[1]) });
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      flush();
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => inlineText(c));
      out.push({ kind: "p", text: cells.join("   ") });
      continue;
    }
    para.push(line.replace(/^>\s?/, ""));
  }
  flush();
  return out.filter((b) => b.text);
}

const TEXT_SIZE: Record<NonNullable<BiTextStyle["size"]>, number> = {
  sm: 7.5,
  md: 8.5,
  lg: 10,
  xl: 11.5,
  "2xl": 13.5,
  "3xl": 16,
};

// ── The document ────────────────────────────────────────────────────────────

export type DashboardPrintPage = { name: string; widgets: BiWidget[]; layout: BiLayoutItem[] };

type Box = { x: number; top: number; w: number; h: number };

/**
 * Lay a dashboard out and return the PDF bytes. Pure layout: the caller has
 * run the queries, fetched the pictures and supplies the chart renderer.
 */
export async function buildDashboardPdfBytes(args: {
  name: string;
  pages: DashboardPrintPage[];
  /** What the header prints as the run's day and time (the schedule's zone). */
  clock: { date: string; time: string };
  /** The server's chart renderer, per widget. */
  renderVisual: (widget: BiWidget) => RenderVisual | null;
  /** Picture widgets' bytes, by widget id. */
  images?: Map<string, ReportImageBytes>;
  /** Widget id → why its query failed this run. Printed in its card. */
  failures?: Map<string, string>;
  /** What a Controls visual prints: the parameter values this copy ran with. */
  valuesLine?: string;
  paper?: "a4" | "letter";
}): Promise<Uint8Array> {
  const geo = pageGeometry({ size: args.paper ?? "a4", orientation: "landscape", margin: MARGIN });
  const left = (geo.w - geo.contentW) / 2;
  const grid = gridGeometry(geo.contentW);
  const contentH = geo.contentTop - geo.contentBottom;
  // Rows a sheet holds, fractionally: a band's last row has no gap below it.
  const rowsPerSheet = Math.max(1, (contentH + grid.gap) / (grid.row + grid.gap));
  const gapShare = grid.gap / (grid.row + grid.gap);
  // CSS px on screen to points on the sheet, as the grid is scaled. Declared
  // before the loop below: drawCard, hoisted, reads it from there.
  const pxToPt = geo.contentW / DASHBOARD_PRINT_WIDTH_PX;

  const pdf = await PDFDocument.create();
  pdf.setTitle(args.name);
  pdf.setCreator("AgentSwarms");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let italic: PDFFont | null = null;
  const italicFont = async () => (italic ??= await pdf.embedFont(StandardFonts.HelveticaOblique));

  const sheets: { page: PDFPage; label: string }[] = [];
  const many = args.pages.length > 1;
  const wrap = (font: PDFFont) => (text: string, size: number, width: number) =>
    wrapText(text, font, size, width);

  for (const dp of args.pages) {
    const label = many ? `${args.name} · ${dp.name}` : args.name;
    const byId = new Map(dp.widgets.map((w) => [w.id, w]));
    const placed = dp.layout.filter((it) => byId.has(it.i));
    const bands = paginateGrid(placed, rowsPerSheet, { minScale: MIN_SHEET_SCALE, gapShare });
    if (bands.length === 0) {
      const page = pdf.addPage([geo.w, geo.h]);
      sheets.push({ page, label });
      page.drawText(printable("This page has nothing on it."), {
        x: left,
        y: geo.contentTop - 14,
        size: 9,
        font: regular,
        color: MUTED,
      });
      continue;
    }
    for (const band of bands) {
      const page = pdf.addPage([geo.w, geo.h]);
      sheets.push({ page, label });
      const bandH = grid.bandHeight(band.bottom - band.top);
      // A band taller than the sheet is shrunk onto it; it keeps its width,
      // so text stays readable and only the height gives. The charts are
      // drawn afresh at the shrunk size, not squashed.
      const k = bandH > contentH ? contentH / bandH : 1;
      const ctx: ChartDrawContext = {
        page,
        regular,
        bold,
        encode: printable,
        ink: INK,
        muted: MUTED,
      };
      for (const it of band.items) {
        const w = byId.get(it.i)!;
        const box: Box = {
          x: left + grid.x(it.x),
          top: geo.contentTop - grid.y(it.y - band.top) * k,
          w: grid.w(Math.min(it.w, GRID_COLS - it.x)),
          h: grid.h(it.h) * k,
        };
        await drawCard(w, box, ctx, await textFont(w), k);
      }
    }
  }

  async function textFont(w: BiWidget): Promise<PDFFont> {
    return w.kind === "text" && w.textStyle?.italic ? await italicFont() : regular;
  }

  async function drawCard(
    w: BiWidget,
    box: Box,
    ctx: ChartDrawContext,
    bodyFont: PDFFont,
    /** How far this card's band was shrunk to fit its sheet. */
    k: number,
  ) {
    const page = ctx.page;
    const framed = w.theme?.card !== "none";
    if (framed) {
      const d = shapePath({
        tag: "rect",
        attrs: { x: "0", y: "0", width: String(box.w), height: String(box.h), rx: "5" },
        children: [],
      });
      if (d) {
        page.drawSvgPath(d, {
          x: box.x,
          y: box.top,
          color: WHITE,
          borderColor: HAIRLINE,
          borderWidth: 0.6,
        });
      }
    }
    const pad = framed ? 7 : 2;
    let inner: Box = { x: box.x + pad, top: box.top - pad, w: box.w - pad * 2, h: box.h - pad * 2 };
    const title = (w.title ?? "").trim();
    if (title && !w.theme?.hideTitle && w.kind !== "text") {
      const size = 8.5;
      page.drawText(fit(printable(title), bold, size, inner.w), {
        x: inner.x,
        y: inner.top - size,
        size,
        font: bold,
        color: colourOf(w.theme?.titleColor) ?? INK,
      });
      inner = { ...inner, top: inner.top - size - 6, h: inner.h - size - 6 };
    }
    if (inner.h < 8 || inner.w < 8) return;

    if (w.kind === "image") {
      const img = args.images?.get(w.id);
      const vector = img?.type === "svg" ? svgPicture(img.bytes) : null;
      if (!img || (img.type === "svg" && !vector)) {
        centred(ctx, inner, "This picture is shown in the app only.");
        return;
      }
      if (vector) {
        // Drawn as vectors, fitted and centred in the card as on screen.
        drawSvg(ctx, vector.svg, inner);
        return;
      }
      const embedded =
        img.type === "png" ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
      const s = Math.min(inner.w / embedded.width, inner.h / embedded.height);
      const iw = embedded.width * s;
      const ih = embedded.height * s;
      page.drawImage(embedded, {
        x: inner.x + (inner.w - iw) / 2,
        y: inner.top - ih - (inner.h - ih) / 2,
        width: iw,
        height: ih,
      });
      return;
    }

    if (w.kind === "text") {
      // A styled block breaks lines and sizes its type as the card does,
      // shrunk with its band; an unstyled one is set plainly.
      const styled = !!w.textStyle;
      drawText(
        ctx,
        markdownBlocks(w.text ?? "", { lineBreaks: styled }),
        inner,
        w.textStyle,
        bodyFont,
        styled ? pxToPt * k : undefined,
      );
      return;
    }

    const chart = w.chart;
    if (!chart) {
      centred(ctx, inner, "This widget has no visual yet.");
      return;
    }
    if (chart.type === "controls") {
      // The controls are for a viewer; a copy says what it was run with.
      drawText(
        ctx,
        [{ kind: "p", text: args.valuesLine ? `Run for ${args.valuesLine}` : "" }].filter(
          (b) => b.text,
        ) as TextBlock[],
        inner,
        undefined,
        regular,
      );
      return;
    }
    const failed = args.failures?.get(w.id);
    if (failed) {
      centred(ctx, inner, `Not refreshed: ${failed}`);
      return;
    }
    // Before "no data": an ontology map has no rows and is still not empty.
    if (scheduledDrawProblem(chart.type)) {
      centred(ctx, inner, `This visual is drawn in the app only (${chart.type}).`);
      return;
    }
    if (!(w.rows ?? []).length) {
      centred(ctx, inner, "No data");
      return;
    }
    const render = args.renderVisual(w);
    if (!render) {
      centred(ctx, inner, "This visual is drawn in the app only.");
      return;
    }
    const caveat = partialRowsCaveat(w);
    const capSize = 6.5;
    const visualBox = caveat ? { ...inner, h: inner.h - capSize - 4 } : inner;
    await drawServerVisual(ctx, chart.type, visualBox, render, wrap(regular));
    if (caveat) {
      page.drawText(fit(printable(caveat), regular, capSize, inner.w), {
        x: inner.x,
        y: inner.top - inner.h,
        size: capSize,
        font: regular,
        color: MUTED,
      });
    }
  }

  // The header and footer, once the number of sheets is known.
  sheets.forEach(({ page, label }, i) => {
    const top = geo.h - MARGIN;
    const stamp = printable(`${args.clock.date} ${args.clock.time}`);
    const stampW = regular.widthOfTextAtSize(stamp, 7.5);
    page.drawText(fit(printable(label), bold, 9, geo.contentW - stampW - 16), {
      x: left,
      y: top - 11,
      size: 9,
      font: bold,
      color: INK,
    });
    page.drawText(stamp, {
      x: left + geo.contentW - stampW,
      y: top - 10,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
    page.drawLine({
      start: { x: left, y: top - 16 },
      end: { x: left + geo.contentW, y: top - 16 },
      thickness: 0.5,
      color: HAIRLINE,
    });
    const foot = printable(`Page ${i + 1} of ${sheets.length}`);
    page.drawText(foot, {
      x: left + geo.contentW - regular.widthOfTextAtSize(foot, 7.5),
      y: MARGIN + 4,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
  });

  return pdf.save();
}

/** Truncate to a width, with an ellipsis. */
function fit(s: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(s, size) <= width) return s;
  let out = s;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out}…`;
}

/** A short muted sentence in the middle of a box, wrapped. */
function centred(ctx: ChartDrawContext, box: Box, text: string) {
  const size = 7.5;
  const lines = wrapText(text, ctx.regular, size, Math.max(20, box.w - 8)).slice(0, 4);
  const lead = size + 3;
  let y = box.top - (box.h - lines.length * lead) / 2 - size;
  for (const line of lines) {
    const w = ctx.regular.widthOfTextAtSize(line, size);
    ctx.page.drawText(line, {
      x: box.x + Math.max(0, (box.w - w) / 2),
      y,
      size,
      font: ctx.regular,
      color: ctx.muted,
    });
    y -= lead;
  }
}

/**
 * A text widget's blocks set in the box, cut with an ellipsis where they run
 * out. A styled one (`pxToPt` given) is set as the card sets it: its sizes
 * from the screen's, scaled with the grid, and centred down the card.
 */
function drawText(
  ctx: ChartDrawContext,
  blocks: TextBlock[],
  box: Box,
  style: BiTextStyle | undefined,
  bodyFont: PDFFont,
  pxToPt?: number,
) {
  const styled = !!style && pxToPt !== undefined;
  const base = styled
    ? (TEXT_BASE_PX[style.size ?? "md"] ?? TEXT_BASE_PX.md) * pxToPt
    : (TEXT_SIZE[style?.size ?? "md"] ?? TEXT_SIZE.md);
  const scale = styled ? TEXT_HEADING_SCALE : { h1: 1.5, h2: 1.3, h3: 1.15 };
  const bodyColour = colourOf(style?.color) ?? ctx.ink;
  const headColour = colourOf(style?.headingColor) ?? colourOf(style?.color) ?? ctx.ink;

  // Laid out first, so a styled block can be centred.
  type Line = { text: string; size: number; font: PDFFont; heading: boolean; top: number };
  const lines: Line[] = [];
  let y = 0;
  let gap = 0;
  for (const b of blocks) {
    const heading = b.kind === "h1" || b.kind === "h2" || b.kind === "h3";
    const size = heading ? base * scale[b.kind as "h1" | "h2" | "h3"] : base;
    if (lines.length && !b.tight) y += gap;
    const font = heading ? ctx.bold : bodyFont;
    const lead = size * (heading ? 1.2 : 1.35);
    for (const text of wrapText(b.kind === "li" ? `• ${b.text}` : b.text, font, size, box.w)) {
      lines.push({ text, size, font, heading, top: y });
      y += lead;
    }
    gap = size * 0.4;
  }
  const offset = styled && y < box.h ? (box.h - y) / 2 : 0;

  for (const l of lines) {
    const lead = l.size * (l.heading ? 1.2 : 1.35);
    if (offset + l.top + lead > box.h + 0.01) {
      if (offset + l.top + l.size <= box.h) {
        ctx.page.drawText("…", {
          x: box.x,
          y: box.top - offset - l.top - l.size,
          size: l.size,
          font: l.font,
          color: ctx.muted,
        });
      }
      return;
    }
    const w = l.font.widthOfTextAtSize(l.text, l.size);
    const x =
      style?.align === "center"
        ? box.x + (box.w - w) / 2
        : style?.align === "right"
          ? box.x + box.w - w
          : box.x;
    ctx.page.drawText(l.text, {
      x,
      y: box.top - offset - l.top - l.size,
      size: l.size,
      font: l.font,
      color: l.heading ? headColour : bodyColour,
    });
  }
}

/** The least contrast against white a widget's colour keeps on paper (WCAG, large text). */
const PAPER_MIN_CONTRAST = 3;

/**
 * A widget's #rrggbb colour as it prints: the PDF is white paper, so a colour
 * chosen for a dark canvas (white text, say) that would not read on white is
 * null, and the caller prints the standard ink instead.
 */
export function paperColour(hex: string | undefined): Rgba | null {
  const h = hexColor(hex);
  const c = h ? parseCssColor(h) : null;
  if (!c) return null;
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  return 1.05 / (lum + 0.05) >= PAPER_MIN_CONTRAST ? c : null;
}

function colourOf(hex: string | undefined) {
  const c = paperColour(hex);
  return c ? toPdfColor(c) : null;
}
