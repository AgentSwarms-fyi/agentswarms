// Arrays in formulas: several values combined element by element, as Excel's
// dynamic arrays do, and the blank rows past the data of a whole column.
//
// A whole column (A:A) is 1,048,576 rows, but the engine reads it only as far
// as the sheet is used. The rows past that are blank, and every one of them
// goes through the same arithmetic: in (A:A="") each is TRUE. So an array
// keeps them as a TAIL: how many there are, and one line holding what each of
// them holds by now. Operators, IF and element-wise functions carry the tail
// along; SUMPRODUCT, SUM, COUNT and the like count it without building it.
// FOUND IN R146: SUMPRODUCT(--(A:A="")) was 0 where Excel says 1,048,573.

import { MAX_COLS, MAX_ROWS } from "../a1";
import { err, isMatrix, type Matrix, type Scalar, type Value } from "./values";

export type Tail = {
  /** "rows": blank rows below (a whole column); "cols": blank columns to the right (a whole row). */
  axis: "rows" | "cols";
  /** How many. */
  n: number;
  /** What each holds: one row across the columns ("rows"), or one column down the rows ("cols"). */
  line: Scalar[];
};

const TAILS = new WeakMap<Matrix, Tail>();

export const tailOf = (v: Value): Tail | undefined => (isMatrix(v) ? TAILS.get(v) : undefined);

export function withTail(m: Matrix, t: Tail | undefined): Matrix {
  if (t && t.n > 0) TAILS.set(m, t);
  return m;
}

/** A range of cells, as a function that answers with one names it (R338). */
export type Area = { sheet: string; r0: number; c0: number; r1: number; c1: number };

const AREAS = new WeakMap<Matrix, Area>();

/**
 * The range INDEX, OFFSET or INDIRECT answered with, kept with the values
 * read from it. FOUND IN R338: @ took the top-left value of such an answer,
 * where Excel's @ takes the cell in the formula's own row or column, as it
 * does for a range written out: in row 5, =@INDEX(A2:B7,0,2) is B5.
 */
export function withArea(v: Value, area: Area): Value {
  if (isMatrix(v)) AREAS.set(v, area);
  return v;
}

export const areaOf = (v: Value): Area | undefined => (isMatrix(v) ? AREAS.get(v) : undefined);

/** A whole column or row as read: the used part, and the blank rest as its tail. */
export function wholeRange(m: Matrix, whole: "cols" | "rows"): Matrix {
  const width = m[0]?.length ?? 0;
  return whole === "cols"
    ? withTail(m.slice(), { axis: "rows", n: MAX_ROWS - m.length, line: Array(width).fill(null) })
    : withTail(m.slice(), { axis: "cols", n: MAX_COLS - width, line: Array(m.length).fill(null) });
}

const along = (m: Matrix, axis: Tail["axis"]) => (axis === "rows" ? m.length : (m[0]?.length ?? 0));

/**
 * A tailed array made explicit as far as `len` along its tail's axis, so that
 * arrays read to different depths (whole columns of two sheets) line up.
 */
export function extend(m: Matrix, t: Tail, len: number): { m: Matrix; t: Tail } {
  const have = along(m, t.axis);
  if (len <= have) return { m, t };
  const k = Math.min(len - have, t.n);
  const out =
    t.axis === "rows"
      ? [...m, ...Array.from({ length: k }, () => t.line.slice())]
      : m.map((row, r) => [...row, ...Array<Scalar>(k).fill(t.line[r] ?? null)]);
  const next = { ...t, n: t.n - k };
  return { m: withTail(out, next), t: next };
}

/** Tailed arrays among `vals` lined up to the longest array; null when the tails cannot be carried. */
export function lineUp(vals: Value[]): {
  ms: (Matrix | null)[];
  tails: (Tail | undefined)[];
  axis: Tail["axis"] | null;
} {
  const ms: (Matrix | null)[] = vals.map((v) => (isMatrix(v) ? v : null));
  const tails = vals.map((v) => tailOf(v));
  const axes = new Set(tails.flatMap((t) => (t ? [t.axis] : [])));
  // A whole column against a whole row: no single tail describes the rest.
  if (axes.size !== 1) return { ms, tails: tails.map(() => undefined), axis: null };
  const axis = [...axes][0];
  const len = Math.max(...ms.map((m) => (m ? along(m, axis) : 0)));
  const out = ms.map((m, i) => {
    const t = tails[i];
    if (!m || !t) return m;
    const e = extend(m, t, len);
    tails[i] = e.t;
    return e.m;
  });
  return { ms: out, tails, axis };
}

/**
 * Values combined element by element, Excel's way: arrays of one size pair
 * up, a single row or column repeats across the other, a scalar repeats
 * everywhere, and a position an array does not reach is #N/A. The answer
 * carries the whole columns' blank tails when every array either has the tail
 * or repeats across it.
 */
export function zipN(vals: Value[], fn: (xs: Scalar[]) => Scalar): Value {
  if (!vals.some(isMatrix)) return fn(vals as Scalar[]);
  const { ms, tails, axis } = lineUp(vals);
  const rows = Math.max(...ms.map((m) => (m ? m.length : 1)));
  const cols = Math.max(...ms.map((m) => (m ? (m[0]?.length ?? 0) : 1)));
  const pick = (m: Matrix, r: number, c: number): Scalar | undefined => {
    const rr = m.length === 1 ? 0 : r;
    const cc = (m[0]?.length ?? 0) === 1 ? 0 : c;
    return m[rr]?.[cc];
  };
  const out: Matrix = [];
  for (let r = 0; r < rows; r++) {
    const line: Scalar[] = [];
    for (let c = 0; c < cols; c++) {
      const xs: Scalar[] = [];
      let missing = false;
      for (let i = 0; i < vals.length; i++) {
        const m = ms[i];
        if (!m) {
          xs.push(vals[i] as Scalar);
          continue;
        }
        const x = pick(m, r, c);
        if (x === undefined) {
          missing = true;
          break;
        }
        xs.push(x);
      }
      line.push(missing ? err("#N/A") : fn(xs));
    }
    out.push(line);
  }
  return withTail(out, axis ? tailAfter(vals, ms, tails, axis, fn) : undefined);
}

function tailAfter(
  vals: Value[],
  ms: (Matrix | null)[],
  tails: (Tail | undefined)[],
  axis: Tail["axis"],
  fn: (xs: Scalar[]) => Scalar,
): Tail | undefined {
  const ns = tails.flatMap((t) => (t ? [t.n] : []));
  const n = ns[0];
  if (!(n > 0) || ns.some((x) => x !== n)) return undefined;
  let size = 1;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (!m) continue;
    const t = tails[i];
    if (t) size = Math.max(size, t.line.length);
    // An array that stops where the tail begins is #N/A there in Excel; the
    // answer is then only what was read, as before.
    else if (along(m, axis) !== 1) return undefined;
    else size = Math.max(size, axis === "rows" ? (m[0]?.length ?? 0) : m.length);
  }
  const line: Scalar[] = [];
  for (let k = 0; k < size; k++) {
    const xs: (Scalar | undefined)[] = vals.map((v, i) => {
      const m = ms[i];
      if (!m) return v as Scalar;
      const t = tails[i];
      const src = t ? t.line : axis === "rows" ? m[0] : m.map((row) => row[0]);
      return src.length === 1 ? src[0] : src[k];
    });
    line.push(xs.some((x) => x === undefined) ? err("#N/A") : fn(xs as Scalar[]));
  }
  return { axis, n, line };
}
