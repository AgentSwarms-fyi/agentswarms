// Inserted rows, columns and cells take the formats of their neighbours
// (R169), as Excel's default Insert Options do: "Format Same As Above" for
// rows and cells shifted down, "Same As Left" for columns and cells shifted
// right. At the sheet's top or left edge they take the row below's or the
// column to the right's. Only the number format and the style come across;
// the value, a note, a link and a saved value stay where they were.

import { cellKey, MAX_COLS, MAX_ROWS, parseKey } from "./a1";
import type { CellInput } from "./engine";

/**
 * Gives the new indices [at, at + count) along one axis of already-shifted
 * `cells` the formats of the neighbour before them (after them, at index 0),
 * for the cells across the axis in [lo, hi]. Changes `cells` in place.
 */
export function formatInserted(
  cells: Record<string, CellInput>,
  alongRows: boolean,
  at: number,
  count: number,
  lo = 0,
  hi = Number.POSITIVE_INFINITY,
): void {
  if (count <= 0) return;
  const from = at > 0 ? at - 1 : at + count;
  const end = Math.min(at + count, alongRows ? MAX_ROWS : MAX_COLS);
  for (const [k, v] of Object.entries(cells)) {
    if (!v.f && !v.s) continue;
    const { row, col } = parseKey(k);
    const across = alongRows ? col : row;
    if ((alongRows ? row : col) !== from || across < lo || across > hi) continue;
    for (let j = at; j < end; j++) {
      const fmt: CellInput = { i: "" };
      if (v.f) fmt.f = v.f;
      if (v.s) fmt.s = structuredClone(v.s);
      cells[alongRows ? cellKey(j, col) : cellKey(row, j)] = fmt;
    }
  }
}
