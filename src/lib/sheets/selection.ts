// The grid's selection and point-mode rules, kept apart from the component.

import { normRange, type RangeAddr } from "./a1";

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
