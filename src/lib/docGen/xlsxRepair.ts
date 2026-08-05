// Putting a column's total under that column.
//
// Data-bound sheets place their totals BY HEADER NAME, so they land correctly
// by construction. Literal sheets are authored positionally by the model, and
// it reliably gets the totals row wrong in the same way: the label goes in A,
// and the first aggregate goes in B regardless of which column it sums.
//
// Observed twice, in two unrelated runs:
//
//   A9 "TOTAL",  B9 =SUM(G2:G8)        …G9 empty
//   A5 "Total",  B5 =SUM(I2:I4)        …I5 empty, while J5/K5/L5 in the SAME
//                                       row were placed correctly
//
// It looks harmless in a screenshot because the builder caches a computed
// value, and it is not harmless at all: the number sits under an unrelated
// heading ("OCI Shape"), and anything referencing the sensible cell — a rollup
// sheet pointing at 'BOQ Line Items'!G9 — reads an empty cell and resolves to
// zero the moment Excel recalculates.
//
// The rewrite is deliberately narrow. A single-column aggregate belongs in that
// column; if the cell it belongs in is already occupied, the layout is somebody
// else's intent and is left alone.
import type { XlsxCell, XlsxLiteralSheet } from "./types";

/** SUM(I2:I4) and friends — ONE column, no sheet qualifier, nothing else. */
const SINGLE_COLUMN_AGGREGATE =
  /^\s*(?:SUM|AVERAGE|AVG|MIN|MAX|COUNT|COUNTA|MEDIAN|PRODUCT)\(\s*\$?([A-Z]{1,3})\$?(\d+)\s*:\s*\$?([A-Z]{1,3})\$?(\d+)\s*\)\s*$/i;

/** A1 column letters to a zero-based index: A→0, Z→25, AA→26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function isEmptyCell(c: XlsxCell | undefined): boolean {
  return c === undefined || c === null || (typeof c === "string" && c.trim() === "");
}

function formulaOf(c: XlsxCell | undefined): string | null {
  return c && typeof c === "object" && "formula" in c ? c.formula : null;
}

/**
 * Move each single-column aggregate into the column it aggregates.
 *
 * Returns the sheet unchanged when there is nothing unambiguous to do, and
 * reports what moved so the caller can record it rather than repairing in
 * silence.
 */
export function alignColumnAggregates(sheet: XlsxLiteralSheet): {
  sheet: XlsxLiteralSheet;
  moves: string[];
} {
  const moves: string[] = [];
  const rows = sheet.rows ?? [];
  const out = rows.map((row) => {
    if (!Array.isArray(row)) return row;
    let next: XlsxCell[] | null = null;

    for (let col = 0; col < row.length; col++) {
      const formula = formulaOf(row[col]);
      if (!formula) continue;
      // Cross-sheet references name their own sheet and are never misplaced by
      // this bug; leave them entirely alone.
      if (formula.includes("!")) continue;
      const m = SINGLE_COLUMN_AGGREGATE.exec(formula);
      if (!m) continue;
      const [, startCol, , endCol] = m;
      if (startCol.toUpperCase() !== endCol.toUpperCase()) continue;

      const target = columnIndex(startCol);
      if (target === col) continue;
      // A total belongs under its own column only if that cell is free. If the
      // author put something there, this is a layout we do not understand.
      const working: XlsxCell[] = next ?? [...row];
      if (!isEmptyCell(working[target])) continue;

      while (working.length <= target) working.push(null);
      working[target] = working[col];
      working[col] = null;
      next = working;
      moves.push(`${formula} → column ${startCol.toUpperCase()}`);
    }
    return next ?? row;
  });

  if (moves.length === 0) return { sheet, moves };
  return { sheet: { ...sheet, rows: out }, moves };
}
