// The number format a formula takes from what it reads, as Excel gives one
// when the formula is entered (R168). =A1+30 over a date is a date,
// =SUM(B1:B2) over dollars is dollars, =A1 is A1's format. A formula with a
// format already, or one that reads nothing formatted, keeps what it has.

import { isDateFormat } from "./format";
import { parseFormula, type Node } from "./formula/parser";

/** A cell's number format: its own, or one its formula implies. Undefined when General. */
export type FormatAt = (sheet: string | undefined, row: number, col: number) => string | undefined;

/** Functions whose answer is in the units of their first argument. */
const SAME_UNITS = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "MEDIAN",
]);

/** A format worth carrying: a number format, not General or text. */
const carried = (f: string | undefined) =>
  f && f.toLowerCase() !== "general" && f !== "@" ? f : undefined;

function formatOf(n: Node, at: FormatAt): string | undefined {
  switch (n.k) {
    case "cell":
      return carried(at(n.sheet, n.ref.row, n.ref.col));
    case "range":
      return n.wholeCols || n.wholeRows
        ? undefined
        : carried(at(n.sheet, n.start.row, n.start.col));
    case "unary":
      return formatOf(n.arg, at);
    case "bin": {
      if (n.op !== "+" && n.op !== "-") return undefined;
      const left = formatOf(n.left, at);
      const right = formatOf(n.right, at);
      // Two dates apart is a number of days, not a date.
      if (n.op === "-" && left && right && isDateFormat(left) && isDateFormat(right))
        return undefined;
      return left ?? right;
    }
    case "call":
      return SAME_UNITS.has(n.name) && n.args.length ? formatOf(n.args[0], at) : undefined;
    default:
      return undefined;
  }
}

/**
 * The format a formula takes from the cells it reads, when the cell has none
 * of its own: a bare reference's; the first formatted operand of + or - (two
 * dates apart are a number of days); the first argument's of SUM, AVERAGE,
 * MIN, MAX, MEDIAN and the ROUNDs. Other formulas, * and / among them, take
 * none.
 */
export function formulaFormat(formula: string, at: FormatAt): string | undefined {
  if (!formula.startsWith("=")) return undefined;
  try {
    return formatOf(parseFormula(formula.slice(1)), at);
  } catch {
    return undefined;
  }
}
