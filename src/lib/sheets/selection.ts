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
