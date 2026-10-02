// Find and Replace, as Excel's (Ctrl+F, Ctrl+H).
// FOUND IN R150: Sheets had neither. Ctrl+F in a sheet did nothing, and a
// browser's own find reads only the rows on screen, because the grid draws
// only those: in a 240-row sheet, row 200 could not be found at all.
//
// The text is Excel's pattern: * stands for any run of characters, ? for any
// one, and ~ before either (or before ~) takes it as itself. Look in
// "values" searches what a cell shows (a formula's answer, a number as
// formatted); "formulas" searches what was typed. Replace works on what was
// typed, as Excel's does.

import { parseFormula } from "./formula/parser";

export type FindOptions = {
  text: string;
  matchCase?: boolean;
  /** The whole of the cell's text, not a part of it. */
  entireCell?: boolean;
  /** "notes": the cells' notes, as Excel's Look in: Notes (R152). */
  lookIn: "formulas" | "values" | "notes";
};

export type FindWithin = "sheet" | "workbook";

/** What Find was last asked, so it opens with it again, as Excel's does. */
export type FindMemory = {
  text: string;
  replacement: string;
  matchCase: boolean;
  entireCell: boolean;
  lookIn: "values" | "formulas" | "notes";
  within: FindWithin;
};

export const EMPTY_FIND: FindMemory = {
  text: "",
  replacement: "",
  matchCase: false,
  entireCell: false,
  lookIn: "values",
  within: "sheet",
};

export type FindHit = { sheetId: string; sheet: string; row: number; col: number; text: string };

/** One sheet to search: its size, and the text of a cell (undefined for none). */
export type FindSource = {
  sheetId: string;
  sheet: string;
  rows: number;
  cols: number;
  text: (row: number, col: number) => string | undefined;
};

const escapeRe = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** The pattern for Excel's find text; null for an empty one. */
export function findPattern(
  opts: Pick<FindOptions, "text" | "matchCase" | "entireCell">,
  global = false,
): RegExp | null {
  const t = opts.text;
  if (!t) return null;
  let src = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "~" && i + 1 < t.length && "*?~".includes(t[i + 1])) {
      src += escapeRe(t[++i]);
    } else if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += escapeRe(ch);
  }
  if (opts.entireCell) src = `^(?:${src})$`;
  return new RegExp(src, `${opts.matchCase ? "" : "i"}${global ? "g" : ""}`);
}

/**
 * Every cell that matches, sheet by sheet in the order given, row by row
 * (Excel's "By Rows"). At most `limit`; `more` says whether there were more.
 */
export function findAll(
  sources: FindSource[],
  opts: FindOptions,
  limit = 10_000,
): { hits: FindHit[]; more: boolean } {
  const re = findPattern(opts);
  const hits: FindHit[] = [];
  if (!re) return { hits, more: false };
  for (const s of sources) {
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const text = s.text(r, c);
        if (!text || !re.test(text)) continue;
        if (hits.length === limit) return { hits, more: true };
        hits.push({ sheetId: s.sheetId, sheet: s.sheet, row: r, col: c, text });
      }
    }
  }
  return { hits, more: false };
}

/**
 * The hit after the active cell (or before it, backwards), wrapping round:
 * Find Next's answer. `sheetOrder` is the sheets as the workbook orders them.
 */
export function nextHit(
  hits: FindHit[],
  at: { sheetId: string; row: number; col: number },
  sheetOrder: string[],
  backwards = false,
): number {
  if (!hits.length) return -1;
  const key = (h: { sheetId: string; row: number; col: number }) => {
    const s = sheetOrder.indexOf(h.sheetId);
    return [s < 0 ? Number.MAX_SAFE_INTEGER : s, h.row, h.col];
  };
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const here = key(at);
  if (!backwards) {
    const i = hits.findIndex((h) => cmp(key(h), here) > 0);
    return i < 0 ? 0 : i;
  }
  for (let i = hits.length - 1; i >= 0; i--) if (cmp(key(hits[i]), here) < 0) return i;
  return hits.length - 1;
}

/**
 * A cell's typed text with every match replaced, as Excel's Replace: null
 * when nothing in it matches, and `broken` when the result is a formula that
 * no longer reads as one (Excel refuses those; so does this).
 */
export function replaceInput(
  input: string,
  opts: Pick<FindOptions, "text" | "matchCase" | "entireCell">,
  replacement: string,
): { next: string } | { broken: string } | null {
  const re = findPattern(opts, true);
  if (!re || !re.test(input)) return null;
  re.lastIndex = 0;
  // A function, so "$1" or "$&" in the replacement stays as typed. An empty
  // match (what * leaves at the end) replaces nothing: "*" is one replacement.
  const next = input.replace(re, (m) => (m === "" ? "" : replacement));
  if (next === input) return null;
  if (next.startsWith("=") && next.length > 1) {
    try {
      parseFormula(next.slice(1));
    } catch {
      return { broken: next };
    }
  }
  return { next };
}
