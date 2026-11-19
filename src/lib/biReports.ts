// Paginated reports: the print-layout half of BI.
//
// A dashboard is a grid you scroll and resize; it has no pages, and exporting
// one to PDF is a screenshot of that grid. A PAGINATED report is the opposite
// shape: a fixed page, a flow of blocks down it, and content that continues
// onto the next page when it runs out of room — the thing an invoice, a
// month-end pack or a regulatory return has to be, because somebody prints it
// and the page count matters.
//
// The two share everything below the layout. A chart block IS a `BiWidget`,
// so the same query, the same cached rows, the same `ChartSpec` and the same
// renderer serve both, and a widget lifted off a dashboard keeps working.
// What is new here is the geometry: page size, margins, a running header and
// footer, explicit breaks, and a table that repeats its header row every time
// it crosses a page — the one thing a screenshot of a scrolling grid can
// never do.

import type { BiWidget } from "@/lib/biDashboards";
import { hasRawDateValues, parseDateValue } from "@/lib/biChartMath";
import type { BarcodeFormat } from "@/lib/biBarcode";
import {
  paramValueLabel,
  parseParams,
  PARAM_NAME,
  type BiParamConfig,
  type BiParamValues,
} from "@/lib/biParams";

/** Page sizes in PDF points (72 per inch), portrait. */
export const PAGE_SIZES = {
  a4: { w: 595.28, h: 841.89, label: "A4" },
  letter: { w: 612, h: 792, label: "Letter" },
  legal: { w: 612, h: 1008, label: "Legal" },
  a3: { w: 841.89, h: 1190.55, label: "A3" },
} as const;

export type ReportPageSize = keyof typeof PAGE_SIZES;
export type ReportOrientation = "portrait" | "landscape";

export type ReportPageSetup = {
  size: ReportPageSize;
  orientation: ReportOrientation;
  /** Uniform margin in points. 36pt = half an inch. */
  margin: number;
  /**
   * The report's parameters (R508): an order number, a month, a region. Kept
   * with the page settings, the report's own settings object, so a report
   * gains them without a schema change. Blocks read them as {{name}} in their
   * SQL, text, header, footer and barcodes.
   */
  params?: BiParamConfig[];
};

export const DEFAULT_PAGE: ReportPageSetup = { size: "a4", orientation: "portrait", margin: 40 };

/** A running header or footer: three slots, each a token string. */
export type ReportBand = { left?: string; center?: string; right?: string };

export type ReportAlign = "left" | "center" | "right";

export type ReportBlock =
  | { id: string; kind: "heading"; text: string; level?: 1 | 2 | 3 }
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "spacer"; height: number }
  | { id: string; kind: "pagebreak" }
  /** A chart, drawn from a dashboard widget's own spec and rows. */
  | { id: string; kind: "chart"; widget: BiWidget; height?: number; ranWith?: BiParamValues }
  /**
   * A table that FLOWS. Where a dashboard table is a scrolling box, this one
   * continues onto the next page and repeats its header row when it does.
   */
  | {
      id: string;
      kind: "table";
      widget: BiWidget;
      /** Columns to show, in order. Empty = every column the query returned. */
      columns?: string[];
      /** Stop after this many rows. Absent = every row. */
      maxRows?: number;
      /** Tint alternate rows, the way a printed table usually is. */
      zebra?: boolean;
      /** The parameter values its rows were fetched with (R508). */
      ranWith?: BiParamValues;
    }
  /**
   * Label and value pairs from the FIRST row of a query (R508): the order
   * number, customer, date and total at the top of a purchase order.
   */
  | {
      id: string;
      kind: "fields";
      widget: BiWidget;
      /** Columns to show, in order. Empty = every column. */
      columns?: string[];
      /** A column's label as printed; unset prints the column name, tidied. */
      labels?: Record<string, string>;
      /** Pairs side by side across the page. */
      perRow?: 1 | 2 | 3;
      /** The parameter values its rows were fetched with. */
      ranWith?: BiParamValues;
    }
  /** A picture: a logo, a signature, a stamp (R508). */
  | {
      id: string;
      kind: "image";
      /** A data:image/png or data:image/jpeg URL, or an https address. */
      src: string;
      /** Height in points; the width follows the picture's proportions. */
      height: number;
      align?: ReportAlign;
      alt?: string;
    }
  /** A Code 128 or QR code of a value, usually a parameter (R508). */
  | {
      id: string;
      kind: "barcode";
      format: BarcodeFormat;
      /** Text with {{tokens}}: "{{order_id}}". */
      value: string;
      /** Height of the bars, or of the QR square, in points. */
      height: number;
      /** Print the value under a Code 128 barcode. */
      showText?: boolean;
      align?: ReportAlign;
    };

export type ReportBlockKind = ReportBlock["kind"];

export type BiReport = {
  id: string;
  name: string;
  description: string | null;
  page: ReportPageSetup;
  header: ReportBand;
  footer: ReportBand;
  blocks: ReportBlock[];
};

export const REPORT_NAME_MAX = 120;
export const MAX_BLOCKS = 200;

/** The page box and the area blocks may use, in points. */
export function pageGeometry(page: ReportPageSetup): {
  w: number;
  h: number;
  contentW: number;
  contentTop: number;
  contentBottom: number;
} {
  const base = PAGE_SIZES[page.size] ?? PAGE_SIZES.a4;
  const landscape = page.orientation === "landscape";
  const w = landscape ? base.h : base.w;
  const h = landscape ? base.w : base.h;
  const m = clampMargin(page.margin, Math.min(w, h));
  return {
    w,
    h,
    contentW: w - m * 2,
    // The bands sit inside the margin, so content stops short of them.
    contentTop: h - m - BAND_H,
    contentBottom: m + BAND_H,
  };
}

/** Height reserved for the running header and footer bands. */
export const BAND_H = 22;

/** A margin that cannot swallow the page. */
export function clampMargin(margin: number, shortSide: number): number {
  const max = Math.floor(shortSide / 2 - 60);
  if (!Number.isFinite(margin)) return DEFAULT_PAGE.margin;
  return Math.min(Math.max(Math.round(margin), 0), Math.max(12, max));
}

export type TokenContext = {
  page: number;
  pages: number;
  title: string;
  /** Rendered at export time so every page of one export agrees. */
  date: string;
  time: string;
};

const TOKEN_RE = /\{\{\s*(page|pages|title|date|time)\s*\}\}/g;

/**
 * The tokens a header or footer may use, for the editor's insert menu (R495).
 * Every name here is one TOKEN_RE replaces; a test holds the two together.
 */
export const REPORT_TOKENS: readonly { token: keyof TokenContext; detail: string }[] = [
  { token: "page", detail: "This page's number" },
  { token: "pages", detail: "How many pages the report has" },
  { token: "title", detail: "The report's title" },
  { token: "date", detail: "The day it was exported" },
  { token: "time", detail: "The time it was exported" },
];

/**
 * Replace the tokens a header or footer may use.
 *
 * `{{pages}}` is why the footer is stamped in a second pass: the total is not
 * known until the last block has been laid out, and a footer that says "of 3"
 * on a four-page report is worse than no footer at all.
 */
export function substituteTokens(s: string, ctx: TokenContext): string {
  return s.replace(TOKEN_RE, (_, key: string) => String(ctx[key as keyof TokenContext] ?? ""));
}

/** Whether a string uses any token at all — used to skip empty bands. */
export function hasTokens(s: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(s);
}

// ── Table pagination ────────────────────────────────────────────────────────
//
// The defining behaviour of a paginated report. A table taller than the space
// left is not clipped and not moved wholesale to the next page: it fills what
// is there, breaks, and CONTINUES — with its header row drawn again, because a
// column of numbers with no heading on page four is unreadable.

export type TableSlice = {
  /** Index of the first row on this page, into the table's own rows. */
  from: number;
  /** One past the last row on this page. */
  to: number;
  /** Every slice draws the header; only the first is not a continuation. */
  continued: boolean;
};

/**
 * Split `rowCount` rows across pages.
 *
 * `firstAvail` is the room left on the page the table starts on; `fullAvail`
 * is a whole page's worth. Both are heights in points, and `rowH` includes the
 * header the slice will redraw.
 */
export function sliceTable(args: {
  rowCount: number;
  rowH: number;
  headerH: number;
  firstAvail: number;
  fullAvail: number;
}): TableSlice[] {
  const { rowCount, rowH, headerH } = args;
  if (rowCount <= 0 || rowH <= 0) return [];
  const fit = (avail: number) => Math.floor((avail - headerH) / rowH);
  const slices: TableSlice[] = [];
  let at = 0;
  // A table needs its header plus at least one row to be worth starting; with
  // less room than that it begins on the next page instead of leaving a
  // stranded header behind.
  let room = fit(args.firstAvail) >= 1 ? fit(args.firstAvail) : 0;
  if (room === 0) room = Math.max(1, fit(args.fullAvail));
  while (at < rowCount) {
    const take = Math.max(1, Math.min(room, rowCount - at));
    slices.push({ from: at, to: at + take, continued: slices.length > 0 });
    at += take;
    room = Math.max(1, fit(args.fullAvail));
  }
  return slices;
}

/** The rows a table block will actually print, after its own cap. */
export function tableRows(
  block: Extract<ReportBlock, { kind: "table" }>,
): Record<string, unknown>[] {
  const rows = block.widget.rows ?? [];
  const cap = block.maxRows;
  return cap && cap > 0 ? rows.slice(0, cap) : rows;
}

/**
 * One table cell as the READER will see it.
 *
 * Shared by the preview and the PDF on purpose. The PDF formatted numbers and
 * the preview called `String(v)`, so a float that prints `410,379.26` on the
 * page a finance team receives read `410379.26499999943` on the page its
 * author approved — IEEE-754 noise, in a table whose whole reason for being
 * paginated is that somebody checks it row by row.
 *
 * Full digits with separators, not the compact "410.4k" the charts use: a
 * number in a table is there to be read exactly.
 */
/**
 * What a column holds, decided once from its values rather than per cell.
 *
 * A timestamp and a quantity are both `number` by the time they reach a cell,
 * so a per-cell decision cannot tell them apart — and printing an order date
 * as `1,640,995,200,000` is only a tidier version of printing it as
 * `1640995200000`.
 */
export type ReportColumnKind = "date" | "datetime" | "year" | "other";

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * The kind of each column of a table block.
 *
 * Note this is NOT the chart axis rule. An axis may relabel a whole column to
 * one grain — "2024-03" for every March — because an axis is a scale. A table
 * is a list of rows somebody checks one at a time, so every row keeps its own
 * value and only its PRESENTATION changes.
 */
export function reportColumnKinds(
  rows: Record<string, unknown>[],
  cols: string[],
): Record<string, ReportColumnKind> {
  const out: Record<string, ReportColumnKind> = {};
  for (const c of cols) {
    if (hasRawDateValues(rows, c)) {
      // Midnight everywhere means the time half is noise, not information.
      const withTime = rows.some((r) => {
        const d = parseDateValue(r[c]);
        return !!d && (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds());
      });
      out[c] = withTime ? "datetime" : "date";
      continue;
    }
    // A column of plain four-digit integers reads as years — the same reading
    // parseDateValue takes of 2026 — and a year is not a quantity, so it must
    // not be grouped into "2,026".
    const nums = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== "");
    const allYears =
      nums.length > 0 &&
      nums.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 9999);
    out[c] = allYears ? "year" : "other";
  }
  return out;
}

export function reportCellText(v: unknown, kind: ReportColumnKind = "other"): string {
  if (v === null || v === undefined) return "—";
  if (kind === "date" || kind === "datetime") {
    const d = parseDateValue(v);
    if (d) {
      const day = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
      return kind === "datetime" ? `${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : day;
    }
  }
  if (typeof v === "number") {
    if (kind === "year") return String(v);
    return Number.isInteger(v)
      ? v.toLocaleString()
      : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

/** The columns a table block prints: the ones it names, else the query's own. */
export function tableColumns(block: Extract<ReportBlock, { kind: "table" }>): string[] {
  if (block.columns?.length) return block.columns;
  if (block.widget.columns?.length) return block.widget.columns;
  const first = (block.widget.rows ?? [])[0];
  return first ? Object.keys(first) : [];
}

/** How tall a block is before any flowing, in points. */
export function blockHeight(block: ReportBlock, contentW: number): number {
  switch (block.kind) {
    case "heading":
      return block.level === 1 ? 30 : block.level === 3 ? 20 : 24;
    case "text": {
      // Rough, and deliberately so: the renderer measures with the real font
      // and re-flows. This is for the designer's preview and for ordering.
      const perLine = Math.max(1, Math.floor(contentW / 5.2));
      return Math.max(14, Math.ceil(block.text.length / perLine) * 14);
    }
    case "spacer":
      return Math.max(0, block.height);
    case "pagebreak":
      return 0;
    case "chart":
      return block.height ?? 200;
    case "table":
      return 18 + tableRows(block).length * 16;
    case "fields": {
      const n = fieldColumns(block).length;
      if (!(block.widget.rows ?? []).length || n === 0) return 20 + BLOCK_GAP;
      const title = block.widget.title ? 16 : 0;
      const caveat = fieldsCaveat(block) ? 12 : 0;
      return title + Math.ceil(n / (block.perRow ?? 2)) * FIELD_ROW_H + caveat + BLOCK_GAP;
    }
    case "image":
      return Math.max(1, block.height) + BLOCK_GAP;
    case "barcode":
      return (
        Math.max(1, block.height) +
        (block.format === "code128" && block.showText !== false ? BARCODE_TEXT_H : 0) +
        BLOCK_GAP
      );
  }
}

export const BLOCK_LABEL: Record<ReportBlockKind, string> = {
  heading: "Heading",
  text: "Text",
  spacer: "Spacer",
  pagebreak: "Page break",
  chart: "Chart",
  table: "Table",
  fields: "Fields",
  image: "Picture",
  barcode: "Barcode",
};

/** Why this report cannot be saved, or null. */
export function validateReport(r: {
  name: string;
  page: ReportPageSetup;
  blocks: ReportBlock[];
}): string | null {
  if (!r.name.trim()) return "Give the report a name";
  if (r.name.length > REPORT_NAME_MAX) return `A name is at most ${REPORT_NAME_MAX} characters`;
  if (!PAGE_SIZES[r.page.size]) return `Unknown page size ${r.page.size}`;
  if (r.blocks.length > MAX_BLOCKS) {
    return `A report holds at most ${MAX_BLOCKS} blocks; this one has ${r.blocks.length}`;
  }
  const seen = new Set<string>();
  for (const b of r.blocks) {
    if (!b.id) return "Every block needs an id";
    if (seen.has(b.id)) return `Two blocks share the id ${b.id}`;
    seen.add(b.id);
    if ((b.kind === "chart" || b.kind === "table" || b.kind === "fields") && !b.widget) {
      return `The ${BLOCK_LABEL[b.kind].toLowerCase()} block has no widget`;
    }
    if (b.kind === "image") {
      const why = imageSourceProblem(b.src);
      if (why) return `Picture: ${why}`;
      if (!(b.height >= 12 && b.height <= 600)) return "A picture is 12 to 600 points tall";
    }
    if (b.kind === "barcode") {
      if (b.format !== "code128" && b.format !== "qr") return "A barcode is Code 128 or QR";
      if (typeof b.value !== "string" || b.value.length > 600) {
        return "A barcode's value is at most 600 characters";
      }
      if (!(b.height >= 16 && b.height <= 300)) return "A barcode is 16 to 300 points tall";
    }
  }
  const params = r.page.params ?? [];
  if (params.length > MAX_REPORT_PARAMS) {
    return `A report takes at most ${MAX_REPORT_PARAMS} parameters`;
  }
  const names = new Set<string>();
  for (const p of params) {
    if (!PARAM_NAME.test(p.name)) {
      return `"${p.name}" is not a parameter name: lower-case letters, digits and _ , starting with a letter`;
    }
    if (RESERVED_TOKEN_NAMES.includes(p.name)) {
      return `{{${p.name}}} is filled by the report itself, so a parameter cannot use that name`;
    }
    if (names.has(p.name)) return `Two parameters are called ${p.name}`;
    names.add(p.name);
  }
  return null;
}

/** A block id that is stable enough to diff and unique enough to key on. */
export function newBlockId(): string {
  return `b_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Laying blocks onto pages ────────────────────────────────────────────────
//
// The designer's preview has to break where the PDF breaks, or it is a picture
// of a document nobody will receive. Both use the primitives above, in the
// same units (points), through this function — the preview passes an
// approximate text measurer and the renderer its real font metrics, and the
// page COUNT is pinned by a test that runs both.

/** One block, or one slice of a table, placed on a page. */
export type PlacedItem = {
  block: ReportBlock;
  height: number;
  /** Set for a table block: which rows this page shows. */
  slice?: TableSlice;
};

export type PlacedPage = { items: PlacedItem[] };

/**
 * Flow `blocks` down pages of `geo`.
 *
 * `measure` returns a block's height in points; it is injected because only
 * the caller knows how its text will be set.
 */
export function paginateBlocks(
  blocks: ReportBlock[],
  geo: ReturnType<typeof pageGeometry>,
  measure: (b: ReportBlock) => number,
): PlacedPage[] {
  const full = geo.contentTop - geo.contentBottom;
  const pages: PlacedPage[] = [{ items: [] }];
  let left = full;
  const push = (item: PlacedItem) => pages[pages.length - 1].items.push(item);
  const nextPage = () => {
    pages.push({ items: [] });
    left = full;
  };

  for (const block of blocks) {
    if (block.kind === "pagebreak") {
      // Only when something is already on this page; otherwise it is a blank
      // sheet that looks deliberate and is not.
      if (pages[pages.length - 1].items.length > 0) nextPage();
      continue;
    }
    if (block.kind === "table") {
      const rows = tableRows(block);
      if (!rows.length) {
        push({ block, height: 20 });
        left -= 20;
        continue;
      }
      const slices = sliceTable({
        rowCount: rows.length,
        rowH: TABLE_ROW_H,
        headerH: TABLE_HEADER_H,
        firstAvail: left,
        fullAvail: full,
      });
      slices.forEach((slice, i) => {
        if (i > 0) nextPage();
        const h = TABLE_HEADER_H + (slice.to - slice.from) * TABLE_ROW_H;
        push({ block, height: h, slice });
        left -= h;
      });
      continue;
    }
    const h = measure(block);
    if (h > left && pages[pages.length - 1].items.length > 0) nextPage();
    push({ block, height: h });
    left -= h;
  }
  return pages;
}

/** Row and header heights the renderer uses, shared so the preview agrees. */
export const TABLE_ROW_H = 14;
export const TABLE_HEADER_H = 16;

export const DEFAULT_FOOTER: ReportBand = {
  left: "{{title}}",
  right: "Page {{page}} of {{pages}}",
};

export const DEFAULT_HEADER: ReportBand = { right: "{{date}}" };

/**
 * The caveat a report block needs when its widget holds only part of the data.
 *
 * A dashboard card shows an amber "Partial" badge for this. A report does not:
 * it draws a title and a chart and nothing else, and the PDF it exports is the
 * artifact that gets circulated and read as final. So the same fact has to
 * survive the export, in words, because there is no badge to look at.
 *
 * Scoped to `truncated` — the snapshot hitting the row cap while the query had
 * more to give, which nothing on the page reveals. A table block's `maxRows` is
 * NOT included: that is the author deciding how many rows to print, visible to
 * them in the editor, and not a fact about the data being unavailable.
 */
export function partialRowsCaveat(widget: BiWidget | undefined): string | null {
  if (!widget?.truncated) return null;
  const n = widget.rows?.length ?? 0;
  return `Partial: ${n.toLocaleString()} row${n === 1 ? "" : "s"} shown — the query returned more.`;
}

// ── Parameters, fields, pictures and barcodes (R508) ────────────────────────

/** The tokens every report fills itself; a parameter may not take their names. */
export const RESERVED_TOKEN_NAMES: readonly string[] = REPORT_TOKENS.map((t) => t.token);

/** The most parameters one report takes. */
export const MAX_REPORT_PARAMS = 12;

/** The report's parameters, parsed as a report reads them (text allowed). */
export function reportParams(page: ReportPageSetup): BiParamConfig[] {
  return parseParams(page.params ?? [], { allowText: true }).filter(
    (p) => !RESERVED_TOKEN_NAMES.includes(p.name),
  );
}

const PARAM_TOKEN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

/**
 * Text with each {{name}} of a report parameter filled with the value it runs
 * with, as a reader would say it (an option's label, a date as written).
 * Other tokens are left for the export to fill ({{page}}) or as written.
 *
 * `raw` fills the value itself instead: what a barcode encodes. A scanner that
 * reads "Irene Walsh, London" where the order number should be finds nothing.
 */
export function fillParamTokens(
  s: string,
  params: BiParamConfig[],
  values: BiParamValues,
  opts: { raw?: boolean } = {},
): string {
  if (!params.length || !s.includes("{{")) return s;
  const byName = new Map(params.map((p) => [p.name, p]));
  return s.replace(PARAM_TOKEN, (whole, name: string) => {
    const p = byName.get(name.toLowerCase());
    if (!p) return whole;
    const v = values[p.name] ?? p.default;
    return opts.raw ? v : paramValueLabel(p, v);
  });
}

/** Height of one row of label and value pairs, in points. */
export const FIELD_ROW_H = 18;
/** Height of the value printed under a Code 128 barcode. */
export const BARCODE_TEXT_H = 12;
/** The gap under every block the renderer and the preview both leave. */
export const BLOCK_GAP = 6;

/** The columns a fields block prints: the ones it names, else the query's own. */
export function fieldColumns(block: Extract<ReportBlock, { kind: "fields" }>): string[] {
  if (block.columns?.length) return block.columns;
  if (block.widget.columns?.length) return block.widget.columns;
  const first = (block.widget.rows ?? [])[0];
  return first ? Object.keys(first) : [];
}

/** A field's label: the one the author wrote, else the column name tidied. */
export function fieldLabel(block: Extract<ReportBlock, { kind: "fields" }>, col: string): string {
  const own = block.labels?.[col]?.trim();
  if (own) return own;
  const words = col.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : col;
}

/** The pairs a fields block prints, from its first row. */
export function fieldPairs(
  block: Extract<ReportBlock, { kind: "fields" }>,
): { label: string; value: string }[] {
  const rows = block.widget.rows ?? [];
  if (!rows.length) return [];
  const cols = fieldColumns(block);
  const kinds = reportColumnKinds(rows.slice(0, 1), cols);
  return cols.map((c) => ({
    label: fieldLabel(block, c),
    value: reportCellText(rows[0][c], kinds[c]),
  }));
}

/**
 * What a fields block says when its query did not return exactly one row: no
 * row prints no values, and several print the first, which a reader takes for
 * the only one unless told.
 */
export function fieldsCaveat(block: Extract<ReportBlock, { kind: "fields" }>): string | null {
  const n = (block.widget.rows ?? []).length;
  if (n <= 1) return null;
  return `The first of ${n.toLocaleString()} rows: these fields show one record.`;
}

/**
 * A picture source a report may keep and print: PNG and JPEG, and SVG (R510),
 * which the PDF draws as shapes and text and never runs (lib/biReportImages).
 */
export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
/** About 1 MB of picture, as a data URL. */
export const IMAGE_MAX_CHARS = 1_400_000;

export function imageSourceProblem(src: string): string | null {
  if (!src) return "Choose a picture or give an https address";
  if (src.startsWith("data:")) {
    if (src.length > IMAGE_MAX_CHARS) return "A picture is at most about 1 MB";
    return IMAGE_DATA_URL.test(src) ? null : "A picture must be a PNG, a JPEG or an SVG";
  }
  return /^https:\/\/[^\s]+$/i.test(src) ? null : "A picture address must start with https://";
}
