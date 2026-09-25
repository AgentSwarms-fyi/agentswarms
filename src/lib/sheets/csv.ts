// CSV in and out of a grid sheet, as Excel reads and writes it: a value that
// looks like a number, a date or a percentage becomes one (with the format
// it implies); anything else stays text. A field that starts with = is text
// here, not a formula: a CSV from elsewhere must not run anything.

import Papa from "papaparse";
import { cellKey } from "./a1";
import { csvText } from "@/lib/exportData";
import { cellView, impliedFormat } from "./cellView";
import type { CellInput, GridData } from "./engine";
import type { Scalar } from "./formula/values";

/** The byte-order mark Excel writes first in a UTF-8 CSV (and wants to read). */
export const BOM = String.fromCharCode(0xfeff);

export type CsvParse = { rows: string[][]; delimiter: string; truncated: boolean };

/** Rows of a CSV (or TSV, or ;-separated) text; the delimiter is detected. */
export function parseCsv(text: string, maxCells = Number.POSITIVE_INFINITY): CsvParse {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  // Papa guesses a delimiter only when every row agrees on the count; a
  // trailing newline or a blank row in the middle made ";" lose to ",".
  const guess = Papa.parse<string[]>(body, {
    preview: 50,
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", "\t", ";", "|"],
  }).meta.delimiter;
  const r = Papa.parse<string[]>(body, { skipEmptyLines: false, delimiter: guess || "," });
  const rows = r.data as string[][];
  // A trailing newline reads as one empty row; Excel does not show it.
  while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();
  let cells = 0;
  let cut = rows.length;
  for (let i = 0; i < rows.length; i++) {
    cells += rows[i].length;
    if (cells > maxCells) {
      cut = i;
      break;
    }
  }
  return {
    rows: rows.slice(0, cut),
    delimiter: r.meta.delimiter || ",",
    truncated: cut < rows.length,
  };
}

/** A field as a cell: what to store, and the format its text implies. */
export function csvCell(field: string): CellInput | undefined {
  if (field === "") return undefined;
  // Formulas, and the other characters spreadsheets treat as one (+ - @),
  // arrive as text. A negative number is still a number.
  if (
    /^[=@]/.test(field) ||
    (/^[+-]/.test(field) && !/^[+-]?[\d,.]+(e[+-]?\d+)?%?$/i.test(field))
  ) {
    return { i: `'${field}` };
  }
  const f = impliedFormat(field);
  return f ? { i: field, f } : { i: field };
}

export function rowsToGrid(rows: string[][]): GridData {
  const cells: Record<string, CellInput> = {};
  rows.forEach((line, r) =>
    line.forEach((field, c) => {
      const cell = csvCell(field);
      if (cell) cells[cellKey(r, c)] = cell;
    }),
  );
  return { cells };
}

/**
 * A sheet's used range as CSV, each cell as it is shown (Excel writes the
 * formatted text too), through the app's one CSV writer, which quotes and
 * defuses formula-looking text. A number whose shown text would read as a
 * formula (-$350.00) is written as the number itself (-350), which is both
 * safe and read back as the same value.
 */
export function gridToCsv(
  rows: number,
  cols: number,
  get: (r: number, c: number) => { v: Scalar; input: CellInput | undefined },
): string {
  const out: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: string[] = [];
    for (let c = 0; c < cols; c++) {
      const { v, input } = get(r, c);
      const shown = cellView(v, input).text;
      line.push(typeof v === "number" && /^[-+=@]/.test(shown) ? String(v) : shown);
    }
    out.push(line);
  }
  return out.length ? `${csvText(out)}\r\n` : "";
}
