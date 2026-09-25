// Insert or delete a block of cells and shift its neighbours, as Excel's
// Insert Cells and Delete Cells do: Shift cells right / down on insert, left
// / up on delete. Only the cells in the block's rows (shifting sideways) or
// columns (shifting vertically) move; every formula in the workbook that
// points at a moved cell follows it, one that pointed into deleted cells
// shows #REF!, and a range follows only when it lies wholly in those rows
// (or columns), as Excel's does.

import {
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
import { parseMerges } from "./merge";

export type ShiftDir = "right" | "down" | "left" | "up";

/** The axis cells move along, and by how much (negative: they close up). */
function motion(r: RangeAddr, dir: ShiftDir) {
  const sideways = dir === "right" || dir === "left";
  const n = sideways ? r.c1 - r.c0 + 1 : r.r1 - r.r0 + 1;
  return {
    sideways,
    /** The first index along the moving axis that moves. */
    at: sideways ? r.c0 : r.r0,
    count: dir === "right" || dir === "down" ? n : -n,
    /** The band across the moving axis: the rows (sideways) or columns that move. */
    lo: sideways ? r.r0 : r.c0,
    hi: sideways ? r.r1 : r.c1,
  };
}

function moveIndex(i: number, at: number, count: number): number | null {
  if (count > 0) return i >= at ? i + count : i;
  const n = -count;
  if (i < at) return i;
  if (i >= at + n) return i - n;
  return null;
}

function moveSpan(lo: number, hi: number, at: number, count: number): [number, number] | null {
  if (count > 0) return [lo >= at ? lo + count : lo, hi >= at ? hi + count : hi];
  const n = -count;
  const nlo = lo < at ? lo : lo >= at + n ? lo - n : at;
  const nhi = hi < at ? hi : hi >= at + n ? hi - n : at - 1;
  return nhi < nlo ? null : [nlo, nhi];
}

/**
 * Why a shift cannot be done, or null: a merged cell that the band cuts in
 * two, or cells pushed past the sheet's edge.
 */
export function shiftProblem(grid: GridData, r: RangeAddr, dir: ShiftDir): string | null {
  const m = motion(r, dir);
  for (const g of parseMerges(grid.merges)) {
    const across = m.sideways ? [g.r0, g.r1] : [g.c0, g.c1];
    const inBand = across[0] >= m.lo && across[1] <= m.hi;
    const outBand = across[1] < m.lo || across[0] > m.hi;
    const along = m.sideways ? [g.c0, g.c1] : [g.r0, g.r1];
    const moves = along[1] >= m.at;
    if (moves && !inBand && !outBand)
      return `The merged cell ${rangeA1(g)} would be cut in two; unmerge it first, or insert whole ${m.sideways ? "columns" : "rows"}.`;
  }
  if (m.count > 0) {
    const limit = m.sideways ? MAX_COLS : MAX_ROWS;
    for (const k of Object.keys(grid.cells)) {
      const { row, col } = parseKey(k);
      const across = m.sideways ? row : col;
      const along = m.sideways ? col : row;
      if (across >= m.lo && across <= m.hi && along >= m.at && along + m.count >= limit)
        return "Cells would be pushed past the edge of the sheet.";
    }
  }
  return null;
}

/** The sheet's cells, merges and rule ranges after the shift (formulas are rewritten separately). */
export function shiftCellsGrid(grid: GridData, r: RangeAddr, dir: ShiftDir): GridData {
  const m = motion(r, dir);
  const cells: Record<string, CellInput> = {};
  for (const [k, v] of Object.entries(grid.cells)) {
    const { row, col } = parseKey(k);
    const across = m.sideways ? row : col;
    if (across < m.lo || across > m.hi) {
      cells[k] = v;
      continue;
    }
    const along = moveIndex(m.sideways ? col : row, m.at, m.count);
    if (along === null) continue; // deleted
    cells[m.sideways ? cellKey(row, along) : cellKey(along, col)] = v;
  }
  const moveRange = (a1Text: string): string | null => {
    const x = parseRangeA1(a1Text.replace(/\$/g, ""));
    if (!x) return a1Text;
    const across = m.sideways ? [x.r0, x.r1] : [x.c0, x.c1];
    if (across[0] < m.lo || across[1] > m.hi) return a1Text; // not wholly in the band: stays
    const span = m.sideways
      ? moveSpan(x.c0, x.c1, m.at, m.count)
      : moveSpan(x.r0, x.r1, m.at, m.count);
    if (!span) return null;
    return rangeA1(
      m.sideways ? { ...x, c0: span[0], c1: span[1] } : { ...x, r0: span[0], r1: span[1] },
    );
  };
  const next: GridData = { ...grid, cells };
  if (grid.merges) next.merges = grid.merges.map(moveRange).filter((x): x is string => x !== null);
  if (grid.cond)
    next.cond = grid.cond
      .map((cf) => ({
        ...cf,
        ranges: cf.ranges.map(moveRange).filter((x): x is string => x !== null),
      }))
      .filter((cf) => cf.ranges.length);
  if (grid.validations)
    next.validations = grid.validations
      .map((v) => ({
        ...v,
        ranges: v.ranges.map(moveRange).filter((x): x is string => x !== null),
      }))
      .filter((v) => v.ranges.length);
  if (grid.charts)
    next.charts = grid.charts
      .map((c) => ({ ...c, range: moveRange(c.range) }))
      .filter((c): c is typeof c & { range: string } => c.range !== null);
  if (grid.filter) {
    const range = moveRange(grid.filter.range);
    next.filter = range ? { ...grid.filter, range } : undefined;
  }
  return next;
}

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}

function partText(p: RefPart, kind: "cell" | "col" | "row"): string {
  const c = `${p.colAbs ? "$" : ""}${colLetters(p.col)}`;
  const rr = `${p.rowAbs ? "$" : ""}${p.row + 1}`;
  return kind === "cell" ? c + rr : kind === "col" ? c : rr;
}

/** A formula rewritten for a cell shift on sheet `target` (it lives on `formulaSheet`). */
export function adjustFormulaForShift(
  input: string,
  formulaSheet: string,
  target: string,
  r: RangeAddr,
  dir: ShiftDir,
): string {
  if (!input.startsWith("=")) return input;
  let tokens: Token[];
  try {
    tokens = lex(input.slice(1));
  } catch {
    return input;
  }
  const m = motion(r, dir);
  const body = input.slice(1);
  const t = target.toLowerCase();
  const alongKey = m.sideways ? "col" : "row";
  const acrossKey = m.sideways ? "row" : "col";
  let out = "";
  let last = 0;
  for (const tok of tokens) {
    if (tok.t !== "cell" && tok.t !== "range") continue;
    if ((tok.sheet ?? formulaSheet).toLowerCase() !== t) continue;
    const prefix = tok.sheet ? `${quoteSheet(tok.sheet)}!` : "";
    let text: string | null = null;
    if (tok.t === "cell") {
      const across = tok.ref[acrossKey];
      if (across < m.lo || across > m.hi) continue;
      const i = moveIndex(tok.ref[alongKey], m.at, m.count);
      if (i === null) text = "#REF!";
      else if (i === tok.ref[alongKey]) continue;
      else text = prefix + partText({ ...tok.ref, [alongKey]: i }, "cell");
    } else {
      // Whole rows and columns, and ranges reaching outside the band, stay.
      if (tok.wholeCols || tok.wholeRows) continue;
      const aLo = Math.min(tok.start[acrossKey], tok.end[acrossKey]);
      const aHi = Math.max(tok.start[acrossKey], tok.end[acrossKey]);
      if (aLo < m.lo || aHi > m.hi) continue;
      const lo = Math.min(tok.start[alongKey], tok.end[alongKey]);
      const hi = Math.max(tok.start[alongKey], tok.end[alongKey]);
      const span = moveSpan(lo, hi, m.at, m.count);
      if (!span) text = "#REF!";
      else if (span[0] === lo && span[1] === hi) continue;
      else
        text = `${prefix}${partText({ ...tok.start, [alongKey]: span[0] }, "cell")}:${partText(
          { ...tok.end, [alongKey]: span[1] },
          "cell",
        )}`;
    }
    out += body.slice(last, tok.s) + text;
    last = tok.e;
  }
  return last === 0 ? input : `=${out}${body.slice(last)}`;
}
