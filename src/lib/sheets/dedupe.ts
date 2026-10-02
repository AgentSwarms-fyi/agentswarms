// Excel's Data → Remove Duplicates (R153): the rows of a range that repeat
// an earlier row in every chosen column go, the rows below them move up
// within the range, and nothing outside the range moves.

import type { RangeAddr } from "./a1";
import type { CellInput } from "./engine";
import { moveRowsEdits, type RowEdit } from "./filter";

/**
 * The data rows (below the header, when there is one) that repeat an earlier
 * row in every chosen column. As in Excel, a cell is compared by what it
 * shows, not what it holds, and case is ignored: "ASHA@EXAMPLE.COM" repeats
 * "asha@example.com", while one date shown two ways ("2026-03-08" and
 * "8 Mar 2026") does not repeat.
 */
export function duplicateRows(
  range: RangeAddr,
  cols: number[],
  hasHeader: boolean,
  text: (row: number, col: number) => string,
): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let r = range.r0 + (hasHeader ? 1 : 0); r <= range.r1; r++) {
    const key = JSON.stringify(cols.map((c) => text(r, c).toLowerCase()));
    if (seen.has(key)) out.push(r);
    else seen.add(key);
  }
  return out;
}

/**
 * The cell edits that remove those rows from the range: every row kept moves
 * up to close the gaps (a formula's relative references with it, as in a
 * sort), and the rows freed at the bottom of the range empty.
 */
export function removeRowsEdits(
  range: RangeAddr,
  remove: number[],
  hasHeader: boolean,
  input: (row: number, col: number) => CellInput | undefined,
): RowEdit[] {
  const gone = new Set(remove);
  const rows: number[] = [];
  for (let r = range.r0 + (hasHeader ? 1 : 0); r <= range.r1; r++) rows.push(r);
  return moveRowsEdits(
    range,
    rows,
    rows.filter((r) => !gone.has(r)),
    input,
  );
}
