// Row heights that follow their content, as Excel's do until a height is
// set by hand: a row grows for wrapped text and for a larger font. And the
// bookkeeping that moves per-row and per-column settings when rows or
// columns are inserted or deleted.

import { parseKey } from "./a1";
import type { CellInput } from "./engine";
import { fontPx } from "./style";

/** Padding inside a cell, each side, at 100%. */
export const CELL_PAD_X = 6;

/**
 * How many lines text takes when wrapped to `width` pixels, breaking at
 * spaces and, for a word wider than the cell, inside the word.
 */
export function wrapLines(text: string, width: number, measure: (s: string) => number): number {
  if (width <= 0) return 1;
  let lines = 0;
  for (const para of text.split("\n")) {
    let line = 0;
    let count = 1;
    const space = measure(" ");
    for (const word of para.split(" ")) {
      const w = measure(word);
      if (line === 0) {
        if (w > width) {
          count += Math.ceil(w / width) - 1;
          line = w % width;
        } else line = w;
      } else if (line + space + w <= width) {
        line += space + w;
      } else {
        count++;
        if (w > width) {
          count += Math.ceil(w / width) - 1;
          line = w % width;
        } else line = w;
      }
    }
    lines += count;
  }
  return Math.max(1, lines);
}

export type AutoHeightInput = {
  cells: Record<string, CellInput>;
  /** Rows given a height by hand keep it. */
  manual: Record<string, number> | undefined;
  /** The default row height, at 100%. */
  base: number;
  colWidth: (col: number) => number;
  /** The text a cell shows. */
  text: (row: number, col: number) => string;
  /** Width of text in a CSS font, at 100%. */
  measure: (text: string, font: string) => number;
  /** Cells inside a merge (Excel does not grow a row for them). */
  merged?: (row: number, col: number) => boolean;
};

/** Rows that need more than the default height, and how much. */
export function autoRowHeights(opts: AutoHeightInput): Map<number, number> {
  const out = new Map<number, number>();
  for (const [key, cell] of Object.entries(opts.cells)) {
    const s = cell.s;
    if (!s || (!s.wrap && !(s.sz && s.sz > 11))) continue;
    const { row, col } = parseKey(key);
    if (opts.manual?.[String(row)] !== undefined) continue;
    if (opts.merged?.(row, col)) continue;
    const px = fontPx(s.sz);
    const lineH = Math.ceil(px * 1.3);
    let lines = 1;
    if (s.wrap) {
      const text = opts.text(row, col);
      if (!text) continue;
      const font = `${s.i ? "italic " : ""}${s.b ? "600 " : ""}${px}px ${s.font ?? "sans-serif"}`;
      lines = wrapLines(text, opts.colWidth(col) - CELL_PAD_X * 2, (t) => opts.measure(t, font));
    }
    const h = Math.max(opts.base, lines * lineH + 6);
    if (h > (out.get(row) ?? opts.base)) out.set(row, h);
  }
  return out;
}

/** Where index i goes when `count` are inserted (> 0) or deleted (< 0) at `at`; null if deleted. */
export function shiftIndex(i: number, at: number, count: number): number | null {
  if (count > 0) return i >= at ? i + count : i;
  const n = -count;
  if (i < at) return i;
  if (i >= at + n) return i - n;
  return null;
}

/** A per-index setting (row heights, column widths) after an insertion or deletion. */
export function shiftIndexRecord<T>(
  rec: Record<string, T> | undefined,
  at: number,
  count: number,
): Record<string, T> | undefined {
  if (!rec) return rec;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    const i = shiftIndex(Number(k), at, count);
    if (i !== null) out[String(i)] = v;
  }
  return out;
}

/** A list of indexes (hidden rows or columns) after an insertion or deletion. */
export function shiftIndexList(
  list: number[] | undefined,
  at: number,
  count: number,
): number[] | undefined {
  if (!list) return list;
  const out: number[] = [];
  for (const i of list) {
    const j = shiftIndex(i, at, count);
    if (j !== null) out.push(j);
  }
  return out;
}
