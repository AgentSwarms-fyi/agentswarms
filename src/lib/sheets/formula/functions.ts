// The Sheets function library.
//
// The functions people use every day are written here against Excel's
// semantics: which arguments are references, how blanks and text count,
// criteria strings with wildcards, lookup match modes, dynamic arrays. The
// long tail (financial, statistical, engineering) comes from formula.js, with
// its inputs and outputs converted at the boundary, because some of its
// answers differ from Excel's in ways this file corrects (DATE returns a
// local JS Date, UNIQUE mishandles columns, TEXT ignores dates, VALUE("x") is
// 0, COUNTA skips "").

import * as formulajs from "@formulajs/formulajs";
import type { Arg, FnCtx, FnImpl } from "./evaluate";
import { excelRound, formatValue } from "../format";
import {
  compareScalars,
  dateSerial,
  err,
  flat,
  isError,
  isMatrix,
  jsDateToSerial,
  nowSerial,
  numberText,
  parseNumberText,
  scalarOf,
  serialParts,
  todaySerial,
  toBool,
  toNumber,
  toText,
  type Matrix,
  type Scalar,
  type SheetError,
  type Value,
} from "./values";
import type { ErrorCode } from "./lexer";
import { colLetters, MAX_COLS, MAX_ROWS } from "../a1";
import { parseFormula } from "./parser";
import { lineUp, tailOf, withTail, zipN, type Tail } from "./arrays";

// ── Helpers ────────────────────────────────────────────────────────────────

const asMatrix = (v: Value): Matrix => (isMatrix(v) ? v : [[v]]);

function firstError(values: Scalar[]): SheetError | null {
  for (const v of values) if (isError(v)) return v;
  return null;
}

/**
 * Numbers for SUM/AVERAGE/MIN/MAX. From a reference, only numbers count
 * (text, TRUE and blanks are skipped). A value typed straight into the
 * arguments is coerced (TRUE is 1, "5" is 5), and text that is not a number
 * is #VALUE!. Errors anywhere propagate.
 */
function collectNumbers(args: Arg[]): number[] | SheetError {
  const out: number[] = [];
  for (const a of args) {
    if (a.node.k === "empty") continue;
    const v = a.value();
    if (a.isRef || isMatrix(v)) {
      for (const x of flat(v)) {
        if (isError(x)) return x;
        if (typeof x === "number") out.push(x);
      }
    } else {
      const n = toNumber(v);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function num(a: Arg | undefined, dflt?: number): number | SheetError {
  if (!a || a.node.k === "empty") return dflt ?? 0;
  return toNumber(scalarOf(a.value()));
}

function text(a: Arg | undefined, dflt = ""): string | SheetError {
  if (!a || a.node.k === "empty") return dflt;
  return toText(scalarOf(a.value()));
}

function bool(a: Arg | undefined, dflt = false): boolean | SheetError {
  if (!a || a.node.k === "empty") return dflt;
  return toBool(scalarOf(a.value()));
}

const arity = (args: Arg[], min: number, max = Infinity): SheetError | null =>
  args.length < min || args.length > max ? err("#N/A", "Wrong number of arguments") : null;

/** Excel wildcards (* and ?, with ~ escaping *, ? or ~) → RegExp source; the rest is literal. */
export function wildcardSource(pattern: string): string {
  const lit = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length && "*?~".includes(pattern[i + 1])) {
      out += lit(pattern[i + 1]);
      i++;
    } else if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += lit(ch);
  }
  return out;
}

/** Excel criteria: 5, ">5", "<>x", "=", "a*", "?b", "~*" → predicate. */
export function makeCriterion(crit: Scalar): (v: Scalar) => boolean {
  if (typeof crit === "number" || typeof crit === "boolean") {
    return (v) => compareScalars(v, crit) === 0 && typeof v === typeof crit;
  }
  if (crit === null) return (v) => v === null || v === "";
  if (isError(crit)) return (v) => isError(v) && v.err === crit.err;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(crit)!;
  const op = m[1] ?? "=";
  const rhsText = m[2];
  const rhsNum = parseNumberText(rhsText);
  if (rhsNum !== null && rhsText.trim() !== "") {
    return (v) => {
      const n = typeof v === "number" ? v : typeof v === "string" ? parseNumberText(v) : null;
      if (n === null) return op === "<>";
      switch (op) {
        case "=":
          return n === rhsNum;
        case "<>":
          return n !== rhsNum;
        case "<":
          return n < rhsNum;
        case ">":
          return n > rhsNum;
        case "<=":
          return n <= rhsNum;
        case ">=":
          return n >= rhsNum;
      }
      return false;
    };
  }
  if (op === "=" || op === "<>") {
    if (rhsText === "") {
      // "=" matches blanks; "<>" matches non-blanks.
      return op === "=" ? (v) => v === null || v === "" : (v) => !(v === null || v === "");
    }
    const upper = rhsText.toUpperCase();
    if (upper === "TRUE" || upper === "FALSE") {
      const b = upper === "TRUE";
      return (v) => (op === "=") === (v === b);
    }
    const hasWild = /(?<!~)[*?]/.test(rhsText);
    const re = hasWild ? new RegExp(`^${wildcardSource(rhsText)}$`, "is") : null;
    const lit = rhsText.replace(/~([*?~])/g, "$1").toLowerCase();
    return (v) => {
      const s = typeof v === "string" ? v : v === null ? "" : null;
      const hit = s !== null && (re ? re.test(s) : s.toLowerCase() === lit);
      return op === "=" ? hit : !hit;
    };
  }
  // < > <= >= against text compare as text.
  return (v) => {
    if (typeof v !== "string") return false;
    const c = compareScalars(v, rhsText);
    return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
  };
}

/**
 * Cells past the part of a whole column (A:A) or whole row (1:1) the sheet
 * uses. The engine reads only the used part; in Excel A:A is all 1,048,576
 * rows, and the ones past the data are blank. FOUND IN R140: ROWS(A:A) was the
 * used rows, COUNTBLANK(A:A) 0, and COUNTIF(A:A,"<>x") counted no blanks.
 */
function blankTail(a: Arg): number {
  const r = a.ref;
  if (!r?.whole) return 0;
  const rows = r.r1 - r.r0 + 1;
  const cols = r.c1 - r.c0 + 1;
  return r.whole === "cols" ? (MAX_ROWS - rows) * cols : (MAX_COLS - cols) * rows;
}

/**
 * The cells of ranges read together (criteria ranges, and the values range),
 * lined up, and the blank cells all of them have past what was read. Whole
 * columns on sheets used to different depths are padded with blanks to the
 * longest, as Excel's are all the same length (R140).
 */
function lined(args: Arg[]): { lists: Scalar[][]; tail: number } | SheetError {
  let ms = args.map((a) => asMatrix(a.value()));
  const kinds = args.map((a) => a.ref?.whole);
  let tail = 0;
  if (kinds.every((k) => k === "cols")) {
    const rows = Math.max(...ms.map((m) => m.length));
    ms = ms.map((m) =>
      m.length < rows
        ? [...m, ...Array.from({ length: rows - m.length }, () => m[0].map(() => null))]
        : m,
    );
    tail = (MAX_ROWS - rows) * (ms[0][0]?.length ?? 1);
  } else if (kinds.every((k) => k === "rows")) {
    const cols = Math.max(...ms.map((m) => m[0]?.length ?? 0));
    ms = ms.map((m) => m.map((line) => [...line, ...Array(cols - line.length).fill(null)]));
    tail = (MAX_COLS - cols) * ms[0].length;
  }
  const lists = ms.map(flat);
  if (lists.some((l) => l.length !== lists[0].length))
    return err("#VALUE!", "Criteria ranges differ in size");
  return { lists, tail };
}

/** Which cells meet every criterion, and whether the blank cells past them all do. */
function criteriaMask(
  pairs: [Arg, Arg][],
  also: Arg[] = [],
): { mask: boolean[]; lists: Scalar[][]; tailCounts: boolean; tail: number } | SheetError {
  const got = lined([...also, ...pairs.map(([r]) => r)]);
  if (isError(got)) return got;
  const lists = got.lists.slice(also.length);
  let mask: boolean[] | null = null;
  let tailCounts = true;
  pairs.forEach(([, critArg], k) => {
    const pred = makeCriterion(scalarOf(critArg.value()));
    const m = lists[k].map((v) => pred(v));
    mask = mask ? mask.map((x, i) => x && m[i]) : m;
    tailCounts = tailCounts && pred(null);
  });
  return { mask: mask ?? [], lists: got.lists, tailCounts, tail: got.tail };
}

function toFormulaJs(v: Value): unknown {
  const conv = (x: Scalar): unknown => {
    if (isError(x)) return new Error(x.err);
    return x;
  };
  return isMatrix(v) ? v.map((r) => r.map(conv)) : conv(v);
}

function fromFormulaJs(r: unknown): Value {
  const conv = (x: unknown): Scalar => {
    if (x === undefined || x === null) return null;
    if (x instanceof Error) {
      const code = x.message as ErrorCode;
      return err(code.startsWith("#") ? code : "#VALUE!");
    }
    if (x instanceof Date) return jsDateToSerial(x);
    if (typeof x === "number") return Number.isFinite(x) ? x : err("#NUM!");
    if (typeof x === "string" || typeof x === "boolean") return x;
    return err("#VALUE!");
  };
  if (Array.isArray(r)) {
    if (r.length && Array.isArray(r[0])) return (r as unknown[][]).map((row) => row.map(conv));
    return [(r as unknown[]).map(conv)];
  }
  return conv(r);
}

/**
 * As collectNumbers, for STDEVA: from a reference, text counts as 0 and TRUE
 * as 1. Blanks are still skipped.
 */
function collectNumbersA(args: Arg[]): number[] | SheetError {
  const out: number[] = [];
  for (const a of args) {
    if (a.node.k === "empty") continue;
    const v = a.value();
    if (a.isRef || isMatrix(v)) {
      for (const x of flat(v)) {
        if (isError(x)) return x;
        if (typeof x === "number") out.push(x);
        else if (typeof x === "boolean") out.push(x ? 1 : 0);
        else if (typeof x === "string") out.push(0);
      }
    } else {
      const n = toNumber(v);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/**
 * Two lists read side by side, as CORREL and SLOPE read them: a position
 * where either is not a number is left out. Lists of different sizes are
 * #N/A.
 */
function pairedNumbers(a: Arg, b: Arg): [number[], number[]] | SheetError {
  const xs = flat(asMatrix(a.value()));
  const ys = flat(asMatrix(b.value()));
  if (xs.length !== ys.length) return err("#N/A", "The two ranges are different sizes");
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (isError(x)) return x;
    if (isError(y)) return y;
    if (typeof x === "number" && typeof y === "number") {
      px.push(x);
      py.push(y);
    }
  }
  return [px, py];
}

/** Argument indices from `k` on. */
const fromIndex = (k: number) => (n: number) =>
  Array.from({ length: Math.max(0, n - k) }, (_, i) => k + i);

/**
 * How formula.js is given the arguments it reads differently from Excel
 * (R170). It counted a blank cell in a range as 0 (GEOMEAN(A1:A3) was 0,
 * SMALL and PERCENTILE ranked the blank, NPV discounted it as a period),
 * paired a blank with a number (CORREL, SLOPE), refused text or TRUE in a
 * range (SUMSQ, RANK, MODE: #VALUE!), and took no single value where it
 * wanted an array (VSTACK("Name",A2:A9), TAKE(A1,1): #VALUE!).
 */
type LibraryArgs = {
  /** Lists of numbers, read as SUM reads them: from a reference only numbers count. */
  lists?: (n: number) => number[];
  /** The lists count text in a reference as 0 and TRUE as 1 (STDEVA). */
  countAll?: boolean;
  /** Two lists read side by side (pairedNumbers). */
  pairs?: [number, number];
  /** Arrays: one value is a 1×1 array. */
  arrays?: (n: number) => number[];
  /** A rank of 0 is a number not in the list: #N/A, as Excel's (formula.js says 0). */
  rank?: boolean;
};
const EVERY_LIST: LibraryArgs = { lists: fromIndex(0) };
const FIRST_LIST: LibraryArgs = { lists: () => [0] };
/** Keyed by the name formula.js has; the older names (STDEV, RANK…) are SAME_AS these. */
const LIBRARY_ARGS: Record<string, LibraryArgs> = {
  SUMSQ: EVERY_LIST,
  "STDEV.S": EVERY_LIST,
  "STDEV.P": EVERY_LIST,
  STDEVP: EVERY_LIST,
  STDEVA: { lists: fromIndex(0), countAll: true },
  VARA: { lists: fromIndex(0), countAll: true },
  "VAR.S": EVERY_LIST,
  "VAR.P": EVERY_LIST,
  GEOMEAN: EVERY_LIST,
  HARMEAN: EVERY_LIST,
  AVEDEV: EVERY_LIST,
  DEVSQ: EVERY_LIST,
  KURT: EVERY_LIST,
  SKEW: EVERY_LIST,
  "MODE.SNGL": EVERY_LIST,
  LARGE: FIRST_LIST,
  SMALL: FIRST_LIST,
  "PERCENTILE.INC": FIRST_LIST,
  "PERCENTILE.EXC": FIRST_LIST,
  "QUARTILE.INC": FIRST_LIST,
  // R258. Each checked against the answer Excel's documentation gives.
  "QUARTILE.EXC": FIRST_LIST,
  "PERCENTRANK.INC": FIRST_LIST,
  "PERCENTRANK.EXC": FIRST_LIST,
  TRIMMEAN: FIRST_LIST,
  // From a reference, text is 0 and TRUE 1, as STDEVA (and as Excel's A-functions).
  AVERAGEA: { lists: fromIndex(0), countAll: true },
  MAXA: { lists: fromIndex(0), countAll: true },
  MINA: { lists: fromIndex(0), countAll: true },
  MMULT: { arrays: () => [0, 1] },
  IRR: FIRST_LIST,
  // Excel's MIRR skips blanks and text in its values, as IRR does (R177).
  MIRR: FIRST_LIST,
  "RANK.EQ": { lists: () => [1], rank: true },
  "RANK.AVG": { lists: () => [1], rank: true },
  NPV: { lists: fromIndex(1) },
  CORREL: { pairs: [0, 1] },
  "COVARIANCE.S": { pairs: [0, 1] },
  "COVARIANCE.P": { pairs: [0, 1] },
  SLOPE: { pairs: [0, 1] },
  INTERCEPT: { pairs: [0, 1] },
  RSQ: { pairs: [0, 1] },
  FORECAST: { pairs: [1, 2] },
  TAKE: { arrays: () => [0] },
  DROP: { arrays: () => [0] },
  CHOOSECOLS: { arrays: () => [0] },
  CHOOSEROWS: { arrays: () => [0] },
  VSTACK: { arrays: fromIndex(0) },
  HSTACK: { arrays: fromIndex(0) },
};

/** Wrap a formula.js function: arguments evaluated eagerly, converted both ways. */
function fromLibrary(name: string): FnImpl | undefined {
  // R262: the exact Excel name first (formula.js keeps CHISQ.DIST, T.INV.2T,
  // BINOM.INV and CONFIDENCE.NORM only as CHISQ.DIST and so on, with no
  // flattened twin), then the flattened one. Measured over all 179 names
  // registered before this round: where both exist they are the same
  // function, so nothing that worked changes. NOTE the flattened LEGACY names
  // are formula.js's MODERN functions under an old spelling - its FDIST is
  // F.DIST, its TINV is T.INV, its BETADIST takes BETA.DIST's arguments - so
  // an old Excel name must never be resolved here: give it a SAME_AS or write it.
  const nested = name
    .split(".")
    .reduce<unknown>(
      (o, k) =>
        o && (typeof o === "object" || typeof o === "function")
          ? (o as Record<string, unknown>)[k]
          : undefined,
      formulajs,
    );
  const fn =
    typeof nested === "function"
      ? nested
      : (formulajs as unknown as Record<string, unknown>)[name.replace(/\./g, "")];
  if (typeof fn !== "function") return undefined;
  const how = LIBRARY_ARGS[name] ?? {};
  return (args) => {
    const lists = new Set(how.lists?.(args.length));
    const arrays = new Set(how.arrays?.(args.length));
    const vals: unknown[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.node.k === "empty" || how.pairs?.includes(i)) vals.push(undefined);
      else if (lists.has(i)) {
        const xs = how.countAll ? collectNumbersA([a]) : collectNumbers([a]);
        if (isError(xs)) return xs;
        vals.push(xs);
      } else if (arrays.has(i)) vals.push(toFormulaJs(asMatrix(a.value())));
      else vals.push(toFormulaJs(a.value()));
    }
    if (how.pairs) {
      const [i, j] = how.pairs;
      if (!args[i] || !args[j]) return err("#N/A", "Wrong number of arguments");
      const got = pairedNumbers(args[i], args[j]);
      if (isError(got)) return got;
      [vals[i], vals[j]] = got;
    }
    try {
      const out = fromFormulaJs((fn as (...x: unknown[]) => unknown)(...vals));
      return how.rank && out === 0 ? err("#N/A", "The number is not in the list") : out;
    } catch {
      return err("#VALUE!");
    }
  };
}

/**
 * The numbers the blank tail of an array holds once computed, each with how
 * many rows (or columns) hold it: (A:A="")*1 is 1 in every blank row past the
 * data. A range's own tail is blank and adds nothing (R146).
 */
function tailNumbers(args: Arg[]): { x: number; n: number }[] | SheetError {
  const out: { x: number; n: number }[] = [];
  for (const a of args) {
    if (a.node.k === "empty") continue;
    const t = tailOf(a.value());
    if (!t) continue;
    for (const x of t.line) {
      if (isError(x)) return x;
      if (typeof x === "number") out.push({ x, n: t.n });
    }
  }
  return out;
}

/** Numbers and tails together, for the aggregates. */
function numbersWithTails(
  args: Arg[],
): { xs: number[]; tails: { x: number; n: number }[] } | SheetError {
  const xs = collectNumbers(args);
  if (isError(xs)) return xs;
  const tails = tailNumbers(args);
  if (isError(tails)) return tails;
  return { xs, tails };
}

// ── The library ────────────────────────────────────────────────────────────

const F: Record<string, FnImpl> = {};

// Aggregates
F.SUM = (args) => {
  const g = numbersWithTails(args);
  if (isError(g)) return g;
  return g.xs.reduce((s, x) => s + x, 0) + g.tails.reduce((s, t) => s + t.x * t.n, 0);
};
F.PRODUCT = (args) => {
  const g = numbersWithTails(args);
  if (isError(g)) return g;
  if (!g.xs.length && !g.tails.length) return 0;
  const r = g.xs.reduce((s, x) => s * x, 1) * g.tails.reduce((s, t) => s * t.x ** t.n, 1);
  return Number.isFinite(r) ? r : err("#NUM!");
};
F.AVERAGE = (args) => {
  const g = numbersWithTails(args);
  if (isError(g)) return g;
  const count = g.xs.length + g.tails.reduce((s, t) => s + t.n, 0);
  if (!count) return err("#DIV/0!");
  return (g.xs.reduce((s, x) => s + x, 0) + g.tails.reduce((s, t) => s + t.x * t.n, 0)) / count;
};
F.MIN = (args) => {
  const g = numbersWithTails(args);
  if (isError(g)) return g;
  const all = [...g.xs, ...g.tails.map((t) => t.x)];
  return all.length ? Math.min(...all) : 0;
};
F.MAX = (args) => {
  const g = numbersWithTails(args);
  if (isError(g)) return g;
  const all = [...g.xs, ...g.tails.map((t) => t.x)];
  return all.length ? Math.max(...all) : 0;
};
F.MEDIAN = (args) => {
  const g = numbersWithTails(args);
  if (isError(g)) return g;
  // Each value with how many times it occurs; the middle one (or two) by count.
  const w = [...g.xs.map((x) => ({ x, n: 1 })), ...g.tails].sort((a, b) => a.x - b.x);
  const total = w.reduce((s, t) => s + t.n, 0);
  if (!total) return err("#NUM!");
  const at = (k: number) => {
    let seen = 0;
    for (const t of w) {
      seen += t.n;
      if (k < seen) return t.x;
    }
    return w[w.length - 1].x;
  };
  return total % 2 ? at((total - 1) / 2) : (at(total / 2 - 1) + at(total / 2)) / 2;
};
F.COUNT = (args) => {
  let c = 0;
  for (const a of args) {
    if (a.node.k === "empty") continue;
    const v = a.value();
    if (a.isRef || isMatrix(v)) c += flat(v).filter((x) => typeof x === "number").length;
    else if (!isError(toNumber(scalarOf(v))) && scalarOf(v) !== null) c++;
    const t = tailOf(v);
    if (t) c += t.n * t.line.filter((x) => typeof x === "number").length;
  }
  return c;
};
F.COUNTA = (args) => {
  let c = 0;
  for (const a of args) {
    if (a.node.k === "empty") continue;
    const v = a.value();
    c += flat(v).filter((x) => x !== null).length;
    const t = tailOf(v);
    if (t) c += t.n * t.line.filter((x) => x !== null).length;
  }
  return c;
};
F.COUNTBLANK = (args) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  return flat(args[0].value()).filter((x) => x === null || x === "").length + blankTail(args[0]);
};
F.SUMPRODUCT = (args) => {
  if (!args.length) return err("#VALUE!");
  // Whole columns line up (two sheets used to different depths), and their
  // blank tails, computed, count too (R146).
  const lined = lineUp(args.map((a) => a.value()));
  const ms = lined.ms.map((m, i) => m ?? asMatrix(args[i].value()));
  const tails = lined.tails;
  const rows = ms[0].length;
  const cols = ms[0][0]?.length ?? 0;
  if (ms.some((m) => m.length !== rows || (m[0]?.length ?? 0) !== cols)) return err("#VALUE!");
  let total = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let p = 1;
      for (const m of ms) {
        const x = m[r][c];
        if (isError(x)) return x;
        p *= typeof x === "number" ? x : 0;
      }
      total += p;
    }
  }
  const t0 = tails[0];
  if (t0 && tails.every((t) => t && t.axis === t0.axis && t.n === t0.n)) {
    for (let k = 0; k < t0.line.length; k++) {
      let p = 1;
      for (const t of tails as Tail[]) {
        const x = t.line[t.line.length === 1 ? 0 : k];
        if (isError(x)) return x;
        p *= typeof x === "number" ? x : 0;
      }
      total += p * t0.n;
    }
  }
  return total;
};

// Conditional aggregates
function ifsAggregate(args: Arg[], valueFirst: boolean, reduce: (xs: number[]) => Scalar): Value {
  let valuesArg: Arg | undefined;
  const pairs: [Arg, Arg][] = [];
  if (valueFirst) {
    if (args.length < 3 || (args.length - 1) % 2) return err("#N/A", "Wrong number of arguments");
    valuesArg = args[0];
    for (let i = 1; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  } else {
    // SUMIF(range, criterion, [sum_range])
    if (args.length < 2 || args.length > 3) return err("#N/A", "Wrong number of arguments");
    pairs.push([args[0], args[1]]);
    valuesArg = args[2] && args[2].node.k !== "empty" ? args[2] : args[0];
  }
  const got = criteriaMask(pairs, [valuesArg]);
  if (isError(got)) return got;
  const { mask } = got;
  // Blank cells past a whole column add nothing to a sum, an average or a min/max.
  const vals = got.lists[0];
  if (vals.length !== mask.length) return err("#VALUE!", "Ranges differ in size");
  const picked: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    if (!mask[i]) continue;
    const v = vals[i];
    if (isError(v)) return v;
    if (typeof v === "number") picked.push(v);
  }
  return reduce(picked);
}
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
F.SUMIF = (args) => ifsAggregate(args, false, sum);
F.SUMIFS = (args) => ifsAggregate(args, true, sum);
F.AVERAGEIF = (args) =>
  ifsAggregate(args, false, (xs) => (xs.length ? sum(xs) / xs.length : err("#DIV/0!")));
F.AVERAGEIFS = (args) =>
  ifsAggregate(args, true, (xs) => (xs.length ? sum(xs) / xs.length : err("#DIV/0!")));
F.MINIFS = (args) => ifsAggregate(args, true, (xs) => (xs.length ? Math.min(...xs) : 0));
F.MAXIFS = (args) => ifsAggregate(args, true, (xs) => (xs.length ? Math.max(...xs) : 0));
const countMet = (pairs: [Arg, Arg][]): Value => {
  const got = criteriaMask(pairs);
  if (isError(got)) return got;
  return got.mask.filter(Boolean).length + (got.tailCounts ? got.tail : 0);
};
F.COUNTIF = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  return countMet([[args[0], args[1]]]);
};
F.COUNTIFS = (args) => {
  if (args.length < 2 || args.length % 2) return err("#N/A", "Wrong number of arguments");
  const pairs: [Arg, Arg][] = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  return countMet(pairs);
};

// Math
const unaryMath =
  (fn: (x: number) => number): FnImpl =>
  (args) => {
    const e = arity(args, 1, 1);
    if (e) return e;
    const v = args[0].value();
    const one = (x: Scalar): Scalar => {
      const n = toNumber(x);
      if (isError(n)) return n;
      const r = fn(n);
      return Number.isFinite(r) ? r : err("#NUM!");
    };
    return isMatrix(v) ? v.map((row) => row.map(one)) : one(v);
  };
F.ABS = unaryMath(Math.abs);
F.SQRT = (args) => {
  const n = num(args[0]);
  if (isError(n)) return n;
  return n < 0 ? err("#NUM!") : Math.sqrt(n);
};
F.INT = unaryMath(Math.floor);
F.EXP = unaryMath(Math.exp);
F.LN = (args) => {
  const n = num(args[0]);
  if (isError(n)) return n;
  return n <= 0 ? err("#NUM!") : Math.log(n);
};
F.LOG10 = (args) => {
  const n = num(args[0]);
  if (isError(n)) return n;
  return n <= 0 ? err("#NUM!") : Math.log10(n);
};
F.SIGN = unaryMath(Math.sign);
F.PI = () => Math.PI;
F.POWER = (args) => {
  const a = num(args[0]);
  const b = num(args[1]);
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (a === 0 && b < 0) return err("#DIV/0!");
  const r = Math.pow(a, b);
  return Number.isFinite(r) ? r : err("#NUM!");
};
F.MOD = (args) => {
  const a = num(args[0]);
  const b = num(args[1]);
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (b === 0) return err("#DIV/0!");
  return a - b * Math.floor(a / b);
};
const roundTo = (mode: "half" | "up" | "down"): FnImpl => {
  return (args) => {
    const e = arity(args, 1, 2);
    if (e) return e;
    const n = num(args[0]);
    const d = num(args[1], 0);
    if (isError(n)) return n;
    if (isError(d)) return d;
    // Excel's 15 digits, shifted as text: 2.675 is 2.68, not 2.67 (R200).
    return excelRound(n, Math.trunc(d), mode);
  };
};
F.ROUND = roundTo("half");
F.ROUNDUP = roundTo("up");
F.ROUNDDOWN = roundTo("down");
// TRUNC is ROUNDDOWN in Excel. FOUND IN R200: it cut the binary, so
// TRUNC(0.29, 2) was 0.28 (0.29 × 100 is 28.999999999999996).
F.TRUNC = roundTo("down");
/**
 * A quotient as Excel reads it, to 15 significant digits: 0.3 / 0.1 is
 * 2.9999999999999996, and FLOOR(0.3,0.1) must be 0.3 (R176).
 *
 * FOUND IN R201: this snapped anything within 1e-9 × the quotient of a whole
 * number, so CEILING(5.0000000001, 1) was 5, CEILING(0.0000000001, 1) 0 and
 * CEILING(12345678901.005, 1) …901, where Excel says 6, 1 and …902. A table
 * sheet's SQL reads the quotient the same way (sql/compile.ts quotient15Sql).
 */
const quotient15 = (q: number): number => (Number.isFinite(q) ? Number(q.toPrecision(15)) : q);
/** A multiple of a step without the step's float noise: 3 × 0.1 is 0.3, not 0.30000000000000004. */
const tidy = (x: number): number => Number(x.toPrecision(15));
/**
 * n rounded to a multiple of s, up (ceil) or down (floor), as CEILING and
 * FLOOR do. FOUND IN R176: FLOOR(0.3,0.1) was 0.2 and FLOOR(4.35,0.05) 4.3,
 * because the quotient landed just under a whole number; and a positive
 * number with a negative step gave a number where Excel gives #NUM!.
 */
function toMultiple(n: number, s: number, up: boolean): number {
  const q = quotient15(n / s);
  return tidy((up ? Math.ceil(q) : Math.floor(q)) * s);
}
F.CEILING = (args) => {
  const n = num(args[0]);
  const s = num(args[1], 1);
  if (isError(n)) return n;
  if (isError(s)) return s;
  if (s === 0) return 0;
  if (n > 0 && s < 0) return err("#NUM!", "A positive number takes a positive significance");
  return toMultiple(n, s, true);
};
F.FLOOR = (args) => {
  const n = num(args[0]);
  const s = num(args[1], 1);
  if (isError(n)) return n;
  if (isError(s)) return s;
  if (s === 0) return err("#DIV/0!");
  if (n > 0 && s < 0) return err("#NUM!", "A positive number takes a positive significance");
  return toMultiple(n, s, false);
};
/**
 * CEILING.MATH and FLOOR.MATH: the significance's sign is ignored; a
 * negative number goes toward zero by default (CEILING.MATH) or away from it
 * (FLOOR.MATH), and a non-zero mode turns that round. Written here for the
 * same float noise as FLOOR (R176): FLOOR.MATH(0.3,0.1) was 0.2.
 */
const multipleMath =
  (ceiling: boolean): FnImpl =>
  (args) => {
    const n = num(args[0]);
    if (isError(n)) return n;
    const sig = num(args[1], 1);
    if (isError(sig)) return sig;
    const mode = num(args[2], 0);
    if (isError(mode)) return mode;
    const s = Math.abs(sig);
    if (s === 0) return 0;
    // For a negative number, a non-zero mode turns the default direction round.
    const up = n < 0 && mode !== 0 ? !ceiling : ceiling;
    return toMultiple(n, s, up);
  };
F["CEILING.MATH"] = multipleMath(true);
F["FLOOR.MATH"] = multipleMath(false);
/** The whole numbers GCD and LCM take: truncated, as Excel's, and none negative (R176). */
function wholeNumbers(args: Arg[]): number[] | SheetError {
  const xs = collectNumbers(args);
  if (isError(xs)) return xs;
  if (xs.some((x) => x < 0)) return err("#NUM!", "GCD and LCM take no negative numbers");
  return xs.map((x) => Math.trunc(x));
}
const gcdOf = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};
F.GCD = (args) => {
  const bad = arity(args, 1);
  if (bad) return bad;
  const xs = wholeNumbers(args);
  if (isError(xs)) return xs;
  return xs.reduce(gcdOf, 0);
};
F.LCM = (args) => {
  const bad = arity(args, 1);
  if (bad) return bad;
  const xs = wholeNumbers(args);
  if (isError(xs)) return xs;
  if (xs.some((x) => x === 0)) return 0;
  return xs.reduce((a, b) => (a / gcdOf(a, b)) * b, 1);
};
F.RAND = () => Math.random();
F.RANDBETWEEN = (args) => {
  const a = num(args[0]);
  const b = num(args[1]);
  if (isError(a)) return a;
  if (isError(b)) return b;
  const lo = Math.ceil(a);
  const hi = Math.floor(b);
  if (hi < lo) return err("#NUM!");
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};

// Logic
F.IF = (args) => {
  const e = arity(args, 1, 3);
  if (e) return e;
  const c = args[0].value();
  if (isMatrix(c)) {
    // Each element takes the branch's element in the same place. FOUND IN
    // R145: it took each branch's FIRST value, so MAX(IF(A1:A3<>"b",B1:B3))
    // was B1 whatever the condition.
    const branch = (a: Arg | undefined, absent: boolean): Value =>
      !a ? absent : a.node.k === "empty" ? 0 : a.value();
    return zipN([c, branch(args[1], true), branch(args[2], false)], ([x, yes, no]) => {
      const b = toBool(x);
      if (isError(b)) return b;
      return b ? yes : no;
    });
  }
  const b = toBool(c);
  if (isError(b)) return b;
  const pick = b ? args[1] : args[2];
  if (!pick) return b; // IF(cond) / IF(cond, x) with no else → FALSE
  return pick.node.k === "empty" ? 0 : pick.value();
};
F.IFS = (args) => {
  if (args.length < 2 || args.length % 2) return err("#N/A", "Wrong number of arguments");
  for (let i = 0; i < args.length; i += 2) {
    const b = bool(args[i]);
    if (isError(b)) return b;
    if (b) return args[i + 1].value();
  }
  return err("#N/A", "No condition was TRUE");
};
F.IFERROR = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  const v = args[0].value();
  if (isMatrix(v)) return zipN([v, args[1].value()], ([x, fb]) => (isError(x) ? fb : x));
  return isError(v) ? args[1].value() : v;
};
F.IFNA = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  const v = args[0].value();
  if (isMatrix(v))
    return zipN([v, args[1].value()], ([x, fb]) => (isError(x) && x.err === "#N/A" ? fb : x));
  return isError(v) && v.err === "#N/A" ? args[1].value() : v;
};
const logical =
  (combine: (xs: boolean[]) => boolean): FnImpl =>
  (args) => {
    const xs: boolean[] = [];
    for (const a of args) {
      const v = a.value();
      const t = tailOf(v);
      // A tail's line stands for n rows: once is enough for AND and OR; XOR
      // needs only whether n is odd.
      const tailLine = t && t.n % 2 === 1 ? t.line : t ? [...t.line, ...t.line] : [];
      for (const x of [...flat(v), ...tailLine]) {
        if (isError(x)) return x;
        if (x === null || (typeof x === "string" && (a.isRef || isMatrix(v)))) continue;
        const b = toBool(x);
        if (isError(b)) return b;
        xs.push(b);
      }
    }
    return xs.length ? combine(xs) : err("#VALUE!");
  };
F.AND = logical((xs) => xs.every(Boolean));
F.OR = logical((xs) => xs.some(Boolean));
F.XOR = logical((xs) => xs.filter(Boolean).length % 2 === 1);
F.NOT = (args) => {
  const b = bool(args[0]);
  return isError(b) ? b : !b;
};
F.TRUE = () => true;
F.FALSE = () => false;
F.SWITCH = (args) => {
  if (args.length < 3) return err("#N/A", "Wrong number of arguments");
  const v = scalarOf(args[0].value());
  if (isError(v)) return v;
  let i = 1;
  for (; i + 1 < args.length; i += 2) {
    if (compareScalars(v, scalarOf(args[i].value())) === 0) return args[i + 1].value();
  }
  return i < args.length ? args[i].value() : err("#N/A", "No case matched");
};
F.CHOOSE = (args) => {
  const i = num(args[0]);
  if (isError(i)) return i;
  const k = Math.trunc(i);
  if (k < 1 || k >= args.length) return err("#VALUE!");
  return args[k].value();
};

// Information
const isFn =
  (pred: (x: Scalar) => boolean): FnImpl =>
  (args) => {
    const e = arity(args, 1, 1);
    if (e) return e;
    return pred(scalarOf(args[0].value()));
  };
F.ISBLANK = isFn((x) => x === null);
F.ISNUMBER = isFn((x) => typeof x === "number");
F.ISTEXT = isFn((x) => typeof x === "string");
F.ISNONTEXT = isFn((x) => typeof x !== "string");
F.ISLOGICAL = isFn((x) => typeof x === "boolean");
F.ISERROR = isFn((x) => isError(x));
F.ISERR = isFn((x) => isError(x) && x.err !== "#N/A");
F.ISNA = isFn((x) => isError(x) && x.err === "#N/A");

// R258. TYPE and ERROR.TYPE read the value itself, errors included, so they
// cannot go through formula.js (which is handed values, not errors).
F.TYPE = (args) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  const v = args[0].value();
  if (isMatrix(v)) return v.length === 1 && v[0].length === 1 ? typeCode(v[0][0]) : 64;
  return typeCode(v);
};
/** Excel's TYPE codes: number (and a blank) 1, text 2, logical 4, error 16. */
function typeCode(x: Scalar): number {
  if (isError(x)) return 16;
  if (typeof x === "string") return 2;
  if (typeof x === "boolean") return 4;
  return 1;
}
/**
 * ERROR.TYPE's numbers, from Excel's documentation: 1-7 for the classic
 * errors, 8 for the one Excel now calls #BUSY! (formerly #GETTING_DATA), 9 and
 * 14 for #SPILL! and #CALC!. #CYCLE! is this engine's own word and Excel has
 * no number for it, so it answers #N/A as Excel does for "anything else".
 */
const ERROR_TYPE: Partial<Record<ErrorCode, number>> = {
  "#NULL!": 1,
  "#DIV/0!": 2,
  "#VALUE!": 3,
  "#REF!": 4,
  "#NAME?": 5,
  "#NUM!": 6,
  "#N/A": 7,
  "#BUSY!": 8,
  "#SPILL!": 9,
  "#CALC!": 14,
};
F["ERROR.TYPE"] = (args) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  const x = scalarOf(args[0].value());
  if (!isError(x)) return err("#N/A", "Not an error");
  return ERROR_TYPE[x.err] ?? err("#N/A", `${x.err} has no ERROR.TYPE number`);
};

/**
 * Student's t, as Excel's T.DIST family. FOUND IN R258: formula.js's T.DIST
 * answers #NUM! for every input - registering it would have shipped a
 * function that always fails - while its legacy TDIST (an upper tail) is
 * right, so the family is built on that. The density is the closed form,
 * through log-gamma so a large df does not overflow.
 */
function tUpperTail(x: number, df: number): number {
  // TDIST takes x >= 0; the tail of a negative x is the mirror image.
  const t = Number(
    (formulajs as unknown as { TDIST: (...a: number[]) => unknown }).TDIST(Math.abs(x), df, 1),
  );
  return x >= 0 ? t : 1 - t;
}
function tArgs(args: Arg[], min: number, max: number): { x: number; df: number } | SheetError {
  const e = arity(args, min, max);
  if (e) return e;
  const x = num(args[0]);
  if (isError(x)) return x;
  const d = num(args[1]);
  if (isError(d)) return d;
  const df = Math.trunc(d);
  if (df < 1) return err("#NUM!", "Degrees of freedom must be at least 1");
  return { x, df };
}
F["T.DIST"] = (args) => {
  const a = tArgs(args, 3, 3);
  if (isError(a)) return a;
  const cumulative = toBool(scalarOf(args[2].value()));
  if (isError(cumulative)) return cumulative;
  if (cumulative) return 1 - tUpperTail(a.x, a.df);
  const gl = (formulajs as unknown as { GAMMALN: (n: number) => number }).GAMMALN;
  const v = a.df;
  return (
    (Math.exp(gl((v + 1) / 2) - gl(v / 2)) / Math.sqrt(v * Math.PI)) *
    Math.pow(1 + (a.x * a.x) / v, -(v + 1) / 2)
  );
};
F["T.DIST.RT"] = (args) => {
  const a = tArgs(args, 2, 2);
  if (isError(a)) return a;
  return tUpperTail(a.x, a.df);
};
F["T.DIST.2T"] = (args) => {
  const a = tArgs(args, 2, 2);
  if (isError(a)) return a;
  if (a.x < 0) return err("#NUM!", "T.DIST.2T needs x of 0 or more");
  return 2 * tUpperTail(a.x, a.df);
};
F.ISEVEN = (args) => {
  const n = num(args[0]);
  return isError(n) ? n : Math.trunc(n) % 2 === 0;
};
F.ISODD = (args) => {
  const n = num(args[0]);
  return isError(n) ? n : Math.abs(Math.trunc(n)) % 2 === 1;
};
F.NA = () => err("#N/A");

// Text
F.CONCAT = (args) => {
  let s = "";
  for (const a of args) {
    for (const x of flat(a.value())) {
      const t = toText(x);
      if (isError(t)) return t;
      s += t;
    }
  }
  return s;
};
F.CONCATENATE = F.CONCAT;
F.TEXTJOIN = (args) => {
  if (args.length < 3) return err("#N/A", "Wrong number of arguments");
  const d = text(args[0]);
  const skip = bool(args[1]);
  if (isError(d)) return d;
  if (isError(skip)) return skip;
  const parts: string[] = [];
  for (const a of args.slice(2)) {
    for (const x of flat(a.value())) {
      if (isError(x)) return x;
      const t = toText(x) as string;
      if (skip && t === "") continue;
      parts.push(t);
    }
  }
  return parts.join(d);
};
const textFn =
  (fn: (s: string, args: Arg[]) => Scalar): FnImpl =>
  (args) => {
    const v = args[0]?.value() ?? null;
    const one = (x: Scalar): Scalar => {
      const s = toText(x);
      return isError(s) ? s : fn(s, args);
    };
    return isMatrix(v) ? v.map((row) => row.map(one)) : one(v);
  };
F.LEN = textFn((s) => s.length);
/**
 * Excel changes case one character for one (Unicode's simple mapping).
 * FOUND IN R327: JavaScript's full mapping made `=UPPER("ß")` "SS" and
 * `=UPPER("straße")` "STRASSE", where Excel keeps the ß; `=LOWER("İ")` was
 * "i" plus a combining dot, where Excel gives "i"; and a final Σ lowered to ς,
 * where Excel gives σ. A character whose capital is several letters stays as
 * it is; a lowercase of several takes its first.
 */
const simpleCase = (s: string, upper: boolean): string =>
  Array.from(s, (ch) => {
    const mapped = Array.from(upper ? ch.toUpperCase() : ch.toLowerCase());
    if (mapped.length === 1) return mapped[0];
    return upper ? ch : mapped[0];
  }).join("");
F.UPPER = textFn((s) => simpleCase(s, true));
F.LOWER = textFn((s) => simpleCase(s, false));
// FOUND IN R199: a letter was [a-z], so "É" counted as a word break and
// PROPER("ÉCOLE normale") gave "éCole Normale"; Excel gives "École Normale".
// Any letter, in any script, is a letter. A letter whose capital is two
// ("ß" to "SS", "ﬁ" to "FI") stays as it is, as it did before.
F.PROPER = textFn((s) =>
  s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => {
    const up = b.toUpperCase();
    return a + (up.length === 1 ? up : b);
  }),
);
F.TRIM = textFn((s) => s.trim().replace(/ {2,}/g, " "));
F.LEFT = textFn((s, args) => {
  const n = num(args[1], 1);
  if (isError(n)) return n;
  return n < 0 ? err("#VALUE!") : s.slice(0, Math.trunc(n));
});
F.RIGHT = textFn((s, args) => {
  const n = num(args[1], 1);
  if (isError(n)) return n;
  if (n < 0) return err("#VALUE!");
  return Math.trunc(n) === 0 ? "" : s.slice(-Math.trunc(n));
});
F.MID = textFn((s, args) => {
  const start = num(args[1]);
  const n = num(args[2]);
  if (isError(start)) return start;
  if (isError(n)) return n;
  if (start < 1 || n < 0) return err("#VALUE!");
  return s.substr(Math.trunc(start) - 1, Math.trunc(n));
});
F.REPT = textFn((s, args) => {
  const n = num(args[1]);
  if (isError(n)) return n;
  return n < 0 ? err("#VALUE!") : s.repeat(Math.trunc(n));
});
F.SUBSTITUTE = (args) => {
  const e = arity(args, 3, 4);
  if (e) return e;
  const s = text(args[0]);
  const from = text(args[1]);
  const to = text(args[2]);
  if (isError(s)) return s;
  if (isError(from)) return from;
  if (isError(to)) return to;
  if (!from) return s;
  if (args[3] && args[3].node.k !== "empty") {
    const k = num(args[3]);
    if (isError(k)) return k;
    let idx = -1;
    for (let i = 0; i < k; i++) {
      idx = s.indexOf(from, idx + 1);
      if (idx < 0) return s;
    }
    return s.slice(0, idx) + to + s.slice(idx + from.length);
  }
  return s.split(from).join(to);
};
F.REPLACE = (args) => {
  const s = text(args[0]);
  const start = num(args[1]);
  const n = num(args[2]);
  const r = text(args[3]);
  for (const x of [s, start, n, r]) if (isError(x)) return x;
  return (
    (s as string).slice(0, (start as number) - 1) +
    (r as string) +
    (s as string).slice((start as number) - 1 + (n as number))
  );
};
const findFn =
  (ci: boolean): FnImpl =>
  (args) => {
    const needle = text(args[0]);
    const hay = text(args[1]);
    const start = num(args[2], 1);
    if (isError(needle)) return needle;
    if (isError(hay)) return hay;
    if (isError(start)) return start;
    if (start < 1 || start > hay.length + 1) return err("#VALUE!");
    if (ci) {
      const re = new RegExp(wildcardSource(needle), "is");
      const m = re.exec(hay.slice(start - 1));
      return m ? m.index + start : err("#VALUE!", "Not found");
    }
    const i = hay.indexOf(needle, start - 1);
    return i < 0 ? err("#VALUE!", "Not found") : i + 1;
  };
F.FIND = findFn(false);
F.SEARCH = findFn(true);
F.EXACT = (args) => {
  const a = text(args[0]);
  const b = text(args[1]);
  if (isError(a)) return a;
  if (isError(b)) return b;
  return a === b;
};
F.TEXT = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  const v = scalarOf(args[0].value());
  const f = text(args[1]);
  if (isError(v)) return v;
  if (isError(f)) return f;
  // A blank is 0 to TEXT, as in Excel: TEXT(A5, "0.00") is "0.00" (R199).
  const n = v === null ? 0 : typeof v === "string" ? (parseNumberText(v) ?? v) : v;
  return formatValue(n, f);
};
F.VALUE = (args) => {
  const v = scalarOf(args[0]?.value() ?? null);
  if (isError(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return err("#VALUE!");
  const n = parseNumberText(String(v ?? ""));
  return n === null ? err("#VALUE!", `"${v}" is not a number`) : n;
};
F.T = (args) => {
  const v = scalarOf(args[0].value());
  return typeof v === "string" ? v : isError(v) ? v : "";
};
F.N = (args) => {
  const v = scalarOf(args[0].value());
  return typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : isError(v) ? v : 0;
};
F.CHAR = (args) => {
  const n = num(args[0]);
  return isError(n) ? n : n < 1 || n > 255 ? err("#VALUE!") : String.fromCharCode(Math.trunc(n));
};
F.CODE = (args) => {
  const s = text(args[0]);
  return isError(s) ? s : s ? s.charCodeAt(0) : err("#VALUE!");
};

// Dates
F.DATE = (args) => {
  const e = arity(args, 3, 3);
  if (e) return e;
  const [y, m, d] = [num(args[0]), num(args[1]), num(args[2])];
  for (const x of [y, m, d]) if (isError(x)) return x;
  let yy = Math.trunc(y as number);
  if (yy < 1900) yy += 1900;
  const s = dateSerial(yy, Math.trunc(m as number), Math.trunc(d as number));
  return s < 0 ? err("#NUM!") : s;
};
F.TODAY = (_a, ctx) => todaySerial(ctx.env.now);
F.NOW = (_a, ctx) => nowSerial(ctx.env.now);
const datePart =
  (pick: (p: ReturnType<typeof serialParts>) => number): FnImpl =>
  (args) => {
    const v = scalarOf(args[0]?.value() ?? null);
    const n = toNumber(v);
    if (isError(n)) return n;
    if (n < 0) return err("#NUM!");
    return pick(serialParts(n));
  };
F.YEAR = datePart((p) => p.y);
F.MONTH = datePart((p) => p.m);
F.DAY = datePart((p) => p.d);
F.HOUR = datePart((p) => p.h);
F.MINUTE = datePart((p) => p.mi);
F.SECOND = datePart((p) => p.s);
F.WEEKDAY = (args) => {
  const n = num(args[0]);
  const type = num(args[1], 1);
  if (isError(n)) return n;
  if (isError(type)) return type;
  const dow = serialParts(n).dow; // 0 = Sunday
  const t = Math.trunc(type);
  if (t === 1) return dow + 1;
  if (t === 2) return ((dow + 6) % 7) + 1;
  if (t === 3) return (dow + 6) % 7;
  // 11 to 17: day 1 is Monday (11) through Sunday (17). FOUND IN R174: #NUM!.
  if (t >= 11 && t <= 17) return ((dow - ((t - 10) % 7) + 7) % 7) + 1;
  return err("#NUM!");
};
/**
 * DAYS360(start, end, [european]): the days between two dates on a year of
 * twelve 30-day months, as Excel counts them (R174; it was #NAME?). The US
 * (NASD) way: a start on the 31st or on the last day of February counts as
 * the 30th, and an end on the 31st counts as the 30th when the start is the
 * 30th or 31st. The European way: every 31st counts as the 30th.
 */
F.DAYS360 = (args) => {
  const bad = arity(args, 2, 3);
  if (bad) return bad;
  const a = num(args[0]);
  if (isError(a)) return a;
  const b = num(args[1]);
  if (isError(b)) return b;
  const european = bool(args[2], false);
  if (isError(european)) return european;
  const s = serialParts(Math.floor(a));
  const e = serialParts(Math.floor(b));
  let d1 = s.d;
  let d2 = e.d;
  if (european) {
    d1 = Math.min(d1, 30);
    d2 = Math.min(d2, 30);
  } else {
    const lastOfFebruary = s.m === 2 && serialParts(Math.floor(a) + 1).m === 3;
    if (d1 === 31 || lastOfFebruary) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
  }
  return (e.y - s.y) * 360 + (e.m - s.m) * 30 + (d2 - d1);
};
F.DATEVALUE = (args) => {
  const s = text(args[0]);
  if (isError(s)) return s;
  const n = parseNumberText(s);
  return n === null ? err("#VALUE!") : Math.floor(n);
};
F.EDATE = (args) => {
  const n = num(args[0]);
  const k = num(args[1]);
  if (isError(n)) return n;
  if (isError(k)) return k;
  const p = serialParts(n);
  const target = new Date(Date.UTC(p.y, p.m - 1 + Math.trunc(k), 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return dateSerial(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(p.d, last));
};
F.EOMONTH = (args) => {
  const n = num(args[0]);
  const k = num(args[1]);
  if (isError(n)) return n;
  if (isError(k)) return k;
  const p = serialParts(n);
  return dateSerial(p.y, p.m + Math.trunc(k) + 1, 0);
};
F.DAYS = (args) => {
  const a = num(args[0]);
  const b = num(args[1]);
  if (isError(a)) return a;
  if (isError(b)) return b;
  return Math.trunc(a) - Math.trunc(b);
};

// Lookup and reference

/**
 * Lookups match text with wildcards (* ? ~) but never read comparison
 * operators: VLOOKUP("<5", …) looks for the text "<5", unlike SUMIF.
 */
function wildcardMatcher(needle: Scalar): (v: Scalar) => boolean {
  if (typeof needle !== "string") {
    return (v) => v !== null && typeof v === typeof needle && compareScalars(v, needle) === 0;
  }
  if (!/(?<!~)[*?]/.test(needle)) {
    const lit = needle.replace(/~([*?~])/g, "$1").toLowerCase();
    return (v) => typeof v === "string" && v.toLowerCase() === lit;
  }
  const re = new RegExp(`^${wildcardSource(needle)}$`, "is");
  return (v) => typeof v === "string" && re.test(v);
}

function matchIndex(
  needle: Scalar,
  vec: Scalar[],
  mode: number, // 0 exact, -1 exact-or-next-smaller, 1 exact-or-next-larger, 2 wildcard
  searchMode = 1, // 1 first→last, -1 last→first
): number {
  const pred = mode === 2 ? wildcardMatcher(needle) : null;
  let best = -1;
  const order = searchMode === -1 ? [...vec.keys()].reverse() : [...vec.keys()];
  for (const i of order) {
    const v = vec[i];
    if (
      pred
        ? pred(v) && v !== null
        : v !== null && compareScalars(v, needle) === 0 && typeof v === typeof needle
    ) {
      return i;
    }
    if (mode === -1 && v !== null && typeof v === typeof needle && compareScalars(v, needle) < 0) {
      if (best < 0 || compareScalars(v, vec[best]) > 0) best = i;
    }
    if (mode === 1 && v !== null && typeof v === typeof needle && compareScalars(v, needle) > 0) {
      if (best < 0 || compareScalars(v, vec[best]) < 0) best = i;
    }
  }
  return best;
}

/** Approximate match on sorted data (VLOOKUP TRUE / MATCH 1): the last value ≤ needle. */
function approxIndex(needle: Scalar, vec: Scalar[], descending = false): number {
  let best = -1;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (v === null || typeof v !== typeof needle) continue;
    const c = compareScalars(v, needle);
    if (descending ? c >= 0 : c <= 0) best = i;
    else break;
  }
  return best;
}

F.VLOOKUP = (args) => {
  const e = arity(args, 3, 4);
  if (e) return e;
  const needle = scalarOf(args[0].value());
  if (isError(needle)) return needle;
  const table = asMatrix(args[1].value());
  const colN = num(args[2]);
  if (isError(colN)) return colN;
  const approx = args[3] ? bool(args[3], true) : true;
  if (isError(approx)) return approx;
  if (colN < 1) return err("#VALUE!");
  if (colN > (table[0]?.length ?? 0)) return err("#REF!");
  const firstCol = table.map((r) => r[0]);
  const i = approx ? approxIndex(needle, firstCol) : matchIndex(needle, firstCol, 2);
  return i < 0 ? err("#N/A", "No match") : table[i][Math.trunc(colN) - 1];
};
F.HLOOKUP = (args) => {
  const e = arity(args, 3, 4);
  if (e) return e;
  const needle = scalarOf(args[0].value());
  if (isError(needle)) return needle;
  const table = asMatrix(args[1].value());
  const rowN = num(args[2]);
  if (isError(rowN)) return rowN;
  const approx = args[3] ? bool(args[3], true) : true;
  if (isError(approx)) return approx;
  if (rowN < 1) return err("#VALUE!");
  if (rowN > table.length) return err("#REF!");
  const i = approx ? approxIndex(needle, table[0]) : matchIndex(needle, table[0], 2);
  return i < 0 ? err("#N/A", "No match") : table[Math.trunc(rowN) - 1][i];
};
F.MATCH = (args) => {
  const e = arity(args, 2, 3);
  if (e) return e;
  const needle = scalarOf(args[0].value());
  if (isError(needle)) return needle;
  const vec = flat(args[1].value());
  const type = num(args[2], 1);
  if (isError(type)) return type;
  const i = type === 0 ? matchIndex(needle, vec, 2) : approxIndex(needle, vec, type < 0);
  if (i < 0 && type === 0) {
    // MATCH(TRUE,INDEX(A:A="",0),0), the first empty row: the tail's first row.
    const t = tailOf(args[1].value());
    if (t && t.line.length === 1 && matchIndex(needle, t.line, 2) === 0) return vec.length + 1;
  }
  return i < 0 ? err("#N/A", "No match") : i + 1;
};
F.XMATCH = (args) => {
  const e = arity(args, 2, 4);
  if (e) return e;
  const needle = scalarOf(args[0].value());
  if (isError(needle)) return needle;
  const vec = flat(args[1].value());
  const mode = num(args[2], 0);
  const search = num(args[3], 1);
  if (isError(mode)) return mode;
  if (isError(search)) return search;
  const i = matchIndex(needle, vec, mode, search);
  return i < 0 ? err("#N/A", "No match") : i + 1;
};
F.XLOOKUP = (args) => {
  const e = arity(args, 3, 6);
  if (e) return e;
  const needle = scalarOf(args[0].value());
  if (isError(needle)) return needle;
  const look = asMatrix(args[1].value());
  const ret = asMatrix(args[2].value());
  const vertical = look.length > 1 || (look[0]?.length ?? 0) === 1;
  const vec = vertical ? look.map((r) => r[0]) : look[0];
  const mode = num(args[4], 0);
  const search = num(args[5], 1);
  if (isError(mode)) return mode;
  if (isError(search)) return search;
  const i = matchIndex(needle, vec, mode, search);
  if (i < 0) {
    if (args[3] && args[3].node.k !== "empty") return args[3].value();
    return err("#N/A", "No match");
  }
  if (vertical) {
    if (ret.length !== vec.length) return err("#VALUE!", "Lookup and return ranges differ");
    const row = ret[i];
    return row.length === 1 ? row[0] : [row];
  }
  if ((ret[0]?.length ?? 0) !== vec.length)
    return err("#VALUE!", "Lookup and return ranges differ");
  const col = ret.map((r) => r[i]);
  return col.length === 1 ? col[0] : col.map((x) => [x]);
};
F.INDEX = (args) => {
  const e = arity(args, 2, 3);
  if (e) return e;
  const m = asMatrix(args[0].value());
  let r = num(args[1], 0);
  let c = num(args[2], 0);
  if (isError(r)) return r;
  if (isError(c)) return c;
  // A single row or column takes one index.
  if (args.length === 2 && m.length === 1) {
    c = r;
    r = 1;
  }
  if (args.length === 2 && (m[0]?.length ?? 0) === 1) c = 1;
  // Past the used part of a whole column or row is its tail: a blank cell for
  // a range (R140), what the arithmetic made of it for an array (R146).
  const t = tailOf(args[0].value());
  const rowsIn = m.length + (t?.axis === "rows" ? t.n : 0);
  const colsIn = (m[0]?.length ?? 0) + (t?.axis === "cols" ? t.n : 0);
  if (r < 0 || c < 0 || r > rowsIn || c > colsIn) return err("#REF!");
  if (t && (r > m.length || c > (m[0]?.length ?? 0))) {
    if (t.axis === "rows") return c === 0 ? [t.line.slice()] : (t.line[c - 1] ?? null);
    return r === 0 ? t.line.map((x) => [x]) : (t.line[r - 1] ?? null);
  }
  if (r === 0 && c === 0) return m;
  // A whole column (or row) of a tailed array keeps its tail: INDEX(A:A="",0).
  if (r === 0)
    return withTail(
      m.map((row) => [row[c - 1]]),
      t?.axis === "rows" ? { ...t, line: [t.line[c - 1] ?? null] } : undefined,
    );
  if (c === 0)
    return withTail(
      [m[r - 1]],
      t?.axis === "cols" ? { ...t, line: [t.line[r - 1] ?? null] } : undefined,
    );
  return m[r - 1][c - 1];
};
F.ROW = (args, ctx) => {
  if (!args.length) return ctx.env.row + 1;
  const ref = args[0].ref;
  return ref ? ref.r0 + 1 : err("#VALUE!");
};
F.COLUMN = (args, ctx) => {
  if (!args.length) return ctx.env.col + 1;
  const ref = args[0].ref;
  return ref ? ref.c0 + 1 : err("#VALUE!");
};
F.ROWS = (args) => {
  const v = args[0].value();
  const t = tailOf(v);
  return asMatrix(v).length + (t?.axis === "rows" ? t.n : 0);
};
F.COLUMNS = (args) => {
  const v = args[0].value();
  const t = tailOf(v);
  return (asMatrix(v)[0]?.length ?? 0) + (t?.axis === "cols" ? t.n : 0);
};
F.TRANSPOSE = (args) => {
  const m = asMatrix(args[0].value());
  return (m[0] ?? []).map((_x, c) => m.map((row) => row[c]));
};

// Dynamic arrays
F.UNIQUE = (args) => {
  const e = arity(args, 1, 3);
  if (e) return e;
  const m = asMatrix(args[0].value());
  const byCol = bool(args[1], false);
  const once = bool(args[2], false);
  if (isError(byCol)) return byCol;
  if (isError(once)) return once;
  const items = byCol ? (m[0] ?? []).map((_x, c) => m.map((r) => r[c])) : m;
  const keyOf = (row: Scalar[]) =>
    JSON.stringify(row.map((x) => (typeof x === "string" ? x.toLowerCase() : x)));
  const counts = new Map<string, number>();
  for (const row of items) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  const seen = new Set<string>();
  const out: Scalar[][] = [];
  for (const row of items) {
    const k = keyOf(row);
    if (seen.has(k)) continue;
    seen.add(k);
    if (once && (counts.get(k) ?? 0) > 1) continue;
    out.push(row);
  }
  if (!out.length) return err("#CALC!", "Nothing is unique");
  return byCol ? (out[0] ?? []).map((_x, r) => out.map((col) => col[r])) : out;
};
F.SORT = (args) => {
  const e = arity(args, 1, 4);
  if (e) return e;
  const m = asMatrix(args[0].value());
  const idx = num(args[1], 1);
  const order = num(args[2], 1);
  if (isError(idx)) return idx;
  if (isError(order)) return order;
  const k = Math.trunc(idx) - 1;
  if (k < 0 || k >= (m[0]?.length ?? 0)) return err("#VALUE!");
  return [...m].sort((a, b) => compareScalars(a[k], b[k]) * (order < 0 ? -1 : 1));
};
F.SORTBY = (args) => {
  if (args.length < 2) return err("#N/A", "Wrong number of arguments");
  const m = asMatrix(args[0].value());
  const keys: { vec: Scalar[]; dir: number }[] = [];
  for (let i = 1; i < args.length; i += 2) {
    const vec = flat(args[i].value());
    if (vec.length !== m.length) return err("#VALUE!", "Sort keys differ in size");
    const dir = num(args[i + 1], 1);
    if (isError(dir)) return dir;
    keys.push({ vec, dir: dir < 0 ? -1 : 1 });
  }
  const order = m.map((_r, i) => i);
  order.sort((a, b) => {
    for (const k of keys) {
      const c = compareScalars(k.vec[a], k.vec[b]);
      if (c) return c * k.dir;
    }
    return a - b;
  });
  return order.map((i) => m[i]);
};
F.FILTER = (args) => {
  const e = arity(args, 2, 3);
  if (e) return e;
  const m = asMatrix(args[0].value());
  const inc = flat(args[1].value());
  if (inc.length !== m.length) return err("#VALUE!", "The include array must match the rows");
  const out: Scalar[][] = [];
  for (let i = 0; i < m.length; i++) {
    const b = toBool(inc[i]);
    if (isError(b)) return b;
    if (b) out.push(m[i]);
  }
  if (!out.length) {
    if (args[2] && args[2].node.k !== "empty") return args[2].value();
    return err("#CALC!", "No rows matched");
  }
  return out;
};
F.SEQUENCE = (args) => {
  const rows = num(args[0]);
  const cols = num(args[1], 1);
  const start = num(args[2], 1);
  const step = num(args[3], 1);
  for (const x of [rows, cols, start, step]) if (isError(x)) return x;
  const R = Math.trunc(rows as number);
  const C = Math.trunc(cols as number);
  if (R < 1 || C < 1) return err("#CALC!");
  if (R * C > 1_000_000) return err("#NUM!", "Too large");
  const out: Matrix = [];
  let v = start as number;
  for (let r = 0; r < R; r++) {
    const line: Scalar[] = [];
    for (let c = 0; c < C; c++) {
      line.push(v);
      v += step as number;
    }
    out.push(line);
  }
  return out;
};

// ── Functions Excel has that were missing (R147) ────────────────────────────

const SUBTOTAL_OF: Record<number, string> = {
  1: "AVERAGE",
  2: "COUNT",
  3: "COUNTA",
  4: "MAX",
  5: "MIN",
  6: "PRODUCT",
  7: "STDEV.S",
  8: "STDEV.P",
  9: "SUM",
  10: "VAR.S",
  11: "VAR.P",
};
/**
 * SUBTOTAL(function_num, ref…): the function over the references, less what
 * Excel leaves out: rows a filter hides; with 101–111, rows hidden by hand
 * too; and cells that are themselves SUBTOTAL or AGGREGATE formulas, so a
 * total of subtotals does not count them twice.
 */
F.SUBTOTAL = (args, ctx) => {
  if (args.length < 2) return err("#N/A", "Wrong number of arguments");
  const code = num(args[0]);
  if (isError(code)) return code;
  const k = Math.trunc(code);
  const name = SUBTOTAL_OF[k > 100 ? k - 100 : k];
  if (!name || !F[name]) return err("#VALUE!", "SUBTOTAL takes 1 to 11, or 101 to 111");
  const handHidden = k > 100;
  const env = ctx.env;
  const kept: Arg[] = args.slice(1).map((a) => {
    const ref = a.ref;
    if (!ref) return a;
    const out = asMatrix(a.value()).map((line, r) =>
      line.map((x, c) => {
        const row = ref.r0 + r;
        const hidden = env.rowHidden?.(ref.sheet, row);
        if (hidden === "filter" || (hidden === "manual" && handHidden)) return null;
        const f = env.formula?.(ref.sheet, row, ref.c0 + c);
        return f && /\b(SUBTOTAL|AGGREGATE)\s*\(/i.test(f) ? null : x;
      }),
    );
    return { node: a.node, isRef: true, ref, value: () => out };
  });
  return F[name](kept, ctx);
};

const AGGREGATE_OF: Record<number, string> = {
  ...SUBTOTAL_OF,
  12: "MEDIAN",
  13: "MODE.SNGL",
  14: "LARGE",
  15: "SMALL",
  16: "PERCENTILE.INC",
  17: "QUARTILE.INC",
  18: "PERCENTILE.EXC",
  19: "QUARTILE.EXC",
};
/**
 * AGGREGATE(function_num, options, ref1, …) for 1–13, and
 * AGGREGATE(function_num, options, array, k) for 14–19 (R327). The options
 * say what to leave out: 0–3 nested SUBTOTAL and AGGREGATE cells; 1, 3, 5
 * and 7 hidden rows, by hand or by a filter; 2, 3, 6 and 7 error values,
 * which is what makes `AGGREGATE(14,6,A:A/(B:B="x"),1)` a filtered LARGE.
 */
F.AGGREGATE = (args, ctx) => {
  if (args.length < 3) return err("#VALUE!", "AGGREGATE takes a function number, options and data");
  const code = num(args[0]);
  if (isError(code)) return code;
  const option = num(args[1], 0);
  if (isError(option)) return option;
  const k = Math.trunc(code);
  const o = Math.trunc(option);
  const name = AGGREGATE_OF[k];
  if (!name || !F[name]) return err("#VALUE!", "AGGREGATE takes 1 to 19");
  if (o < 0 || o > 7) return err("#VALUE!", "AGGREGATE's options are 0 to 7");
  const withK = k >= 14;
  if (withK && args.length !== 4) return err("#VALUE!", "AGGREGATE 14 to 19 take one array and k");
  const skipNested = o <= 3;
  const skipHidden = o % 2 === 1;
  const skipErrors = o === 2 || o === 3 || o === 6 || o === 7;
  const env = ctx.env;
  const kept: Arg[] = (withK ? args.slice(2, 3) : args.slice(2)).map((a) => {
    const ref = a.ref;
    const out = asMatrix(a.value()).map((line, r) =>
      line.map((x, c) => {
        if (skipErrors && isError(x)) return null;
        if (!ref) return x;
        const row = ref.r0 + r;
        if (skipHidden && env.rowHidden?.(ref.sheet, row)) return null;
        if (skipNested) {
          const f = env.formula?.(ref.sheet, row, ref.c0 + c);
          if (f && /\b(SUBTOTAL|AGGREGATE)\s*\(/i.test(f)) return null;
        }
        return x;
      }),
    );
    return { ...a, value: () => out };
  });
  return F[name](withK ? [...kept, args[3]] : kept, ctx);
};

/** OFFSET(reference, rows, cols, [height], [width]): the cells that far from a reference. */
F.OFFSET = (args, ctx) => {
  const e = arity(args, 3, 5);
  if (e) return e;
  const ref = args[0].ref;
  if (!ref) return err("#VALUE!", "OFFSET starts from a reference, such as A1");
  const dr = num(args[1]);
  const dc = num(args[2]);
  const h = num(args[3], ref.r1 - ref.r0 + 1);
  const w = num(args[4], ref.c1 - ref.c0 + 1);
  for (const x of [dr, dc, h, w]) if (isError(x)) return x;
  const r0 = ref.r0 + Math.trunc(dr as number);
  const c0 = ref.c0 + Math.trunc(dc as number);
  const r1 = r0 + Math.trunc(h as number) - 1;
  const c1 = c0 + Math.trunc(w as number) - 1;
  if (r1 < r0 || c1 < c0 || r0 < 0 || c0 < 0 || r1 >= MAX_ROWS || c1 >= MAX_COLS)
    return err("#REF!", "That is outside the sheet");
  if (r0 === r1 && c0 === c1) return ctx.env.cell(ref.sheet, r0, c0);
  return ctx.env.range({ sheet: ref.sheet, r0, c0, r1, c1 });
};

/** INDIRECT(text): the cell or range the text names, as "B2", "Sales!A1:C9" or "'Q3 data'!D4". */
F.INDIRECT = (args, ctx) => {
  const e = arity(args, 1, 2);
  if (e) return e;
  const t = text(args[0]);
  if (isError(t)) return t;
  const a1 = bool(args[1], true);
  if (isError(a1)) return a1;
  let source = t.trim();
  if (!a1) {
    // FOUND IN R327: R1C1 text was refused outright. It is read relative to
    // this formula's cell, as Excel reads it.
    const asA1 = r1c1ToA1(source, ctx.env.row, ctx.env.col);
    if (!asA1) return err("#REF!", `"${t}" is not an R1C1 reference, such as R2C3 or R[-1]C`);
    source = asA1;
  }
  let node;
  try {
    node = parseFormula(source);
  } catch {
    return err("#REF!", `"${t}" is not a reference`);
  }
  if (node.k !== "cell" && node.k !== "range") return err("#REF!", `"${t}" is not a reference`);
  return ctx.evaluate ? ctx.evaluate(node) : err("#REF!");
};

/**
 * R1C1 text as A1 text, read from the cell at (row, col), 0-based: R2C3 is
 * C2, R[-1]C is the cell above, RC[1] the cell to the right, and two joined by
 * a colon a range. A sheet prefix is kept. Null if it is not R1C1, or falls
 * outside the sheet.
 */
function r1c1ToA1(text: string, row: number, col: number): string | null {
  const PART = "R(?:\\[-?\\d+\\]|\\d+)?C(?:\\[-?\\d+\\]|\\d+)?";
  const m = new RegExp(`^(?:(.+)!)?(${PART})(?::(${PART}))?$`, "i").exec(text);
  if (!m) return null;
  const one = (ref: string): string | null => {
    const p = /^R(?:\[(-?\d+)\]|(\d+))?C(?:\[(-?\d+)\]|(\d+))?$/i.exec(ref);
    if (!p) return null;
    const r = p[2] !== undefined ? Number(p[2]) - 1 : row + Number(p[1] ?? 0);
    const c = p[4] !== undefined ? Number(p[4]) - 1 : col + Number(p[3] ?? 0);
    if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) return null;
    return `${colLetters(c)}${r + 1}`;
  };
  const first = one(m[2]);
  const second = m[3] ? one(m[3]) : "";
  if (!first || second === null) return null;
  return `${m[1] ? `${m[1]}!` : ""}${first}${second ? `:${second}` : ""}`;
}

/** ADDRESS(row, column, [abs_num], [a1], [sheet]): a reference as text. */
F.ADDRESS = (args) => {
  const e = arity(args, 2, 5);
  if (e) return e;
  const row = num(args[0]);
  const col = num(args[1]);
  const abs = num(args[2], 1);
  const a1 = bool(args[3], true);
  const sheet = text(args[4], "");
  for (const x of [row, col, abs, a1, sheet]) if (isError(x)) return x;
  const r = Math.trunc(row as number);
  const c = Math.trunc(col as number);
  const k = Math.trunc(abs as number);
  if (r < 1 || c < 1 || r > MAX_ROWS || c > MAX_COLS || k < 1 || k > 4) return err("#VALUE!");
  const absRow = k === 1 || k === 2;
  const absCol = k === 1 || k === 3;
  const ref = a1
    ? `${absCol ? "$" : ""}${colLetters(c - 1)}${absRow ? "$" : ""}${r}`
    : `R${absRow ? r : `[${r}]`}C${absCol ? c : `[${c}]`}`;
  const s = sheet as string;
  if (!s) return ref;
  return `${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`}!${ref}`;
};

/** HYPERLINK(link, [friendly_name]): what the cell shows. */
F.HYPERLINK = (args) => {
  const e = arity(args, 1, 2);
  if (e) return e;
  const shown = args[1] && args[1].node.k !== "empty" ? args[1] : args[0];
  return scalarOf(shown.value());
};

/** ISREF(value): TRUE for a reference, cell or range. */
F.ISREF = (args) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  const a = args[0];
  if (a.isRef) return true;
  return (
    a.node.k === "call" &&
    ["OFFSET", "INDIRECT", "INDEX"].includes(a.node.name) &&
    !isError(scalarOf(a.value()))
  );
};

/** ISFORMULA(reference): whether the cell holds a formula. */
F.ISFORMULA = (args, ctx) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  const ref = args[0].ref;
  if (!ref) return err("#VALUE!", "ISFORMULA takes a reference, such as A1");
  return ctx.env.formula?.(ref.sheet, ref.r0, ref.c0) !== undefined;
};

/** FORMULATEXT(reference): the cell's formula as text. */
F.FORMULATEXT = (args, ctx) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  const ref = args[0].ref;
  if (!ref) return err("#VALUE!", "FORMULATEXT takes a reference, such as A1");
  return ctx.env.formula?.(ref.sheet, ref.r0, ref.c0) ?? err("#N/A", "That cell holds no formula");
};

/** TOCOL / TOROW(array, [ignore], [scan_by_column]): an array as one column or row. */
const toLine =
  (asColumn: boolean): FnImpl =>
  (args) => {
    const e = arity(args, 1, 3);
    if (e) return e;
    const m = asMatrix(args[0].value());
    const ignore = num(args[1], 0);
    const byCol = bool(args[2], false);
    if (isError(ignore)) return ignore;
    if (isError(byCol)) return byCol;
    const k = Math.trunc(ignore);
    if (k < 0 || k > 3) return err("#VALUE!");
    const cells: Scalar[] = [];
    const rows = m.length;
    const cols = m[0]?.length ?? 0;
    if (byCol) {
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cells.push(m[r][c]);
    } else {
      for (const line of m) cells.push(...line);
    }
    const kept = cells.filter(
      (x) => !((k === 1 || k === 3) && x === null) && !((k === 2 || k === 3) && isError(x)),
    );
    if (!kept.length) return err("#CALC!", "Nothing is left");
    return asColumn ? kept.map((x) => [x]) : [kept];
  };
F.TOCOL = toLine(true);
F.TOROW = toLine(false);

/** The delimiters a text function was given: one text, or an array of them. */
function delimiters(a: Arg | undefined): string[] | SheetError {
  if (!a || a.node.k === "empty") return [];
  const out: string[] = [];
  for (const x of flat(a.value())) {
    if (isError(x)) return x;
    const t = toText(x);
    if (isError(t)) return t;
    out.push(t);
  }
  return out;
}
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with]). */
F.TEXTSPLIT = (args) => {
  const e = arity(args, 2, 6);
  if (e) return e;
  const t = text(args[0]);
  if (isError(t)) return t;
  const colD = delimiters(args[1]);
  const rowD = delimiters(args[2]);
  if (isError(colD)) return colD;
  if (isError(rowD)) return rowD;
  if (!colD.length && !rowD.length) return err("#VALUE!", "Give a delimiter");
  if ([...colD, ...rowD].some((d) => d === ""))
    return err("#VALUE!", "A delimiter cannot be empty");
  const ignore = bool(args[3], false);
  const mode = num(args[4], 0);
  if (isError(ignore)) return ignore;
  if (isError(mode)) return mode;
  const pad = args[5] && args[5].node.k !== "empty" ? scalarOf(args[5].value()) : err("#N/A");
  const flags = mode === 1 ? "i" : "";
  const split = (s: string, ds: string[]) => {
    if (!ds.length) return [s];
    const parts = s.split(new RegExp(ds.map(escapeRe).join("|"), flags));
    return ignore ? parts.filter((p) => p !== "") : parts;
  };
  const rows = split(t, rowD).map((line) => split(line, colD));
  const width = Math.max(1, ...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array<Scalar>(width - r.length).fill(pad)]);
};

/** TEXTBEFORE / TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]). */
const textAround =
  (after: boolean): FnImpl =>
  (args) => {
    const e = arity(args, 2, 6);
    if (e) return e;
    const t = text(args[0]);
    if (isError(t)) return t;
    const ds = delimiters(args[1]);
    if (isError(ds)) return ds;
    const n = num(args[2], 1);
    const mode = num(args[3], 0);
    const end = num(args[4], 0);
    for (const x of [n, mode, end]) if (isError(x)) return x;
    const k = Math.trunc(n as number);
    if (k === 0 || Math.abs(k) > t.length + 1) return err("#VALUE!");
    const notFound =
      args[5] && args[5].node.k !== "empty" ? scalarOf(args[5].value()) : err("#N/A");
    // Every place a delimiter starts, left to right.
    const hay = mode === 1 ? t.toLowerCase() : t;
    const found: { at: number; len: number }[] = [];
    if (ds.some((d) => d === "")) {
      found.push({ at: 0, len: 0 });
    } else {
      let i = 0;
      while (i <= hay.length) {
        let hit: { at: number; len: number } | null = null;
        for (const d of ds) {
          const j = hay.indexOf(mode === 1 ? d.toLowerCase() : d, i);
          if (j >= 0 && (!hit || j < hit.at)) hit = { at: j, len: d.length };
        }
        if (!hit) break;
        found.push(hit);
        i = hit.at + Math.max(1, hit.len);
      }
    }
    // With match_end, the end of the text counts as a delimiter (the start, counting back).
    if (end === 1) {
      if (k > 0) found.push({ at: t.length, len: 0 });
      else found.unshift({ at: 0, len: 0 });
    }
    const pick = k > 0 ? found[k - 1] : found[found.length + k];
    if (!pick) return notFound;
    return after ? t.slice(pick.at + pick.len) : t.slice(0, pick.at);
  };
F.TEXTBEFORE = textAround(false);
F.TEXTAFTER = textAround(true);

/** RANDARRAY([rows], [columns], [min], [max], [whole_number]). */
F.RANDARRAY = (args) => {
  const e = arity(args, 0, 5);
  if (e) return e;
  const rows = num(args[0], 1);
  const cols = num(args[1], 1);
  const lo = num(args[2], 0);
  const hi = num(args[3], 1);
  const whole = bool(args[4], false);
  for (const x of [rows, cols, lo, hi, whole]) if (isError(x)) return x;
  const R = Math.trunc(rows as number);
  const C = Math.trunc(cols as number);
  if (R < 1 || C < 1 || (hi as number) < (lo as number)) return err("#VALUE!");
  if (R * C > 1_000_000) return err("#NUM!", "Too large");
  const a = lo as number;
  const b = hi as number;
  return Array.from({ length: R }, () =>
    Array.from({ length: C }, () =>
      whole
        ? Math.ceil(a) + Math.floor(Math.random() * (Math.floor(b) - Math.ceil(a) + 1))
        : a + Math.random() * (b - a),
    ),
  );
};

/**
 * LOOKUP(value, lookup_vector, [result_vector]), or LOOKUP(value, array):
 * the largest value not above the one looked for, in sorted data. The array
 * form searches the first row of a wide array or the first column of a tall
 * one, and answers from the last. (formula.js answered the array form with
 * the value found, not the one beside it.)
 */
F.LOOKUP = (args) => {
  const e = arity(args, 2, 3);
  if (e) return e;
  const needle = scalarOf(args[0].value());
  if (isError(needle)) return needle;
  const m = asMatrix(args[1].value());
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  let look: Scalar[];
  let answer: Scalar[];
  if (args.length === 3) {
    look = flat(m);
    answer = flat(args[2].value());
  } else if (cols > rows) {
    look = m[0];
    answer = m[rows - 1];
  } else {
    look = m.map((r) => r[0]);
    answer = m.map((r) => r[cols - 1]);
  }
  const i = approxIndex(needle, look);
  if (i < 0) return err("#N/A", "No value that low");
  return answer[i] ?? err("#N/A");
};

/** TIME(hour, minute, second): a time of day, past 24 hours wrapping round as in Excel. */
F.TIME = (args) => {
  const e = arity(args, 3, 3);
  if (e) return e;
  const [h, m, sec] = [num(args[0]), num(args[1]), num(args[2])];
  for (const x of [h, m, sec]) if (isError(x)) return x;
  const total =
    Math.trunc(h as number) * 3600 + Math.trunc(m as number) * 60 + Math.trunc(sec as number);
  if (total < 0) return err("#NUM!");
  return (total % 86400) / 86400;
};

/** TIMEVALUE(text): the time of day a text names ("6:30 PM", "18:30:05", "2026-09-28 18:30"). */
F.TIMEVALUE = (args) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  const t = text(args[0]);
  if (isError(t)) return t;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(AM|PM)?\s*$/i.exec(t.trim());
  if (!m) return err("#VALUE!", `"${t}" is not a time`);
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = Number(m[3] ?? 0);
  if (m[4]) {
    if (h < 1 || h > 12) return err("#VALUE!");
    h = (h % 12) + (m[4].toUpperCase() === "PM" ? 12 : 0);
  }
  if (h > 23 || mi > 59 || sec >= 60) return err("#VALUE!");
  return (h * 3600 + mi * 60 + sec) / 86400;
};

/** NUMBERVALUE(text, [decimal_separator], [group_separator]): a number written any locale's way. */
F.NUMBERVALUE = (args) => {
  const e = arity(args, 1, 3);
  if (e) return e;
  const t = text(args[0]);
  const dec = text(args[1], ".");
  const grp = text(args[2], ",");
  for (const x of [t, dec, grp]) if (isError(x)) return x;
  let body = (t as string).replace(/\s/g, "");
  if (!body) return 0;
  let percents = 0;
  while (body.endsWith("%")) {
    percents++;
    body = body.slice(0, -1);
  }
  const d = (dec as string).charAt(0) || ".";
  const g = (grp as string).charAt(0);
  const at = body.indexOf(d);
  const whole = at < 0 ? body : body.slice(0, at);
  const frac = at < 0 ? "" : body.slice(at + 1);
  // A group separator after the decimal one, or a second decimal separator, is not a number.
  if ((g && frac.includes(g)) || frac.includes(d)) return err("#VALUE!");
  const n = Number(`${g ? whole.split(g).join("") : whole}${at < 0 ? "" : `.${frac}`}`);
  if (!Number.isFinite(n)) return err("#VALUE!", `"${t}" is not a number`);
  return n / 100 ** percents;
};

/** FREQUENCY(data, bins): how many values fall in each bin, and above the last, as a column. */
F.FREQUENCY = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  const data: number[] = [];
  for (const x of flat(args[0].value())) {
    if (isError(x)) return x;
    if (typeof x === "number") data.push(x);
  }
  const bins: number[] = [];
  for (const x of flat(args[1].value())) {
    if (isError(x)) return x;
    if (typeof x === "number") bins.push(x);
  }
  const counts = Array<number>(bins.length + 1).fill(0);
  // Each value goes to the lowest bin at or above it; a bin repeated counts once.
  const order = bins.map((b, i) => ({ b, i })).sort((x, y) => x.b - y.b || x.i - y.i);
  for (const v of data) {
    const hit = order.find((o) => v <= o.b);
    counts[hit ? hit.i : bins.length]++;
  }
  return counts.map((c) => [c]);
};

/** LET is evaluated by the evaluator (its names need a scope); this entry only makes it known. */
F.LET = () => err("#VALUE!", "LET is evaluated where it stands");
/** LAMBDA and the functions that take one are evaluated by the evaluator too (R328). */
for (const name of ["LAMBDA", "MAP", "REDUCE", "SCAN", "BYROW", "BYCOL", "MAKEARRAY", "ISOMITTED"])
  F[name] = () => err("#VALUE!", `${name} is evaluated where it stands`);

// ── Long tail from formula.js ──────────────────────────────────────────────

export const LIBRARY_NAMES = [
  "SUMSQ",
  "TAKE",
  "DROP",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "VSTACK",
  "HSTACK",
  "CEILING.MATH",
  "FLOOR.MATH",
  "NETWORKDAYS.INTL",
  "WORKDAY.INTL",
  "TREND",
  "GROWTH",
  "STDEV",
  "STDEV.S",
  "STDEV.P",
  "STDEVA",
  "STDEVP",
  "VAR",
  "VAR.S",
  "VAR.P",
  "PERCENTILE",
  "PERCENTILE.INC",
  "PERCENTILE.EXC",
  "QUARTILE",
  "QUARTILE.INC",
  "RANK",
  "RANK.EQ",
  "RANK.AVG",
  "LARGE",
  "SMALL",
  "MODE",
  "MODE.SNGL",
  "CORREL",
  "COVARIANCE.S",
  "COVARIANCE.P",
  "SLOPE",
  "INTERCEPT",
  "RSQ",
  "FORECAST",
  "FORECAST.LINEAR",
  "GEOMEAN",
  "HARMEAN",
  "AVEDEV",
  "DEVSQ",
  "KURT",
  "SKEW",
  "NORM.DIST",
  "NORM.INV",
  "NORM.S.DIST",
  "NORM.S.INV",
  "PMT",
  "IPMT",
  "PPMT",
  "FV",
  "PV",
  "NPV",
  "XNPV",
  "IRR",
  "MIRR",
  "CUMIPMT",
  "CUMPRINC",
  "FVSCHEDULE",
  "SYD",
  "ISPMT",
  "PDURATION",
  "RRI",
  "XIRR",
  "RATE",
  "NPER",
  "EFFECT",
  "NOMINAL",
  "SLN",
  "DB",
  "DDB",
  "NETWORKDAYS",
  "WORKDAY",
  "DATEDIF",
  "YEARFRAC",
  "WEEKNUM",
  "ISOWEEKNUM",
  "FACT",
  "COMBIN",
  "PERMUT",
  "GCD",
  "LCM",
  "QUOTIENT",
  "MROUND",
  "EVEN",
  "ODD",
  "SIN",
  "COS",
  "TAN",
  "ASIN",
  "ACOS",
  "ATAN",
  "ATAN2",
  "SINH",
  "COSH",
  "TANH",
  "DEGREES",
  "RADIANS",
  "LOG",
  "BASE",
  "DECIMAL",
  "ROMAN",
  "ARABIC",
  "BIN2DEC",
  "DEC2BIN",
  "HEX2DEC",
  "DEC2HEX",
  "DEC2OCT",
  "OCT2DEC",
  "OCT2BIN",
  "OCT2HEX",
  "BIN2OCT",
  "BIN2HEX",
  "HEX2BIN",
  "HEX2OCT",
  "CLEAN",
  "UNICHAR",
  "UNICODE",
  "FIXED",
  "DOLLAR",
  // R258: #NAME? on a grid until now. formula.js answers each of these as
  // Excel's documentation does (sheetsExcelBatch1.test.ts). T.DIST is NOT
  // here: formula.js answers #NUM! for every input, so it is written below.
  "AVERAGEA",
  "MAXA",
  "MINA",
  "TRIMMEAN",
  "MMULT",
  "QUARTILE.EXC",
  "PERCENTRANK.INC",
  "PERCENTRANK.EXC",
  "BINOM.DIST",
  "TDIST",
  "BITAND",
  "BITOR",
  "BITXOR",
  "BITLSHIFT",
  "BITRSHIFT",
  "COMPLEX",
  "VARA",
  // R262: the distributions, each checked against a closed form, an identity
  // or a round trip (sheetsDistributions.test.ts). GAMMA and the legacy
  // LOGNORMDIST and TINV are NOT here: formula.js gets those wrong, so they
  // are written below.
  "EXPON.DIST",
  "POISSON.DIST",
  "WEIBULL.DIST",
  "HYPGEOM.DIST",
  "NEGBINOM.DIST",
  "CHISQ.DIST",
  "CHISQ.DIST.RT",
  "CHISQ.INV",
  "CHISQ.INV.RT",
  "GAMMA.DIST",
  "GAMMA.INV",
  "BETA.DIST",
  "BETA.INV",
  "F.DIST",
  "F.DIST.RT",
  "F.INV",
  "F.INV.RT",
  "LOGNORM.DIST",
  "LOGNORM.INV",
  "GAMMALN",
  "GAMMALN.PRECISE",
  "FISHER",
  "FISHERINV",
  "PHI",
  "GAUSS",
  "STANDARDIZE",
  "COMBINA",
  "PERMUTATIONA",
  "T.INV",
  "T.INV.2T",
  "BINOM.INV",
  "CONFIDENCE.NORM",
  "CONFIDENCE.T",
  "EXPONDIST",
  "HYPGEOMDIST",
  "NEGBINOMDIST",
  "GAMMADIST",
];
for (const name of LIBRARY_NAMES) {
  if (F[name]) continue;
  const impl = fromLibrary(name);
  if (impl) F[name] = impl;
}

/**
 * Names Excel still takes, as the functions they became. FOUND IN R147:
 * formula.js exports these as groups (STDEV.S and STDEV.P under STDEV), so
 * the loop above found no function and passed over them without a word:
 * =STDEV(A1:A9) was #NAME? on a grid while the lakehouse computed it over a
 * table sheet. A listed name that does not register now fails a test.
 */
/**
 * How many numbers a statistic needs, and the error Excel gives below that.
 *
 * FOUND IN R261. formula.js answered these with a NUMBER where Excel refuses:
 * STDEV.S and VAR.S of no numbers were 0 (one number gave #NUM!), and
 * HARMEAN(0) was 0. And it answered the wrong error for the rest: SKEW below
 * three values and KURT below four were #NUM!, STDEV.P and VAR.P of nothing
 * #NUM!, LARGE, SMALL, PERCENTILE and QUARTILE of an empty list #VALUE!,
 * GEOMEAN of one #VALUE!, MODE of one #VALUE!. Each code below is the one
 * the function's own page in Excel's documentation states.
 */
const TOO_FEW: Record<string, [number, ErrorCode]> = {
  "STDEV.S": [2, "#DIV/0!"],
  "VAR.S": [2, "#DIV/0!"],
  STDEVA: [2, "#DIV/0!"],
  VARA: [2, "#DIV/0!"],
  "STDEV.P": [1, "#DIV/0!"],
  "VAR.P": [1, "#DIV/0!"],
  STDEVP: [1, "#DIV/0!"],
  SKEW: [3, "#DIV/0!"],
  KURT: [4, "#DIV/0!"],
  GEOMEAN: [1, "#NUM!"],
  "MODE.SNGL": [1, "#N/A"],
  LARGE: [1, "#NUM!"],
  SMALL: [1, "#NUM!"],
  "PERCENTILE.INC": [1, "#NUM!"],
  "PERCENTILE.EXC": [1, "#NUM!"],
  "QUARTILE.INC": [1, "#NUM!"],
  "QUARTILE.EXC": [1, "#NUM!"],
};
for (const [name, [min, code]] of Object.entries(TOO_FEW)) {
  const inner = F[name];
  const how = LIBRARY_ARGS[name];
  if (!inner || !how?.lists) continue;
  F[name] = (args, ctx) => {
    const lists = how.lists!(args.length)
      .map((i) => args[i])
      .filter((a): a is Arg => !!a);
    const xs = how.countAll ? collectNumbersA(lists) : collectNumbers(lists);
    if (isError(xs)) return xs;
    if (xs.length < min) {
      return err(code, min === 1 ? "There are no numbers" : `It needs at least ${min} numbers`);
    }
    return inner(args, ctx);
  };
}
/** HARMEAN: "If any data point is 0 or less, HARMEAN returns #NUM!" — formula.js said 0. */
{
  const inner = F.HARMEAN;
  if (inner) {
    F.HARMEAN = (args, ctx) => {
      const xs = collectNumbers(args);
      if (isError(xs)) return xs;
      if (xs.some((x) => x <= 0)) return err("#NUM!", "Every value must be above 0");
      return inner(args, ctx);
    };
  }
}

const SAME_AS: Record<string, string> = {
  STDEV: "STDEV.S",
  VAR: "VAR.S",
  PERCENTILE: "PERCENTILE.INC",
  QUARTILE: "QUARTILE.INC",
  RANK: "RANK.EQ",
  MODE: "MODE.SNGL",
  "FORECAST.LINEAR": "FORECAST",
  PERCENTRANK: "PERCENTRANK.INC",
  VARP: "VAR.P",
  // R262: the pre-2010 names, where the arguments are the same.
  POISSON: "POISSON.DIST",
  WEIBULL: "WEIBULL.DIST",
  NORMDIST: "NORM.DIST",
  CHIDIST: "CHISQ.DIST.RT",
  FDIST: "F.DIST.RT",
  CHIINV: "CHISQ.INV.RT",
  FINV: "F.INV.RT",
  GAMMAINV: "GAMMA.INV",
  BETAINV: "BETA.INV",
  LOGINV: "LOGNORM.INV",
  // formula.js's own TINV answers -0; T.INV.2T is the same function, right.
  TINV: "T.INV.2T",
  CRITBINOM: "BINOM.INV",
  CONFIDENCE: "CONFIDENCE.NORM",
  BINOMDIST: "BINOM.DIST",
};
for (const [name, now] of Object.entries(SAME_AS)) if (!F[name] && F[now]) F[name] = F[now];

/** A number as an argument, for handing a library function a value read here. */
const numberArg = (v: number): Arg => ({ node: { k: "num", v }, value: () => v, isRef: false });

/**
 * Working days between two dates, read as Excel reads them (R173). FOUND IN
 * R173: formula.js counts only forwards and, given a later start, returned
 * the calendar days between the two, weekends and holidays included (a year
 * counted backwards was -364 working days where Excel says -262); it counted
 * a start later in the day than the end as no day at all; and it turned an
 * error in a date into #VALUE!. Here the dates are whole days, an error
 * passes through, and backwards is minus forwards.
 */
for (const name of ["NETWORKDAYS", "NETWORKDAYS.INTL"]) {
  const forwards = F[name];
  if (!forwards) continue;
  F[name] = (args, ctx) => {
    if (args.length < 2) return forwards(args, ctx);
    const from = num(args[0]);
    if (isError(from)) return from;
    const to = num(args[1]);
    if (isError(to)) return to;
    const a = Math.floor(from);
    const b = Math.floor(to);
    if (a <= b) return forwards([numberArg(a), numberArg(b), ...args.slice(2)], ctx);
    const v = forwards([numberArg(b), numberArg(a), ...args.slice(2)], ctx);
    return typeof v === "number" ? -v : v;
  };
}

/**
 * DOLLAR brackets a negative amount outside the sign, "($1,234.57)", as
 * Excel's currency format does. FOUND IN R175: formula.js wrote "$(1,234.57)".
 */
const libraryDollar = F.DOLLAR;
if (libraryDollar) {
  F.DOLLAR = (args, ctx) => {
    const n = num(args[0]);
    if (isError(n)) return n;
    if (n >= 0) return libraryDollar(args, ctx);
    const v = libraryDollar([numberArg(-n), ...args.slice(1)], ctx);
    return typeof v === "string" ? `(${v})` : v;
  };
}

/**
 * DATEDIF in whole days ("D") is the difference of the serials, as Excel's
 * is. FOUND IN R205: formula.js turns the serials into dates and back by two
 * rules that disagree around Excel's 1900-02-29, so 1900-02-28 to 03-01 was 0
 * days (Excel: 2) and 03-01 to 03-02 was 2 (Excel: 1). A start after the end
 * is #NUM!, as in Excel. The calendar units still go to formula.js.
 */
const libraryDatedif = F.DATEDIF;
if (libraryDatedif) {
  F.DATEDIF = (args, ctx) => {
    const unit = text(args[2]);
    if (isError(unit) || unit.trim().toUpperCase() !== "D") return libraryDatedif(args, ctx);
    const from = num(args[0]);
    if (isError(from)) return from;
    const to = num(args[1]);
    if (isError(to)) return to;
    const a = Math.floor(from);
    const b = Math.floor(to);
    if (a > b) return err("#NUM!", "DATEDIF's start date is after its end date");
    return b - a;
  };
}

/** Hexadecimal and base-36 digits in capitals, as Excel writes them. FOUND IN R176: ff. */
for (const name of ["DEC2HEX", "BIN2HEX", "OCT2HEX", "BASE"]) {
  const lower = F[name];
  if (!lower) continue;
  F[name] = (args, ctx) => {
    const v = lower(args, ctx);
    return typeof v === "string" ? v.toUpperCase() : v;
  };
}

// ── Database functions (DSUM, DAVERAGE, DGET…) ─────────────────────────────
//
// FOUND IN R259. formula.js has these, and they do not read criteria the way
// Excel does: on Microsoft's own tree example its DSUM of the apple trees'
// profit was the profit of EVERY tree (502.8, not 225), whichever way the
// table was handed over, and most of the rest answered wrongly or threw. So
// they are written here, to Excel's rules for a criteria range:
//
//   - the first row of the criteria range names fields of the database (case
//     does not matter); each row below it is one alternative, and a record
//     matches if ANY row matches;
//   - within a row every non-blank cell must match (AND), and a blank cell is
//     no condition at all;
//   - a bare text criterion is "begins with" (Dav finds Davolio and David),
//     "=Dav" is exact, and > < >= <= <> compare, with * ? ~ as wildcards.

type Database = { headers: string[]; rows: Scalar[][] };

/** A header or field label, compared without case. An error in a header names no field. */
function labelOf(h: Scalar): string {
  if (h === null || isError(h)) return "";
  const t = toText(h);
  return (isError(t) ? "" : t).trim().toLowerCase();
}

function databaseOf(a: Arg): Database | SheetError {
  const m = asMatrix(a.value());
  if (m.length < 1 || !m[0]?.length) return err("#VALUE!", "The database needs a header row");
  return {
    headers: m[0].map((h) => labelOf(h)),
    rows: m.slice(1),
  };
}

/** The field argument: a column label (any case) or a 1-based column number. */
function fieldIndex(db: Database, a: Arg): number | SheetError {
  const v = scalarOf(a.value());
  if (isError(v)) return v;
  if (typeof v === "number") {
    const k = Math.trunc(v);
    return k >= 1 && k <= db.headers.length ? k - 1 : err("#VALUE!", `There is no column ${k}`);
  }
  const name = labelOf(v);
  const i = db.headers.indexOf(name);
  return i >= 0 ? i : err("#VALUE!", `No column is labelled "${v}"`);
}

/** A criteria-range cell as a predicate; null when it sets no condition. */
function databaseCriterion(c: Scalar): ((v: Scalar) => boolean) | null {
  if (c === null || c === "") return null;
  if (typeof c === "string" && !/^\s*(<=|>=|<>|<|>|=)/.test(c) && parseNumberText(c) === null) {
    // Bare text: begins with.
    return makeCriterion(`${c}*`);
  }
  return makeCriterion(c);
}

/** Which records the criteria range selects. */
function matchingRows(db: Database, a: Arg): Scalar[][] | SheetError {
  const m = asMatrix(a.value());
  if (m.length < 2)
    return err("#VALUE!", "The criteria need a header row and at least one row under it");
  const cols = m[0].map((h) => db.headers.indexOf(labelOf(h)));
  const alternatives = m
    .slice(1)
    .map((row) =>
      row.map((cell, j) => ({ col: cols[j], test: databaseCriterion(cell) })).filter((c) => c.test),
    );
  return db.rows.filter((rec) =>
    alternatives.some((conds) =>
      // A condition under a label the database does not have selects nothing here.
      // Excel reads such a column as a COMPUTED criterion (a formula), which this
      // engine does not support; refusing to match is the cautious half of that.
      conds.every((c) => c.col >= 0 && (c.test as (v: Scalar) => boolean)(rec[c.col] ?? null)),
    ),
  );
}

/** The selected records' values in the field; `field` may be omitted for the counts. */
function databaseValues(
  args: Arg[],
  fieldOptional = false,
): Scalar[] | { records: number } | SheetError {
  const e = arity(args, 3, 3);
  if (e) return e;
  const db = databaseOf(args[0]);
  if (isError(db)) return db;
  const rows = matchingRows(db, args[2]);
  if (isError(rows)) return rows;
  if (fieldOptional && args[1].node.k === "empty") return { records: rows.length };
  const i = fieldIndex(db, args[1]);
  if (isError(i)) return i;
  return rows.map((r) => r[i] ?? null);
}

function numbersOf(vals: Scalar[]): number[] | SheetError {
  const out: number[] = [];
  for (const v of vals) {
    if (isError(v)) return v;
    if (typeof v === "number") out.push(v);
  }
  return out;
}

const dbNumbers = (args: Arg[]): number[] | SheetError => {
  const vals = databaseValues(args);
  if (isError(vals)) return vals;
  return numbersOf(vals as Scalar[]);
};
const variance = (xs: number[], sample: boolean): number | SheetError => {
  const n = xs.length;
  if (n === 0 || (sample && n < 2)) return err("#DIV/0!", "Not enough values");
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (sample ? n - 1 : n);
};

F.DSUM = (args) => {
  const xs = dbNumbers(args);
  return isError(xs) ? xs : xs.reduce((a, b) => a + b, 0);
};
F.DAVERAGE = (args) => {
  const xs = dbNumbers(args);
  if (isError(xs)) return xs;
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : err("#DIV/0!", "No values match");
};
F.DMAX = (args) => {
  const xs = dbNumbers(args);
  return isError(xs) ? xs : xs.length ? Math.max(...xs) : 0;
};
F.DMIN = (args) => {
  const xs = dbNumbers(args);
  return isError(xs) ? xs : xs.length ? Math.min(...xs) : 0;
};
F.DPRODUCT = (args) => {
  const xs = dbNumbers(args);
  return isError(xs) ? xs : xs.length ? xs.reduce((a, b) => a * b, 1) : 0;
};
F.DCOUNT = (args) => {
  const vals = databaseValues(args, true);
  if (isError(vals)) return vals;
  if (!Array.isArray(vals)) return vals.records;
  return vals.filter((v) => typeof v === "number").length;
};
F.DCOUNTA = (args) => {
  const vals = databaseValues(args, true);
  if (isError(vals)) return vals;
  if (!Array.isArray(vals)) return vals.records;
  return vals.filter((v) => v !== null && v !== "").length;
};
F.DGET = (args) => {
  const vals = databaseValues(args);
  if (isError(vals)) return vals;
  const list = vals as Scalar[];
  if (list.length === 0) return err("#VALUE!", "No record matches");
  if (list.length > 1) return err("#NUM!", "More than one record matches");
  return list[0];
};
for (const [name, sample, root] of [
  ["DSTDEV", true, true],
  ["DSTDEVP", false, true],
  ["DVAR", true, false],
  ["DVARP", false, false],
] as const) {
  F[name] = (args) => {
    const xs = dbNumbers(args);
    if (isError(xs)) return xs;
    const v = variance(xs, sample);
    return isError(v) ? v : root ? Math.sqrt(v) : v;
  };
}

// ── Complex numbers (IMSUM, IMPRODUCT, IMDIV…) ─────────────────────────────
//
// FOUND IN R260. formula.js has these and gets the arithmetic right where it is
// exact, but not Excel's text: given "1+2j" and "3+4j" its IMSUM and IMPRODUCT
// answered with an "i" ("-5+10i" where Excel writes "-5+10j"), a mix of "i"
// and "j" was added up instead of being #VALUE!, and a result was written to
// sixteen or seventeen digits ("0.3333333333333333", "-45.99999999999999+
// 9.000000000000007i") where Excel writes any number as text to fifteen
// significant digits ("0.333333333333333", "-46+9.00000000000001i"). So the
// library computed, and a wrapper wrote the answer the way Excel does.
//
// FOUND IN R264, adding the rest of the family: formula.js could not be kept.
// Its parser calls .substring on its argument, so a NUMBER threw - IMSUB(5,2),
// IMPOWER(2,2), IMEXP(0) and IMSUB over two number cells were all #VALUE! - and
// it misread a part written with an exponent, as Excel writes a small or large
// one: "1E-07", "3E-5i" and "1.5E-07-2i" were #NUM!. Its IMPRODUCT never opened a range:
// over "3+4i", 5 and a blank it answered "3+4i". Its IMARGUMENT put the negative
// real axis at -pi, where Excel's range is (-pi, pi]: IMARGUMENT("-1") was
// -3.14159..., which gave IMSQRT("-4") as -2i and IMPOWER("-8",1/3) as
// 1-1.732i, both with the wrong sign. And its IMLN, IMLOG10 and IMLOG2 took the
// angle as atan(y/x), wrong whenever the real part is negative: IMLN("-1") was
// 0, where it is pi i. So the whole family is written here, on R260's parser
// and writer.

type Suffix = "i" | "j";

/** The suffix a complex argument uses, if any; null for a plain number. */
function suffixOf(v: Scalar): Suffix | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const last = t[t.length - 1];
  return last === "i" || last === "j" ? last : null;
}

/** Excel's complex text, read back: "3+4i", "-i", "2j", "5". */
function parseComplexText(text: string): { re: number; im: number } | null {
  const t = text.trim();
  if (!t) return null;
  const last = t[t.length - 1];
  if (last !== "i" && last !== "j") {
    const n = Number(t);
    return Number.isFinite(n) ? { re: n, im: 0 } : null;
  }
  const body = t.slice(0, -1);
  // The sign that starts the imaginary part: the last + or - that is neither
  // the first character nor an exponent's.
  let k = -1;
  for (let i = body.length - 1; i > 0; i--) {
    const ch = body[i];
    if ((ch === "+" || ch === "-") && body[i - 1] !== "e" && body[i - 1] !== "E") {
      k = i;
      break;
    }
  }
  const reText = k > 0 ? body.slice(0, k) : "";
  let imText = k > 0 ? body.slice(k) : body;
  if (imText === "" || imText === "+") imText = "1";
  else if (imText === "-") imText = "-1";
  const re = reText === "" ? 0 : Number(reText);
  const im = Number(imText);
  return Number.isFinite(re) && Number.isFinite(im) ? { re, im } : null;
}

/** A complex number as Excel writes it: "8+i", "-46+9.00000000000001i", "2j", "0". */
function complexText(re: number, im: number, suffix: Suffix): string {
  const reText = numberText(re);
  const imText = numberText(im);
  if (imText === "0") return reText;
  const imPart = imText === "1" ? "" : imText === "-1" ? "-" : imText;
  if (reText === "0") return `${imPart}${suffix}`;
  return `${reText}${im > 0 ? "+" : ""}${imPart}${suffix}`;
}

type Complex = { re: number; im: number };

/**
 * One complex argument, as Excel reads it: a number, or text such as "3+4i",
 * "-2j" or "5". A blank is 0; TRUE and FALSE are #VALUE!, and other text is
 * #NUM!, as Excel's own pages for these functions say.
 */
function complexOf(v: Scalar): Complex | SheetError {
  if (isError(v)) return v;
  if (v === null) return { re: 0, im: 0 };
  if (typeof v === "number") return { re: v, im: 0 };
  if (typeof v === "boolean") return err("#VALUE!", "A complex number cannot be TRUE or FALSE");
  return parseComplexText(v) ?? err("#NUM!", "Not a complex number such as 3+4i");
}

/** The suffix an answer takes: its arguments' own, or "i". Excel refuses a mix of "i" and "j". */
function suffixAcross(values: Scalar[]): Suffix | SheetError {
  let suffix: Suffix | null = null;
  for (const v of values) {
    const sx = suffixOf(v);
    if (sx && suffix && sx !== suffix) return err("#VALUE!", 'Mixes "i" and "j"');
    suffix = sx ?? suffix;
  }
  return suffix ?? "i";
}

/** A complex answer as Excel's text, or #NUM! when it divided by zero or overflowed. */
function complexAnswer(z: Complex | SheetError | null, suffix: Suffix): Value {
  if (z === null) return err("#NUM!", "Divides by zero");
  if (isError(z)) return z;
  if (!Number.isFinite(z.re) || !Number.isFinite(z.im)) return err("#NUM!", "Too large");
  return complexText(z.re, z.im, suffix);
}

const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});

/** a / b, or null when b is zero. */
function cDiv(a: Complex, b: Complex): Complex | null {
  const den = b.re * b.re + b.im * b.im;
  if (den === 0) return null;
  return { re: (a.re * b.re + a.im * b.im) / den, im: (a.im * b.re - a.re * b.im) / den };
}

const ONE: Complex = { re: 1, im: 0 };
const cSin = (z: Complex): Complex => ({
  re: Math.sin(z.re) * Math.cosh(z.im),
  im: Math.cos(z.re) * Math.sinh(z.im),
});
const cCos = (z: Complex): Complex => ({
  re: Math.cos(z.re) * Math.cosh(z.im),
  im: 0 - Math.sin(z.re) * Math.sinh(z.im),
});
const cSinh = (z: Complex): Complex => ({
  re: Math.sinh(z.re) * Math.cos(z.im),
  im: Math.cosh(z.re) * Math.sin(z.im),
});
const cCosh = (z: Complex): Complex => ({
  re: Math.cosh(z.re) * Math.cos(z.im),
  im: Math.sinh(z.re) * Math.sin(z.im),
});
/** The natural logarithm, or null at zero. The angle is atan2's, in (-pi, pi]. */
const cLn = (z: Complex): Complex | null =>
  z.re === 0 && z.im === 0
    ? null
    : { re: Math.log(Math.hypot(z.re, z.im)), im: Math.atan2(z.im, z.re) };
const scaled = (z: Complex | null, by: number): Complex | null =>
  z && { re: z.re / by, im: z.im / by };

/** A function of one complex number with a complex answer. */
function complexFn(f: (z: Complex) => Complex | SheetError | null): FnImpl {
  return (args) => {
    const e = arity(args, 1, 1);
    if (e) return e;
    const v = scalarOf(args[0].value());
    const z = complexOf(v);
    if (isError(z)) return z;
    return complexAnswer(f(z), suffixOf(v) ?? "i");
  };
}

/** A function of one complex number with a number for an answer. */
function complexPart(f: (z: Complex) => number | SheetError): FnImpl {
  return (args) => {
    const e = arity(args, 1, 1);
    if (e) return e;
    const z = complexOf(scalarOf(args[0].value()));
    return isError(z) ? z : f(z);
  };
}

/** A function of two complex numbers: IMSUB and IMDIV. */
function complexPair(f: (a: Complex, b: Complex) => Complex | null): FnImpl {
  return (args) => {
    const e = arity(args, 2, 2);
    if (e) return e;
    const values = [scalarOf(args[0].value()), scalarOf(args[1].value())];
    const a = complexOf(values[0]);
    if (isError(a)) return a;
    const b = complexOf(values[1]);
    if (isError(b)) return b;
    const suffix = suffixAcross(values);
    return isError(suffix) ? suffix : complexAnswer(f(a, b), suffix);
  };
}

/**
 * IMSUM and IMPRODUCT: every value of every argument, ranges included; a blank
 * cell is passed over, as SUM and PRODUCT pass it over.
 */
function complexFold(start: Complex, step: (acc: Complex, z: Complex) => Complex): FnImpl {
  return (args) => {
    const e = arity(args, 1);
    if (e) return e;
    const values = args.flatMap((a) => flat(a.value())).filter((v) => v !== null);
    let acc = start;
    for (const v of values) {
      const z = complexOf(v);
      if (isError(z)) return z;
      acc = step(acc, z);
    }
    const suffix = suffixAcross(values);
    return isError(suffix) ? suffix : complexAnswer(acc, suffix);
  };
}

F.IMSUM = complexFold({ re: 0, im: 0 }, (a, z) => ({ re: a.re + z.re, im: a.im + z.im }));
F.IMPRODUCT = complexFold(ONE, cMul);
F.IMSUB = complexPair((a, b) => ({ re: a.re - b.re, im: a.im - b.im }));
F.IMDIV = complexPair(cDiv);
F.IMCONJUGATE = complexFn((z) => ({ re: z.re, im: 0 - z.im }));
F.IMABS = complexPart((z) => Math.hypot(z.re, z.im));
F.IMREAL = complexPart((z) => z.re);
F.IMAGINARY = complexPart((z) => z.im);
F.IMARGUMENT = complexPart((z) =>
  z.re === 0 && z.im === 0 ? err("#DIV/0!", "Zero has no angle") : Math.atan2(z.im, z.re),
);

/**
 * IMPOWER, in polar form as Excel computes it: |z|^n at n times the angle, so
 * IMPOWER("i",2) keeps a residue of sin(pi) in its imaginary part.
 */
F.IMPOWER = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  const v = scalarOf(args[0].value());
  const z = complexOf(v);
  if (isError(z)) return z;
  const n = num(args[1]);
  if (isError(n)) return n;
  if (z.re === 0 && z.im === 0) {
    return n > 0 ? "0" : err("#NUM!", "Zero to a power that is not positive");
  }
  const p = Math.pow(Math.hypot(z.re, z.im), n);
  const t = Math.atan2(z.im, z.re) * n;
  return complexAnswer({ re: p * Math.cos(t), im: p * Math.sin(t) }, suffixOf(v) ?? "i");
};

F.IMEXP = complexFn((z) => {
  const m = Math.exp(z.re);
  return { re: m * Math.cos(z.im), im: m * Math.sin(z.im) };
});
F.IMLN = complexFn(cLn);
F.IMLOG10 = complexFn((z) => scaled(cLn(z), Math.LN10));
F.IMLOG2 = complexFn((z) => scaled(cLn(z), Math.LN2));
F.IMSIN = complexFn(cSin);
F.IMCOS = complexFn(cCos);
F.IMTAN = complexFn((z) => cDiv(cSin(z), cCos(z)));
F.IMCOT = complexFn((z) => cDiv(cCos(z), cSin(z)));
F.IMSEC = complexFn((z) => cDiv(ONE, cCos(z)));
F.IMCSC = complexFn((z) => cDiv(ONE, cSin(z)));
F.IMSINH = complexFn(cSinh);
F.IMCOSH = complexFn(cCosh);
F.IMSECH = complexFn((z) => cDiv(ONE, cCosh(z)));
F.IMCSCH = complexFn((z) => cDiv(ONE, cSinh(z)));

/**
 * IMSQRT, the principal square root. Excel's root has a non-negative real part
 * and, on the negative real axis, a positive imaginary one: the square root of
 * -4 is 2i (formula.js said -2i). Computed the way C's csqrt and Python's
 * cmath.sqrt compute it, not in polar form, whose cos(pi/2) leaves 1.2E-16 in
 * the real part of 2i: one part is the root of (|re| + r) / 2, the other found
 * by dividing, so neither cancels.
 */
F.IMSQRT = complexFn((z) => {
  if (z.re === 0 && z.im === 0) return z;
  const t = Math.sqrt(Math.abs(z.re) / 2 + Math.hypot(z.re, z.im) / 2);
  return z.re >= 0
    ? { re: t, im: z.im / (2 * t) }
    : { re: Math.abs(z.im) / (2 * t), im: z.im < 0 ? -t : t };
});

// ── GAMMA and the legacy LOGNORMDIST (R262) ───────────────────────────────
//
// FOUND IN R262. formula.js's GAMMA is off in the ninth significant digit -
// GAMMA(0.5) was 1.7724538559 where the answer is the square root of pi,
// 1.7724538509 - which shows at a cell's default width. Its GAMMALN is right
// to the last digit, so GAMMA is exp(GAMMALN), with the reflection formula
// below 1/2 for negative arguments. And its legacy LOGNORMDIST answered the
// DENSITY: LOGNORMDIST(4,1.2,0.5) was 0.186 where Excel's old function is
// cumulative, 0.645, as LOGNORM.DIST(…,TRUE) is.

function gammaOf(x: number): number | SheetError {
  if (x <= 0 && Number.isInteger(x))
    return err("#NUM!", "GAMMA is undefined at 0 and the negative whole numbers");
  const ln = (formulajs as unknown as { GAMMALN: (n: number) => number }).GAMMALN;
  if (x >= 0.5) return Math.exp(ln(x));
  // Reflection: Gamma(x) Gamma(1-x) = pi / sin(pi x).
  return Math.PI / (Math.sin(Math.PI * x) * Math.exp(ln(1 - x)));
}
F.GAMMA = (args) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  const x = num(args[0]);
  if (isError(x)) return x;
  return gammaOf(x);
};
/**
 * BETADIST(x, alpha, beta, [A], [B]) is BETA.DIST(x, alpha, beta, TRUE, A, B).
 * formula.js's BETADIST is its BETA.DIST, so its fourth argument is the
 * cumulative flag: BETADIST(2.5,8,10,1,3) read 1 as "cumulative" and 3 as the
 * lower bound. (A symmetric case, x = 2 between 1 and 3, happened to come
 * out right, which is how this nearly shipped.)
 */
F.BETADIST = (args, ctx) => {
  const e = arity(args, 3, 5);
  if (e) return e;
  const inner = F["BETA.DIST"];
  if (!inner) return err("#NAME?");
  return inner([args[0], args[1], args[2], numberArg(1), ...args.slice(3)], ctx);
};
F.LOGNORMDIST = (args, ctx) => {
  const e = arity(args, 3, 3);
  if (e) return e;
  const inner = F["LOGNORM.DIST"];
  if (!inner) return err("#NAME?");
  // The old function is the cumulative one: LOGNORM.DIST(x, mean, sd, TRUE).
  return inner([...args, numberArg(1)], ctx);
};

// ── VDB (R265) ────────────────────────────────────────────────────────────
//
// FOUND IN R265: formula.js has no VDB, so it was #NAME?. Depreciation from
// one period to another by declining balance at `factor` (2, double, unless
// given), switching to straight line over what is left once that is larger,
// unless no_switch is TRUE. A part period takes its share of that period's
// depreciation, so the pieces of a life always add up to cost - salvage. The
// algorithm is the one LibreOffice uses for Excel's VDB; every test answer is
// worked out from closed forms (sheetsVdb.test.ts).

/** One period's double-declining-balance depreciation, never below the salvage value. */
function ddbPeriod(
  cost: number,
  salvage: number,
  life: number,
  period: number,
  factor: number,
): number {
  let rate = factor / life;
  let before: number;
  if (rate >= 1) {
    rate = 1;
    before = period === 1 ? cost : 0;
  } else {
    before = cost * Math.pow(1 - rate, period - 1);
  }
  const after = cost * Math.pow(1 - rate, period);
  const d = after < salvage ? before - salvage : before - after;
  return d < 0 ? 0 : d;
}

/**
 * Depreciation over the first `periods` whole periods of an asset with `left`
 * periods of its life to go, switching to straight line. (Part periods are
 * taken off by the caller, so this needs no fraction of its own.)
 */
function vdbSpan(
  cost: number,
  salvage: number,
  life: number,
  left: number,
  periods: number,
  factor: number,
): number {
  let total = 0;
  let remaining = cost - salvage;
  let straight: number | null = null;
  for (let i = 1; i <= periods; i++) {
    let term: number;
    if (straight === null) {
      const d = ddbPeriod(cost, salvage, life, i, factor);
      const line = remaining / (left - (i - 1));
      if (line > d) {
        straight = line;
        term = line;
      } else {
        term = d;
        remaining -= d;
      }
    } else {
      term = straight;
    }
    total += term;
  }
  return total;
}

F.VDB = (args) => {
  const e = arity(args, 5, 7);
  if (e) return e;
  const vals: number[] = [];
  for (let i = 0; i < 6; i++) {
    const v = num(args[i], i === 5 ? 2 : undefined);
    if (isError(v)) return v;
    vals.push(v);
  }
  const noSwitch = bool(args[6], false);
  if (isError(noSwitch)) return noSwitch;
  const [cost, salvage, life, start, end, factor] = vals;
  if (cost < 0 || salvage < 0 || life <= 0 || start < 0 || factor <= 0) {
    return err("#NUM!", "VDB needs positive numbers");
  }
  if (end < start) return err("#NUM!", "The span ends before it starts");
  if (end > life) return err("#NUM!", "The span ends after the asset's life");
  if (salvage > cost) return err("#NUM!", "The salvage value is more than the cost");
  const first = Math.floor(start);
  const last = Math.ceil(end);
  if (noSwitch) {
    let total = 0;
    for (let i = first + 1; i <= last; i++) {
      let term = ddbPeriod(cost, salvage, life, i, factor);
      if (i === first + 1) term *= Math.min(end, first + 1) - start;
      else if (i === last) term *= end + 1 - last;
      total += term;
    }
    return total;
  }
  // The part periods at either end, taken off a span of whole periods.
  let part = 0;
  if (start > first) {
    const value = cost - vdbSpan(cost, salvage, life, life, first, factor);
    part += (start - first) * vdbSpan(value, salvage, life, life - first, 1, factor);
  }
  if (end < last) {
    const value = cost - vdbSpan(cost, salvage, life, life, last - 1, factor);
    part += (last - end) * vdbSpan(value, salvage, life, life - last + 1, 1, factor);
  }
  const value = cost - vdbSpan(cost, salvage, life, life, first, factor);
  return vdbSpan(value, salvage, life, life - first, last - first, factor) - part;
};

export const FUNCTIONS: Readonly<Record<string, FnImpl>> = F;

/**
 * Which arguments of a function take one value, so that given an array the
 * evaluator applies the function to each element (Excel's lifting):
 * ISNUMBER(SEARCH("x",A1:A9)) is nine answers, and COUNTIF(A:A,{"a","b"})
 * two. FOUND IN R144. Arguments that take ranges or arrays on purpose (SUM's,
 * INDEX's first, TEXTJOIN's, N's, T's…) never lift.
 */
const all = (n: number) => Array.from({ length: n }, (_, i) => i);
const first = () => [0];
const second = () => [1];
/** COUNTIFS(range1, crit1, range2, crit2…): the criteria. */
const oddOnes = (n: number) => all(n).filter((i) => i % 2 === 1);
/** SUMIFS(values, range1, crit1…): the criteria. */
const evenFromTwo = (n: number) => all(n).filter((i) => i >= 2 && i % 2 === 0);
const SCALAR_FUNCTIONS = [
  "ABS",
  "SQRT",
  "INT",
  "EXP",
  "LN",
  "LOG10",
  "SIGN",
  "POWER",
  "MOD",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "TRUNC",
  "CEILING",
  "FLOOR",
  "NOT",
  "ISBLANK",
  "ISNUMBER",
  "ISTEXT",
  "ISNONTEXT",
  "ISLOGICAL",
  "ISERROR",
  "ISERR",
  "ISNA",
  "ISEVEN",
  "ISODD",
  "LEN",
  "UPPER",
  "LOWER",
  "PROPER",
  "TRIM",
  "LEFT",
  "RIGHT",
  "MID",
  "REPT",
  "SUBSTITUTE",
  "REPLACE",
  "FIND",
  "SEARCH",
  "EXACT",
  "TEXT",
  "VALUE",
  "CHAR",
  "CODE",
  "DATE",
  "YEAR",
  "MONTH",
  "DAY",
  "HOUR",
  "MINUTE",
  "SECOND",
  "WEEKDAY",
  "DATEVALUE",
  "HYPERLINK",
  "TIME",
  "TIMEVALUE",
  "NUMBERVALUE",
  "EDATE",
  "EOMONTH",
  "DAYS",
  "DAYS360",
];
export const LIFTS: ReadonlyMap<string, (argCount: number) => number[]> = new Map([
  ...SCALAR_FUNCTIONS.map((name) => [name, all] as const),
  ...["MATCH", "XMATCH", "XLOOKUP", "VLOOKUP", "HLOOKUP"].map((n) => [n, first] as const),
  ...["COUNTIF", "SUMIF", "AVERAGEIF"].map((n) => [n, second] as const),
  ...["TEXTBEFORE", "TEXTAFTER"].map((n) => [n, first] as const),
  ["COUNTIFS", oddOnes] as const,
  ...["SUMIFS", "AVERAGEIFS", "MINIFS", "MAXIFS"].map((n) => [n, evenFromTwo] as const),
]);

/**
 * Functions that work over arrays by themselves, not through LIFTS, and the
 * argument Excel before dynamic arrays read as one value: IF's condition,
 * IFERROR's value, CHOOSE's index (R162).
 */
export const OWN_LIFTS: ReadonlyMap<string, readonly number[]> = new Map([
  ["IF", [0]],
  ["IFERROR", [0]],
  ["IFNA", [0]],
  ["CHOOSE", [0]],
]);

/** Every function name the engine knows, sorted (for autocomplete and the AI's context). */
export const FUNCTION_NAMES: readonly string[] = Object.keys(F).sort();

export type { FnCtx };
