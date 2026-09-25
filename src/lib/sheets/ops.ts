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
import { shiftFormula } from "./formula/shift";
import { shiftIndex, shiftIndexList, shiftIndexRecord } from "./layout";
import { shiftMerges, shiftSpan } from "./merge";

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
  const next: GridData = { ...grid, cells };
  if (axis === "cols") {
    if (grid.colWidths) next.colWidths = shiftIndexRecord(grid.colWidths, at, count);
    if (grid.hiddenCols) next.hiddenCols = shiftIndexList(grid.hiddenCols, at, count);
  } else {
    if (grid.rowHeights) next.rowHeights = shiftIndexRecord(grid.rowHeights, at, count);
    if (grid.hiddenRows) next.hiddenRows = shiftIndexList(grid.hiddenRows, at, count);
  }
  if (grid.merges) next.merges = shiftMerges(grid.merges, axis, at, count);
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
  let changed = false;
  const adj = (text: string): string => {
    if (!text.trim().startsWith("=")) return text;
    const next = adjustFormula(text.trim(), formulaSheet, target, axis, at, count);
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

/** A number series, if the values are one: [2, 4, 6] → step 2. */
function seriesStep(nums: number[]): number | null {
  if (nums.length < 2) return null;
  const step = nums[1] - nums[0];
  for (let i = 2; i < nums.length; i++) {
    if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9) return null;
  }
  return step;
}

const TEXT_NUM = /^(.*?)(\d+)$/;

/**
 * Fill `target` from `source` (target contains source and extends it down or
 * right). Formulas shift; a run of numbers (or "Item 1, Item 2") continues
 * its series; anything else repeats.
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
    const literal = src.every((c) => c && c.i !== "" && !c.i.startsWith("="));
    const nums = literal ? src.map((c) => Number(c!.i.replace(/,/g, ""))) : [];
    const numeric = literal && nums.every((n) => Number.isFinite(n));
    const step = numeric ? seriesStep(nums) : null;
    const textNums = literal && !numeric ? src.map((c) => TEXT_NUM.exec(c!.i)) : [];
    const sameStem = textNums.length > 0 && textNums.every((m) => m && m[1] === textNums[0]![1]);
    const textStep =
      sameStem && textNums.length >= 1
        ? textNums.length === 1
          ? 1
          : seriesStep(textNums.map((m) => Number(m![2])))
        : null;

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
      } else if (step !== null) {
        input = String(+(nums[len - 1] + step * k).toFixed(10));
      } else if (textStep !== null && sameStem) {
        const lastNum = Number(textNums[len - 1]![2]);
        const width = textNums[len - 1]![2].length;
        input = textNums[0]![1] + String(lastNum + textStep * k).padStart(width, "0");
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
