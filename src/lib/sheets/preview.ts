// A workbook's thumbnail on the Sheets page: the top-left corner of its first
// grid sheet as it reads on screen (values, not formulas; bold, fills and
// number colors kept), its column widths in proportion, and the charts on it.
// Built in the browser, where the values are computed, and kept with the
// workbook so the gallery never has to load a sheet to draw it.

import { z } from "zod";
import { cellKey } from "./a1";
import { parseMerges } from "./merge";
import type { CellInput, GridData } from "./engine";
import type { ChartType } from "./charts";

export const PREVIEW_ROWS = 8;
export const PREVIEW_COLS = 6;
const TEXT_MAX = 32;
const DEFAULT_COL_PX = 104;

export type PreviewCell = {
  /** The text as the cell shows it. */
  t: string;
  /** Right-aligned (a number), or centered. */
  a?: "r" | "c";
  b?: 1;
  /** Fill and text colors, "#rrggbb". */
  bg?: string;
  fg?: string;
};

export type WorkbookPreview = {
  v: 1;
  /** The sheet drawn. */
  sheet: string;
  /** Rows of cells, null for an empty one. */
  rows: (PreviewCell | null)[][];
  /** Each drawn column's share of the width, summing to 1. */
  widths: number[];
  /** The charts on that sheet, by type (at most three). */
  charts: ChartType[];
  /** How many charts that sheet has in all. */
  chartCount?: number;
};

const COLOR = /^#[0-9a-fA-F]{6}$/;
const cellSchema = z
  .object({
    t: z.string().max(TEXT_MAX),
    a: z.enum(["r", "c"]).optional(),
    b: z.literal(1).optional(),
    bg: z.string().regex(COLOR).optional(),
    fg: z.string().regex(COLOR).optional(),
  })
  .strict();

export const previewSchema = z
  .object({
    v: z.literal(1),
    sheet: z.string().max(100),
    rows: z.array(z.array(cellSchema.nullable()).max(PREVIEW_COLS)).max(PREVIEW_ROWS),
    widths: z.array(z.number().min(0).max(1)).max(PREVIEW_COLS),
    charts: z
      .array(
        z.enum(["column", "bar", "line", "area", "pie", "doughnut", "scatter", "combo", "radar"]),
      )
      .max(3),
    chartCount: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export type CellShown = {
  text: string;
  kind: "empty" | "number" | "text" | "bool" | "error";
  align: "left" | "right" | "center";
  color?: string;
  /** What a conditional format adds: a fill, a text color, bold. */
  cf?: { bg?: string; color?: string; b?: boolean };
};

const hex = (c: string | undefined) => (c && COLOR.test(c) ? c.toLowerCase() : undefined);

/**
 * The preview of one grid sheet. `shown(r, c)` is how the cell reads on
 * screen (the editor's cellView over the engine's value). Hidden rows and
 * columns are skipped, as they are on screen; a merged cell's text sits in its
 * top-left cell and the rest of it reads empty.
 */
export function buildPreview(
  sheet: string,
  grid: GridData,
  shown: (row: number, col: number) => CellShown,
): WorkbookPreview {
  const hiddenR = new Set(grid.hiddenRows ?? []);
  const hiddenC = new Set(grid.hiddenCols ?? []);
  for (const r of grid.filter?.hidden ?? []) hiddenR.add(r);
  const rowsAt: number[] = [];
  for (let r = 0; rowsAt.length < PREVIEW_ROWS && r < 10_000; r++)
    if (!hiddenR.has(r)) rowsAt.push(r);
  const colsAt: number[] = [];
  for (let c = 0; colsAt.length < PREVIEW_COLS && c < 1_000; c++)
    if (!hiddenC.has(c)) colsAt.push(c);
  // A merged cell reads as one: its text once, in the top-left cell; its fill
  // across all of it. Whatever lies under the rest of it is not shown.
  const covered = new Map<string, string>();
  for (const m of parseMerges(grid.merges))
    for (let r = m.r0; r <= m.r1; r++)
      for (let c = m.c0; c <= m.c1; c++)
        if (r !== m.r0 || c !== m.c0) covered.set(`${r},${c}`, cellKey(m.r0, m.c0));
  const rows = rowsAt.map((r) =>
    colsAt.map((c): PreviewCell | null => {
      const under = covered.get(`${r},${c}`);
      if (under !== undefined) {
        const fill = hex(grid.cells[under]?.s?.bg);
        return fill ? { t: "", bg: fill } : null;
      }
      const input: CellInput | undefined = grid.cells[`${r},${c}`];
      const view = shown(r, c);
      // A conditional format's fill and color win over the cell's own, as in Excel.
      const bg = hex(view.cf?.bg) ?? hex(input?.s?.bg);
      if (!view.text && !bg) return null;
      const cell: PreviewCell = { t: view.text.slice(0, TEXT_MAX) };
      if (view.align === "right") cell.a = "r";
      else if (view.align === "center") cell.a = "c";
      if (view.cf?.b ?? input?.s?.b) cell.b = 1;
      if (bg) cell.bg = bg;
      const fg = hex(view.cf?.color) ?? hex(view.color) ?? hex(input?.s?.color);
      if (fg) cell.fg = fg;
      return cell;
    }),
  );
  // Trailing empty rows and columns go, so a small table fills the thumbnail.
  let lastRow = rows.length - 1;
  while (lastRow >= 0 && rows[lastRow].every((c) => c === null)) lastRow--;
  let lastCol = colsAt.length - 1;
  while (lastCol >= 0 && rows.every((row) => row[lastCol] === null)) lastCol--;
  const keepCols = Math.max(lastCol + 1, Math.min(3, colsAt.length));
  const px = colsAt
    .slice(0, keepCols)
    .map((c) => Math.max(24, grid.colWidths?.[String(c)] ?? DEFAULT_COL_PX));
  const total = px.reduce((a, b) => a + b, 0) || 1;
  return {
    v: 1,
    sheet: sheet.slice(0, 100),
    rows: rows.slice(0, Math.max(lastRow + 1, 0)).map((row) => row.slice(0, keepCols)),
    widths: px.map((w) => Math.round((w / total) * 1000) / 1000),
    charts: (grid.charts ?? []).slice(0, 3).map((ch) => ch.type),
    ...(grid.charts?.length ? { chartCount: grid.charts.length } : {}),
  };
}

export type GallerySort = "edited" | "name" | "created";

export type GalleryItem = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  sheets: { name: string; kind: "grid" | "table" }[];
};

/**
 * The workbooks a search keeps, in the order asked for. Every word must be
 * found in the name, the description or a sheet's name (case and accents
 * ignored), so "q3 west" finds "Q3 revenue" with a sheet "West".
 */
export function searchWorkbooks<T extends GalleryItem>(
  list: T[],
  query: string,
  sort: GallerySort,
): T[] {
  const fold = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const kept = words.length
    ? list.filter((w) => {
        const hay = fold([w.name, w.description ?? "", ...w.sheets.map((s) => s.name)].join("\n"));
        return words.every((word) => hay.includes(word));
      })
    : [...list];
  const by: Record<GallerySort, (a: T, b: T) => number> = {
    edited: (a, b) => b.updated_at.localeCompare(a.updated_at),
    created: (a, b) => b.created_at.localeCompare(a.created_at),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  };
  return kept.sort(by[sort]);
}

/** Where the words of a search fall in a text, for highlighting: [start, end) pairs, merged. */
export function matchSpans(text: string, query: string): [number, number][] {
  const lower = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let i = lower.indexOf(word);
    while (i >= 0) {
      spans.push([i, i + word.length]);
      i = lower.indexOf(word, i + word.length);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}
