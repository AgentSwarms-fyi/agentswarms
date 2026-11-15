// The grid's selection and point-mode rules, kept apart from the component.

import { a1, normRange, rangeA1, type CellAddr, type RangeAddr } from "./a1";
import type { WorkbookEngine } from "./engine";

/**
 * A selection as Excel keeps it: the ANCHOR is the active cell (where typing
 * goes, what the formula bar shows) and stays put while the selection is
 * extended; the FOCUS is the end that moves (Shift+arrow, Shift+click).
 */
export type Selection = {
  anchor: { row: number; col: number };
  focus: { row: number; col: number };
  /** Which end to bring into view: the moving end (default), the active cell, or neither. */
  scroll?: "focus" | "anchor" | "none";
};

export function selRange(s: Selection): RangeAddr {
  return normRange(s.anchor, s.focus);
}

/** True when the caret is where Excel would accept a clicked reference. */
export function acceptsReference(text: string, caret: number): boolean {
  if (!text.startsWith("=")) return false;
  const before = text.slice(0, caret).trimEnd();
  if (before === "=") return true;
  return /[=(,+\-*/^&<>:;%]$/.test(before);
}

/** The size of the array spilled from a cell, when it spilled into more than that cell. */
export type SpillExtent = (row: number, col: number) => { rows: number; cols: number } | undefined;

/**
 * The reference point mode writes for a drag from one cell to another. A drag
 * over exactly a spilled array is that spill's own reference, `A1#`, as Excel
 * writes it, so the formula follows the array when it grows or shrinks; any
 * other drag is the range, and one cell is `A1`. FOUND IN R266: it wrote
 * `A1:A3`, fixed to the array's size on the day the formula was typed.
 */
export function pointedReference(start: CellAddr, end: CellAddr, spilled: SpillExtent): string {
  const r = normRange(start, end);
  const size = spilled(r.r0, r.c0);
  if (size && r.r1 - r.r0 + 1 === size.rows && r.c1 - r.c0 + 1 === size.cols) {
    return `${a1(r.r0, r.c0)}#`;
  }
  return rangeA1(r);
}

/**
 * A sheet's spills, for pointedReference. The engine keeps an array's size
 * only when it spilled: one blocked by a value (#SPILL!) or of a single value
 * has none, so selecting its cells writes a plain range.
 */
export function spillExtentIn(
  engine: Pick<WorkbookEngine, "spillSize">,
  sheetId: string,
): SpillExtent {
  return (row, col) => engine.spillSize(sheetId, row, col);
}

/**
 * Whether text that reached the grid's keyboard input starts typing into the
 * cell. A bare line break does not: an Enter whose key press lands after
 * focus came back to the grid (a dialog's button closed it on keydown) put
 * "\n" here, and committing that edit blanked the cell (R116).
 */
export function startsEdit(text: string): boolean {
  return text !== "" && !/^[\r\n]+$/.test(text);
}

// ── Whole rows and columns (R497) ───────────────────────────────────────────

/** The grid's size: how many rows and columns the sheet shows. */
export type Extent = { rows: number; cols: number };

/** Every row is selected: the selection is whole columns (Select All included). */
export function isWholeColumns(r: RangeAddr, rowCount: number): boolean {
  return r.r0 === 0 && r.r1 >= rowCount - 1;
}

/** Every column is selected: the selection is whole rows (Select All included). */
export function isWholeRows(r: RangeAddr, colCount: number): boolean {
  return r.c0 === 0 && r.c1 >= colCount - 1;
}

/**
 * The columns (or rows) that dragging one header's edge resizes, and that
 * double-clicking it fits, as [first, last].
 *
 * Excel's and Google Sheets' rule: when whole columns are selected (by their
 * headers, or Select All) and the dragged edge is one of theirs, every
 * selected column takes the new width; otherwise only the dragged one does —
 * a selection of cells that happens to cross the column is not a request to
 * resize its neighbours. FOUND IN R497: only the dragged column ever moved,
 * so Select All and a drag changed one column.
 */
export function resizeSpan(
  range: RangeAddr,
  index: number,
  axis: "cols" | "rows",
  extent: Extent,
): [number, number] {
  if (axis === "cols") {
    return isWholeColumns(range, extent.rows) && index >= range.c0 && index <= range.c1
      ? [range.c0, range.c1]
      : [index, index];
  }
  return isWholeRows(range, extent.cols) && index >= range.r0 && index <= range.r1
    ? [range.r0, range.r1]
    : [index, index];
}

/** Ctrl+Space: the selection's columns, top to bottom, as a header click selects them. */
export function selectWholeColumns(s: Selection, rowCount: number): Selection {
  return {
    anchor: { row: 0, col: s.anchor.col },
    focus: { row: rowCount - 1, col: s.focus.col },
    scroll: "none",
  };
}

/** Shift+Space: the selection's rows, end to end. */
export function selectWholeRows(s: Selection, colCount: number): Selection {
  return {
    anchor: { row: s.anchor.row, col: 0 },
    focus: { row: s.focus.row, col: colCount - 1 },
    scroll: "none",
  };
}

/**
 * A whole-column (or whole-row) selection, kept whole when the grid grows.
 *
 * The grid adds rows and columns as you scroll toward its end. A selection
 * made by a header, Ctrl+A or Ctrl+Space reached the old last row, so after
 * the grid grew it no longer counted as whole columns: a resize changed one
 * column again, and the header's menu treated it as a block of cells.
 */
export function growWithExtent(s: Selection, from: Extent, to: Extent): Selection {
  let { anchor, focus } = s;
  const r = selRange(s);
  if (to.rows > from.rows && r.r0 === 0 && r.r1 === from.rows - 1 && from.rows > 1) {
    if (focus.row === r.r1) focus = { ...focus, row: to.rows - 1 };
    else anchor = { ...anchor, row: to.rows - 1 };
  }
  if (to.cols > from.cols && r.c0 === 0 && r.c1 === from.cols - 1 && from.cols > 1) {
    if (focus.col === r.c1) focus = { ...focus, col: to.cols - 1 };
    else anchor = { ...anchor, col: to.cols - 1 };
  }
  return anchor === s.anchor && focus === s.focus ? s : { anchor, focus, scroll: "none" };
}
