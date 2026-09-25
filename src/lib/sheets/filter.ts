// A grid sheet's AutoFilter, as Excel's Data > Filter works: a range whose
// first row holds the headers; each column may keep only some values or
// only rows meeting a condition; rows that fail are hidden (not deleted),
// and sorting reorders the rows under the headers.

import { parseRangeA1, type RangeAddr } from "./a1";
import type { CellInput } from "./engine";
import { shiftFormula } from "./formula/shift";
import { isError, type Scalar } from "./formula/values";

export type FilterCond = {
  op:
    | "eq"
    | "ne"
    | "gt"
    | "ge"
    | "lt"
    | "le"
    | "between"
    | "contains"
    | "notContains"
    | "begins"
    | "ends"
    | "blank"
    | "notBlank"
    | "top"
    | "bottom"
    | "aboveAverage"
    | "belowAverage";
  a?: string;
  b?: string;
};

export type ColumnFilter = {
  /** The shown values kept (as displayed text; "" is the blanks). */
  values?: string[];
  cond?: FilterCond;
};

export type AutoFilter = {
  /** Header row and data, "A1:F200". */
  range: string;
  /** By column offset within the range. */
  cols: Record<string, ColumnFilter>;
  /** Rows the filter hides, as last applied (Excel keeps them until Reapply). */
  hidden?: number[];
};

export type FilterEnv = {
  value: (row: number, col: number) => Scalar;
  text: (row: number, col: number) => string;
};

/** The data rows of a filter range (below the header). */
export function dataRows(r: RangeAddr): number[] {
  const out: number[] = [];
  for (let row = r.r0 + 1; row <= r.r1; row++) out.push(row);
  return out;
}

function num(v: Scalar): number | null {
  return typeof v === "number" ? v : null;
}

function condTest(
  cond: FilterCond,
  v: Scalar,
  text: string,
  stats: () => { sorted: number[]; avg: number },
): boolean {
  const t = text.toLowerCase();
  const q = (cond.a ?? "").toLowerCase();
  const n = num(v);
  const an = cond.a !== undefined && cond.a.trim() !== "" ? Number(cond.a) : NaN;
  const bn = cond.b !== undefined && cond.b.trim() !== "" ? Number(cond.b) : NaN;
  const cmp = (x: number | null, y: number) => (x === null || !Number.isFinite(y) ? null : x - y);
  switch (cond.op) {
    case "eq":
      return Number.isFinite(an) && n !== null ? n === an : t === q;
    case "ne":
      return Number.isFinite(an) && n !== null ? n !== an : t !== q;
    case "gt":
      return (cmp(n, an) ?? -1) > 0;
    case "ge":
      return (cmp(n, an) ?? -1) >= 0;
    case "lt":
      return (cmp(n, an) ?? 1) < 0;
    case "le":
      return (cmp(n, an) ?? 1) <= 0;
    case "between":
      return (
        n !== null &&
        Number.isFinite(an) &&
        Number.isFinite(bn) &&
        n >= Math.min(an, bn) &&
        n <= Math.max(an, bn)
      );
    case "contains":
      return t.includes(q);
    case "notContains":
      return !t.includes(q);
    case "begins":
      return t.startsWith(q);
    case "ends":
      return t.endsWith(q);
    case "blank":
      return t === "";
    case "notBlank":
      return t !== "";
    case "top":
    case "bottom": {
      if (n === null) return false;
      const { sorted } = stats();
      const k = Math.max(1, Math.floor(Number.isFinite(an) ? an : 10));
      if (!sorted.length) return false;
      return cond.op === "top"
        ? n >= sorted[Math.max(0, sorted.length - k)]
        : n <= sorted[Math.min(sorted.length, k) - 1];
    }
    case "aboveAverage":
      return n !== null && n > stats().avg;
    case "belowAverage":
      return n !== null && n < stats().avg;
  }
}

/** The rows a filter hides: those failing any column's filter. */
export function filteredRows(f: AutoFilter, env: FilterEnv): number[] {
  const r = parseRangeA1(f.range);
  if (!r) return [];
  const rows = dataRows(r);
  const hidden: number[] = [];
  const colStats = new Map<number, { sorted: number[]; avg: number }>();
  const statsFor = (col: number) => () => {
    let s = colStats.get(col);
    if (!s) {
      const nums = rows
        .map((row) => num(env.value(row, col)))
        .filter((x): x is number => x !== null)
        .sort((a, b) => a - b);
      s = { sorted: nums, avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0 };
      colStats.set(col, s);
    }
    return s;
  };
  for (const row of rows) {
    let keep = true;
    for (const [k, cf] of Object.entries(f.cols)) {
      const col = r.c0 + Number(k);
      if (col > r.c1) continue;
      const v = env.value(row, col);
      const text = isError(v) ? v.err : env.text(row, col);
      if (cf.values && !cf.values.includes(text)) {
        keep = false;
        break;
      }
      if (cf.cond && !condTest(cf.cond, v, text, statsFor(col))) {
        keep = false;
        break;
      }
    }
    if (!keep) hidden.push(row);
  }
  return hidden;
}

/** Every distinct shown value in a column's data rows, with counts, sorted as Excel lists them. */
export function columnValues(
  f: Pick<AutoFilter, "range">,
  colOffset: number,
  env: FilterEnv,
): { text: string; count: number }[] {
  const r = parseRangeA1(f.range);
  if (!r) return [];
  const col = r.c0 + colOffset;
  const counts = new Map<string, number>();
  for (const row of dataRows(r)) {
    const v = env.value(row, col);
    const t = isError(v) ? v.err : env.text(row, col);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) =>
      a.text === ""
        ? 1
        : b.text === ""
          ? -1
          : a.text.localeCompare(b.text, undefined, { numeric: true }),
    );
}

export type SortKey = { col: number; desc?: boolean };

/** Excel's sort order: numbers, then text (no case), then booleans, then errors, then blanks last. */
export function compareForSort(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) =>
    v === null || v === ""
      ? 5
      : typeof v === "number"
        ? 0
        : typeof v === "string"
          ? 1
          : typeof v === "boolean"
            ? 2
            : 3;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string")
    return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return 0;
}

/**
 * The cell edits that sort a range's rows (the header row stays put). A
 * formula moving from row r to row r' has its relative references moved by
 * r' - r, as Excel's sort does; formats move with their rows. Blanks sort
 * last whichever way.
 */
export function sortEdits(
  range: RangeAddr,
  keys: SortKey[],
  env: {
    value: (row: number, col: number) => Scalar;
    input: (row: number, col: number) => CellInput | undefined;
  },
  hasHeader = true,
): {
  row: number;
  col: number;
  input: string;
  format: string | null;
  style: CellInput["s"] | null;
  link: string | null;
}[] {
  const first = range.r0 + (hasHeader ? 1 : 0);
  const rows: number[] = [];
  for (let r = first; r <= range.r1; r++) rows.push(r);
  const order = [...rows].sort((x, y) => {
    for (const k of keys) {
      const a = env.value(x, k.col);
      const b = env.value(y, k.col);
      const blankA = a === null || a === "";
      const blankB = b === null || b === "";
      if (blankA !== blankB) return blankA ? 1 : -1;
      const c = compareForSort(a, b);
      if (c !== 0) return k.desc ? -c : c;
    }
    return x - y; // stable
  });
  const edits: {
    row: number;
    col: number;
    input: string;
    format: string | null;
    style: CellInput["s"] | null;
    link: string | null;
  }[] = [];
  order.forEach((src, i) => {
    const dst = rows[i];
    for (let c = range.c0; c <= range.c1; c++) {
      const cell = env.input(src, c);
      const input = cell?.i ?? "";
      edits.push({
        row: dst,
        col: c,
        input: input.startsWith("=") && dst !== src ? shiftFormula(input, dst - src, 0) : input,
        format: cell?.f ?? null,
        style: cell?.s ?? null,
        link: cell?.l ?? null,
      });
    }
  });
  return edits;
}

/** The block of data around a cell, as Excel's "current region": bounded by empty rows and columns. */
export function currentRegion(
  row: number,
  col: number,
  filled: (row: number, col: number) => boolean,
  limit = { rows: 1_048_576, cols: 16_384 },
): RangeAddr {
  let r0 = row;
  let r1 = row;
  let c0 = col;
  let c1 = col;
  const rowHas = (r: number) => {
    for (let c = Math.max(0, c0 - 1); c <= Math.min(limit.cols - 1, c1 + 1); c++)
      if (filled(r, c)) return true;
    return false;
  };
  const colHas = (c: number) => {
    for (let r = Math.max(0, r0 - 1); r <= Math.min(limit.rows - 1, r1 + 1); r++)
      if (filled(r, c)) return true;
    return false;
  };
  for (let grew = true, steps = 0; grew && steps < 100_000; steps++) {
    grew = false;
    if (r0 > 0 && rowHas(r0 - 1)) {
      r0--;
      grew = true;
    }
    if (r1 < limit.rows - 1 && rowHas(r1 + 1)) {
      r1++;
      grew = true;
    }
    if (c0 > 0 && colHas(c0 - 1)) {
      c0--;
      grew = true;
    }
    if (c1 < limit.cols - 1 && colHas(c1 + 1)) {
      c1++;
      grew = true;
    }
  }
  return { r0, c0, r1, c1 };
}
