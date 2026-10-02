// A1 addressing for Sheets: column letters, cell keys and ranges.
//
// Rows and columns are zero-based everywhere inside the engine; A1 text is
// what people type and read. The limits are Excel's, so a reference that
// Excel would accept parses here and one it would reject does not.

export const MAX_COLS = 16384; // XFD
export const MAX_ROWS = 1048576;

export type CellAddr = { row: number; col: number };

/** "A" → 0, "Z" → 25, "AA" → 26. Returns -1 for anything that is not 1–3 letters within XFD. */
export function colIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colLetters(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The storage key of a cell: "r,c" (zero-based). */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

export function parseKey(key: string): CellAddr {
  const [r, c] = key.split(",");
  return { row: Number(r), col: Number(c) };
}

/** "B3" for {row: 2, col: 1}. */
export function a1(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/** "B3" → {row: 2, col: 1}; null when it is not a plain cell address. */
export function parseA1(text: string): CellAddr | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text.trim());
  if (!m) return null;
  const col = colIndex(m[1]);
  const row = Number(m[2]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col };
}

export type RangeAddr = { r0: number; c0: number; r1: number; c1: number };

/** Normalise two corners into top-left / bottom-right. */
export function normRange(a: CellAddr, b: CellAddr): RangeAddr {
  return {
    r0: Math.min(a.row, b.row),
    c0: Math.min(a.col, b.col),
    r1: Math.max(a.row, b.row),
    c1: Math.max(a.col, b.col),
  };
}

/** "A1:C4", or "A1" for a single cell. */
export function rangeA1(r: RangeAddr): string {
  const start = a1(r.r0, r.c0);
  return r.r0 === r.r1 && r.c0 === r.c1 ? start : `${start}:${a1(r.r1, r.c1)}`;
}

/** "A1:C4" or "A1" → a range; null when it is neither. */
export function parseRangeA1(text: string): RangeAddr | null {
  const [a, b] = text.trim().split(":");
  const p = parseA1(a ?? "");
  if (!p) return null;
  if (b === undefined) return { r0: p.row, c0: p.col, r1: p.row, c1: p.col };
  const q = parseA1(b);
  return q ? normRange(p, q) : null;
}
