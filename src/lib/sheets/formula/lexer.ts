// The Excel formula lexer.
//
// Turns the text after "=" into tokens that keep their source position, so a
// formula can be rewritten token by token (copy, fill, shift) without
// re-printing anything the user typed. References are lexed whole: a cell,
// a range, a whole column or row, each with an optional sheet prefix, and
// structured references to a table sheet (Orders[amount], [@amount]).

import { colIndex, MAX_ROWS } from "../a1";

export const ERROR_CODES = [
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#SPILL!",
  "#CALC!",
  "#CYCLE!",
  // Excel's own word for an answer that is still being computed elsewhere.
  "#BUSY!",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type RefPart = { row: number; col: number; rowAbs: boolean; colAbs: boolean };

export type Token =
  | { t: "num"; v: number; s: number; e: number }
  | { t: "str"; v: string; s: number; e: number }
  | { t: "bool"; v: boolean; s: number; e: number }
  | { t: "err"; v: ErrorCode; s: number; e: number }
  | { t: "cell"; sheet?: string; ref: RefPart; s: number; e: number }
  | {
      t: "range";
      sheet?: string;
      start: RefPart;
      end: RefPart;
      /** A:C — every row. */
      wholeCols?: boolean;
      /** 2:4 — every column. */
      wholeRows?: boolean;
      s: number;
      e: number;
    }
  | {
      t: "struct";
      /** Absent for [@col] / [col] inside the table itself. */
      table?: string;
      column: string;
      endColumn?: string;
      thisRow: boolean;
      s: number;
      e: number;
    }
  | { t: "func"; name: string; s: number; e: number }
  | { t: "name"; name: string; s: number; e: number }
  | { t: "op"; v: string; s: number; e: number }
  | { t: "("; s: number; e: number }
  | { t: ")"; s: number; e: number }
  | { t: ","; s: number; e: number }
  | { t: ";"; s: number; e: number }
  | { t: "{"; s: number; e: number }
  | { t: "}"; s: number; e: number };

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    public readonly at: number,
  ) {
    super(message);
    this.name = "FormulaSyntaxError";
  }
}

const IDENT_START = /[A-Za-z_\\]/;
const IDENT_CHAR = /[A-Za-z0-9_.\\]/;
const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;
const COL_RE = /^(\$?)([A-Za-z]{1,3})$/;

function cellPart(text: string): RefPart | null {
  const m = CELL_RE.exec(text);
  if (!m) return null;
  const col = colIndex(m[2]);
  const row = Number(m[4]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { col, row, colAbs: m[1] === "$", rowAbs: m[3] === "$" };
}

function colPart(text: string): RefPart | null {
  const m = COL_RE.exec(text);
  if (!m) return null;
  const col = colIndex(m[2]);
  if (col < 0) return null;
  return { col, row: 0, colAbs: m[1] === "$", rowAbs: false };
}

function rowPart(text: string): RefPart | null {
  const m = /^(\$?)(\d{1,7})$/.exec(text);
  if (!m) return null;
  const row = Number(m[2]) - 1;
  if (row < 0 || row >= MAX_ROWS) return null;
  return { row, col: 0, rowAbs: m[1] === "$", colAbs: false };
}

/** Read a run of reference characters ($, letters, digits) from i. */
function refRun(src: string, i: number): string {
  let j = i;
  while (j < src.length && /[$A-Za-z0-9]/.test(src[j])) j++;
  return src.slice(i, j);
}

/**
 * The inside of a structured reference's brackets, from the "[" at i.
 * Returns the column (and end column), whether it is "this row", and where
 * the reference ends. Special items (#All, #Data, #Headers, #Totals) other
 * than #This Row are accepted and ignored: a column reference means its data.
 */
function lexStructured(
  src: string,
  i: number,
): { column: string; endColumn?: string; thisRow: boolean; end: number } {
  // Read a balanced [...] honouring the ' escape for special characters.
  const readBracket = (k: number): { text: string; end: number } => {
    if (src[k] !== "[") throw new FormulaSyntaxError("Expected [", k);
    let depth = 0;
    let out = "";
    let j = k;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "'" && j + 1 < src.length) {
        out += src[j + 1];
        j++;
        continue;
      }
      if (ch === "[") {
        depth++;
        if (depth > 1) out += ch;
        continue;
      }
      if (ch === "]") {
        depth--;
        if (depth === 0) return { text: out, end: j + 1 };
        out += ch;
        continue;
      }
      out += ch;
    }
    throw new FormulaSyntaxError("Unclosed [ in a table reference", k);
  };

  const { text, end } = readBracket(i);
  const inner = text.trim();
  // [@col] or [@[col]]
  if (inner.startsWith("@")) {
    const rest = inner.slice(1).trim();
    const col = rest.startsWith("[") && rest.endsWith("]") ? rest.slice(1, -1) : rest;
    if (!col) throw new FormulaSyntaxError("A table reference needs a column", i);
    return { column: col, thisRow: true, end };
  }
  // Nested items: [[#This Row],[col]] or [[col1]:[col2]] or [[col]]
  if (inner.startsWith("[")) {
    const items: string[] = [];
    let thisRow = false;
    let rangeSep = false;
    // The items, each in its own brackets, separated by "," or ":".
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    // Escapes were already resolved by readBracket.
    for (let j = 0; j < inner.length; j++) {
      const ch = inner[j];
      if (ch === "[") {
        depth++;
        if (depth === 1) {
          cur = "";
          continue;
        }
      }
      if (ch === "]") {
        depth--;
        if (depth === 0) {
          parts.push(cur);
          cur = "";
          continue;
        }
      }
      if (depth === 0) {
        if (ch === ":") rangeSep = true;
        continue;
      }
      cur += ch;
    }
    for (const p of parts) {
      const t = p.trim();
      if (/^#this row$/i.test(t)) thisRow = true;
      else if (/^#(all|data|headers|totals)$/i.test(t)) continue;
      else items.push(t);
    }
    if (!items.length) throw new FormulaSyntaxError("A table reference needs a column", i);
    if (rangeSep && items.length >= 2) {
      return { column: items[0], endColumn: items[1], thisRow, end };
    }
    return { column: items[0], thisRow, end };
  }
  if (!inner) throw new FormulaSyntaxError("A table reference needs a column", i);
  if (/^#this row$/i.test(inner)) throw new FormulaSyntaxError("#This Row needs a column", i);
  return { column: inner, thisRow: false, end };
}

/** Lex the formula body (the text after "="). */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;

  // Whether the previous token ends an operand, so "-" after it is binary.
  const prevIsOperand = () => {
    const p = out[out.length - 1];
    if (!p) return false;
    return (
      p.t === "num" ||
      p.t === "str" ||
      p.t === "bool" ||
      p.t === "err" ||
      p.t === "cell" ||
      p.t === "range" ||
      p.t === "struct" ||
      p.t === "name" ||
      p.t === ")" ||
      p.t === "}" ||
      (p.t === "op" && p.v === "%")
    );
  };

  const pushRef = (sheet: string | undefined, start: number) => {
    // A reference begins at `start` (after any sheet prefix).
    const run = refRun(src, start);
    // Row range: 1:3
    if (/^\$?\d+$/.test(run) && src[start + run.length] === ":") {
      const run2 = refRun(src, start + run.length + 1);
      const a = rowPart(run);
      const b = rowPart(run2);
      if (a && b) {
        const e = start + run.length + 1 + run2.length;
        out.push({ t: "range", sheet, start: a, end: b, wholeRows: true, s: start, e });
        return e;
      }
    }
    const cell = cellPart(run);
    if (cell) {
      if (src[start + run.length] === ":") {
        const run2 = refRun(src, start + run.length + 1);
        const cell2 = cellPart(run2);
        if (cell2) {
          const e = start + run.length + 1 + run2.length;
          out.push({ t: "range", sheet, start: cell, end: cell2, s: start, e });
          return e;
        }
        throw new FormulaSyntaxError(`"${run}:${run2}" is not a range`, start);
      }
      out.push({ t: "cell", sheet, ref: cell, s: start, e: start + run.length });
      return start + run.length;
    }
    // Column range: A:C
    const col = colPart(run);
    if (col && src[start + run.length] === ":") {
      const run2 = refRun(src, start + run.length + 1);
      const col2 = colPart(run2);
      if (col2) {
        const e = start + run.length + 1 + run2.length;
        out.push({ t: "range", sheet, start: col, end: col2, wholeCols: true, s: start, e });
        return e;
      }
    }
    return -1;
  };

  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    // Strings
    if (ch === '"') {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= n) throw new FormulaSyntaxError("Unclosed string", i);
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += src[j];
        j++;
      }
      out.push({ t: "str", v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    // Errors
    if (ch === "#") {
      const code = ERROR_CODES.find((c) => src.slice(i, i + c.length).toUpperCase() === c);
      if (!code) throw new FormulaSyntaxError("Unknown error value", i);
      out.push({ t: "err", v: code, s: i, e: i + code.length });
      i += code.length;
      continue;
    }
    // Quoted sheet name: 'My Sheet'!A1
    if (ch === "'") {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= n) throw new FormulaSyntaxError("Unclosed sheet name", i);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            name += "'";
            j += 2;
            continue;
          }
          break;
        }
        name += src[j];
        j++;
      }
      if (src[j + 1] !== "!") throw new FormulaSyntaxError("A quoted sheet name needs !", i);
      const e = pushRef(name, j + 2);
      if (e < 0) throw new FormulaSyntaxError(`Expected a reference after '${name}'!`, j + 2);
      out[out.length - 1].s = i;
      i = e;
      continue;
    }
    // Structured reference inside a table: [@col] / [col]
    if (ch === "[") {
      const st = lexStructured(src, i);
      out.push({
        t: "struct",
        column: st.column,
        endColumn: st.endColumn,
        thisRow: st.thisRow,
        s: i,
        e: st.end,
      });
      i = st.end;
      continue;
    }
    // Numbers (and row ranges like 2:4)
    if (/[0-9.]/.test(ch) && (ch !== "." || /[0-9]/.test(src[i + 1] ?? ""))) {
      if (/^\d+:\$?\d+/.test(src.slice(i))) {
        const e = pushRef(undefined, i);
        if (e > 0) {
          i = e;
          continue;
        }
      }
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaSyntaxError("Bad number", i);
      out.push({ t: "num", v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    // References that start with $
    if (ch === "$") {
      const e = pushRef(undefined, i);
      if (e < 0) throw new FormulaSyntaxError("Bad reference", i);
      i = e;
      continue;
    }
    // Identifiers: functions, sheet prefixes, tables, refs, booleans, names
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < n && IDENT_CHAR.test(src[j])) j++;
      const word = src.slice(i, j);
      const next = src[j];
      if (next === "(") {
        out.push({ t: "func", name: word.toUpperCase().replace(/^_XLFN\./, ""), s: i, e: j });
        i = j;
        continue;
      }
      if (next === "!") {
        const e = pushRef(word, j + 1);
        if (e < 0) throw new FormulaSyntaxError(`Expected a reference after ${word}!`, j + 1);
        out[out.length - 1].s = i;
        i = e;
        continue;
      }
      if (next === "[") {
        const st = lexStructured(src, j);
        out.push({
          t: "struct",
          table: word,
          column: st.column,
          endColumn: st.endColumn,
          thisRow: st.thisRow,
          s: i,
          e: st.end,
        });
        i = st.end;
        continue;
      }
      // A plain reference (A1, AB12, A:C)?
      if (/^[A-Za-z]{1,3}\d*$/.test(word) || /^[A-Za-z]{1,3}$/.test(word)) {
        const e = pushRef(undefined, i);
        if (e > 0) {
          i = e;
          continue;
        }
      }
      const upper = word.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        out.push({ t: "bool", v: upper === "TRUE", s: i, e: j });
      } else {
        out.push({ t: "name", name: word, s: i, e: j });
      }
      i = j;
      continue;
    }
    // Operators
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ t: "op", v: two, s: i, e: i + 2 });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%".includes(ch)) {
      // A leading or post-operator + / - is unary; mark it so the parser knows.
      const v = (ch === "-" || ch === "+") && !prevIsOperand() ? `u${ch}` : ch;
      out.push({ t: "op", v, s: i, e: i + 1 });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === "{" || ch === "}") {
      out.push({ t: ch, s: i, e: i + 1 } as Token);
      i++;
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected "${ch}"`, i);
  }
  return out;
}
