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
};

export const DEFAULT_PAGE: ReportPageSetup = { size: "a4", orientation: "portrait", margin: 40 };

/** A running header or footer: three slots, each a token string. */
export type ReportBand = { left?: string; center?: string; right?: string };

export type ReportBlock =
  | { id: string; kind: "heading"; text: string; level?: 1 | 2 | 3 }
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "spacer"; height: number }
  | { id: string; kind: "pagebreak" }
  /** A chart, drawn from a dashboard widget's own spec and rows. */
  | { id: string; kind: "chart"; widget: BiWidget; height?: number }
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
  }
}

export const BLOCK_LABEL: Record<ReportBlockKind, string> = {
  heading: "Heading",
  text: "Text",
  spacer: "Spacer",
  pagebreak: "Page break",
  chart: "Chart",
  table: "Table",
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
    if ((b.kind === "chart" || b.kind === "table") && !b.widget) {
      return `The ${BLOCK_LABEL[b.kind].toLowerCase()} block has no widget`;
    }
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
