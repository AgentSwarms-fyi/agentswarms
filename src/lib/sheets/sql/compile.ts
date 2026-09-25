// Excel formulas → DuckDB SQL, for the calculated columns of a table sheet.
//
// A table sheet's rows live in the lakehouse and can be far too many to
// bring to the browser, so a calculated column is not evaluated cell by cell:
// its formula is translated once into a SQL expression and the engine computes
// the whole column. `=[@price]*[@qty]` becomes a product of two columns,
// `=[@amount]/SUM([amount])` divides by a scalar subquery over the table, and
// `=XLOOKUP([@customer_id], Customers[id], Customers[name])` becomes a lookup
// subquery against another table sheet.
//
// The translation keeps Excel's meaning where SQL's differs and it matters:
// a blank counts as 0 in arithmetic and as "" in text, text comparison
// ignores case, MOD takes the divisor's sign, DATE(2024, 13, 1) rolls over
// into the next year, "&" writes 3 not 3.0. Where a formula would give an
// Excel error (#DIV/0!, #NUM!, #VALUE!), the table cell is blank instead: SQL
// has no error values, and one bad row must not fail the whole column.
// Anything that has no sound translation is refused with a message that says
// what to write instead, never approximated.

import { parseFormula, type Node } from "../formula/parser";
import { parseDateText, parseNumberText, serialParts } from "../formula/values";

export type ColKind = "number" | "text" | "bool" | "date" | "datetime" | "other";

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

/** What an engine type holds, in spreadsheet terms. */
export function kindOfSqlType(type: string): ColKind {
  const t = type.toUpperCase().trim();
  if (
    /^(TINYINT|SMALLINT|INTEGER|INT\b|INT[1248]|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/.test(
      t,
    )
  )
    return "number";
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|UUID|ENUM)/.test(t)) return "text";
  if (t === "BOOLEAN" || t === "BOOL") return "bool";
  if (t === "DATE") return "date";
  if (t.startsWith("TIMESTAMP") || t === "DATETIME") return "datetime";
  return "other";
}

export const qid = (name: string): string => `"${name.replace(/"/g, '""')}"`;
export const qstr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export type SheetColumn = { name: string; kind: ColKind };

/** Another table a formula may read whole columns of (Customers[id]). */
export type TableSource = {
  /** A relation: a CTE name or a parenthesized SELECT. */
  from: string;
  columns: SheetColumn[];
};

export type CompileContext = {
  /** This row's columns: the table's own, then the calculated ones before this one. */
  columns: SheetColumn[];
  /** The relation holding this table's rows as the formula sees them (for [amount], SUM). */
  self: string;
  /** The alias of the current row in the outer query. */
  row: string;
  /** This table's name, so Orders[amount] written inside Orders means itself. */
  selfName?: string;
  /** Other table sheets of the workbook, by name (case-insensitive). */
  table?: (name: string) => TableSource | undefined;
};

export type CompiledColumn = { sql: string; kind: ColKind };

/** Compile a calculated column's formula ("=[@price]*[@qty]") to a SQL expression. */
export function compileColumnFormula(formula: string, cx: CompileContext): CompiledColumn {
  const text = formula.trim();
  if (!text.startsWith("=")) {
    throw new CompileError("A calculated column's formula starts with =, e.g. =[@price]*[@qty]");
  }
  let node: Node;
  try {
    node = parseFormula(text.slice(1));
  } catch (e) {
    throw new CompileError((e as Error).message);
  }
  const c = new Compiler(cx);
  const t = c.scalar(node);
  return { sql: guard(t), kind: t.kind === "other" && t.nul ? "text" : t.kind };
}

// ── Typed SQL fragments ─────────────────────────────────────────────────────

type T = {
  sql: string;
  kind: ColKind;
  /** A bare column read, which may be NULL where Excel sees a blank. */
  col?: boolean;
  /** Contains a scalar subquery (TRY cannot wrap one). */
  sub?: boolean;
  /** Already a DOUBLE. */
  dbl?: boolean;
  /** The NULL literal (an omitted argument), which takes any kind. */
  nul?: boolean;
  /** The literal value, when the fragment is one. */
  lit?: string | number | boolean;
};

/** A whole column: every row of a table, for SUM, COUNTIFS, lookups. */
type Whole = { from: string; column: string; kind: ColKind; table: string; columns: SheetColumn[] };

/** Runtime errors (a bad cast, sqrt(-1)) become NULL, where TRY is allowed. */
function guard(t: T): string {
  return t.sub || t.nul || t.lit !== undefined ? t.sql : `TRY(${t.sql})`;
}

const NULL_T: T = { sql: "NULL", kind: "other", nul: true };

function num(n: number): T {
  if (!Number.isFinite(n)) throw new CompileError("That number is out of range");
  return { sql: `CAST(${n} AS DOUBLE)`, kind: "number", dbl: true, lit: n };
}

const sub = (...ts: T[]) => ts.some((t) => t.sub);

function toNum(t: T): string {
  switch (t.kind) {
    case "number":
      if (t.dbl) return t.sql;
      return t.col ? `coalesce(CAST(${t.sql} AS DOUBLE), 0)` : `CAST(${t.sql} AS DOUBLE)`;
    case "bool":
      return `CAST(coalesce(${t.sql}, FALSE) AS DOUBLE)`;
    case "text":
      return t.col
        ? `(CASE WHEN ${t.sql} IS NULL OR ${t.sql} = '' THEN 0 ELSE TRY_CAST(${t.sql} AS DOUBLE) END)`
        : `TRY_CAST(${t.sql} AS DOUBLE)`;
    case "date":
      // Excel's serial day number: days since 1899-12-30.
      return `CAST(date_diff('day', DATE '1899-12-30', ${t.sql}) AS DOUBLE)`;
    case "datetime":
      return `(epoch(CAST(${t.sql} AS TIMESTAMP)) / 86400.0 + 25569)`;
    default:
      return t.nul ? "CAST(0 AS DOUBLE)" : `TRY_CAST(${t.sql} AS DOUBLE)`;
  }
}

function toText(t: T): string {
  switch (t.kind) {
    case "text":
      return t.col ? `coalesce(${t.sql}, '')` : t.sql;
    case "number": {
      // 3, not 3.0; 0.5 stays 0.5.
      const x = toNum(t);
      return `(CASE WHEN ${x} = trunc(${x}) AND abs(${x}) < 1e15 THEN CAST(CAST(${x} AS BIGINT) AS VARCHAR) ELSE CAST(${x} AS VARCHAR) END)`;
    }
    case "bool":
      return `(CASE WHEN ${t.sql} THEN 'TRUE' WHEN NOT ${t.sql} THEN 'FALSE' ELSE '' END)`;
    case "date":
      return `coalesce(strftime(${t.sql}, '%Y-%m-%d'), '')`;
    case "datetime":
      return `coalesce(strftime(CAST(${t.sql} AS TIMESTAMP), '%Y-%m-%d %H:%M:%S'), '')`;
    default:
      return t.nul ? "''" : `coalesce(CAST(${t.sql} AS VARCHAR), '')`;
  }
}

function toBool(t: T): string {
  switch (t.kind) {
    case "bool":
      return t.col ? `coalesce(${t.sql}, FALSE)` : t.sql;
    case "number":
      return `(${toNum(t)} <> 0)`;
    case "text":
      return `(lower(${t.sql}) = 'true')`;
    default:
      return t.nul ? "FALSE" : `TRY_CAST(${t.sql} AS BOOLEAN)`;
  }
}

function toDate(t: T): string {
  switch (t.kind) {
    case "date":
      return t.sql;
    case "datetime":
      return `CAST(${t.sql} AS DATE)`;
    case "number":
      return `CAST(DATE '1899-12-30' + CAST(trunc(${toNum(t)}) AS INTEGER) AS DATE)`;
    default:
      return `TRY_CAST(${t.sql} AS DATE)`;
  }
}

/** Two branches of a CASE must share a type; unlike ones meet as text. */
function unify(ts: T[]): { parts: string[]; kind: ColKind } {
  const kinds = new Set(ts.filter((t) => !t.nul).map((t) => t.kind));
  if (kinds.size === 0) return { parts: ts.map(() => "NULL"), kind: "text" };
  if (kinds.size === 1) {
    const k = [...kinds][0];
    return {
      parts: ts.map((t) => (t.nul ? "NULL" : k === "number" ? toNum(t) : t.sql)),
      kind: k,
    };
  }
  if ([...kinds].every((k) => k === "number" || k === "bool")) {
    return { parts: ts.map((t) => (t.nul ? "NULL" : toNum(t))), kind: "number" };
  }
  if ([...kinds].every((k) => k === "date" || k === "datetime")) {
    return {
      parts: ts.map((t) => (t.nul ? "NULL" : `CAST(${t.sql} AS TIMESTAMP)`)),
      kind: "datetime",
    };
  }
  return { parts: ts.map((t) => (t.nul ? "NULL" : toText(t))), kind: "text" };
}

const OPS: Record<string, string> = {
  "=": "=",
  "<>": "<>",
  "<": "<",
  ">": ">",
  "<=": "<=",
  ">=": ">=",
};

const isBlankLit = (t: T) => t.lit === "";

function blankTest(t: T, negate: boolean): string {
  const blank = `(${t.sql} IS NULL OR CAST(${t.sql} AS VARCHAR) = '')`;
  return negate ? `(NOT ${blank})` : blank;
}

function dateLiteral(t: T): string | null {
  if (typeof t.lit !== "string") return null;
  const serial = parseDateText(t.lit);
  if (serial === null) return null;
  const p = serialParts(serial);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `DATE '${p.y}-${pad(p.m)}-${pad(p.d)}'`;
}

function compare(op: string, l: T, r: T): string {
  const o = OPS[op];
  if ((op === "=" || op === "<>") && (isBlankLit(r) || isBlankLit(l))) {
    return blankTest(isBlankLit(r) ? l : r, op === "<>");
  }
  const dateish = (k: ColKind) => k === "date" || k === "datetime";
  if (dateish(l.kind) || dateish(r.kind)) {
    const ld = dateish(l.kind) ? l.sql : dateLiteral(l);
    const rd = dateish(r.kind) ? r.sql : dateLiteral(r);
    if (ld && rd) {
      const ts = l.kind === "datetime" || r.kind === "datetime";
      return ts ? `(CAST(${ld} AS TIMESTAMP) ${o} CAST(${rd} AS TIMESTAMP))` : `(${ld} ${o} ${rd})`;
    }
    return `(${toNum(l)} ${o} ${toNum(r)})`;
  }
  const numeric = (k: ColKind) => k === "number" || k === "bool";
  if (numeric(l.kind) && numeric(r.kind)) return `(${toNum(l)} ${o} ${toNum(r)})`;
  if (l.kind === "text" && r.kind === "text") {
    return `(lower(${toText(l)}) ${o} lower(${toText(r)}))`;
  }
  // Number against text: compare as numbers when the text is one. A lakehouse
  // column of codes stored as text should match =[@code]=5.
  if ((numeric(l.kind) && r.kind === "text") || (l.kind === "text" && numeric(r.kind))) {
    return `coalesce(${toNum(l)} ${o} ${toNum(r)}, FALSE)`;
  }
  return `(${toText(l)} ${o} ${toText(r)})`;
}

// Excel wildcards → a LIKE pattern (backslash escapes).
function likePattern(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length && "*?~".includes(pattern[i + 1])) {
      const lit = pattern[i + 1];
      out += lit === "~" ? "~" : lit;
      i++;
    } else if (ch === "*") out += "%";
    else if (ch === "?") out += "_";
    else if (ch === "%" || ch === "_" || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out;
}

const hasWildcard = (s: string) => /(^|[^~])[*?]/.test(s);

// ── The compiler ───────────────────────────────────────────────────────────

class Compiler {
  private aliases = 0;
  constructor(private cx: CompileContext) {}

  private alias(): string {
    return `q${++this.aliases}`;
  }

  private findColumn(columns: SheetColumn[], name: string, table: string): SheetColumn {
    const want = name.trim().toLowerCase();
    const hit = columns.find((c) => c.name.toLowerCase() === want);
    if (!hit) {
      const list = columns
        .slice(0, 12)
        .map((c) => c.name)
        .join(", ");
      throw new CompileError(
        `There is no column "${name}" in ${table}. Its columns: ${list}${columns.length > 12 ? ", …" : ""}`,
      );
    }
    return hit;
  }

  private isSelf(table: string | undefined): boolean {
    return (
      !table ||
      (this.cx.selfName !== undefined && table.toLowerCase() === this.cx.selfName.toLowerCase())
    );
  }

  private otherTable(name: string): TableSource {
    const t = this.cx.table?.(name);
    if (!t) {
      throw new CompileError(
        `There is no table sheet named "${name}" in this workbook. A formula can read the columns of this table ([@column]) and of other table sheets (Customers[id]).`,
      );
    }
    return t;
  }

  /** A reference to every row of a column, or null when the node is not one. */
  whole(n: Node): Whole | null {
    if (n.k !== "struct" || n.thisRow) return null;
    if (n.endColumn) {
      throw new CompileError(
        "A range of columns (Table[[a]:[b]]) only works as VLOOKUP's table; name one column here",
      );
    }
    if (this.isSelf(n.table)) {
      const c = this.findColumn(this.cx.columns, n.column, "this table");
      return {
        from: this.cx.self,
        column: c.name,
        kind: c.kind,
        table: this.cx.selfName ?? "this table",
        columns: this.cx.columns,
      };
    }
    const t = this.otherTable(n.table!);
    const c = this.findColumn(t.columns, n.column, n.table!);
    return { from: t.from, column: c.name, kind: c.kind, table: n.table!, columns: t.columns };
  }

  private wholeArg(n: Node | undefined, fn: string, what: string): Whole {
    const w = n ? this.whole(n) : null;
    if (!w) {
      throw new CompileError(
        `${fn}'s ${what} must be a whole column, like [amount] or Orders[amount]`,
      );
    }
    return w;
  }

  scalar(n: Node): T {
    switch (n.k) {
      case "num":
        return num(n.v);
      case "str":
        return { sql: qstr(n.v), kind: "text", lit: n.v };
      case "bool":
        return { sql: n.v ? "TRUE" : "FALSE", kind: "bool", lit: n.v };
      case "empty":
        return NULL_T;
      case "err":
        throw new CompileError(`${n.v} in a formula has no meaning in a table column`);
      case "cell":
      case "range":
        throw new CompileError(
          "A table column can't refer to grid cells like A1. Use [@column] for this row's value.",
        );
      case "name":
        throw new CompileError(
          `"${n.name}" is not a column. Refer to this row's value of a column as [@${n.name}].`,
        );
      case "array":
        throw new CompileError("An array constant has no place in one row of a table");
      case "struct": {
        if (!this.isSelf(n.table)) {
          this.otherTable(n.table!); // a table that is not there says so first
          throw new CompileError(
            `${n.table}[${n.column}] is a whole column of another table. Use it inside SUM, SUMIFS, XLOOKUP and the like.`,
          );
        }
        if (n.endColumn) {
          throw new CompileError("A range of columns can't be one row's value; name one column");
        }
        // [amount] without @ in a row means this row's value, as Excel's
        // implicit intersection does inside a table.
        const c = this.findColumn(this.cx.columns, n.column, "this table");
        return { sql: `${this.cx.row}.${qid(c.name)}`, kind: c.kind, col: true };
      }
      case "unary": {
        const a = this.scalar(n.arg);
        if (n.op === "+") return a;
        if (a.kind === "number" && typeof a.lit === "number") return num(-a.lit);
        return { sql: `(-${toNum(a)})`, kind: "number", dbl: true, sub: a.sub };
      }
      case "percent": {
        const a = this.scalar(n.arg);
        return { sql: `(${toNum(a)} / 100.0)`, kind: "number", dbl: true, sub: a.sub };
      }
      case "bin":
        return this.binary(n.op, this.scalar(n.left), this.scalar(n.right));
      case "call":
        return this.call(n.name, n.args);
    }
  }

  private binary(op: string, l: T, r: T): T {
    const s = sub(l, r);
    if (op === "&") return { sql: `concat(${toText(l)}, ${toText(r)})`, kind: "text", sub: s };
    if (OPS[op]) return { sql: compare(op, l, r), kind: "bool", sub: s };
    const dateish = (k: ColKind) => k === "date" || k === "datetime";
    if ((op === "+" || op === "-") && (dateish(l.kind) || dateish(r.kind))) {
      // Date arithmetic in days, as Excel's serial numbers do it.
      if (op === "-" && dateish(l.kind) && dateish(r.kind)) {
        const sql =
          l.kind === "date" && r.kind === "date"
            ? `CAST(date_diff('day', ${r.sql}, ${l.sql}) AS DOUBLE)`
            : `((epoch(CAST(${l.sql} AS TIMESTAMP)) - epoch(CAST(${r.sql} AS TIMESTAMP))) / 86400.0)`;
        return { sql, kind: "number", dbl: true, sub: s };
      }
      const d = dateish(l.kind) ? l : r;
      const n = d === l ? r : l;
      if (op === "-" && d === r) {
        // number - date: a number (serial arithmetic).
        return { sql: `(${toNum(l)} - ${toNum(r)})`, kind: "number", dbl: true, sub: s };
      }
      const days = toNum(n);
      const sign = op === "-" ? "-" : "+";
      if (d.kind === "date") {
        return {
          sql: `CAST(${d.sql} ${sign} CAST(trunc(${days}) AS INTEGER) AS DATE)`,
          kind: "date",
          sub: s,
        };
      }
      return {
        sql: `(CAST(${d.sql} AS TIMESTAMP) ${sign} to_microseconds(CAST(round(${days} * 86400000000) AS BIGINT)))`,
        kind: "datetime",
        sub: s,
      };
    }
    const a = toNum(l);
    const b = toNum(r);
    switch (op) {
      case "+":
      case "-":
      case "*":
        return { sql: `(${a} ${op} ${b})`, kind: "number", dbl: true, sub: s };
      case "/":
        // #DIV/0! is a blank in a table column.
        return { sql: `(${a} / nullif(${b}, 0))`, kind: "number", dbl: true, sub: s };
      case "^":
        return { sql: `power(${a}, ${b})`, kind: "number", dbl: true, sub: s };
    }
    throw new CompileError(`The operator ${op} is not supported`);
  }

  // ── Functions ────────────────────────────────────────────────────────────

  private args(fn: string, args: Node[], min: number, max: number): void {
    if (args.length < min || args.length > max) {
      const want =
        min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
      throw new CompileError(`${fn} takes ${want} argument${want === "1" ? "" : "s"}`);
    }
  }

  private literalNumber(n: Node | undefined, fn: string, what: string): number {
    if (!n) throw new CompileError(`${fn} needs ${what}`);
    const t = this.scalar(n);
    if (typeof t.lit !== "number") {
      throw new CompileError(`${fn}'s ${what} must be a number written in the formula`);
    }
    return t.lit;
  }

  private numFn(sql: (x: string) => string, t: T): T {
    return { sql: sql(toNum(t)), kind: "number", dbl: true, sub: t.sub };
  }

  private call(name: string, args: Node[]): T {
    const fn = name.toUpperCase();
    const S = (i: number) => (args[i] ? this.scalar(args[i]) : NULL_T);
    const agg = AGGREGATES[fn];
    if (agg) return this.aggregate(fn, args);

    switch (fn) {
      // ── Logic
      case "IF": {
        this.args(fn, args, 2, 3);
        const c = S(0);
        const a = S(1);
        const b = args[2]
          ? S(2)
          : a.kind === "bool"
            ? { ...NULL_T, sql: "FALSE", kind: "bool" as const }
            : NULL_T;
        const u = unify([a, b]);
        return {
          sql: `(CASE WHEN ${toBool(c)} THEN ${u.parts[0]} ELSE ${u.parts[1]} END)`,
          kind: u.kind,
          sub: sub(c, a, b),
        };
      }
      case "IFS": {
        if (args.length < 2 || args.length % 2) {
          throw new CompileError("IFS takes pairs: a test, then the value when it holds");
        }
        const tests: T[] = [];
        const vals: T[] = [];
        for (let i = 0; i < args.length; i += 2) {
          tests.push(S(i));
          vals.push(S(i + 1));
        }
        const u = unify(vals);
        const whens = tests.map((t, i) => `WHEN ${toBool(t)} THEN ${u.parts[i]}`).join(" ");
        return { sql: `(CASE ${whens} END)`, kind: u.kind, sub: sub(...tests, ...vals) };
      }
      case "SWITCH": {
        if (args.length < 3)
          throw new CompileError("SWITCH takes a value, then pairs of match and result");
        const v = S(0);
        const rest = args.slice(1).map((a) => this.scalar(a));
        const hasDefault = rest.length % 2 === 1;
        const pairs = hasDefault ? rest.slice(0, -1) : rest;
        const results = pairs.filter((_, i) => i % 2 === 1);
        const all = hasDefault ? [...results, rest[rest.length - 1]] : results;
        const u = unify(all);
        const whens = pairs
          .filter((_, i) => i % 2 === 0)
          .map((m, i) => `WHEN ${compare("=", v, m)} THEN ${u.parts[i]}`)
          .join(" ");
        const dflt = hasDefault ? ` ELSE ${u.parts[u.parts.length - 1]}` : "";
        return { sql: `(CASE ${whens}${dflt} END)`, kind: u.kind, sub: sub(v, ...rest) };
      }
      case "CHOOSE": {
        this.args(fn, args, 2, 254);
        const idx = S(0);
        const vals = args.slice(1).map((a) => this.scalar(a));
        const u = unify(vals);
        const whens = u.parts.map((p, i) => `WHEN ${i + 1} THEN ${p}`).join(" ");
        return {
          sql: `(CASE CAST(trunc(${toNum(idx)}) AS INTEGER) ${whens} END)`,
          kind: u.kind,
          sub: sub(idx, ...vals),
        };
      }
      case "AND":
      case "OR": {
        this.args(fn, args, 1, 255);
        const ts = args.map((a) => this.scalar(a));
        return {
          sql: `(${ts.map(toBool).join(fn === "AND" ? " AND " : " OR ")})`,
          kind: "bool",
          sub: sub(...ts),
        };
      }
      case "XOR": {
        this.args(fn, args, 1, 255);
        const ts = args.map((a) => this.scalar(a));
        return {
          sql: `((${ts.map((t) => `CAST(${toBool(t)} AS INTEGER)`).join(" + ")}) % 2 = 1)`,
          kind: "bool",
          sub: sub(...ts),
        };
      }
      case "NOT": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return { sql: `(NOT ${toBool(t)})`, kind: "bool", sub: t.sub };
      }
      case "TRUE":
      case "FALSE":
        this.args(fn, args, 0, 0);
        return { sql: fn, kind: "bool", lit: fn === "TRUE" };
      case "IFERROR":
      case "IFNA": {
        this.args(fn, args, 2, 2);
        // Errors in a table column are blanks, so the fallback fills blanks.
        const a = S(0);
        const b = S(1);
        const u = unify([a, b]);
        const first = a.sub ? u.parts[0] : `TRY(${u.parts[0]})`;
        return { sql: `coalesce(${first}, ${u.parts[1]})`, kind: u.kind, sub: sub(a, b) };
      }
      case "ISBLANK": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return { sql: `(${t.sql} IS NULL)`, kind: "bool", sub: t.sub };
      }
      case "ISNUMBER":
      case "ISTEXT":
      case "ISNONTEXT":
      case "ISLOGICAL": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        const want: Record<string, ColKind> = {
          ISNUMBER: "number",
          ISTEXT: "text",
          ISLOGICAL: "bool",
        };
        if (fn === "ISNONTEXT") {
          return {
            sql: t.kind === "text" ? `(${t.sql} IS NULL)` : "TRUE",
            kind: "bool",
            sub: t.sub,
          };
        }
        // Dates are numbers to Excel.
        const matches =
          t.kind === want[fn] ||
          (fn === "ISNUMBER" && (t.kind === "date" || t.kind === "datetime"));
        return { sql: matches ? `(${t.sql} IS NOT NULL)` : "FALSE", kind: "bool", sub: t.sub };
      }
      case "ISERROR":
      case "ISERR":
      case "ISNA":
        throw new CompileError(
          `${fn} can't tell an error from a blank in a table column, where errors are blank. Use IFERROR(value, fallback) or ISBLANK.`,
        );

      // ── Math
      case "ABS":
        this.args(fn, args, 1, 1);
        return this.numFn((x) => `abs(${x})`, S(0));
      case "SIGN":
        this.args(fn, args, 1, 1);
        return this.numFn((x) => `CAST(sign(${x}) AS DOUBLE)`, S(0));
      case "INT":
        this.args(fn, args, 1, 1);
        return this.numFn((x) => `floor(${x})`, S(0));
      case "SQRT":
        this.args(fn, args, 1, 1);
        return this.numFn((x) => `(CASE WHEN ${x} < 0 THEN NULL ELSE sqrt(${x}) END)`, S(0));
      case "EXP":
        this.args(fn, args, 1, 1);
        return this.numFn((x) => `exp(${x})`, S(0));
      case "LN":
        this.args(fn, args, 1, 1);
        return this.numFn((x) => `(CASE WHEN ${x} <= 0 THEN NULL ELSE ln(${x}) END)`, S(0));
      case "LOG10":
        this.args(fn, args, 1, 1);
        return this.numFn((x) => `(CASE WHEN ${x} <= 0 THEN NULL ELSE log10(${x}) END)`, S(0));
      case "LOG": {
        this.args(fn, args, 1, 2);
        const x = S(0);
        const b = args[1] ? S(1) : num(10);
        const xs = toNum(x);
        const bs = toNum(b);
        return {
          sql: `(CASE WHEN ${xs} <= 0 OR ${bs} <= 0 OR ${bs} = 1 THEN NULL ELSE ln(${xs}) / ln(${bs}) END)`,
          kind: "number",
          dbl: true,
          sub: sub(x, b),
        };
      }
      case "PI":
        this.args(fn, args, 0, 0);
        return num(Math.PI);
      case "POWER": {
        this.args(fn, args, 2, 2);
        const a = S(0);
        const b = S(1);
        return {
          sql: `power(${toNum(a)}, ${toNum(b)})`,
          kind: "number",
          dbl: true,
          sub: sub(a, b),
        };
      }
      case "MOD": {
        this.args(fn, args, 2, 2);
        // The divisor's sign, as Excel: MOD(-7, 3) is 2.
        const x = S(0);
        const y = S(1);
        const a = toNum(x);
        const b = toNum(y);
        return {
          sql: `(${a} - nullif(${b}, 0) * floor(${a} / nullif(${b}, 0)))`,
          kind: "number",
          dbl: true,
          sub: sub(x, y),
        };
      }
      case "QUOTIENT": {
        this.args(fn, args, 2, 2);
        const x = S(0);
        const y = S(1);
        return {
          sql: `trunc(${toNum(x)} / nullif(${toNum(y)}, 0))`,
          kind: "number",
          dbl: true,
          sub: sub(x, y),
        };
      }
      case "ROUND":
      case "ROUNDUP":
      case "ROUNDDOWN":
      case "TRUNC": {
        this.args(fn, args, fn === "TRUNC" ? 1 : 2, 2);
        const x = S(0);
        const d = args[1] ? S(1) : num(0);
        const xs = toNum(x);
        const ds = `CAST(trunc(${toNum(d)}) AS INTEGER)`;
        const scale = `power(10, ${ds})`;
        const sql =
          fn === "ROUND"
            ? `round(${xs}, ${ds})`
            : fn === "ROUNDUP"
              ? `(sign(${xs}) * ceil(abs(${xs}) * ${scale}) / ${scale})`
              : `(sign(${xs}) * floor(abs(${xs}) * ${scale}) / ${scale})`;
        return { sql, kind: "number", dbl: true, sub: sub(x, d) };
      }
      case "CEILING":
      case "CEILING.MATH":
      case "FLOOR":
      case "FLOOR.MATH": {
        this.args(fn, args, 1, 2);
        const x = S(0);
        const sig = args[1] ? S(1) : num(1);
        const f = fn.startsWith("CEILING") ? "ceil" : "floor";
        const ss = `nullif(${toNum(sig)}, 0)`;
        return {
          sql: `(${f}(${toNum(x)} / ${ss}) * ${ss})`,
          kind: "number",
          dbl: true,
          sub: sub(x, sig),
        };
      }
      case "MROUND": {
        this.args(fn, args, 2, 2);
        const x = S(0);
        const m = S(1);
        const ms = `nullif(${toNum(m)}, 0)`;
        return {
          sql: `(round(${toNum(x)} / ${ms}) * ${ms})`,
          kind: "number",
          dbl: true,
          sub: sub(x, m),
        };
      }

      // ── Text
      case "LEN": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return {
          sql: `CAST(length(${toText(t)}) AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: t.sub,
        };
      }
      case "UPPER":
      case "LOWER": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return { sql: `${fn.toLowerCase()}(${toText(t)})`, kind: "text", sub: t.sub };
      }
      case "PROPER": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return {
          sql: `array_to_string(list_transform(string_split(lower(${toText(t)}), ' '), lambda w: upper(left(w, 1)) || substring(w, 2)), ' ')`,
          kind: "text",
          sub: t.sub,
        };
      }
      case "TRIM": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        // Excel also collapses runs of inner spaces.
        return {
          sql: `regexp_replace(trim(${toText(t)}), ' +', ' ', 'g')`,
          kind: "text",
          sub: t.sub,
        };
      }
      case "LEFT":
      case "RIGHT": {
        this.args(fn, args, 1, 2);
        const t = S(0);
        const n = args[1] ? S(1) : num(1);
        return {
          sql: `${fn.toLowerCase()}(${toText(t)}, CAST(trunc(${toNum(n)}) AS INTEGER))`,
          kind: "text",
          sub: sub(t, n),
        };
      }
      case "MID": {
        this.args(fn, args, 3, 3);
        const t = S(0);
        const st = S(1);
        const n = S(2);
        return {
          sql: `substring(${toText(t)}, CAST(trunc(${toNum(st)}) AS INTEGER), CAST(trunc(${toNum(n)}) AS INTEGER))`,
          kind: "text",
          sub: sub(t, st, n),
        };
      }
      case "CONCAT":
      case "CONCATENATE": {
        this.args(fn, args, 1, 255);
        const ts = args.map((a) => this.scalar(a));
        return { sql: `concat(${ts.map(toText).join(", ")})`, kind: "text", sub: sub(...ts) };
      }
      case "TEXTJOIN": {
        this.args(fn, args, 3, 255);
        const delim = S(0);
        const ignore = S(1);
        const ts = args.slice(2).map((a) => this.scalar(a));
        const parts = ts.map(
          (t) =>
            // concat_ws skips NULLs; blanks are skipped only when asked.
            `(CASE WHEN ${toBool(ignore)} AND ${toText(t)} = '' THEN NULL ELSE ${toText(t)} END)`,
        );
        return {
          sql: `concat_ws(${toText(delim)}, ${parts.join(", ")})`,
          kind: "text",
          sub: sub(delim, ignore, ...ts),
        };
      }
      case "SUBSTITUTE": {
        this.args(fn, args, 3, 3);
        const t = S(0);
        const o = S(1);
        const w = S(2);
        return {
          sql: `(CASE WHEN ${toText(o)} = '' THEN ${toText(t)} ELSE replace(${toText(t)}, ${toText(o)}, ${toText(w)}) END)`,
          kind: "text",
          sub: sub(t, o, w),
        };
      }
      case "REPT": {
        this.args(fn, args, 2, 2);
        const t = S(0);
        const n = S(1);
        return {
          sql: `repeat(${toText(t)}, CAST(trunc(${toNum(n)}) AS INTEGER))`,
          kind: "text",
          sub: sub(t, n),
        };
      }
      case "FIND":
      case "SEARCH": {
        this.args(fn, args, 2, 3);
        const needle = S(0);
        const hay = S(1);
        const start = args[2] ? S(2) : num(1);
        if (fn === "SEARCH" && typeof needle.lit === "string" && hasWildcard(needle.lit)) {
          throw new CompileError(
            "SEARCH with wildcards is not available in a table column; test with COUNTIFS-style criteria or LIKE-free text functions",
          );
        }
        const st = `CAST(trunc(${toNum(start)}) AS INTEGER)`;
        const n = fn === "SEARCH" ? `lower(${toText(needle)})` : toText(needle);
        const h = fn === "SEARCH" ? `lower(${toText(hay)})` : toText(hay);
        const pos = `instr(substring(${h}, ${st}), ${n})`;
        return {
          sql: `(CASE WHEN ${pos} = 0 THEN NULL ELSE CAST(${pos} + ${st} - 1 AS DOUBLE) END)`,
          kind: "number",
          dbl: true,
          sub: sub(needle, hay, start),
        };
      }
      case "EXACT": {
        this.args(fn, args, 2, 2);
        const a = S(0);
        const b = S(1);
        return { sql: `(${toText(a)} = ${toText(b)})`, kind: "bool", sub: sub(a, b) };
      }
      case "VALUE":
      case "NUMBERVALUE": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        if (t.kind === "number") return t;
        return {
          sql: `TRY_CAST(replace(${toText(t)}, ',', '') AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: t.sub,
        };
      }
      case "TEXT":
        return this.text(args);

      // ── Dates
      case "TODAY":
        this.args(fn, args, 0, 0);
        return { sql: "current_date", kind: "date" };
      case "NOW":
        this.args(fn, args, 0, 0);
        return { sql: "CAST(now() AS TIMESTAMP)", kind: "datetime" };
      case "DATE": {
        this.args(fn, args, 3, 3);
        const [y, m, d] = [S(0), S(1), S(2)];
        // Months and days roll over, as Excel: DATE(2024, 13, 1) is 2025-01-01.
        return {
          sql: `CAST(make_date(CAST(trunc(${toNum(y)}) AS INTEGER), 1, 1) + to_months(CAST(trunc(${toNum(m)}) AS INTEGER) - 1) + to_days(CAST(trunc(${toNum(d)}) AS INTEGER) - 1) AS DATE)`,
          kind: "date",
          sub: sub(y, m, d),
        };
      }
      case "DATEVALUE": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return { sql: `TRY_CAST(${toText(t)} AS DATE)`, kind: "date", sub: t.sub };
      }
      case "YEAR":
      case "MONTH":
      case "DAY": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return {
          sql: `CAST(${fn.toLowerCase()}(${toDate(t)}) AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: t.sub,
        };
      }
      case "HOUR":
      case "MINUTE":
      case "SECOND": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        const ts = t.kind === "datetime" ? t.sql : `TRY_CAST(${t.sql} AS TIMESTAMP)`;
        return {
          sql: `CAST(${fn.toLowerCase()}(${ts}) AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: t.sub,
        };
      }
      case "WEEKDAY": {
        this.args(fn, args, 1, 2);
        const t = S(0);
        const type = args[1] ? this.literalNumber(args[1], fn, "return type") : 1;
        const d = toDate(t);
        const sql =
          type === 1 || type === 17
            ? `(dayofweek(${d}) + 1)`
            : type === 2 || type === 11
              ? `isodow(${d})`
              : type === 3
                ? `(isodow(${d}) - 1)`
                : null;
        if (!sql) throw new CompileError("WEEKDAY's return type here can be 1, 2 or 3");
        return { sql: `CAST(${sql} AS DOUBLE)`, kind: "number", dbl: true, sub: t.sub };
      }
      case "ISOWEEKNUM": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        return {
          sql: `CAST(weekofyear(${toDate(t)}) AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: t.sub,
        };
      }
      case "WEEKNUM": {
        this.args(fn, args, 1, 1);
        const t = S(0);
        const d = toDate(t);
        // Weeks start on Sunday and January 1 is in week 1.
        return {
          sql: `CAST(floor((dayofyear(${d}) + dayofweek(make_date(year(${d}), 1, 1)) - 1) / 7) + 1 AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: t.sub,
        };
      }
      case "EDATE":
      case "EOMONTH": {
        this.args(fn, args, 2, 2);
        const t = S(0);
        const m = S(1);
        const moved = `CAST(${toDate(t)} + to_months(CAST(trunc(${toNum(m)}) AS INTEGER)) AS DATE)`;
        return {
          sql: fn === "EDATE" ? moved : `last_day(${moved})`,
          kind: "date",
          sub: sub(t, m),
        };
      }
      case "DAYS": {
        this.args(fn, args, 2, 2);
        const e = S(0);
        const s = S(1);
        return {
          sql: `CAST(date_diff('day', ${toDate(s)}, ${toDate(e)}) AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: sub(e, s),
        };
      }
      case "DATEDIF": {
        this.args(fn, args, 3, 3);
        const s = S(0);
        const e = S(1);
        const unit = args[2]?.k === "str" ? args[2].v.toUpperCase() : null;
        const part = unit === "D" ? "day" : unit === "M" ? "month" : unit === "Y" ? "year" : null;
        if (!part) throw new CompileError('DATEDIF\'s unit here can be "D", "M" or "Y"');
        // Whole units only, as Excel counts them.
        return {
          sql: `CAST(date_sub('${part}', ${toDate(s)}, ${toDate(e)}) AS DOUBLE)`,
          kind: "number",
          dbl: true,
          sub: sub(s, e),
        };
      }

      // ── Lookups
      case "XLOOKUP":
        return this.xlookup(args);
      case "VLOOKUP":
        return this.vlookup(args);
      case "INDEX":
        return this.indexMatch(args);
      case "RANK":
      case "RANK.EQ": {
        this.args(fn, args, 2, 3);
        const x = S(0);
        const w = this.wholeArg(args[1], fn, "second argument");
        const asc = args[2] ? this.literalNumber(args[2], fn, "order") !== 0 : false;
        const q = this.alias();
        const cmp = asc ? "<" : ">";
        return {
          sql: `(SELECT CAST(count(*) + 1 AS DOUBLE) FROM ${w.from} ${q} WHERE CAST(${q}.${qid(w.column)} AS DOUBLE) ${cmp} ${toNum(x)})`,
          kind: "number",
          dbl: true,
          sub: true,
        };
      }
      case "ROWS": {
        this.args(fn, args, 1, 1);
        const w = this.wholeArg(args[0], fn, "argument");
        return {
          sql: `(SELECT CAST(count(*) AS DOUBLE) FROM ${w.from})`,
          kind: "number",
          dbl: true,
          sub: true,
        };
      }
      case "MATCH":
        throw new CompileError(
          "A table's rows have no fixed order, so MATCH's position means nothing on its own. Use XLOOKUP, or INDEX(column, MATCH(value, column, 0)).",
        );
      case "UNIQUE":
      case "FILTER":
      case "SORT":
      case "SORTBY":
      case "SEQUENCE":
      case "TRANSPOSE":
        throw new CompileError(
          `${fn} returns many values, and a calculated column holds one per row. Use a pivot, a filter on the table, or a grid sheet.`,
        );
    }
    throw new CompileError(
      `${fn} is not available in a table column. It works in grid sheets; in a table, use the functions in the calculated-column list.`,
    );
  }

  private text(args: Node[]): T {
    this.args("TEXT", args, 2, 2);
    const v = this.scalar(args[0]);
    const f = this.scalar(args[1]);
    if (typeof f.lit !== "string") {
      throw new CompileError('TEXT\'s format must be written in the formula, e.g. "yyyy-mm-dd"');
    }
    const code = f.lit;
    const dateCode = /[yd]|m{3,}|h|s/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, ""));
    if (dateCode || v.kind === "date" || v.kind === "datetime") {
      const pattern = strftimePattern(code);
      if (!pattern)
        throw new CompileError(`TEXT's format "${code}" is not available in a table column`);
      const ts =
        v.kind === "date" || v.kind === "datetime"
          ? `CAST(${v.sql} AS TIMESTAMP)`
          : `CAST(${toDate(v)} AS TIMESTAMP)`;
      return { sql: `strftime(${ts}, ${qstr(pattern)})`, kind: "text", sub: v.sub };
    }
    const m = /^(#,##)?0(\.(0+))?(%)?$/.exec(code.trim());
    if (!m) {
      throw new CompileError(
        `TEXT's format "${code}" is not available in a table column; these are: 0, 0.00, #,##0, #,##0.00, 0%, 0.0%, and date codes like yyyy-mm-dd`,
      );
    }
    const places = m[3]?.length ?? 0;
    const pct = Boolean(m[4]);
    const x = pct ? `(${toNum(v)} * 100)` : toNum(v);
    const spec = `{:${m[1] ? "," : ""}.${places}f}`;
    // Round half away from zero first; format() alone rounds half to even.
    return {
      sql: `(format('${spec}', round(${x}, ${places}))${pct ? " || '%'" : ""})`,
      kind: "text",
      sub: v.sub,
    };
  }

  // ── Aggregates over whole columns ───────────────────────────────────────

  private aggregate(fn: string, args: Node[]): T {
    const spec = AGGREGATES[fn];
    // SUM(a, b) of this row's values is plain arithmetic.
    const wholes = args.map((a) => this.whole(a));
    if (spec.ifs) return this.aggregateIfs(fn, args);
    if (wholes.every((w) => w === null)) {
      if (!spec.scalar) {
        throw new CompileError(`${fn} needs a whole column, like ${fn}([amount])`);
      }
      const ts = args.map((a) => this.scalar(a));
      if (!ts.length) throw new CompileError(`${fn} needs at least one value`);
      return { sql: spec.scalar(ts.map(toNum)), kind: "number", dbl: true, sub: sub(...ts) };
    }
    if (args.length !== 1 && fn !== "SUMPRODUCT") {
      throw new CompileError(
        `${fn} over a whole column takes just that column, like ${fn}([amount])`,
      );
    }
    const w = wholes[0]!;
    const q = this.alias();
    if (fn === "SUMPRODUCT") {
      if (wholes.some((x) => !x) || wholes.some((x) => x!.from !== w.from)) {
        throw new CompileError("SUMPRODUCT's columns must all be whole columns of the same table");
      }
      const prod = wholes.map((x) => `CAST(${q}.${qid(x!.column)} AS DOUBLE)`).join(" * ");
      return {
        sql: `(SELECT CAST(sum(${prod}) AS DOUBLE) FROM ${w.from} ${q})`,
        kind: "number",
        dbl: true,
        sub: true,
      };
    }
    const col = `${q}.${qid(w.column)}`;
    const numeric = w.kind === "number" ? `CAST(${col} AS DOUBLE)` : `TRY_CAST(${col} AS DOUBLE)`;
    const expr = spec.whole(col, numeric, w.kind);
    const kind: ColKind =
      (fn === "MIN" || fn === "MAX") && (w.kind === "date" || w.kind === "datetime")
        ? w.kind
        : "number";
    return {
      sql: `(SELECT ${kind === "number" ? `CAST(${expr} AS DOUBLE)` : expr} FROM ${w.from} ${q})`,
      kind,
      dbl: kind === "number",
      sub: true,
    };
  }

  private aggregateIfs(fn: string, args: Node[]): T {
    // SUMIF(range, criteria, [sum_range]); SUMIFS(sum_range, range1, crit1, …);
    // COUNTIF(range, criteria); COUNTIFS(range1, crit1, …); AVERAGEIF(S), MINIFS, MAXIFS.
    let target: Node | undefined;
    let pairs: [Node, Node][] = [];
    if (fn === "SUMIF" || fn === "AVERAGEIF") {
      this.args(fn, args, 2, 3);
      pairs = [[args[0], args[1]]];
      target = args[2] ?? args[0];
    } else if (fn === "COUNTIF") {
      this.args(fn, args, 2, 2);
      pairs = [[args[0], args[1]]];
    } else if (fn === "COUNTIFS") {
      if (args.length < 2 || args.length % 2)
        throw new CompileError("COUNTIFS takes pairs of column and criteria");
      for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
    } else {
      if (args.length < 3 || args.length % 2 === 0) {
        throw new CompileError(
          `${fn} takes the column to total, then pairs of column and criteria`,
        );
      }
      target = args[0];
      for (let i = 1; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
    }
    const wholes = pairs.map(([r]) => this.wholeArg(r, fn, "ranges"));
    const t = target ? this.wholeArg(target, fn, "range to total") : null;
    const from = (t ?? wholes[0]).from;
    if (wholes.some((w) => w.from !== from)) {
      throw new CompileError(`${fn}'s columns must all come from the same table`);
    }
    const q = this.alias();
    const conds = pairs.map(([, crit], i) =>
      this.criterion(`${q}.${qid(wholes[i].column)}`, wholes[i].kind, crit),
    );
    const where = conds.map((c) => c.sql).join(" AND ");
    const tv = t
      ? t.kind === "number"
        ? `CAST(${q}.${qid(t.column)} AS DOUBLE)`
        : `TRY_CAST(${q}.${qid(t.column)} AS DOUBLE)`
      : "";
    const agg: Record<string, string> = {
      SUMIF: `coalesce(sum(${tv}), 0)`,
      SUMIFS: `coalesce(sum(${tv}), 0)`,
      COUNTIF: "count(*)",
      COUNTIFS: "count(*)",
      AVERAGEIF: `avg(${tv})`,
      AVERAGEIFS: `avg(${tv})`,
      MINIFS: `coalesce(min(${tv}), 0)`,
      MAXIFS: `coalesce(max(${tv}), 0)`,
    };
    return {
      sql: `(SELECT CAST(${agg[fn]} AS DOUBLE) FROM ${from} ${q} WHERE ${where})`,
      kind: "number",
      dbl: true,
      sub: true,
    };
  }

  /**
   * An Excel criterion ("West", ">100", "<>", "a*", [@region], ">"&[@min])
   * as a predicate on `col`, which holds values of `kind`.
   */
  criterion(col: string, kind: ColKind, crit: Node): { sql: string } {
    // ">" & [@x]: an operator written in front of a row-dependent value.
    // The range side is NOT a blank-as-0 read: Excel's criteria never match
    // a blank cell against a number (COUNTIF(A:A, ">-5") skips blanks), and
    // "<>" is the one operator a blank satisfies.
    const column: T = { sql: col, kind };
    if (crit.k === "bin" && crit.op === "&" && crit.left.k === "str" && OPS[crit.left.v.trim()]) {
      const rhs = this.scalar(crit.right);
      const op = crit.left.v.trim();
      const test = compare(op, column, rhs);
      return { sql: op === "<>" ? `coalesce(${test}, TRUE)` : `coalesce(${test}, FALSE)` };
    }
    const c = this.scalar(crit);
    if (typeof c.lit === "string") {
      const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(c.lit)!;
      const op = m[1] ?? "=";
      const rhs = m[2];
      if (rhs === "" && (op === "=" || op === "<>")) return { sql: blankTest(column, op === "<>") };
      if ((kind === "date" || kind === "datetime") && parseDateText(rhs) !== null) {
        return { sql: compare(op, column, { sql: qstr(rhs), kind: "text", lit: rhs }) };
      }
      const n = parseNumberText(rhs);
      if (n !== null && rhs.trim() !== "") {
        const numeric = kind === "number" ? `CAST(${col} AS DOUBLE)` : `TRY_CAST(${col} AS DOUBLE)`;
        const test = `${numeric} ${OPS[op]} CAST(${n} AS DOUBLE)`;
        return { sql: op === "<>" ? `coalesce(${test}, TRUE)` : `coalesce(${test}, FALSE)` };
      }
      const upper = rhs.toUpperCase();
      if (kind === "bool" && (upper === "TRUE" || upper === "FALSE")) {
        const test = `${col} = ${upper}`;
        return { sql: op === "<>" ? `coalesce(NOT (${test}), TRUE)` : `coalesce(${test}, FALSE)` };
      }
      if ((op === "=" || op === "<>") && hasWildcard(rhs)) {
        const like = `CAST(${col} AS VARCHAR) ILIKE ${qstr(likePattern(rhs))} ESCAPE '\\'`;
        return { sql: op === "<>" ? `coalesce(NOT (${like}), TRUE)` : `coalesce(${like}, FALSE)` };
      }
      const lit: T = { sql: qstr(rhs.replace(/~([*?~])/g, "$1")), kind: "text", lit: rhs };
      const test = `lower(CAST(${col} AS VARCHAR)) ${OPS[op]} lower(${lit.sql})`;
      return { sql: op === "<>" ? `coalesce(${test}, TRUE)` : `coalesce(${test}, FALSE)` };
    }
    if (typeof c.lit === "number" || typeof c.lit === "boolean") {
      return { sql: `coalesce(${compare("=", column, c)}, FALSE)` };
    }
    // A row-dependent value: equality, as Excel matches a criterion cell.
    return { sql: `coalesce(${compare("=", column, c)}, FALSE)` };
  }

  // ── Lookups ─────────────────────────────────────────────────────────────

  private lookup(key: T, lookupCol: Whole, ret: Whole, approx: boolean): string {
    const q = this.alias();
    const kc: T = { sql: `${q}.${qid(lookupCol.column)}`, kind: lookupCol.kind };
    const val = `${q}.${qid(ret.column)}`;
    if (!approx) {
      return `(SELECT ${val} FROM ${lookupCol.from} ${q} WHERE ${compare("=", kc, key)} LIMIT 1)`;
    }
    // Approximate match on sorted data: the largest key not above the value.
    return `(SELECT ${val} FROM ${lookupCol.from} ${q} WHERE ${compare("<=", kc, key)} ORDER BY ${kc.sql} DESC LIMIT 1)`;
  }

  private xlookup(args: Node[]): T {
    this.args("XLOOKUP", args, 3, 6);
    const key = this.scalar(args[0]);
    const look = this.wholeArg(args[1], "XLOOKUP", "lookup array");
    const ret = this.wholeArg(args[2], "XLOOKUP", "return array");
    if (look.from !== ret.from) {
      throw new CompileError("XLOOKUP's lookup and return columns must come from the same table");
    }
    if (args[4]) {
      const mode = this.literalNumber(args[4], "XLOOKUP", "match mode");
      if (mode !== 0)
        throw new CompileError("XLOOKUP in a table column matches exactly (match mode 0)");
    }
    if (args[5]) {
      const mode = this.literalNumber(args[5], "XLOOKUP", "search mode");
      if (mode !== 1)
        throw new CompileError("XLOOKUP in a table column has no search order: rows have none");
    }
    const found = this.lookup(key, look, ret, false);
    const nf = args[3] && args[3].k !== "empty" ? this.scalar(args[3]) : null;
    if (!nf) return { sql: found, kind: ret.kind, sub: true };
    const u = unify([{ sql: found, kind: ret.kind, sub: true }, nf]);
    return { sql: `coalesce(${u.parts[0]}, ${u.parts[1]})`, kind: u.kind, sub: true };
  }

  private vlookup(args: Node[]): T {
    this.args("VLOOKUP", args, 3, 4);
    const key = this.scalar(args[0]);
    const tableNode = args[1];
    let cols: SheetColumn[];
    let from: string;
    if (tableNode.k === "name") {
      if (this.isSelf(tableNode.name)) {
        cols = this.cx.columns;
        from = this.cx.self;
      } else {
        const t = this.otherTable(tableNode.name);
        cols = t.columns;
        from = t.from;
      }
    } else if (tableNode.k === "struct" && !tableNode.thisRow) {
      const src = this.isSelf(tableNode.table)
        ? { columns: this.cx.columns, from: this.cx.self }
        : this.otherTable(tableNode.table!);
      const first = this.findColumn(src.columns, tableNode.column, tableNode.table ?? "this table");
      const last = tableNode.endColumn
        ? this.findColumn(src.columns, tableNode.endColumn, tableNode.table ?? "this table")
        : first;
      const a = src.columns.indexOf(first);
      const b = src.columns.indexOf(last);
      cols = src.columns.slice(Math.min(a, b), Math.max(a, b) + 1);
      from = src.from;
    } else {
      throw new CompileError(
        "VLOOKUP's table must be a table sheet's name, like Customers, or Customers[[id]:[name]]",
      );
    }
    const idx = this.literalNumber(args[2], "VLOOKUP", "column number");
    if (!Number.isInteger(idx) || idx < 1 || idx > cols.length) {
      throw new CompileError(`VLOOKUP's column number must be 1 to ${cols.length} for that table`);
    }
    let approx = true; // Excel's default, and the classic VLOOKUP surprise.
    if (args[3] && args[3].k !== "empty") {
      const r = this.scalar(args[3]);
      if (typeof r.lit !== "boolean" && typeof r.lit !== "number") {
        throw new CompileError(
          "VLOOKUP's last argument must be TRUE or FALSE written in the formula",
        );
      }
      approx = Boolean(r.lit);
    }
    const look: Whole = {
      from,
      column: cols[0].name,
      kind: cols[0].kind,
      table: "",
      columns: cols,
    };
    const ret: Whole = {
      from,
      column: cols[idx - 1].name,
      kind: cols[idx - 1].kind,
      table: "",
      columns: cols,
    };
    return { sql: this.lookup(key, look, ret, approx), kind: ret.kind, sub: true };
  }

  private indexMatch(args: Node[]): T {
    // INDEX(return_column, MATCH(value, lookup_column, 0)) is XLOOKUP spelled the old way.
    const m = args[1];
    if (
      args.length === 2 &&
      m.k === "call" &&
      m.name.toUpperCase() === "MATCH" &&
      (m.args.length === 3 || m.args.length === 2)
    ) {
      const ret = this.wholeArg(args[0], "INDEX", "array");
      const look = this.wholeArg(m.args[1], "MATCH", "lookup array");
      if (look.from !== ret.from) {
        throw new CompileError("INDEX and MATCH must look in columns of the same table");
      }
      const mode = m.args[2] ? this.literalNumber(m.args[2], "MATCH", "match type") : 1;
      const key = this.scalar(m.args[0]);
      if (mode === -1)
        throw new CompileError("MATCH type -1 is not available in a table column; use 0 or 1");
      return { sql: this.lookup(key, look, ret, mode === 1), kind: ret.kind, sub: true };
    }
    throw new CompileError(
      "INDEX works in a table column as INDEX(column, MATCH(value, column, 0)); rows have no fixed positions otherwise",
    );
  }
}

type AggSpec = {
  /** Over a whole column: the aggregate expression. */
  whole: (col: string, numeric: string, kind: ColKind) => string;
  /** Over this row's values: plain arithmetic (SUM([@a], [@b])). */
  scalar?: (xs: string[]) => string;
  ifs?: boolean;
};

const AGGREGATES: Record<string, AggSpec> = {
  SUM: { whole: (_c, n) => `coalesce(sum(${n}), 0)`, scalar: (xs) => `(${xs.join(" + ")})` },
  AVERAGE: {
    whole: (_c, n) => `avg(${n})`,
    scalar: (xs) => `((${xs.join(" + ")}) / ${xs.length})`,
  },
  MIN: {
    whole: (c, n, k) => (k === "date" || k === "datetime" ? `min(${c})` : `coalesce(min(${n}), 0)`),
    scalar: (xs) => `least(${xs.join(", ")})`,
  },
  MAX: {
    whole: (c, n, k) => (k === "date" || k === "datetime" ? `max(${c})` : `coalesce(max(${n}), 0)`),
    scalar: (xs) => `greatest(${xs.join(", ")})`,
  },
  COUNT: { whole: (_c, n) => `count(${n})` },
  COUNTA: { whole: (c) => `count(CASE WHEN CAST(${c} AS VARCHAR) <> '' THEN 1 END)` },
  COUNTBLANK: {
    whole: (c) => `count(CASE WHEN ${c} IS NULL OR CAST(${c} AS VARCHAR) = '' THEN 1 END)`,
  },
  MEDIAN: { whole: (_c, n) => `median(${n})` },
  STDEV: { whole: (_c, n) => `stddev_samp(${n})` },
  "STDEV.S": { whole: (_c, n) => `stddev_samp(${n})` },
  "STDEV.P": { whole: (_c, n) => `stddev_pop(${n})` },
  VAR: { whole: (_c, n) => `var_samp(${n})` },
  "VAR.S": { whole: (_c, n) => `var_samp(${n})` },
  "VAR.P": { whole: (_c, n) => `var_pop(${n})` },
  SUMPRODUCT: { whole: () => "" },
  SUMIF: { whole: () => "", ifs: true },
  SUMIFS: { whole: () => "", ifs: true },
  COUNTIF: { whole: () => "", ifs: true },
  COUNTIFS: { whole: () => "", ifs: true },
  AVERAGEIF: { whole: () => "", ifs: true },
  AVERAGEIFS: { whole: () => "", ifs: true },
  MINIFS: { whole: () => "", ifs: true },
  MAXIFS: { whole: () => "", ifs: true },
};

/** Functions a calculated column accepts, for the editor's autocomplete. */
export const TABLE_FUNCTIONS: readonly string[] = [
  ...Object.keys(AGGREGATES),
  ...`IF IFS SWITCH CHOOSE AND OR XOR NOT TRUE FALSE IFERROR IFNA ISBLANK ISNUMBER ISTEXT ISNONTEXT ISLOGICAL
ABS SIGN INT SQRT EXP LN LOG10 LOG PI POWER MOD QUOTIENT ROUND ROUNDUP ROUNDDOWN TRUNC CEILING CEILING.MATH FLOOR FLOOR.MATH MROUND
LEN UPPER LOWER PROPER TRIM LEFT RIGHT MID CONCAT CONCATENATE TEXTJOIN SUBSTITUTE REPT FIND SEARCH EXACT VALUE NUMBERVALUE TEXT
TODAY NOW DATE DATEVALUE YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY ISOWEEKNUM WEEKNUM EDATE EOMONTH DAYS DATEDIF
XLOOKUP VLOOKUP INDEX RANK RANK.EQ ROWS`.split(/\s+/),
].sort();

/** An Excel date/time format code → a strftime pattern, or null when it has no equivalent. */
export function strftimePattern(code: string): string | null {
  let out = "";
  let i = 0;
  let lastWasHour = false;
  const lower = code.toLowerCase();
  while (i < code.length) {
    const rest = lower.slice(i);
    const ch = code[i];
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) return null;
      out += code.slice(i + 1, end).replace(/%/g, "%%");
      i = end + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < code.length) {
      out += code[i + 1] === "%" ? "%%" : code[i + 1];
      i += 2;
      continue;
    }
    const take = (re: RegExp) => re.exec(rest)?.[0] ?? null;
    let tok: string | null;
    if ((tok = take(/^yyyy|^yy/))) {
      out += tok === "yyyy" ? "%Y" : "%y";
      lastWasHour = false;
    } else if ((tok = take(/^mmmm|^mmm/))) {
      out += tok === "mmmm" ? "%B" : "%b";
      lastWasHour = false;
    } else if ((tok = take(/^mm|^m/))) {
      // After an hour it is minutes, as Excel reads it.
      out += lastWasHour ? "%M" : tok === "mm" ? "%m" : "%-m";
      lastWasHour = false;
    } else if ((tok = take(/^dddd|^ddd|^dd|^d/))) {
      out += { dddd: "%A", ddd: "%a", dd: "%d", d: "%-d" }[tok];
      lastWasHour = false;
    } else if ((tok = take(/^hh|^h/))) {
      out += /am\/pm|a\/p/.test(lower)
        ? tok === "hh"
          ? "%I"
          : "%-I"
        : tok === "hh"
          ? "%H"
          : "%-H";
      lastWasHour = true;
    } else if ((tok = take(/^ss|^s/))) {
      out += tok === "ss" ? "%S" : "%-S";
      lastWasHour = false;
    } else if ((tok = take(/^am\/pm|^a\/p/))) {
      out += "%p";
    } else if (/[\s\-/:.,()]/.test(ch)) {
      out += ch;
      if (ch !== ":") lastWasHour = false;
    } else {
      return null;
    }
    i += tok ? tok.length : 1;
  }
  return out;
}
