// How a cell reads on screen, and how typed text picks up a format.
//
// Excel formats a cell by what was typed: "12%" becomes a percentage, "$5" a
// currency, "2024-01-05" a date, and a formula whose answer is a date (DATE,
// TODAY, EOMONTH…) shows as one. The stored value is always the number; the
// format only decides what is shown.

import type { CellInput } from "./engine";
import { formatValue } from "./format";
import { isError, type Scalar } from "./formula/values";

export type CellView = {
  text: string;
  kind: "empty" | "number" | "text" | "bool" | "error";
  align: "left" | "right" | "center";
  /** The reason behind an error, for a tooltip. */
  title?: string;
};

const DATE_FUNCS = /^=\s*(DATE|TODAY|EDATE|EOMONTH|DATEVALUE|WORKDAY|WORKDAY\.INTL)\s*\(/i;
const DATETIME_FUNCS = /^=\s*NOW\s*\(/i;

/** The format a cell displays with: its own, or one implied by its formula. */
export function effectiveFormat(input: CellInput | undefined): string | undefined {
  if (!input) return undefined;
  if (input.f) return input.f;
  if (DATETIME_FUNCS.test(input.i)) return "yyyy-mm-dd hh:mm";
  if (DATE_FUNCS.test(input.i)) return "yyyy-mm-dd";
  return undefined;
}

export function cellView(value: Scalar, input: CellInput | undefined, detail?: string): CellView {
  const fmt = effectiveFormat(input);
  const explicitAlign = input?.s?.align;
  if (value === null || value === "") {
    return { text: "", kind: "empty", align: explicitAlign ?? "left" };
  }
  if (isError(value)) {
    return {
      text: value.err,
      kind: "error",
      align: explicitAlign ?? "center",
      title: detail ?? value.detail ?? errorHelp(value.err),
    };
  }
  if (typeof value === "boolean") {
    return { text: value ? "TRUE" : "FALSE", kind: "bool", align: explicitAlign ?? "center" };
  }
  if (typeof value === "number") {
    return { text: formatValue(value, fmt), kind: "number", align: explicitAlign ?? "right" };
  }
  return { text: formatValue(value, fmt), kind: "text", align: explicitAlign ?? "left" };
}

export function errorHelp(code: string): string {
  switch (code) {
    case "#DIV/0!":
      return "Division by zero (or an average of nothing).";
    case "#VALUE!":
      return "A value of the wrong type, e.g. text where a number was needed.";
    case "#REF!":
      return "A reference to a cell or sheet that does not exist.";
    case "#NAME?":
      return "An unknown function or name, or a formula that could not be read.";
    case "#N/A":
      return "No match was found.";
    case "#NUM!":
      return "A number that is out of range.";
    case "#SPILL!":
      return "The result needs more cells, and something is in the way.";
    case "#CALC!":
      return "The calculation produced nothing (e.g. FILTER matched no rows).";
    case "#CYCLE!":
      return "The formula depends on itself.";
    case "#BUSY!":
      return "Waiting for the lakehouse to answer.";
    default:
      return code;
  }
}

/**
 * The format typed text implies, when the cell has none yet: "12%" → 0%,
 * "$1,200" → currency, "2024-01-05" → a date, "2024-01-05 13:30" → date-time.
 */
export function impliedFormat(text: string): string | undefined {
  const t = text.trim();
  if (!t || t.startsWith("=") || t.startsWith("'")) return undefined;
  if (/^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}/.test(t)) return "yyyy-mm-dd hh:mm";
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return "yyyy-mm-dd";
  if (/^[+-]?[\d,]*\.?\d+%$/.test(t)) return t.includes(".") ? "0.00%" : "0%";
  if (/^\$[\d,]*\.?\d+$/.test(t)) return t.includes(".") ? '"$"#,##0.00' : '"$"#,##0';
  return undefined;
}

/** The text to put in the formula bar/editor for a cell. */
export function editText(input: CellInput | undefined): string {
  return input?.i ?? "";
}
