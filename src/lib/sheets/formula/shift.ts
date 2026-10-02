// Rewriting formulas without re-printing them: copy/fill shifts relative
// references, a sheet rename follows references to that sheet. Only the
// reference tokens change; everything the user typed stays as typed.

import { colLetters, MAX_COLS, MAX_ROWS } from "../a1";
import { lex, type RefPart, type Token } from "./lexer";

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

function shiftPart(p: RefPart, dr: number, dc: number): RefPart | null {
  const row = p.rowAbs ? p.row : p.row + dr;
  const col = p.colAbs ? p.col : p.col + dc;
  if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) return null;
  return { ...p, row, col };
}

function tokenText(t: Token, sheetText: string): string | null {
  if (t.t === "cell") return sheetText + partText(t.ref, "cell");
  if (t.t === "range") {
    const kind = t.wholeCols ? "col" : t.wholeRows ? "row" : "cell";
    return `${sheetText}${partText(t.start, kind)}:${partText(t.end, kind)}`;
  }
  return null;
}

function rewrite(input: string, map: (t: Token) => Token | "REF" | null): string {
  if (!input.startsWith("=")) return input;
  let tokens: Token[];
  try {
    tokens = lex(input.slice(1));
  } catch {
    return input; // leave a broken formula exactly as typed
  }
  const body = input.slice(1);
  let out = "";
  let last = 0;
  for (const t of tokens) {
    if (t.t !== "cell" && t.t !== "range") continue;
    const next = map(t);
    if (next === null) continue;
    out += body.slice(last, t.s);
    if (next === "REF") out += "#REF!";
    else {
      const sheet = (next as { sheet?: string }).sheet;
      out += tokenText(next, sheet ? `${quoteSheet(sheet)}!` : "");
    }
    last = t.e;
  }
  return `=${out}${body.slice(last)}`;
}

/** Move a formula by (dr, dc): relative references follow, absolute ones stay. */
export function shiftFormula(input: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return input;
  return rewrite(input, (t) => {
    if (t.t === "cell") {
      const p = shiftPart(t.ref, dr, dc);
      return p ? { ...t, ref: p } : "REF";
    }
    if (t.t === "range") {
      const a = shiftPart(
        t.start,
        t.wholeRows ? dr : t.wholeCols ? 0 : dr,
        t.wholeCols ? dc : t.wholeRows ? 0 : dc,
      );
      const b = shiftPart(
        t.end,
        t.wholeRows ? dr : t.wholeCols ? 0 : dr,
        t.wholeCols ? dc : t.wholeRows ? 0 : dc,
      );
      return a && b ? { ...t, start: a, end: b } : "REF";
    }
    return null;
  });
}

/** A sheet was renamed: references to it follow the new name. */
export function renameSheetInFormula(input: string, oldName: string, newName: string): string {
  const lower = oldName.toLowerCase();
  return rewrite(input, (t) => {
    if ((t.t === "cell" || t.t === "range") && t.sheet?.toLowerCase() === lower) {
      return { ...t, sheet: newName };
    }
    return null;
  });
}

/** A table sheet was renamed: structured references follow. */
export function renameTableInFormula(input: string, oldName: string, newName: string): string {
  if (!input.startsWith("=")) return input;
  let tokens: Token[];
  try {
    tokens = lex(input.slice(1));
  } catch {
    return input;
  }
  const body = input.slice(1);
  let out = "";
  let last = 0;
  const old = oldName.toLowerCase();
  for (const t of tokens) {
    if (t.t === "name" && t.name.toLowerCase() === old) {
      // A whole table by name: VLOOKUP(x, Customers, 2).
      out += body.slice(last, t.s) + newName;
      last = t.e;
      continue;
    }
    if (t.t !== "struct" || t.table?.toLowerCase() !== old) continue;
    out += body.slice(last, t.s) + newName;
    last = t.s + t.table.length;
  }
  return `=${out}${body.slice(last)}`;
}
