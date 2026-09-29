// Query variables (R155), as Row Zero's: {{Region}} in a query sheet's SQL is
// the value of the workbook's name Region (Data → Names), so a cell can
// steer the query: type EMEA in the cell the name points at, and the sheet,
// and every formula over it, shows EMEA's rows.
//
// A variable is always a value, never SQL: it is bound as a literal ('EMEA',
// 42, TRUE, NULL), and a name over several cells becomes a list for IN
// ('EMEA', 'APAC'). Whatever a browser sends as a value, the query stays the
// one saved with the sheet. Row Zero's examples quote a text variable
// ('{{date}}'); the quotes around a variable are taken as part of it, so both
// ways read the same.

import { isError, isMatrix, type Value } from "../formula/values";
import { qstr } from "./compile";

export type ParamScalar = string | number | boolean | null;
export type ParamValue = ParamScalar | ParamScalar[];
/** Each workbook name's value, by name (any case). */
export type QueryParams = Record<string, ParamValue>;

/** Most values one name may bring as a list. */
export const MAX_PARAM_LIST = 1000;

const NAME = "[A-Za-z_\\\\][A-Za-z0-9_.]*";
const PLACEHOLDER = new RegExp(
  `'\\{\\{\\s*(${NAME})\\s*\\}\\}'|\\{\\{\\s*(${NAME})\\s*\\}\\}`,
  "g",
);

/** The variables a query uses, in order, each once (names ignore case). */
export function queryVariables(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? m[2];
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

function literal(v: ParamScalar): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return qstr(v);
}

/**
 * The query with each variable bound to its value as a literal. With
 * `blank`, a variable with no value is NULL (to learn the query's columns
 * before any value is set); otherwise it is refused, naming the name to
 * define.
 */
export function bindQuery(
  sql: string,
  params: QueryParams | undefined,
  opts: { blank?: boolean } = {},
): { ok: true; sql: string } | { ok: false; error: string } {
  const byName = new Map(Object.entries(params ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let missing: string | null = null;
  const bound = sql.replace(
    PLACEHOLDER,
    (_all, quoted: string | undefined, bare: string | undefined) => {
      const name = quoted ?? bare ?? "";
      const v = byName.get(name.toLowerCase());
      if (v === undefined) {
        if (!opts.blank) missing ??= name;
        return "NULL";
      }
      if (Array.isArray(v)) {
        const items = v.slice(0, MAX_PARAM_LIST);
        return items.length ? `(${items.map(literal).join(", ")})` : "(NULL)";
      }
      return literal(v);
    },
  );
  if (missing) {
    return {
      ok: false,
      error: `{{${missing}}} has no value: name a cell ${missing} (Data → Names) and put the value there`,
    };
  }
  return { ok: true, sql: bound };
}

/**
 * A workbook name's value as a variable: one cell's value, or a range's
 * values in reading order (blanks left out). An error is no value.
 */
export function paramValue(v: Value): ParamValue | undefined {
  if (isMatrix(v)) {
    const out: ParamScalar[] = [];
    for (const row of v) {
      for (const x of row) {
        if (x === null || x === "" || isError(x) || isMatrix(x)) continue;
        out.push(x as ParamScalar);
        if (out.length >= MAX_PARAM_LIST) return out;
      }
    }
    return out;
  }
  if (isError(v)) return undefined;
  return v as ParamScalar;
}
