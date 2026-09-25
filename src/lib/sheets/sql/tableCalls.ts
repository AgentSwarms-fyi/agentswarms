// Grid formulas over table sheets, as SQL. A call like
// =SUMIFS(Orders[amount], Orders[region], A2) reaches the server as the
// function, the columns by name and A2's value; it is written back as formula
// text with the value as a literal and compiled by the same compiler as a
// table's calculated columns, so a SUMIFS means the same thing in both.

import type { TableCallArg, TableCallRequest } from "../formula/evaluate";
import type { Scalar } from "../formula/values";

/** A column name inside [ ], with Excel's ' escape for its special characters. */
function bracket(name: string): string {
  return name.replace(/['[\]#@]/g, (ch) => `'${ch}`);
}

function literal(v: Scalar): string {
  if (v === null) return '""';
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("A number out of range");
    // Plain digits: the formula lexer reads 1.5E+21 but not every spelling JS makes.
    const text =
      Math.abs(v) >= 1e21 || (v !== 0 && Math.abs(v) < 1e-6) ? v.toExponential() : String(v);
    return v < 0 ? `(${text})` : text;
  }
  if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
  throw new Error(`${v.err} as a value can't be sent to a table`);
}

/** The table names a call reads, lowercased. */
export function tablesOf(req: TableCallRequest): string[] {
  const out = new Set<string>();
  const walk = (r: TableCallRequest) => {
    for (const a of r.args) {
      if ("col" in a) out.add(a.col.table.toLowerCase());
      else if ("cols" in a) out.add(a.cols.table.toLowerCase());
      else if ("table" in a) out.add(a.table.toLowerCase());
      else if ("call" in a) walk(a.call);
    }
  };
  walk(req);
  return [...out];
}

function argText(a: TableCallArg): string {
  if ("col" in a) return `${a.col.table}[${bracket(a.col.column)}]`;
  if ("cols" in a) return `${a.cols.table}[[${bracket(a.cols.from)}]:[${bracket(a.cols.to)}]]`;
  if ("table" in a) return a.table;
  if ("call" in a) return callText(a.call);
  return literal(a.value);
}

/** The call as formula text (no leading "="). */
export function callText(req: TableCallRequest): string {
  if (!/^[A-Z][A-Z0-9.]*$/.test(req.fn)) throw new Error(`"${req.fn}" is not a function name`);
  return `${req.fn}(${req.args.map(argText).join(",")})`;
}

/** Functions whose empty answer is an error, not a blank. */
export const EMPTY_IS: Record<string, "#N/A" | "#DIV/0!"> = {
  XLOOKUP: "#N/A",
  VLOOKUP: "#N/A",
  INDEX: "#N/A",
  AVERAGE: "#DIV/0!",
  AVERAGEIF: "#DIV/0!",
  AVERAGEIFS: "#DIV/0!",
  MEDIAN: "#DIV/0!",
  STDEV: "#DIV/0!",
  "STDEV.S": "#DIV/0!",
  "STDEV.P": "#DIV/0!",
  VAR: "#DIV/0!",
  "VAR.S": "#DIV/0!",
  "VAR.P": "#DIV/0!",
};
