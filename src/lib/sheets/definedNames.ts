// Named ranges: a workbook's names for cells, ranges and values (Excel's
// "defined names"), so that =SUM(Revenue)*TaxRate reads as the model means.
// FOUND IN R148: Sheets had none. An Excel model's formulas that used names
// showed #NAME?, or the value Excel last saved, which then never changed
// when an input did; the import dropped the names without a word.
//
// A name refers to a reference (Data!$B$2:$B$13) or a value (0.2). Names are
// the workbook's; the one Excel file form that scopes a name to a sheet is
// brought in for the whole workbook when no other name has it.

import { a1, type RangeAddr } from "./a1";
import { lex, type Token } from "./formula/lexer";
import { parseFormula, type Node } from "./formula/parser";
import { isError, type Scalar, type Value } from "./formula/values";

export type DefinedName = {
  name: string;
  /** What it refers to, as a formula without its "=": Data!$B$2:$B$13, or 0.2. */
  ref: string;
  comment?: string;
};

/** Most names one workbook keeps. */
export const MAX_NAMES = 1000;

const CELL_LIKE = /^\$?[A-Za-z]{1,3}\$?\d+$/;
const R1C1_LIKE = /^[Rr](\d*)([Cc](\d*))?$|^[Cc]\d*$/;

/** Why a name cannot be used, by Excel's rules; null when it can. */
export function nameProblem(name: string, taken: string[] = []): string | null {
  const n = name.trim();
  if (!n) return "Give the name";
  if (n.length > 255) return "A name has at most 255 characters";
  if (!/^[A-Za-z_\\À-￿][A-Za-z0-9_.\\À-￿]*$/.test(n))
    return "A name starts with a letter or an underscore, and has only letters, digits, periods and underscores";
  if (CELL_LIKE.test(n) || R1C1_LIKE.test(n))
    return `"${n}" reads as a cell reference; choose another name`;
  if (/^(TRUE|FALSE)$/i.test(n)) return `"${n}" is a value in Excel; choose another name`;
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase()))
    return `There is already a name "${n}"`;
  return null;
}

/** The formula a reference text parses to, or why it does not. */
export function parseRef(ref: string): { ok: true; node: Node } | { ok: false; error: string } {
  const text = ref.trim().replace(/^=/, "");
  if (!text) return { ok: false, error: "Say what the name refers to, such as Data!$B$2:$B$13" };
  try {
    return { ok: true, node: parseFormula(text) };
  } catch {
    return { ok: false, error: `"${text}" is not a reference or a value` };
  }
}

/** Names as the server takes them: valid, unique, and at most MAX_NAMES. */
export function namesProblem(names: DefinedName[]): string | null {
  if (names.length > MAX_NAMES) return `A workbook keeps at most ${MAX_NAMES} names`;
  const seen: string[] = [];
  for (const d of names) {
    const p = nameProblem(d.name, seen);
    if (p) return `${d.name}: ${p}`;
    const r = parseRef(d.ref);
    if (!r.ok) return `${d.name}: ${r.error}`;
    seen.push(d.name);
  }
  return null;
}

/** The sheets (and table sheets) a name's reference reads, lower-cased: a viewer not shown one sees no name into it. */
export function sheetsIn(ref: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if ((n.k === "cell" || n.k === "range") && n.sheet) out.add(n.sheet.toLowerCase());
    if (n.k === "struct" && n.table) out.add(n.table.toLowerCase());
    if (n.k === "array") n.rows.forEach((r) => r.forEach(walk));
    if (n.k === "call") n.args.forEach(walk);
    if (n.k === "bin") {
      walk(n.left);
      walk(n.right);
    }
    if (n.k === "unary" || n.k === "percent") walk(n.arg);
  };
  const r = parseRef(ref);
  if (r.ok) walk(r.node);
  return [...out];
}

/**
 * The names a caller is shown: none that reads a sheet their share leaves
 * out. A name into a sheet that no longer exists is still shown, so the
 * owner sees it come to #REF! and can change it.
 */
export function namesShown(names: DefinedName[], shown: (sheet: string) => boolean): DefinedName[] {
  return names.filter((d) => sheetsIn(d.ref).every(shown));
}

/**
 * A name's reference moved as the workbook's formulas are when rows or
 * columns are inserted, cells shifted or a sheet renamed: `adjust` is the
 * same rewrite the cells get, applied to "=" + ref.
 */
export function adjustNames(
  names: DefinedName[],
  adjust: (formula: string) => string,
): DefinedName[] {
  return names.map((d) => {
    const next = adjust(`=${d.ref}`).replace(/^=/, "");
    return next === d.ref ? d : { ...d, ref: next };
  });
}

/**
 * The names in an .xlsx's workbook part (<definedNames>). External links and
 * names over several areas are left out, and said so; a name scoped to one
 * sheet comes in for the whole workbook when no other name has it.
 */
export function namesFromWorkbookXml(xml: string): { names: DefinedName[]; warnings: string[] } {
  const names: DefinedName[] = [];
  const warnings: string[] = [];
  const decode = (t: string) =>
    t
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const re = /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[1];
    const name = decode(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const ref = decode(m[2]).trim();
    const comment = decode(/\bcomment="([^"]*)"/.exec(attrs)?.[1] ?? "").trim();
    const hidden = /\bhidden="(1|true)"/.test(attrs);
    // Excel's own (print areas, filter databases) and hidden helper names.
    if (!name || name.startsWith("_xlnm.") || hidden) continue;
    if (/\[\d+\]/.test(ref)) {
      warnings.push(`The name ${name} points into another workbook, so it was left out`);
      continue;
    }
    if (/^[^"(]*![^"(]*,/.test(ref)) {
      warnings.push(
        `The name ${name} covers several areas (${ref}); one area is kept per name, so it was left out`,
      );
      continue;
    }
    if (names.some((n) => n.name.toLowerCase() === name.toLowerCase())) {
      warnings.push(`The name ${name} is defined for more than one sheet; the first is kept`);
      continue;
    }
    const problem = nameProblem(name) ?? (parseRef(ref).ok ? null : `"${ref}" could not be read`);
    if (problem) {
      warnings.push(`The name ${name} was left out: ${problem}`);
      continue;
    }
    names.push({ name, ref, ...(comment ? { comment: comment.slice(0, 1000) } : {}) });
  }
  return { names, warnings };
}

/** <definedNames> for an .xlsx's workbook part. */
export function namesToWorkbookXml(names: DefinedName[]): string {
  if (!names.length) return "";
  const esc = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<definedNames>${names
    .map(
      (n) =>
        `<definedName name="${esc(n.name)}"${n.comment ? ` comment="${esc(n.comment)}"` : ""}>${esc(n.ref)}</definedName>`,
    )
    .join("")}</definedNames>`;
}

/** A sheet's name as a reference writes it: quoted unless it lexes as a name. */
export function sheetPrefix(sheet: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) && !/^[A-Za-z]{1,3}\d+$/.test(sheet);
  return `${plain ? sheet : `'${sheet.replace(/'/g, "''")}'`}!`;
}

/** The reference a name made from a selection gets: 'Q 3'!$A$1:$B$5, absolute as Excel makes it. */
export function refForRange(sheet: string, r: RangeAddr): string {
  const abs = (row: number, col: number) => a1(row, col).replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2");
  const one = r.r0 === r.r1 && r.c0 === r.c1;
  return sheetPrefix(sheet) + (one ? abs(r.r0, r.c0) : `${abs(r.r0, r.c0)}:${abs(r.r1, r.c1)}`);
}

/**
 * A typed reference with its sheet said: a name's cells are on one sheet,
 * whichever sheet a formula using it is on, so "B2:B9" typed on Data is
 * kept as Data!B2:B9 (Excel does the same).
 */
export function qualifyRef(ref: string, sheet: string): string {
  const text = ref.trim().replace(/^=/, "");
  let tokens: Token[];
  try {
    tokens = lex(text);
  } catch {
    return text;
  }
  let out = "";
  let last = 0;
  for (const t of tokens) {
    if ((t.t === "cell" || t.t === "range") && !t.sheet) {
      out += text.slice(last, t.s) + sheetPrefix(sheet);
      last = t.s;
    }
  }
  return out + text.slice(last);
}

/** A name was renamed: formulas that use it follow, as Excel's Name Manager does. */
export function renameNameInFormula(input: string, oldName: string, newName: string): string {
  if (!input.startsWith("=")) return input;
  let tokens: Token[];
  try {
    tokens = lex(input.slice(1));
  } catch {
    return input;
  }
  const body = input.slice(1);
  const old = oldName.toLowerCase();
  let out = "";
  let last = 0;
  for (const t of tokens) {
    if (t.t !== "name" || t.name.toLowerCase() !== old) continue;
    out += body.slice(last, t.s) + newName;
    last = t.e;
  }
  return `=${out}${body.slice(last)}`;
}

/** The cells a name stands for, when it stands for cells on a named sheet (the Name box goes there). */
export function nameTarget(
  ref: string,
): { sheet: string; range: RangeAddr; wholeCols?: boolean; wholeRows?: boolean } | null {
  const r = parseRef(ref);
  if (!r.ok) return null;
  const n = r.node;
  if (n.k === "cell" && n.sheet) {
    return {
      sheet: n.sheet,
      range: { r0: n.ref.row, c0: n.ref.col, r1: n.ref.row, c1: n.ref.col },
    };
  }
  if (n.k === "range" && n.sheet) {
    return {
      sheet: n.sheet,
      range: {
        r0: Math.min(n.start.row, n.end.row),
        c0: Math.min(n.start.col, n.end.col),
        r1: Math.max(n.start.row, n.end.row),
        c1: Math.max(n.start.col, n.end.col),
      },
      wholeCols: n.wholeCols,
      wholeRows: n.wholeRows,
    };
  }
  return null;
}

/** What a name comes to, as the Name Manager shows it: 0.2, "West", {10;20;30}. */
export function valuePreview(v: Value): string {
  const one = (x: Scalar): string =>
    x === null
      ? ""
      : isError(x)
        ? x.err
        : typeof x === "string"
          ? `"${x}"`
          : typeof x === "boolean"
            ? x
              ? "TRUE"
              : "FALSE"
            : String(Math.round(x * 1e10) / 1e10);
  if (!Array.isArray(v)) return one(v);
  const rows = v.length;
  const cols = v[0]?.length ?? 0;
  if (rows === 1 && cols === 1) return one(v[0][0]);
  // Excel's array text: , between columns, ; between rows; the first few only.
  const LIMIT = 12;
  let shown = 0;
  const parts: string[] = [];
  for (const row of v) {
    if (shown >= LIMIT) break;
    const cells = row.slice(0, Math.max(1, LIMIT - shown)).map(one);
    shown += cells.length;
    parts.push(cells.join(","));
  }
  const more = rows * cols > shown ? ";…" : "";
  return `{${parts.join(";")}${more}} (${rows}×${cols})`;
}
