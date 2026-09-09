// Rendering a paginated report to PDF.
//
// Two things make this different from the dashboard export beside it. That one
// rasterises a grid of cards and fits the picture to a page; this one LAYS
// OUT — text is vector text you can select and search, blocks flow down the
// page, and a table that runs out of room continues on the next page with its
// header row drawn again. Charts are the only bitmap, because a chart is a
// picture either way.
//
// The header and footer are stamped in a SECOND pass over the finished
// document. `{{pages}}` cannot be known while laying out — the total is a
// consequence of the layout — and a footer that says "of 3" on a four-page
// report is worse than no footer.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { encLine, wrapText } from "@/lib/biPdf";
import {
  BAND_H,
  pageGeometry,
  sliceTable,
  substituteTokens,
  tableColumns,
  tableRows,
  TABLE_HEADER_H,
  TABLE_ROW_H,
  type BiReport,
  type ReportBlock,
  type TokenContext,
} from "@/lib/biReports";

const INK = rgb(0.1, 0.11, 0.14);
const MUTED = rgb(0.42, 0.44, 0.5);
const FAINT = rgb(0.62, 0.64, 0.68);
const HAIRLINE = rgb(0.87, 0.885, 0.9);
const ZEBRA = rgb(0.968, 0.973, 0.98);

/** Type sizes, in points, for each thing a report draws. */
const SIZE = { h1: 16, h2: 12.5, h3: 10.5, body: 9.5, table: 8.5, band: 7.5 } as const;
// Shared with the designer's preview, so the two cannot disagree about where
// a table breaks.
const ROW_H = TABLE_ROW_H;
const HEADER_ROW_H = TABLE_HEADER_H;

/** A chart already rasterised by the caller, keyed by block id. */
export type ChartBitmap = { dataUrl: string; wPx: number; hPx: number };

/**
 * Lay the report out and return the PDF bytes.
 *
 * Charts arrive pre-rasterised because only the browser can draw them; this
 * function is otherwise pure layout and is what the tests exercise.
 */
export async function buildReportPdfBytes(args: {
  report: BiReport;
  charts?: Map<string, ChartBitmap>;
  /** Fixed at call time so every page of one export agrees. */
  now?: Date;
}): Promise<Uint8Array> {
  const { report } = args;
  const geo = pageGeometry(report.page);
  const now = args.now ?? new Date();

  const pdf = await PDFDocument.create();
  pdf.setTitle(report.name);
  pdf.setCreator("AgentSwarms");
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);

  let page: PDFPage = pdf.addPage([geo.w, geo.h]);
  let y = geo.contentTop;

  const newPage = () => {
    page = pdf.addPage([geo.w, geo.h]);
    y = geo.contentTop;
  };
  /** Room for `h` points above the footer band, or a fresh page. */
  const ensure = (h: number) => {
    if (y - h < geo.contentBottom) newPage();
  };
  const margin = (geo.w - geo.contentW) / 2;
  const draw = (
    s: string,
    o: { x?: number; font?: PDFFont; size?: number; color?: typeof INK },
  ) => {
    page.drawText(encLine(s), {
      x: o.x ?? margin,
      y: y - (o.size ?? SIZE.body),
      size: o.size ?? SIZE.body,
      font: o.font ?? regular,
      color: o.color ?? INK,
    });
  };
  const flow = (s: string, o: { font?: PDFFont; size?: number; color?: typeof INK } = {}) => {
    const font = o.font ?? regular;
    const size = o.size ?? SIZE.body;
    const leading = size + 4.5;
    for (const line of wrapText(s, font, size, geo.contentW)) {
      ensure(leading);
      draw(line, { font, size, color: o.color });
      y -= leading;
    }
  };

  for (const block of report.blocks) {
    switch (block.kind) {
      case "pagebreak":
        // Only if something is already on this page: a break at the very top
        // would leave a blank sheet, which is a bug that looks like a choice.
        if (y < geo.contentTop) newPage();
        break;

      case "spacer":
        ensure(block.height);
        y -= block.height;
        break;

      case "heading": {
        const size = block.level === 1 ? SIZE.h1 : block.level === 3 ? SIZE.h3 : SIZE.h2;
        ensure(size + 12);
        draw(block.text, { font: bold, size });
        y -= size + 6;
        if (block.level !== 3) {
          page.drawLine({
            start: { x: margin, y },
            end: { x: margin + geo.contentW, y },
            thickness: 0.5,
            color: HAIRLINE,
          });
          y -= 8;
        }
        break;
      }

      case "text":
        flow(block.text);
        y -= 6;
        break;

      case "chart": {
        const bmp = args.charts?.get(block.id);
        const boxH = block.height ?? 200;
        if (!bmp) {
          // Say what is missing rather than leaving a gap the reader has to
          // interpret. A silent hole reads as "no data", which is a different
          // and untrue statement.
          ensure(24);
          draw(`[chart unavailable: ${block.widget.title || "untitled"}]`, {
            size: SIZE.body,
            color: MUTED,
          });
          y -= 20;
          break;
        }
        const scale = Math.min(geo.contentW / bmp.wPx, boxH / bmp.hPx);
        const w = bmp.wPx * scale;
        const h = bmp.hPx * scale;
        ensure(h + 18);
        if (block.widget.title) {
          draw(block.widget.title, { font: bold, size: SIZE.h3 });
          y -= SIZE.h3 + 5;
          ensure(h);
        }
        const png = await pdf.embedPng(bmp.dataUrl);
        page.drawImage(png, { x: margin, y: y - h, width: w, height: h });
        y -= h + 12;
        break;
      }

      case "table": {
        const rows = tableRows(block);
        const cols = tableColumns(block);
        if (!rows.length || !cols.length) {
          ensure(20);
          draw(`[no rows: ${block.widget.title || "untitled"}]`, {
            size: SIZE.body,
            color: MUTED,
          });
          y -= 18;
          break;
        }
        if (block.widget.title) {
          ensure(SIZE.h3 + 8 + HEADER_ROW_H + ROW_H);
          draw(block.widget.title, { font: bold, size: SIZE.h3 });
          y -= SIZE.h3 + 6;
        }
        const colW = geo.contentW / cols.length;
        const slices = sliceTable({
          rowCount: rows.length,
          rowH: ROW_H,
          headerH: HEADER_ROW_H,
          firstAvail: y - geo.contentBottom,
          fullAvail: geo.contentTop - geo.contentBottom,
        });
        for (const slice of slices) {
          if (slice.continued) newPage();
          // The header, every time. A column of numbers with no heading on
          // page four is unreadable, and this is the whole reason a paginated
          // report is not a screenshot of a scrolling table.
          page.drawRectangle({
            x: margin,
            y: y - HEADER_ROW_H + 4,
            width: geo.contentW,
            height: HEADER_ROW_H,
            color: rgb(0.955, 0.965, 0.975),
          });
          cols.forEach((c, i) => {
            page.drawText(fit(encLine(c), bold, SIZE.table, colW - 8), {
              x: margin + i * colW + 4,
              y: y - SIZE.table - 2,
              size: SIZE.table,
              font: bold,
              color: INK,
            });
          });
          y -= HEADER_ROW_H;
          for (let r = slice.from; r < slice.to; r++) {
            if (block.zebra !== false && (r - slice.from) % 2 === 1) {
              page.drawRectangle({
                x: margin,
                y: y - ROW_H + 3,
                width: geo.contentW,
                height: ROW_H,
                color: ZEBRA,
              });
            }
            cols.forEach((c, i) => {
              page.drawText(fit(cell(rows[r]?.[c]), regular, SIZE.table, colW - 8), {
                x: margin + i * colW + 4,
                y: y - SIZE.table - 1,
                size: SIZE.table,
                font: regular,
                color: INK,
              });
            });
            y -= ROW_H;
          }
          page.drawLine({
            start: { x: margin, y: y + 2 },
            end: { x: margin + geo.contentW, y: y + 2 },
            thickness: 0.5,
            color: HAIRLINE,
          });
        }
        y -= 12;
        break;
      }
    }
  }

  stampBands({ pdf, report, geo, regular, now });
  return pdf.save();
}

/** One cell's text: numbers grouped, nulls made visible rather than blank. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? v.toLocaleString()
      : v.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        });
  }
  return encLine(String(v));
}

/** Truncate to the column, with an ellipsis, so a long value cannot overrun its neighbour. */
function fit(s: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(s, size) <= width) return s;
  let out = s;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * The running header and footer, drawn once the page count is known.
 *
 * This is the second pass, and the reason for it is `{{pages}}`.
 */
function stampBands(args: {
  pdf: PDFDocument;
  report: BiReport;
  geo: ReturnType<typeof pageGeometry>;
  regular: PDFFont;
  now: Date;
}): void {
  const { pdf, report, geo, regular, now } = args;
  const pages = pdf.getPages();
  const margin = (geo.w - geo.contentW) / 2;
  const date = now.toLocaleDateString();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  pages.forEach((p, i) => {
    const ctx: TokenContext = {
      page: i + 1,
      pages: pages.length,
      title: report.name,
      date,
      time,
    };
    const band = (b: typeof report.header, yText: number, rule: number | null) => {
      const slots: [string | undefined, "left" | "center" | "right"][] = [
        [b.left, "left"],
        [b.center, "center"],
        [b.right, "right"],
      ];
      let drew = false;
      for (const [raw, align] of slots) {
        if (!raw?.trim()) continue;
        const s = encLine(substituteTokens(raw, ctx));
        if (!s) continue;
        const w = regular.widthOfTextAtSize(s, SIZE.band);
        const x =
          align === "left"
            ? margin
            : align === "center"
              ? margin + (geo.contentW - w) / 2
              : margin + geo.contentW - w;
        p.drawText(s, { x, y: yText, size: SIZE.band, font: regular, color: FAINT });
        drew = true;
      }
      if (drew && rule !== null) {
        p.drawLine({
          start: { x: margin, y: rule },
          end: { x: margin + geo.contentW, y: rule },
          thickness: 0.5,
          color: HAIRLINE,
        });
      }
    };
    band(report.header, geo.contentTop + BAND_H / 2, geo.contentTop + 4);
    band(report.footer, geo.contentBottom - BAND_H / 2, geo.contentBottom - 4);
  });
}
