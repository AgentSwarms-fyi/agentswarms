// Merged cells, as Excel keeps them: a list of rectangles, each shown as one
// cell whose value and style are its top-left cell's. The other cells of a
// merge hold nothing (merging clears them, after asking).

import { parseRangeA1, rangeA1, type RangeAddr } from "./a1";

export function parseMerges(list: readonly string[] | undefined): RangeAddr[] {
  const out: RangeAddr[] = [];
  for (const s of list ?? []) {
    const r = parseRangeA1(s);
    if (r && (r.r1 > r.r0 || r.c1 > r.c0)) out.push(r);
  }
  return out;
}

export function intersects(a: RangeAddr, b: RangeAddr): boolean {
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
}

export function contains(r: RangeAddr, row: number, col: number): boolean {
  return row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;
}

/** The merge a cell belongs to, if any. */
export function mergeAt(
  merges: readonly RangeAddr[],
  row: number,
  col: number,
): RangeAddr | undefined {
  for (const m of merges) if (contains(m, row, col)) return m;
  return undefined;
}

/**
 * A selection grown until it cuts no merge in two, as Excel's does: selecting
 * B2:C2 when B1:B3 is merged selects B1:C3.
 */
export function expandToMerges(range: RangeAddr, merges: readonly RangeAddr[]): RangeAddr {
  const r = { ...range };
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of merges) {
      if (!intersects(r, m)) continue;
      if (m.r0 < r.r0 || m.c0 < r.c0 || m.r1 > r.r1 || m.c1 > r.c1) {
        r.r0 = Math.min(r.r0, m.r0);
        r.c0 = Math.min(r.c0, m.c0);
        r.r1 = Math.max(r.r1, m.r1);
        r.c1 = Math.max(r.c1, m.c1);
        changed = true;
      }
    }
  }
  return r;
}

export type MergeMode = "merge" | "center" | "across";

/**
 * The merge list after merging `range`: any merge it touches is replaced.
 * "across" merges each row of the range on its own (Excel's Merge Across).
 */
export function addMerge(
  list: readonly string[] | undefined,
  range: RangeAddr,
  mode: MergeMode,
): string[] {
  const kept = parseMerges(list).filter((m) => !intersects(m, range));
  const added: RangeAddr[] =
    mode === "across"
      ? Array.from({ length: range.r1 - range.r0 + 1 }, (_, i) => ({
          r0: range.r0 + i,
          r1: range.r0 + i,
          c0: range.c0,
          c1: range.c1,
        }))
      : [range];
  return [...kept, ...added.filter((m) => m.r1 > m.r0 || m.c1 > m.c0)].map(rangeA1);
}

export function removeMerges(list: readonly string[] | undefined, range: RangeAddr): string[] {
  return parseMerges(list)
    .filter((m) => !intersects(m, range))
    .map(rangeA1);
}

/** The cells a merge would clear: every non-empty one but each merged block's top-left. */
export function cellsLostByMerge(
  range: RangeAddr,
  mode: MergeMode,
  filled: (row: number, col: number) => boolean,
): { row: number; col: number }[] {
  const lost: { row: number; col: number }[] = [];
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const keeper = mode === "across" ? c === range.c0 : r === range.r0 && c === range.c0;
      if (!keeper && filled(r, c)) lost.push({ row: r, col: c });
    }
  }
  return lost;
}

/**
 * Where a span of rows or columns goes when `count` are inserted (> 0) or
 * deleted (< 0) at `at`: it moves, grows around an insertion inside it,
 * shrinks by what was deleted from it, or is gone.
 */
export function shiftSpan(
  lo: number,
  hi: number,
  at: number,
  count: number,
): [number, number] | null {
  if (count > 0) return [lo >= at ? lo + count : lo, hi >= at ? hi + count : hi];
  const n = -count;
  const nlo = lo < at ? lo : lo >= at + n ? lo - n : at;
  const nhi = hi < at ? hi : hi >= at + n ? hi - n : at - 1;
  return nhi < nlo ? null : [nlo, nhi];
}

/** The merge list after rows or columns are inserted or deleted. */
export function shiftMerges(
  list: readonly string[] | undefined,
  axis: "rows" | "cols",
  at: number,
  count: number,
): string[] | undefined {
  if (!list?.length) return list ? [...list] : undefined;
  const out: RangeAddr[] = [];
  for (const m of parseMerges(list)) {
    const span =
      axis === "rows" ? shiftSpan(m.r0, m.r1, at, count) : shiftSpan(m.c0, m.c1, at, count);
    if (!span) continue;
    const next =
      axis === "rows" ? { ...m, r0: span[0], r1: span[1] } : { ...m, c0: span[0], c1: span[1] };
    if (next.r1 > next.r0 || next.c1 > next.c0) out.push(next);
  }
  return out.map(rangeA1);
}
