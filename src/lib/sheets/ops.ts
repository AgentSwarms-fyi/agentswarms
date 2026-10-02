// Structural and bulk operations on grid sheets, as pure functions.
//
// Inserting or deleting rows and columns moves cells AND rewrites every
// formula in the workbook that points at them, the way Excel does: a
// reference below an insertion moves down (absolute or not, because the cell
// it named moved), a range that spans it grows, and a reference into deleted
// cells becomes #REF!. Fill repeats a pattern, continuing number series.

import {
  a1,
  cellKey,
  colLetters,
  MAX_COLS,
  MAX_ROWS,
  parseKey,
  parseRangeA1,
  rangeA1,
  type RangeAddr,
} from "./a1";
import type { CellInput, GridData } from "./engine";
import { lex, type RefPart, type Token } from "./formula/lexer";
import { renameSheetInFormula, shiftFormula } from "./formula/shift";
import { formatInserted } from "./insertFormats";
import { shiftIndex, shiftIndexList, shiftIndexRecord } from "./layout";
import { shiftMerges, shiftSpan } from "./merge";
import { seriesOf } from "./series";

export type Axis = "rows" | "cols";

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}

function partText(p: RefPart, kind: "cell" | "col" | "row"): string {
  const c = `${p.colAbs ? "$" : ""}${colLetters(p.col)}`;
  const r = `${p.rowAbs ? "$" : ""}${p.row + 1}`;
  return kind === "cell" ? c + r : kind === "col" ? c : r;
}

/**
 * Rewrite a formula for an insertion (count > 0) or deletion (count < 0) of
 * rows or columns at `at` on sheet `target`. `formulaSheet` is the sheet the
 * formula lives on (an unqualified reference points there).
 */
export function adjustFormula(
  input: string,
  formulaSheet: string,
  target: string,
  axis: Axis,
  at: number,
  count: number,
): string {
  if (!input.startsWith("=")) return input;
  let tokens: Token[];
  try {
    tokens = lex(input.slice(1));
  } catch {
    return input;
  }
  const body = input.slice(1);
  const t = target.toLowerCase();
  const key = axis === "rows" ? "row" : "col";

  const moveIndex = (i: number): number | null => {
    if (count > 0) return i >= at ? i + count : i;
    const n = -count;
    if (i < at) return i;
    if (i >= at + n) return i - n;
    return null; // deleted
  };
  const moveRange = (lo: number, hi: number): [number, number] | null => {
    if (count > 0) return [lo >= at ? lo + count : lo, hi >= at ? hi + count : hi];
    const n = -count;
    const nlo = lo < at ? lo : lo >= at + n ? lo - n : at;
    const nhi = hi < at ? hi : hi >= at + n ? hi - n : at - 1;
    return nhi < nlo ? null : [nlo, nhi];
  };

  let out = "";
  let last = 0;
  for (const tok of tokens) {
    if (tok.t !== "cell" && tok.t !== "range") continue;
    const sheet = (tok.sheet ?? formulaSheet).toLowerCase();
    if (sheet !== t) continue;
    const prefix = tok.sheet ? `${quoteSheet(tok.sheet)}!` : "";
    let text: string | null = null;
    if (tok.t === "cell") {
      const i = moveIndex(tok.ref[key]);
      if (i === null) text = "#REF!";
      else if (i >= (axis === "rows" ? MAX_ROWS : MAX_COLS)) text = "#REF!";
      else text = prefix + partText({ ...tok.ref, [key]: i }, "cell");
    } else {
      // A whole-column range is untouched by row changes, and vice versa.
      if ((axis === "rows" && tok.wholeCols) || (axis === "cols" && tok.wholeRows)) continue;
      const lo = Math.min(tok.start[key], tok.end[key]);
      const hi = Math.max(tok.start[key], tok.end[key]);
      const r = moveRange(lo, hi);
      if (!r) text = "#REF!";
      else {
        const kind = tok.wholeCols ? "col" : tok.wholeRows ? "row" : "cell";
        const a = { ...tok.start, [key]: r[0] };
        const b = { ...tok.end, [key]: r[1] };
        text = `${prefix}${partText(a, kind)}:${partText(b, kind)}`;
      }
    }
    out += body.slice(last, tok.s) + text;
    last = tok.e;
  }
  return `=${out}${body.slice(last)}`;
}

/** The most rows and columns a sheet keeps frozen, as its save allows (R151). */
export const MAX_FROZEN_ROWS = 100;
export const MAX_FROZEN_COLS = 50;

/**
 * What Freeze Panes writes: the rows and columns kept in view, within what a
 * sheet keeps. 0 leaves the setting out; `clamped` says it asked for more.
 */
export function freezePatch(
  rows: number,
  cols: number,
): { patch: Pick<GridData, "frozenRows" | "frozenCols">; clamped: boolean } {
  const r = Math.max(0, Math.min(MAX_FROZEN_ROWS, Math.trunc(rows)));
  const c = Math.max(0, Math.min(MAX_FROZEN_COLS, Math.trunc(cols)));
  return {
    patch: { frozenRows: r || undefined, frozenCols: c || undefined },
    clamped: r !== rows || c !== cols,
  };
}

/**
 * How many rows (or columns) stay frozen after `count` are inserted (or,
 * negative, deleted) at `at`: the ones above the line that are left, and the
 * line moves down past rows inserted above it.
 */
export function shiftFrozen(
  frozen: number | undefined,
  at: number,
  count: number,
  max: number,
): number | undefined {
  if (!frozen || at >= frozen) return frozen;
  if (count > 0) return Math.min(max, frozen + count);
  const gone = Math.min(frozen, at - count) - at;
  return frozen - gone || undefined;
}

/**
 * Move a sheet's cells for an insertion or deletion, and everything kept per
 * row or column with them: widths, heights, hidden rows and columns, merges.
 */
export function moveCells(grid: GridData, axis: Axis, at: number, count: number): GridData {
  const cells: Record<string, CellInput> = {};
  for (const [k, v] of Object.entries(grid.cells)) {
    const { row, col } = parseKey(k);
    const i = axis === "rows" ? row : col;
    let ni: number;
    if (count > 0) ni = i >= at ? i + count : i;
    else {
      const n = -count;
      if (i >= at && i < at + n) continue; // deleted
      ni = i >= at + n ? i - n : i;
    }
    const nr = axis === "rows" ? ni : row;
    const nc = axis === "cols" ? ni : col;
    if (nr >= MAX_ROWS || nc >= MAX_COLS) continue;
    cells[cellKey(nr, nc)] = v;
  }
  // New rows are formatted like the row above, new columns like the one to the left (R169).
  formatInserted(cells, axis === "rows", at, count);
  const next: GridData = { ...grid, cells };
  if (axis === "cols") {
    if (grid.colWidths) next.colWidths = shiftIndexRecord(grid.colWidths, at, count);
    if (grid.hiddenCols) next.hiddenCols = shiftIndexList(grid.hiddenCols, at, count);
  } else {
    if (grid.rowHeights) next.rowHeights = shiftIndexRecord(grid.rowHeights, at, count);
    if (grid.hiddenRows) next.hiddenRows = shiftIndexList(grid.hiddenRows, at, count);
  }
  if (grid.merges) next.merges = shiftMerges(grid.merges, axis, at, count);
  // The freeze line moves with the rows (or columns) above it, as Excel's (R151).
  if (axis === "rows" && grid.frozenRows)
    next.frozenRows = shiftFrozen(grid.frozenRows, at, count, MAX_FROZEN_ROWS);
  if (axis === "cols" && grid.frozenCols)
    next.frozenCols = shiftFrozen(grid.frozenCols, at, count, MAX_FROZEN_COLS);
  // Rules and the filter cover ranges; they move, grow and shrink as merges do.
  const moveRanges = (list: string[]) =>
    list.map((a1) => shiftRangeA1(a1, axis, at, count)).filter((x): x is string => x !== null);
  if (grid.cond) {
    next.cond = grid.cond
      .map((cf) => ({ ...cf, ranges: moveRanges(cf.ranges) }))
      .filter((cf) => cf.ranges.length);
  }
  if (grid.validations) {
    next.validations = grid.validations
      .map((v) => ({ ...v, ranges: moveRanges(v.ranges) }))
      .filter((v) => v.ranges.length);
  }
  if (grid.charts) {
    next.charts = grid.charts
      .map((ch) => ({ ...ch, range: shiftRangeA1(ch.range, axis, at, count) }))
      .filter((ch): ch is typeof ch & { range: string } => ch.range !== null);
  }
  if (grid.filter) {
    const range = shiftRangeA1(grid.filter.range, axis, at, count);
    if (!range) next.filter = undefined;
    else {
      // Column filters are kept by offset; a column deleted inside the range drops its own.
      const f = { ...grid.filter, range };
      if (axis === "rows") f.hidden = shiftIndexList(grid.filter.hidden, at, count);
      else {
        const r0 = parseRangeA1(grid.filter.range)!.c0;
        const cols: typeof f.cols = {};
        for (const [k, v] of Object.entries(grid.filter.cols)) {
          const c = shiftIndex(r0 + Number(k), at, count);
          const nr0 = parseRangeA1(range)!.c0;
          if (c !== null) cols[String(c - nr0)] = v;
        }
        f.cols = cols;
      }
      next.filter = f;
    }
  }
  return next;
}

/**
 * The formulas inside a sheet's rules (conditional formats, validations)
 * rewritten for an insertion or deletion on `target`, as cell formulas are.
 * Returns the same object when nothing changed.
 */
export function adjustRuleFormulas(
  grid: GridData,
  formulaSheet: string,
  target: string,
  axis: Axis,
  at: number,
  count: number,
): GridData {
  return mapRuleFormulas(grid, (f) => adjustFormula(f, formulaSheet, target, axis, at, count));
}

/**
 * A sheet's rule formulas (conditional formats, validations) passed through
 * `fn`, as its cell formulas are. Returns the same object when none changed.
 */
export function mapRuleFormulas(grid: GridData, fn: (formula: string) => string): GridData {
  let changed = false;
  const adj = (text: string): string => {
    if (!text.trim().startsWith("=")) return text;
    const next = fn(text.trim());
    if (next !== text.trim()) changed = true;
    return next === text.trim() ? text : next;
  };
  const cond = grid.cond?.map((cf) => {
    const r = cf.rule;
    if (r.kind === "cell")
      return { ...cf, rule: { ...r, a: adj(r.a), ...(r.b !== undefined ? { b: adj(r.b) } : {}) } };
    if (r.kind === "formula") return { ...cf, rule: { ...r, formula: adj(r.formula) } };
    return cf;
  });
  const validations = grid.validations?.map((v) => {
    const r = v.rule;
    if (r.kind === "list")
      return r.source !== undefined ? { ...v, rule: { ...r, source: adj(r.source) } } : v;
    if (r.kind === "custom") return { ...v, rule: { ...r, formula: adj(r.formula) } };
    return { ...v, rule: { ...r, a: adj(r.a), ...(r.b !== undefined ? { b: adj(r.b) } : {}) } };
  });
  if (!changed) return grid;
  return {
    ...grid,
    ...(cond ? { cond } : {}),
    ...(validations ? { validations } : {}),
  };
}

/**
 * Every formula of a grid sheet passed through `fn`: its cells' and its
 * rules'. Whatever rewrites formulas (a sheet or a name renamed, rows
 * inserted, cells shifted) goes through here, so a validation list's source
 * or a conditional format's formula is never left behind the cells.
 * FOUND IN R149: a sheet rename and Insert/Delete cells rewrote the cells
 * only; a list over the renamed sheet came up empty and refused its own
 * values. Returns the same object when nothing changed.
 */
export function mapGridFormulas(grid: GridData, fn: (formula: string) => string): GridData {
  const ruled = mapRuleFormulas(grid, fn);
  let cells: GridData["cells"] | null = null;
  for (const [k, cell] of Object.entries(grid.cells)) {
    if (!cell.i.startsWith("=")) continue;
    const next = fn(cell.i);
    if (next !== cell.i) (cells ??= { ...grid.cells })[k] = { ...cell, i: next };
  }
  return cells ? { ...ruled, cells } : ruled;
}

/** A sheet's formulas, cells' and rules', saying renamed sheets' new names (an import that had to rename one). */
export function renameSheetsInGrid(
  grid: GridData,
  renamed: { from: string; to: string }[],
): GridData {
  return mapGridFormulas(grid, (f) =>
    renamed.reduce((out, r) => renameSheetInFormula(out, r.from, r.to), f),
  );
}

/** A range after rows or columns are inserted or deleted, or null when it is gone. */
export function shiftRangeA1(a1Text: string, axis: Axis, at: number, count: number): string | null {
  const r = parseRangeA1(a1Text);
  if (!r) return null;
  const span =
    axis === "rows" ? shiftSpan(r.r0, r.r1, at, count) : shiftSpan(r.c0, r.c1, at, count);
  if (!span) return null;
  return rangeA1(
    axis === "rows" ? { ...r, r0: span[0], r1: span[1] } : { ...r, c0: span[0], c1: span[1] },
  );
}

/**
 * Fill `target` from `source` (target contains source and extends it down or
 * right). Formulas shift; a series continues (numbers, dates, months and
 * days, quarters, "Item 1, Item 2": see series.ts); anything else repeats.
 */
export function fillEdits(
  source: RangeAddr,
  target: RangeAddr,
  get: (row: number, col: number) => CellInput | undefined,
): {
  row: number;
  col: number;
  input: string;
  format?: string | null;
  style?: CellInput["s"] | null;
}[] {
  const down = target.r1 > source.r1;
  const h = source.r1 - source.r0 + 1;
  const w = source.c1 - source.c0 + 1;
  const edits: {
    row: number;
    col: number;
    input: string;
    format?: string | null;
    style?: CellInput["s"] | null;
  }[] = [];

  // Per line (column when filling down, row when filling right), the series if any.
  const lines = down ? w : h;
  for (let li = 0; li < lines; li++) {
    const src: (CellInput | undefined)[] = [];
    const len = down ? h : w;
    for (let k = 0; k < len; k++) {
      src.push(down ? get(source.r0 + k, source.c0 + li) : get(source.r0 + li, source.c0 + k));
    }
    const series = seriesOf(src);

    const extent = down ? target.r1 - source.r1 : target.c1 - source.c1;
    for (let k = 1; k <= extent; k++) {
      const pos = len - 1 + k; // index past the source start
      const srcIdx = pos % len;
      const cell = src[srcIdx];
      const row = down ? source.r1 + k : source.r0 + li;
      const col = down ? source.c0 + li : source.c1 + k;
      let input = cell?.i ?? "";
      if (cell && cell.i.startsWith("=")) {
        const srcRow = down ? source.r0 + srcIdx : source.r0 + li;
        const srcCol = down ? source.c0 + li : source.c0 + srcIdx;
        input = shiftFormula(cell.i, row - srcRow, col - srcCol);
      } else if (series) {
        input = series(k);
      }
      edits.push({ row, col, input, format: cell?.f ?? null, style: cell?.s ?? null });
    }
  }
  return edits;
}

// ── Clipboard ──────────────────────────────────────────────────────────────

/** Rows of text → TSV, quoting fields as Excel does (tabs, newlines, quotes). */
export function toTsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t"))
    .join("\r\n");
}

/** TSV (from Excel, Sheets, or here) → rows of text; quoted fields may hold tabs and newlines. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** "B3" for a label, "B3:D9" for a range. */
export function describeRange(r: RangeAddr): string {
  return r.r0 === r.r1 && r.c0 === r.c1 ? a1(r.r0, r.c0) : `${a1(r.r0, r.c0)}:${a1(r.r1, r.c1)}`;
}
