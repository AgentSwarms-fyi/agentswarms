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
import {
  accrint,
  amordegrc,
  amorlinc,
  checkBasis,
  checkFrequency,
  duration,
  oddfprice,
  oddlprice,
  oddlyield,
  price,
  solveRate,
  yieldOf,
  coupdaybs,
  coupdays,
  coupdaysnc,
  coupncd,
  coupnum,
  couppcd,
  dollarde,
  dollarfr,
  yearFrac,
  type Basis,
} from "./securities";
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
  // The holidays, as one list of dates. FOUND IN R329: formula.js reads each
  // row of what it is given as one date, so holidays across a row (B1:C1,
  // {46301,46302}, DATE(2026,10,{6,7})) were #VALUE! and only a column worked.
  NETWORKDAYS: { lists: () => [2] },
  "NETWORKDAYS.INTL": { lists: () => [3] },
  WORKDAY: { lists: () => [2] },
  "WORKDAY.INTL": { lists: () => [3] },
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

// ── Math and engineering Excel has (R330) ─────────────────────────────────
//
// FOUND IN R329's inventory: these were #NAME?. formula.js has most of them,
// but its ISO.CEILING was wrong in 4 of the 6 cases on Excel's page, its
// ERF(lower, upper) ignored the lower limit, its ERFC(5) was right to 5
// digits, and its BESSELJ took a negative order and did not truncate one.
// So they are written here, and each is checked against its page.

/** CEILING.PRECISE, ISO.CEILING and FLOOR.PRECISE: toward +∞ or −∞ whatever the signs. */
const precise =
  (ceiling: boolean): FnImpl =>
  (args, ctx) =>
    arity(args, 1, 2) ?? multipleMath(ceiling)(args.slice(0, 2), ctx);
F["CEILING.PRECISE"] = precise(true);
F["ISO.CEILING"] = precise(true);
F["FLOOR.PRECISE"] = precise(false);

/** A function of one number, given its own errors. */
const ofNumber =
  (fn: (x: number) => Value): FnImpl =>
  (args) => {
    const bad = arity(args, 1, 1);
    if (bad) return bad;
    const x = num(args[0]);
    return isError(x) ? x : fn(x);
  };
/** Excel's trigonometry takes an angle below 2^27 in size. */
const ANGLE_LIMIT = 2 ** 27;
const reciprocal = (of: (x: number) => number, zeroDivides: boolean): FnImpl =>
  ofNumber((x) =>
    Math.abs(x) >= ANGLE_LIMIT
      ? err("#NUM!", "The number must be below 2^27 in size")
      : zeroDivides && x === 0
        ? err("#DIV/0!", "It is 1 divided by 0 at 0")
        : 1 / of(x),
  );
F.COT = reciprocal(Math.tan, true);
F.CSC = reciprocal(Math.sin, true);
F.SEC = reciprocal(Math.cos, false);
F.COTH = reciprocal(Math.tanh, true);
F.CSCH = reciprocal(Math.sinh, true);
F.SECH = reciprocal(Math.cosh, false);
F.ACOSH = ofNumber((x) => (x < 1 ? err("#NUM!", "ACOSH takes 1 or more") : Math.acosh(x)));
F.ASINH = ofNumber(Math.asinh);
F.ATANH = ofNumber((x) =>
  x <= -1 || x >= 1 ? err("#NUM!", "ATANH takes a number between -1 and 1") : Math.atanh(x),
);
/** ACOT is in 0 to π, as Excel's. */
F.ACOT = ofNumber((x) => Math.PI / 2 - Math.atan(x));
F.ACOTH = ofNumber((x) =>
  Math.abs(x) <= 1
    ? err("#NUM!", "ACOTH takes a number above 1 in size")
    : 0.5 * Math.log((x + 1) / (x - 1)),
);
/** n!!: 1 for 0 and -1, as Excel's, and #NUM! below. */
F.FACTDOUBLE = ofNumber((x) => {
  const n = Math.trunc(x);
  if (n < -1) return err("#NUM!", "FACTDOUBLE takes -1 or more");
  let r = 1;
  for (let k = n; k > 1; k -= 2) r *= k;
  return Number.isFinite(r) ? r : err("#NUM!", "Too large");
});
F.SQRTPI = ofNumber((x) =>
  x < 0 ? err("#NUM!", "SQRTPI takes 0 or more") : Math.sqrt(x * Math.PI),
);
F.MULTINOMIAL = (args) => {
  const bad = arity(args, 1);
  if (bad) return bad;
  const xs = collectNumbers(args);
  if (isError(xs)) return xs;
  if (xs.some((x) => x < 0)) return err("#NUM!", "MULTINOMIAL takes no negative numbers");
  // (a+b+…)! / (a!·b!·…), built up one factor at a time so it stays in range.
  let r = 1;
  let total = 0;
  for (const x of xs) {
    for (let k = 1; k <= Math.trunc(x); k++) r = (r * ++total) / k;
  }
  return Number.isFinite(r) ? r : err("#NUM!", "Too large");
};
/** SERIESSUM(x, n, m, coefficients): Σ aᵢ·x^(n+i·m). */
F.SERIESSUM = (args) => {
  const bad = arity(args, 4, 4);
  if (bad) return bad;
  const [x, n, m] = [num(args[0]), num(args[1]), num(args[2])];
  for (const v of [x, n, m]) if (isError(v)) return v;
  let sum = 0;
  let i = 0;
  for (const a of flat(args[3].value())) {
    if (isError(a)) return a;
    if (a !== null && typeof a !== "number")
      return err("#VALUE!", "SERIESSUM's coefficients must be numbers");
    sum += (a ?? 0) * (x as number) ** ((n as number) + i++ * (m as number));
  }
  return Number.isFinite(sum) ? sum : err("#NUM!", "Too large");
};
F.DELTA = (args) => {
  const bad = arity(args, 1, 2);
  if (bad) return bad;
  const a = num(args[0]);
  if (isError(a)) return a;
  const b = num(args[1], 0);
  return isError(b) ? b : a === b ? 1 : 0;
};
F.GESTEP = (args) => {
  const bad = arity(args, 1, 2);
  if (bad) return bad;
  const a = num(args[0]);
  if (isError(a)) return a;
  const step = num(args[1], 0);
  return isError(step) ? step : a >= step ? 1 : 0;
};

const SQRT_PI = Math.sqrt(Math.PI);
/** erf for 0 ≤ x < 2: (2/√π)·e^(−x²)·Σ 2ⁿx^(2n+1)/(2n+1)!!, every term positive. */
function erfSeries(x: number): number {
  let term = x;
  let sum = x;
  const x2 = 2 * x * x;
  for (let n = 1; n < 500; n++) {
    term *= x2 / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return (2 / SQRT_PI) * Math.exp(-x * x) * sum;
}
/** erfc for x ≥ 2, by Laplace's continued fraction (modified Lentz). */
function erfcFraction(x: number): number {
  const tiny = 1e-300;
  let f = x;
  let c = f;
  let d = 0;
  for (let k = 1; k < 1000; k++) {
    const a = k / 2;
    d = x + a * d;
    if (d === 0) d = tiny;
    c = x + a / c;
    if (c === 0) c = tiny;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / (SQRT_PI * f);
}
/** The error function and its complement, to about 16 digits. */
export const erf = (x: number): number =>
  x < 0 ? -erf(-x) : x < 2 ? erfSeries(x) : 1 - erfcFraction(x);
export const erfc = (x: number): number =>
  x < 0 ? 2 - erfc(-x) : x < 2 ? 1 - erfSeries(x) : erfcFraction(x);
/** ERF(lower, [upper]): from 0 to lower, or from lower to upper. */
F.ERF = (args) => {
  const bad = arity(args, 1, 2);
  if (bad) return bad;
  const lower = num(args[0]);
  if (isError(lower)) return lower;
  if (!args[1] || args[1].node.k === "empty") return erf(lower);
  const upper = num(args[1]);
  return isError(upper) ? upper : erf(upper) - erf(lower);
};
F["ERF.PRECISE"] = ofNumber(erf);
F.ERFC = ofNumber(erfc);
F["ERFC.PRECISE"] = ofNumber(erfc);

/** BESSELI/J/K/Y(x, n): the order truncated, and none below 0, as Excel's. */
for (const name of ["BESSELI", "BESSELJ", "BESSELK", "BESSELY"]) {
  const lib = (formulajs as unknown as Record<string, (x: number, n: number) => unknown>)[name];
  F[name] = (args) => {
    const bad = arity(args, 2, 2);
    if (bad) return bad;
    const x = num(args[0]);
    if (isError(x)) return x;
    const n = num(args[1]);
    if (isError(n)) return n;
    if (n < 0) return err("#NUM!", "The order must be 0 or more");
    return scalarOf(fromFormulaJs(lib(x, Math.trunc(n))));
  };
}

/** A square block of numbers, or the error MDETERM and MINVERSE give. */
function squareMatrix(a: Arg | undefined): number[][] | SheetError {
  if (!a) return err("#N/A", "Wrong number of arguments");
  const m = asMatrix(a.value());
  if (m.length !== (m[0]?.length ?? 0)) return err("#VALUE!", "The array must be square");
  const out: number[][] = [];
  for (const line of m) {
    const row: number[] = [];
    for (const x of line) {
      if (isError(x)) return x;
      if (typeof x !== "number") return err("#VALUE!", "Every cell must hold a number");
      row.push(x);
    }
    out.push(row);
  }
  return out;
}
/** MDETERM: by elimination with partial pivoting. */
F.MDETERM = (args) => {
  const bad = arity(args, 1, 1);
  if (bad) return bad;
  const m = squareMatrix(args[0]);
  if (isError(m)) return m;
  const n = m.length;
  let det = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (m[p][c] === 0) return 0;
    if (p !== c) {
      [m[p], m[c]] = [m[c], m[p]];
      det = -det;
    }
    det *= m[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return Number.isFinite(det) ? det : err("#NUM!", "Too large");
};
/** MINVERSE: by Gauss-Jordan; a matrix with no inverse is #NUM!. */
F.MINVERSE = (args) => {
  const bad = arity(args, 1, 1);
  if (bad) return bad;
  const m = squareMatrix(args[0]);
  if (isError(m)) return m;
  const n = m.length;
  const inv = m.map((_, r) => Array.from({ length: n }, (__, c) => (r === c ? 1 : 0)));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (m[p][c] === 0) return err("#NUM!", "The matrix has no inverse (its determinant is 0)");
    [m[p], m[c]] = [m[c], m[p]];
    [inv[p], inv[c]] = [inv[c], inv[p]];
    const pivot = m[c][c];
    for (let k = 0; k < n; k++) {
      m[c][k] /= pivot;
      inv[c][k] /= pivot;
    }
    for (let r = 0; r < n; r++) {
      if (r === c || m[r][c] === 0) continue;
      const f = m[r][c];
      for (let k = 0; k < n; k++) {
        m[r][k] -= f * m[c][k];
        inv[r][k] -= f * inv[c][k];
      }
    }
  }
  return inv;
};
// ── Arrays, text and sheets Excel has (R331) ──────────────────────────────

/** One row or one column as a list, or the #VALUE! WRAPROWS and WRAPCOLS give. */
function vectorOf(a: Arg | undefined, name: string): Scalar[] | SheetError {
  if (!a) return err("#N/A", "Wrong number of arguments");
  const m = asMatrix(a.value());
  if (m.length !== 1 && (m[0]?.length ?? 0) !== 1)
    return err("#VALUE!", `${name} takes one row or one column`);
  return m.length === 1 ? m[0] : m.map((line) => line[0]);
}
/** What fills the rest: the argument, or Excel's #N/A when it is left out. */
const padOf = (a: Arg | undefined): Scalar =>
  !a || a.node.k === "empty" ? err("#N/A", "Past the end of the array") : scalarOf(a.value());
/** WRAPROWS and WRAPCOLS(vector, wrap_count, [pad_with]). */
const wrap =
  (byRows: boolean): FnImpl =>
  (args) => {
    const bad = arity(args, 2, 3);
    if (bad) return bad;
    const xs = vectorOf(args[0], byRows ? "WRAPROWS" : "WRAPCOLS");
    if (isError(xs)) return xs;
    const k = num(args[1]);
    if (isError(k)) return k;
    const n = Math.trunc(k);
    if (n < 1) return err("#NUM!", "The count must be 1 or more");
    const lines = Math.ceil(xs.length / n);
    if (lines * n > 1_000_000) return err("#NUM!", "Too large");
    const pad = padOf(args[2]);
    const at = (i: number, j: number) => (i * n + j < xs.length ? xs[i * n + j] : pad);
    return byRows
      ? Array.from({ length: lines }, (_, i) => Array.from({ length: n }, (__, j) => at(i, j)))
      : Array.from({ length: n }, (_, j) => Array.from({ length: lines }, (__, i) => at(i, j)));
  };
F.WRAPROWS = wrap(true);
F.WRAPCOLS = wrap(false);
/** EXPAND(array, rows, [columns], [pad_with]): a size left out keeps the array's. */
F.EXPAND = (args) => {
  const bad = arity(args, 2, 4);
  if (bad) return bad;
  const m = asMatrix(args[0].value());
  const r0 = m.length;
  const c0 = m[0]?.length ?? 0;
  const size = (a: Arg | undefined, keep: number) => (!a || a.node.k === "empty" ? keep : num(a));
  const r = size(args[1], r0);
  if (isError(r)) return r;
  const c = size(args[2], c0);
  if (isError(c)) return c;
  const R = Math.trunc(r);
  const C = Math.trunc(c);
  if (R < r0 || C < c0) return err("#VALUE!", "EXPAND cannot make the array smaller");
  if (R * C > 1_000_000) return err("#NUM!", "Too large");
  const pad = padOf(args[3]);
  return Array.from({ length: R }, (_, i) =>
    Array.from({ length: C }, (__, j) => (i < r0 && j < c0 ? m[i][j] : pad)),
  );
};

/** A value as ARRAYTOTEXT and VALUETOTEXT write it; strict quotes text, as a formula would. */
function valueText(x: Scalar, strict: boolean): string {
  if (isError(x)) return x.err;
  if (typeof x === "string") return strict ? `"${x.replace(/"/g, '""')}"` : x;
  return toText(x) as string;
}
/** The format: 0 concise (the default) or 1 strict. */
function textFormat(a: Arg | undefined): boolean | SheetError {
  const f = num(a, 0);
  if (isError(f)) return f;
  return f === 0
    ? false
    : f === 1
      ? true
      : err("#VALUE!", "The format is 0 (concise) or 1 (strict)");
}
F.ARRAYTOTEXT = (args) => {
  const bad = arity(args, 1, 2);
  if (bad) return bad;
  const strict = textFormat(args[1]);
  if (isError(strict)) return strict;
  const m = asMatrix(args[0].value());
  return strict
    ? `{${m.map((line) => line.map((x) => valueText(x, true)).join(",")).join(";")}}`
    : m.flatMap((line) => line.map((x) => valueText(x, false))).join(", ");
};
F.VALUETOTEXT = (args) => {
  const bad = arity(args, 1, 2);
  if (bad) return bad;
  const strict = textFormat(args[1]);
  if (isError(strict)) return strict;
  return valueText(scalarOf(args[0].value()), strict);
};

/** SHEET([value]): a sheet's place among the tabs, hidden ones counted, as Excel's. */
F.SHEET = (args, ctx) => {
  const bad = arity(args, 0, 1);
  if (bad) return bad;
  const names = ctx.env.sheetNames?.() ?? [ctx.env.sheet];
  const place = (name: string, missing: SheetError) => {
    const i = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    return i < 0 ? missing : i + 1;
  };
  const a = args[0];
  if (!a || a.node.k === "empty") return place(ctx.env.sheet, err("#N/A", "No such sheet"));
  // A reference, a name for one, or a table sheet's column: the sheet it is on.
  if (a.ref) return place(a.ref.sheet, err("#REF!", `No sheet "${a.ref.sheet}"`));
  if (a.node.k === "struct" && a.node.table)
    return place(a.node.table, err("#REF!", `No sheet "${a.node.table}"`));
  const v = scalarOf(a.value());
  if (isError(v)) return v;
  // A sheet's name as text; Excel's own answer for one it does not have is #N/A.
  if (typeof v === "string") return place(v, err("#N/A", `No sheet "${v}"`));
  return err("#VALUE!", "SHEET takes a reference or a sheet's name");
};
/** SHEETS([reference]): every sheet in the workbook, or 1 for a reference to one. */
F.SHEETS = (args, ctx) => {
  const bad = arity(args, 0, 1);
  if (bad) return bad;
  const names = ctx.env.sheetNames?.() ?? [ctx.env.sheet];
  const a = args[0];
  if (!a || a.node.k === "empty") return names.length;
  const sheet = a.ref?.sheet ?? (a.node.k === "struct" ? a.node.table : undefined);
  if (!sheet) return err("#REF!", "SHEETS takes a reference");
  return names.some((n) => n.toLowerCase() === sheet.toLowerCase())
    ? 1
    : err("#REF!", `No sheet "${sheet}"`);
};
/** AREAS(reference): Sheets has no unions of ranges, so every reference is one area. */
F.AREAS = (args) => {
  const bad = arity(args, 1, 1);
  if (bad) return bad;
  const a = args[0];
  return a.ref || (a.node.k === "struct" && a.node.table)
    ? 1
    : err("#VALUE!", "AREAS takes a reference");
};

// ── CONVERT (R332) ─────────────────────────────────────────────────────────
//
// FOUND IN R329's inventory: CONVERT was #NAME?, and formula.js's knows too
// few of Excel's units: "F", "C" and "ft2", all on Excel's own page, were
// #N/A. This is the page's table: every unit and spelling, case-sensitive,
// the SI prefixes on the metric units (raised to the power on a square or
// cube: "cm2" is 1E-4 m²), and the binary prefixes on bits and bytes only.

/** A unit: its group, how many of the group's base it is, and whether a prefix may go on it. */
type ConvertUnit = {
  group: string;
  factor: number;
  offset: number;
  prefix: boolean;
  power: number;
};
const CONVERT_UNITS = new Map<string, ConvertUnit>();
const units = (
  names: string[],
  group: string,
  factor: number,
  opts: { prefix?: boolean; power?: number; offset?: number } = {},
) => {
  for (const n of names)
    CONVERT_UNITS.set(n, {
      group,
      factor,
      offset: opts.offset ?? 0,
      prefix: opts.prefix ?? false,
      power: opts.power ?? 1,
    });
};
const SI = { prefix: true };
const INCH = 0.0254;
const FOOT = 0.3048;
const MILE = 1609.344;
const NAUTICAL_MILE = 1852;
const LIGHT_YEAR = 9460730472580800;
const PICA_POINT = INCH / 72;
const LB = 453.59237; // grams
const LBF = 4.4482216152605; // newtons
const HORSEPOWER = 745.6998715822702; // watts
const US_FLUID_OUNCE = 2.95735295625e-5; // m³
// Mass, in grams.
units(["g"], "mass", 1, SI);
units(["sg"], "mass", 14593.902937206363);
units(["lbm"], "mass", LB);
units(["u"], "mass", 1.6605390666e-24, SI);
units(["ozm"], "mass", LB / 16);
units(["grain"], "mass", 0.06479891);
units(["cwt", "shweight"], "mass", LB * 100);
units(["uk_cwt", "lcwt", "hweight"], "mass", LB * 112);
units(["stone"], "mass", LB * 14);
units(["ton"], "mass", LB * 2000);
units(["uk_ton", "LTON", "brton"], "mass", LB * 2240);
// Distance, in metres.
units(["m"], "distance", 1, SI);
units(["mi"], "distance", MILE);
units(["Nmi"], "distance", NAUTICAL_MILE);
units(["in"], "distance", INCH);
units(["ft"], "distance", FOOT);
units(["yd"], "distance", 0.9144);
units(["ang"], "distance", 1e-10, SI);
units(["ell"], "distance", INCH * 45);
units(["ly"], "distance", LIGHT_YEAR, SI);
units(["parsec", "pc"], "distance", 3.085677581491367e16, SI);
units(["Picapt", "Pica"], "distance", PICA_POINT);
units(["pica"], "distance", INCH / 6);
units(["survey_mi"], "distance", 6336000 / 3937);
// Time, in seconds.
units(["yr"], "time", 365.25 * 86400);
units(["day", "d"], "time", 86400);
units(["hr"], "time", 3600);
units(["mn", "min"], "time", 60);
units(["sec", "s"], "time", 1, SI);
// Pressure, in pascals.
units(["Pa", "p"], "pressure", 1, SI);
units(["atm", "at"], "pressure", 101325, SI);
units(["mmHg"], "pressure", 133.322387415, SI);
units(["psi"], "pressure", LBF / (INCH * INCH));
units(["Torr"], "pressure", 101325 / 760);
// Force, in newtons.
units(["N"], "force", 1, SI);
units(["dyn", "dy"], "force", 1e-5, SI);
units(["lbf"], "force", LBF);
// Energy, in joules.
units(["J"], "energy", 1, SI);
units(["e"], "energy", 1e-7, SI);
units(["c"], "energy", 4.184, SI);
units(["cal"], "energy", 4.1868, SI);
units(["eV", "ev"], "energy", 1.602176634e-19, SI);
units(["HPh", "hh"], "energy", HORSEPOWER * 3600);
units(["Wh", "wh"], "energy", 3600, SI);
units(["flb"], "energy", FOOT * LBF);
units(["BTU", "btu"], "energy", 1055.05585262);
// Power, in watts.
units(["HP", "h"], "power", HORSEPOWER);
units(["PS"], "power", 735.49875);
units(["W", "w"], "power", 1, SI);
// Magnetism, in teslas.
units(["T"], "magnetism", 1, SI);
units(["ga"], "magnetism", 1e-4, SI);
// Temperature, as kelvin = value × factor + offset.
units(["C", "cel"], "temperature", 1, { offset: 273.15 });
units(["F", "fah"], "temperature", 5 / 9, { offset: (459.67 * 5) / 9 });
units(["K", "kel"], "temperature", 1, SI);
units(["Rank"], "temperature", 5 / 9);
units(["Reau"], "temperature", 1.25, { offset: 273.15 });
// Volume, in cubic metres.
units(["tsp"], "volume", US_FLUID_OUNCE / 6);
units(["tspm"], "volume", 5e-6);
units(["tbs"], "volume", US_FLUID_OUNCE / 2);
units(["oz"], "volume", US_FLUID_OUNCE);
units(["cup"], "volume", US_FLUID_OUNCE * 8);
units(["pt", "us_pt"], "volume", US_FLUID_OUNCE * 16);
units(["uk_pt"], "volume", 5.6826125e-4);
units(["qt"], "volume", US_FLUID_OUNCE * 32);
units(["uk_qt"], "volume", 1.1365225e-3);
units(["gal"], "volume", 3.785411784e-3);
units(["uk_gal"], "volume", 4.54609e-3);
units(["l", "L", "lt"], "volume", 1e-3, SI);
units(["ang3", "ang^3"], "volume", 1e-30, { prefix: true, power: 3 });
units(["barrel"], "volume", 3.785411784e-3 * 42);
units(["bushel"], "volume", 0.03523907016688);
units(["ft3", "ft^3"], "volume", FOOT ** 3);
units(["in3", "in^3"], "volume", INCH ** 3);
units(["ly3", "ly^3"], "volume", LIGHT_YEAR ** 3, { prefix: true, power: 3 });
units(["m3", "m^3"], "volume", 1, { prefix: true, power: 3 });
units(["mi3", "mi^3"], "volume", MILE ** 3);
units(["yd3", "yd^3"], "volume", 0.9144 ** 3);
units(["Nmi3", "Nmi^3"], "volume", NAUTICAL_MILE ** 3);
units(["Picapt3", "Picapt^3", "Pica3", "Pica^3"], "volume", PICA_POINT ** 3);
units(["GRT", "regton"], "volume", FOOT ** 3 * 100);
units(["MTON"], "volume", FOOT ** 3 * 40);
// Area, in square metres.
units(["uk_acre"], "area", 4046.8564224);
units(["us_acre"], "area", 4046.8726098742513);
units(["ang2", "ang^2"], "area", 1e-20, { prefix: true, power: 2 });
units(["ar"], "area", 100, SI);
units(["ft2", "ft^2"], "area", FOOT ** 2);
units(["ha"], "area", 10000);
units(["in2", "in^2"], "area", INCH ** 2);
units(["ly2", "ly^2"], "area", LIGHT_YEAR ** 2, { prefix: true, power: 2 });
units(["m2", "m^2"], "area", 1, { prefix: true, power: 2 });
units(["Morgen"], "area", 2500);
units(["mi2", "mi^2"], "area", MILE ** 2);
units(["Nmi2", "Nmi^2"], "area", NAUTICAL_MILE ** 2);
units(["Picapt2", "Pica2", "Pica^2", "Picapt^2"], "area", PICA_POINT ** 2);
units(["yd2", "yd^2"], "area", 0.9144 ** 2);
// Information, in bits.
units(["bit"], "information", 1, SI);
units(["byte"], "information", 8, SI);
// Speed, in metres per second.
units(["admkn"], "speed", 1853.184 / 3600);
units(["kn"], "speed", NAUTICAL_MILE / 3600);
units(["m/h", "m/hr"], "speed", 1 / 3600, SI);
units(["m/s", "m/sec"], "speed", 1, SI);
units(["mph"], "speed", MILE / 3600);

const SI_PREFIXES: Record<string, number> = {
  Y: 1e24,
  Z: 1e21,
  E: 1e18,
  P: 1e15,
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  h: 1e2,
  da: 1e1,
  e: 1e1,
  d: 1e-1,
  c: 1e-2,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
  a: 1e-18,
  z: 1e-21,
  y: 1e-24,
};
const BINARY_PREFIXES: Record<string, number> = {
  Yi: 2 ** 80,
  Zi: 2 ** 70,
  Ei: 2 ** 60,
  Pi: 2 ** 50,
  Ti: 2 ** 40,
  Gi: 2 ** 30,
  Mi: 2 ** 20,
  ki: 2 ** 10,
};
/** A unit as written: the unit itself, or a prefix on one that takes it. */
function convertUnit(name: string): ConvertUnit | null {
  const exact = CONVERT_UNITS.get(name);
  if (exact) return exact;
  const withPrefix = (prefixLength: number, scale: number | undefined, binary: boolean) => {
    const u = scale === undefined ? undefined : CONVERT_UNITS.get(name.slice(prefixLength));
    if (!u || !u.prefix || (binary && u.group !== "information")) return null;
    return { ...u, factor: u.factor * scale! ** u.power };
  };
  return (
    withPrefix(2, BINARY_PREFIXES[name.slice(0, 2)], true) ??
    withPrefix(2, name.startsWith("da") ? SI_PREFIXES.da : undefined, false) ??
    withPrefix(1, SI_PREFIXES[name[0]], false)
  );
}
F.CONVERT = (args) => {
  const bad = arity(args, 3, 3);
  if (bad) return bad;
  const x = num(args[0]);
  if (isError(x)) return x;
  const from = text(args[1]);
  if (isError(from)) return from;
  const to = text(args[2]);
  if (isError(to)) return to;
  const a = convertUnit(from);
  if (!a) return err("#N/A", `CONVERT has no unit "${from}" (units are case-sensitive)`);
  const b = convertUnit(to);
  if (!b) return err("#N/A", `CONVERT has no unit "${to}" (units are case-sensitive)`);
  if (a.group !== b.group) return err("#N/A", `${from} is ${a.group} and ${to} is ${b.group}`);
  return (x * a.factor + a.offset - b.offset) / b.factor;
};

// ── Statistics Excel has (R333) ────────────────────────────────────────────
//
// FOUND IN R329's inventory: these were #NAME?. formula.js has most, and
// is right on the pages' examples for Z.TEST, COVAR, PEARSON, STEYX,
// SKEW.P, STDEVPA, VARPA, PROB, the SUMX2 three and BINOM.DIST.RANGE, but
// not on these: its T.TEST ignores tails and type and gives the two-tailed
// equal-variance p for every test (0.192 for the page's paired 0.196), its
// F.TEST was 0.614 for the page's 0.648, its CHISQ.TEST is rounded to six
// places, and its MODE.MULT is in the wrong order and shape. The tests here
// are written over formula.js's distributions, which agree with an
// independent incomplete-beta and incomplete-gamma to 1E-8 or better, at a
// fractional number of degrees of freedom too.

const statsLib = formulajs as unknown as {
  T: { DIST: { RT: (t: number, df: number) => number } };
  F: { DIST: (x: number, d1: number, d2: number, cumulative: boolean) => number };
  CHISQ: { DIST: { RT: (x: number, df: number) => number } };
};
const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sumSqDev = (xs: number[]) => {
  const m = meanOf(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0);
};
const sampleVar = (xs: number[]) => sumSqDev(xs) / (xs.length - 1);
/** The numbers of one argument, as Excel's statistics read a range. */
const argNumbers = (a: Arg | undefined) =>
  a ? collectNumbers([a]) : err("#N/A", "Wrong number of arguments");

/**
 * T.TEST(array1, array2, tails, type): 1 paired, 2 equal variances, 3
 * unequal (Welch's, with its degrees of freedom unrounded, as Excel's
 * T.TEST does; the Analysis ToolPak rounds them, T.TEST does not).
 */
F["T.TEST"] = (args) => {
  const bad = arity(args, 4, 4);
  if (bad) return bad;
  const tails = num(args[2]);
  if (isError(tails)) return tails;
  const type = num(args[3]);
  if (isError(type)) return type;
  const k = Math.trunc(tails);
  const kind = Math.trunc(type);
  if (k !== 1 && k !== 2) return err("#NUM!", "Tails is 1 or 2");
  if (kind < 1 || kind > 3) return err("#NUM!", "Type is 1 (paired), 2 or 3");
  let t: number;
  let df: number;
  if (kind === 1) {
    const pairs = pairedNumbers(args[0], args[1]);
    if (isError(pairs)) return pairs;
    const d = pairs[0].map((x, i) => x - pairs[1][i]);
    if (d.length < 2) return err("#DIV/0!", "A paired test needs at least two pairs");
    const se = Math.sqrt(sampleVar(d) / d.length);
    if (se === 0) return err("#DIV/0!", "The differences do not vary");
    t = meanOf(d) / se;
    df = d.length - 1;
  } else {
    const a = argNumbers(args[0]);
    if (isError(a)) return a;
    const b = argNumbers(args[1]);
    if (isError(b)) return b;
    if (a.length < 2 || b.length < 2)
      return err("#DIV/0!", "Each array needs at least two numbers");
    const [n1, n2, v1, v2] = [a.length, b.length, sampleVar(a), sampleVar(b)];
    let se: number;
    if (kind === 2) {
      df = n1 + n2 - 2;
      se = Math.sqrt((((n1 - 1) * v1 + (n2 - 1) * v2) / df) * (1 / n1 + 1 / n2));
    } else {
      const [s1, s2] = [v1 / n1, v2 / n2];
      se = Math.sqrt(s1 + s2);
      df = (s1 + s2) ** 2 / (s1 ** 2 / (n1 - 1) + s2 ** 2 / (n2 - 1));
    }
    if (se === 0) return err("#DIV/0!", "Neither array varies");
    t = (meanOf(a) - meanOf(b)) / se;
  }
  return k * statsLib.T.DIST.RT(Math.abs(t), df);
};
/** F.TEST(array1, array2): the two-tailed probability that the variances are the same. */
F["F.TEST"] = (args) => {
  const bad = arity(args, 2, 2);
  if (bad) return bad;
  const a = argNumbers(args[0]);
  if (isError(a)) return a;
  const b = argNumbers(args[1]);
  if (isError(b)) return b;
  if (a.length < 2 || b.length < 2) return err("#DIV/0!", "Each array needs at least two numbers");
  const [v1, v2] = [sampleVar(a), sampleVar(b)];
  if (v1 === 0 || v2 === 0) return err("#DIV/0!", "An array does not vary");
  const p = statsLib.F.DIST(v1 / v2, a.length - 1, b.length - 1, true);
  return 2 * Math.min(p, 1 - p);
};
/** Z.TEST(array, x, [sigma]): the one-tailed P of a mean above the array's, by the normal. */
F["Z.TEST"] = (args) => {
  const bad = arity(args, 2, 3);
  if (bad) return bad;
  const xs = argNumbers(args[0]);
  if (isError(xs)) return xs;
  if (!xs.length) return err("#N/A", "The array has no numbers");
  const x = num(args[1]);
  if (isError(x)) return x;
  const given = args[2] && args[2].node.k !== "empty";
  const sigma = given ? num(args[2]) : Math.sqrt(xs.length > 1 ? sampleVar(xs) : NaN);
  if (isError(sigma)) return sigma;
  if (!(sigma > 0)) return err("#DIV/0!", "The standard deviation is 0");
  const z = (meanOf(xs) - x) / (sigma / Math.sqrt(xs.length));
  return 0.5 * erfc(z / Math.SQRT2);
};
/** CHISQ.TEST(actual, expected): degrees of freedom (r−1)(c−1), or n−1 for one row or column. */
F["CHISQ.TEST"] = (args) => {
  const bad = arity(args, 2, 2);
  if (bad) return bad;
  const actual = asMatrix(args[0].value());
  const expected = asMatrix(args[1].value());
  const r = actual.length;
  const c = actual[0]?.length ?? 0;
  if (expected.length !== r || (expected[0]?.length ?? 0) !== c)
    return err("#N/A", "The two ranges are different sizes");
  let chi = 0;
  for (let i = 0; i < r; i++)
    for (let j = 0; j < c; j++) {
      const a = actual[i][j];
      const e = expected[i][j];
      if (isError(a)) return a;
      if (isError(e)) return e;
      if (typeof a !== "number" || typeof e !== "number") continue;
      if (e === 0) return err("#DIV/0!", "An expected value is 0");
      chi += (a - e) ** 2 / e;
    }
  const df = r > 1 && c > 1 ? (r - 1) * (c - 1) : r * c - 1;
  if (df < 1) return err("#N/A", "One value has no degrees of freedom");
  return statsLib.CHISQ.DIST.RT(chi, df);
};
/** MODE.MULT: every value that occurs most, at least twice, in order of first appearance, down a column. */
F["MODE.MULT"] = (args) => {
  const bad = arity(args, 1);
  if (bad) return bad;
  const xs = collectNumbers(args);
  if (isError(xs)) return xs;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  const most = Math.max(0, ...counts.values());
  if (most < 2) return err("#N/A", "No value occurs more than once");
  return [...counts].filter(([, n]) => n === most).map(([x]) => [x]);
};
/** STEYX(known_y's, known_x's): the standard error of a predicted y in a regression. */
F.STEYX = (args) => {
  const bad = arity(args, 2, 2);
  if (bad) return bad;
  const pairs = pairedNumbers(args[0], args[1]);
  if (isError(pairs)) return pairs;
  const [ys, xs] = pairs;
  if (xs.length < 3) return err("#DIV/0!", "STEYX needs at least three pairs");
  const [mx, my] = [meanOf(xs), meanOf(ys)];
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return err("#DIV/0!", "The x values do not vary");
  return Math.sqrt(Math.max(0, syy - sxy ** 2 / sxx) / (xs.length - 2));
};
/** SKEW.P: the skewness of a population. */
F["SKEW.P"] = (args) => {
  const bad = arity(args, 1);
  if (bad) return bad;
  const xs = collectNumbers(args);
  if (isError(xs)) return xs;
  if (xs.length < 3) return err("#DIV/0!", "SKEW.P needs at least three numbers");
  const m = meanOf(xs);
  const sd = Math.sqrt(sumSqDev(xs) / xs.length);
  if (sd === 0) return err("#DIV/0!", "The numbers do not vary");
  return xs.reduce((a, x) => a + ((x - m) / sd) ** 3, 0) / xs.length;
};
/** VARPA and STDEVPA: a population's, text in a range counted as 0 and TRUE as 1. */
const populationA =
  (root: boolean): FnImpl =>
  (args) => {
    const bad = arity(args, 1);
    if (bad) return bad;
    const xs = collectNumbersA(args);
    if (isError(xs)) return xs;
    if (!xs.length) return err("#DIV/0!", "There are no values");
    const v = sumSqDev(xs) / xs.length;
    return root ? Math.sqrt(v) : v;
  };
F.VARPA = populationA(false);
F.STDEVPA = populationA(true);
/** PROB(x_range, prob_range, lower_limit, [upper_limit]). */
F.PROB = (args) => {
  const bad = arity(args, 3, 4);
  if (bad) return bad;
  const pairs = pairedNumbers(args[0], args[1]);
  if (isError(pairs)) return pairs;
  const [xs, ps] = pairs;
  if (ps.some((p) => p < 0 || p > 1)) return err("#NUM!", "Each probability is from 0 to 1");
  const total = ps.reduce((a, b) => a + b, 0);
  // To Excel's 15 digits: 0.1+0.2+0.3+0.4 is 1.0000000000000002 as stored.
  if (Number(total.toPrecision(15)) !== 1)
    return err("#NUM!", "The probabilities must add up to 1");
  const lower = num(args[2]);
  if (isError(lower)) return lower;
  const upper = args[3] && args[3].node.k !== "empty" ? num(args[3]) : lower;
  if (isError(upper)) return upper;
  return xs.reduce((a, x, i) => (x >= lower && x <= upper ? a + ps[i] : a), 0);
};
/** SUMX2MY2, SUMX2PY2 and SUMXMY2, over pairs of numbers. */
const sumOfPairs =
  (term: (x: number, y: number) => number): FnImpl =>
  (args) => {
    const bad = arity(args, 2, 2);
    if (bad) return bad;
    const pairs = pairedNumbers(args[0], args[1]);
    if (isError(pairs)) return pairs;
    return pairs[0].reduce((a, x, i) => a + term(x, pairs[1][i]), 0);
  };
F.SUMX2MY2 = sumOfPairs((x, y) => x * x - y * y);
F.SUMX2PY2 = sumOfPairs((x, y) => x * x + y * y);
F.SUMXMY2 = sumOfPairs((x, y) => (x - y) ** 2);
// The pre-2010 names of the tests, the same functions.
F.TTEST = F["T.TEST"];
F.FTEST = F["F.TEST"];
F.ZTEST = F["Z.TEST"];
F.CHITEST = F["CHISQ.TEST"];

// ── Securities (R335) ──────────────────────────────────────────────────────
//
// FOUND IN R329's inventory: these were #NAME?. The schedule and the day
// counts are in securities.ts; here, each page's argument rules: dates and
// the frequency and basis truncated, a frequency of 1, 2 or 4, a basis of 0
// to 4, settlement before maturity, and the bounds each page names.

/** A securities function's arguments as numbers, NaN for one left out. */
function securityArgs(args: Arg[], min: number, max: number): number[] | SheetError {
  const bad = arity(args, min, max);
  if (bad) return bad;
  const xs: number[] = [];
  for (const a of args) {
    if (a.node.k === "empty") {
      xs.push(NaN);
      continue;
    }
    const v = num(a);
    if (isError(v)) return v;
    xs.push(v);
  }
  // An optional argument left off the end reads as one left empty.
  while (xs.length < max) xs.push(NaN);
  return xs;
}
const badBasis = () => err("#NUM!", "The basis is 0 to 4");
const badFrequency = () =>
  err("#NUM!", "The frequency is 1, 2 or 4 (yearly, half-yearly, quarterly)");
const tooLate = () => err("#NUM!", "The settlement must come before the maturity");
const badDate = () => err("#VALUE!", "That is not a date");

/** COUPDAYBS, COUPDAYS, COUPDAYSNC, COUPNCD, COUPNUM and COUPPCD(settlement, maturity, frequency, [basis]). */
const coupon =
  (fn: (s: number, m: number, f: number, b: Basis) => number): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 3, 4);
    if (isError(xs)) return xs;
    const [s, m] = [Math.trunc(xs[0]), Math.trunc(xs[1])];
    if (s < 0 || m < 0) return badDate();
    const f = checkFrequency(xs[2]);
    if (f === null) return badFrequency();
    const b = checkBasis(xs[3]);
    if (b === null) return badBasis();
    if (s >= m) return tooLate();
    return fn(s, m, f, b);
  };
F.COUPDAYBS = coupon(coupdaybs);
F.COUPDAYS = coupon(coupdays);
F.COUPDAYSNC = coupon(coupdaysnc);
F.COUPNCD = coupon(coupncd);
F.COUPNUM = coupon(coupnum);
F.COUPPCD = coupon(couppcd);

/**
 * The discount family, (settlement, maturity, a, b, [basis]), each over
 * YEARFRAC of settlement to maturity: DISC, INTRATE, PRICEDISC, RECEIVED and
 * YIELDDISC. Both amounts must be above 0.
 */
const discounted =
  (fn: (a: number, b: number, years: number) => number): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 4, 5);
    if (isError(xs)) return xs;
    const [s, m] = [Math.trunc(xs[0]), Math.trunc(xs[1])];
    if (s < 0 || m < 0) return badDate();
    if (!(xs[2] > 0) || !(xs[3] > 0)) return err("#NUM!", "Both amounts must be above 0");
    const b = checkBasis(xs[4]);
    if (b === null) return badBasis();
    if (s >= m) return tooLate();
    const v = fn(xs[2], xs[3], yearFrac(s, m, b));
    return Number.isFinite(v) && v > 0 ? v : err("#NUM!", "There is no such amount");
  };
F.DISC = discounted((pr, redemption, years) => (redemption - pr) / redemption / years);
F.INTRATE = discounted(
  (investment, redemption, years) => (redemption - investment) / investment / years,
);
F.PRICEDISC = discounted(
  (discount, redemption, years) => redemption - discount * redemption * years,
);
F.RECEIVED = discounted((investment, discount, years) => investment / (1 - discount * years));
F.YIELDDISC = discounted((pr, redemption, years) => (redemption / pr - 1) / years);

/** ACCRINTM(issue, settlement, rate, [par], [basis]): par × rate × YEARFRAC; par left out is $1,000. */
F.ACCRINTM = (args) => {
  const xs = securityArgs(args, 3, 5);
  if (isError(xs)) return xs;
  const [issue, s] = [Math.trunc(xs[0]), Math.trunc(xs[1])];
  if (issue < 0 || s < 0) return badDate();
  const par = Number.isNaN(xs[3]) ? 1000 : xs[3];
  if (!(xs[2] > 0) || !(par > 0)) return err("#NUM!", "The rate and par must be above 0");
  const b = checkBasis(xs[4]);
  if (b === null) return badBasis();
  if (issue >= s) return err("#NUM!", "The issue must come before the settlement");
  return par * xs[2] * yearFrac(issue, s, b);
};
/** PRICEMAT and YIELDMAT(settlement, maturity, issue, rate, yld or pr, [basis]). */
const atMaturity =
  (price: boolean): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 5, 6);
    if (isError(xs)) return xs;
    const [s, m, issue] = [Math.trunc(xs[0]), Math.trunc(xs[1]), Math.trunc(xs[2])];
    if (s < 0 || m < 0 || issue < 0) return badDate();
    const [rate, other] = [xs[3], xs[4]];
    if (rate < 0 || (price ? other < 0 : !(other > 0)))
      return err(
        "#NUM!",
        price
          ? "The rate and yield must be 0 or more"
          : "The rate must be 0 or more and the price above 0",
      );
    const b = checkBasis(xs[5]);
    if (b === null) return badBasis();
    if (s >= m) return tooLate();
    const issMat = yearFrac(issue, m, b);
    const issSet = yearFrac(issue, s, b);
    const setMat = yearFrac(s, m, b);
    return price
      ? ((1 + issMat * rate) / (1 + setMat * other) - issSet * rate) * 100
      : ((1 + issMat * rate) / (other / 100 + issSet * rate) - 1) / setMat;
  };
F.PRICEMAT = atMaturity(true);
F.YIELDMAT = atMaturity(false);

/** A Treasury bill's days, settlement to maturity: none past a year after settlement. */
function billDays(args: Arg[], strict: boolean): number[] | SheetError {
  const xs = securityArgs(args, 3, 3);
  if (isError(xs)) return xs;
  const [s, m] = [Math.trunc(xs[0]), Math.trunc(xs[1])];
  if (s < 0 || m < 0) return badDate();
  if (strict ? s >= m : s > m) return tooLate();
  const p = serialParts(s);
  // A year after settlement; from February 29th, February 28th.
  const yearOn = dateSerial(p.y + 1, p.m, Math.min(p.d, p.m === 2 ? 28 : p.d));
  if (m > yearOn) return err("#NUM!", "A Treasury bill matures within a year");
  return [m - s, xs[2]];
}
F.TBILLEQ = (args) => {
  const r = billDays(args, false);
  if (isError(r)) return r;
  const [dsm, discount] = r;
  if (!(discount > 0)) return err("#NUM!", "The discount must be above 0");
  return (365 * discount) / (360 - discount * dsm);
};
F.TBILLPRICE = (args) => {
  const r = billDays(args, false);
  if (isError(r)) return r;
  const [dsm, discount] = r;
  if (!(discount > 0)) return err("#NUM!", "The discount must be above 0");
  const v = 100 * (1 - (discount * dsm) / 360);
  return v > 0 ? v : err("#NUM!", "The discount is too large for the days");
};
F.TBILLYIELD = (args) => {
  const r = billDays(args, true);
  if (isError(r)) return r;
  const [dsm, pr] = r;
  if (!(pr > 0)) return err("#NUM!", "The price must be above 0");
  return ((100 - pr) / pr) * (360 / dsm);
};

/**
 * YEARFRAC(start_date, end_date, [basis]), on the same day counts as the
 * securities. FOUND IN R335, comparing the two over 3,300 spans: formula.js's
 * YEARFRAC, registered until now, ignored European 30/360's rule that a 31st
 * is the 30th (YEARFRAC(2009-01-01, 2009-12-31, 4) was 1, not 359/360), and
 * counted a 366-day year for any span ending on January 29th, leap or not
 * (2009-01-01 to 2009-01-29 was 28/366).
 */
F.YEARFRAC = (args) => {
  const xs = securityArgs(args, 2, 3);
  if (isError(xs)) return xs;
  const [s, e] = [Math.trunc(xs[0]), Math.trunc(xs[1])];
  if (s < 0 || e < 0) return badDate();
  const b = checkBasis(xs[2]);
  if (b === null) return badBasis();
  return yearFrac(s, e, b);
};

/** DOLLARDE and DOLLARFR(dollar, fraction): 1.02 in sixteenths is 1 2/16. */
const dollar =
  (toDecimal: boolean): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 2, 2);
    if (isError(xs)) return xs;
    const f = Math.trunc(xs[1]);
    if (f < 0) return err("#NUM!", "The fraction must be 0 or more");
    if (f < 1) return err("#DIV/0!", "The fraction is 0");
    return toDecimal ? dollarde(xs[0], f) : dollarfr(xs[0], f);
  };
F.DOLLARDE = dollar(true);
F.DOLLARFR = dollar(false);

// ── Bond prices, yields and durations (R336) ───────────────────────────────

/** The dates, frequency and basis every bond page checks: settlement before maturity. */
function bondTerms(
  xs: number[],
  fi: number,
  bi: number,
): { s: number; m: number; f: number; b: Basis } | SheetError {
  const [s, m] = [Math.trunc(xs[0]), Math.trunc(xs[1])];
  if (s < 0 || m < 0) return badDate();
  const f = checkFrequency(xs[fi]);
  if (f === null) return badFrequency();
  const b = checkBasis(xs[bi]);
  if (b === null) return badBasis();
  if (s >= m) return tooLate();
  return { s, m, f, b };
}
const noRate = () => err("#NUM!", "No rate gives that price");

/** PRICE(settlement, maturity, rate, yld, redemption, frequency, [basis]). */
F.PRICE = (args) => {
  const xs = securityArgs(args, 6, 7);
  if (isError(xs)) return xs;
  const t = bondTerms(xs, 5, 6);
  if (isError(t)) return t;
  const [rate, yld, red] = [xs[2], xs[3], xs[4]];
  if (rate < 0 || yld < 0) return err("#NUM!", "The rate and yield must be 0 or more");
  if (!(red > 0)) return err("#NUM!", "The redemption must be above 0");
  return price(t.s, t.m, rate, yld, red, t.f, t.b);
};
/** YIELD(settlement, maturity, rate, pr, redemption, frequency, [basis]). */
F.YIELD = (args) => {
  const xs = securityArgs(args, 6, 7);
  if (isError(xs)) return xs;
  const t = bondTerms(xs, 5, 6);
  if (isError(t)) return t;
  const [rate, pr, red] = [xs[2], xs[3], xs[4]];
  if (rate < 0) return err("#NUM!", "The rate must be 0 or more");
  if (!(pr > 0) || !(red > 0)) return err("#NUM!", "The price and redemption must be above 0");
  return yieldOf(t.s, t.m, rate, pr, red, t.f, t.b) ?? noRate();
};
/** DURATION and MDURATION(settlement, maturity, coupon, yld, frequency, [basis]). */
const bondDuration =
  (modified: boolean): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 5, 6);
    if (isError(xs)) return xs;
    const t = bondTerms(xs, 4, 5);
    if (isError(t)) return t;
    const [coupon, yld] = [xs[2], xs[3]];
    if (coupon < 0 || yld < 0) return err("#NUM!", "The coupon and yield must be 0 or more");
    const d = duration(t.s, t.m, coupon, yld, t.f, t.b);
    return modified ? d / (1 + yld / t.f) : d;
  };
F.DURATION = bondDuration(false);
F.MDURATION = bondDuration(true);

/** ACCRINT(issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method]). */
F.ACCRINT = (args) => {
  const bad = arity(args, 6, 8);
  if (bad) return bad;
  // calc_method is TRUE or FALSE; the rest are numbers.
  const xs = securityArgs(args.slice(0, 7), 6, 7);
  if (isError(xs)) return xs;
  const fromIssue = args[7] && args[7].node.k !== "empty" ? bool(args[7]) : true;
  if (isError(fromIssue)) return fromIssue;
  const [issue, first, s] = [Math.trunc(xs[0]), Math.trunc(xs[1]), Math.trunc(xs[2])];
  if (issue < 0 || first < 0 || s < 0) return badDate();
  const par = Number.isNaN(xs[4]) ? 1000 : xs[4];
  if (!(xs[3] > 0) || !(par > 0)) return err("#NUM!", "The rate and par must be above 0");
  const f = checkFrequency(xs[5]);
  if (f === null) return badFrequency();
  const b = checkBasis(xs[6]);
  if (b === null) return badBasis();
  if (issue >= s) return err("#NUM!", "The issue must come before the settlement");
  return accrint(issue, first, s, xs[3], par, f, b, fromIssue);
};

/** ODDFPRICE and ODDFYIELD(settlement, maturity, issue, first_coupon, rate, yld or pr, redemption, frequency, [basis]). */
const oddFirst =
  (yieldWanted: boolean): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 8, 9);
    if (isError(xs)) return xs;
    const [s, m, issue, first] = xs.slice(0, 4).map(Math.trunc);
    if ([s, m, issue, first].some((x) => x < 0)) return badDate();
    const [rate, other, red] = [xs[4], xs[5], xs[6]];
    if (rate < 0 || (yieldWanted ? !(other > 0) : other < 0))
      return err(
        "#NUM!",
        yieldWanted
          ? "The rate must be 0 or more and the price above 0"
          : "The rate and yield must be 0 or more",
      );
    if (!(red > 0)) return err("#NUM!", "The redemption must be above 0");
    const f = checkFrequency(xs[7]);
    if (f === null) return badFrequency();
    const b = checkBasis(xs[8]);
    if (b === null) return badBasis();
    if (!(m > first && first > s && s > issue))
      return err("#NUM!", "The dates must run issue, settlement, first coupon, maturity");
    const at = (y: number) => oddfprice(s, m, issue, first, rate, y, red, f, b);
    return yieldWanted ? (solveRate(at, other, f) ?? noRate()) : at(other);
  };
F.ODDFPRICE = oddFirst(false);
F.ODDFYIELD = oddFirst(true);
/** ODDLPRICE and ODDLYIELD(settlement, maturity, last_interest, rate, yld or pr, redemption, frequency, [basis]). */
const oddLastFn =
  (yieldWanted: boolean): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 7, 8);
    if (isError(xs)) return xs;
    const [s, m, last] = xs.slice(0, 3).map(Math.trunc);
    if ([s, m, last].some((x) => x < 0)) return badDate();
    const [rate, other, red] = [xs[3], xs[4], xs[5]];
    if (rate < 0 || (yieldWanted ? !(other > 0) : other < 0))
      return err(
        "#NUM!",
        yieldWanted
          ? "The rate must be 0 or more and the price above 0"
          : "The rate and yield must be 0 or more",
      );
    if (!(red > 0)) return err("#NUM!", "The redemption must be above 0");
    const f = checkFrequency(xs[6]);
    if (f === null) return badFrequency();
    const b = checkBasis(xs[7]);
    if (b === null) return badBasis();
    if (!(m > s && s > last))
      return err("#NUM!", "The dates must run last interest, settlement, maturity");
    return yieldWanted
      ? oddlyield(s, m, last, rate, other, red, f, b)
      : oddlprice(s, m, last, rate, other, red, f, b);
  };
F.ODDLPRICE = oddLastFn(false);
F.ODDLYIELD = oddLastFn(true);

/** AMORDEGRC and AMORLINC(cost, date_purchased, first_period, salvage, period, rate, [basis]): no basis 2. */
const amortisation =
  (declining: boolean): FnImpl =>
  (args) => {
    const xs = securityArgs(args, 6, 7);
    if (isError(xs)) return xs;
    const [cost, bought, first, salvage, period, rate] = xs;
    if (Math.trunc(bought) < 0 || Math.trunc(first) < 0) return badDate();
    const b = checkBasis(xs[6]);
    if (b === null || b === 2) return err("#NUM!", "The basis is 0, 1, 3 or 4");
    if (!(rate > 0) || cost < 0 || salvage < 0 || salvage > cost || period < 0)
      return err("#NUM!", "The cost, salvage, period and rate must make sense together");
    const p = Math.trunc(period);
    const [d0, d1] = [Math.trunc(bought), Math.trunc(first)];
    if (!declining) return amorlinc(cost, d0, d1, salvage, p, rate, b);
    return (
      amordegrc(cost, d0, d1, salvage, p, rate, b) ??
      err("#NUM!", "AMORDEGRC takes a life (1/rate) of 3 to 4 years, 5 to 6, or more than 6")
    );
  };
F.AMORDEGRC = amortisation(true);
F.AMORLINC = amortisation(false);

/** MUNIT(n): the n×n identity. */
F.MUNIT = ofNumber((x) => {
  const n = Math.trunc(x);
  if (n < 1) return err("#VALUE!", "MUNIT takes 1 or more");
  if (n * n > 1_000_000) return err("#NUM!", "Too large");
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (__, c) => (r === c ? 1 : 0)),
  );
});
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
  // R333: right on its page's examples; the bounds are DOMAIN's.
  "BINOM.DIST.RANGE",
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

/**
 * The values each function's page in Excel's documentation refuses, and the
 * error it names (R329). FOUND IN R329: formula.js answered many of them with
 * a number or another error. NORM.INV(0,0,1) was -141.4 and LOGNORM.INV(1,0,1)
 * 2.6E+61 where Excel says #NUM!, CHISQ.INV(1.1,2) was 202, WEIBULL.DIST of a
 * negative x -1.72, ROMAN(4000) "MMMM", BASE(-1,2) -1, ATAN2(0,0) 0, and
 * FACT(-1) #VALUE! where Excel says #NUM!. Each rule reads the arguments as
 * numbers; an argument that is not one is left to the function's own error.
 * NaN stands for an argument left out.
 */
const DOMAIN: Record<string, (x: number[]) => [ErrorCode, string] | null> = {
  FACT: ([n]) => (n < 0 ? ["#NUM!", "FACT needs a number of 0 or more"] : null),
  PERMUT: ([n, k]) =>
    n < 0 || k < 0 || n < k ? ["#NUM!", "PERMUT needs 0 ≤ number_chosen ≤ number"] : null,
  LOG: ([, base]) => (base === 1 ? ["#DIV/0!", "A logarithm to base 1 divides by 0"] : null),
  ROMAN: ([n]) => (n < 0 || n > 3999 ? ["#VALUE!", "ROMAN takes 0 to 3999"] : null),
  BASE: ([n]) => (n < 0 || n >= 2 ** 53 ? ["#NUM!", "BASE takes a number from 0 to 2^53"] : null),
  QUOTIENT: ([, d]) => (d === 0 ? ["#DIV/0!", "QUOTIENT divides by 0"] : null),
  ATAN2: ([x, y]) => (x === 0 && y === 0 ? ["#DIV/0!", "ATAN2(0, 0) has no angle"] : null),
  "NORM.S.INV": ([p]) =>
    p <= 0 || p >= 1 ? ["#NUM!", "The probability must be between 0 and 1"] : null,
  "NORM.INV": ([p, , sd]) =>
    p <= 0 || p >= 1
      ? ["#NUM!", "The probability must be between 0 and 1"]
      : sd <= 0
        ? ["#NUM!", "The standard deviation must be above 0"]
        : null,
  "LOGNORM.INV": ([p, , sd]) =>
    p <= 0 || p >= 1
      ? ["#NUM!", "The probability must be between 0 and 1"]
      : sd <= 0
        ? ["#NUM!", "The standard deviation must be above 0"]
        : null,
  "T.INV": ([p, df]) =>
    p <= 0 || p > 1
      ? ["#NUM!", "The probability must be above 0 and at most 1"]
      : df < 1
        ? ["#NUM!", "The degrees of freedom must be at least 1"]
        : null,
  "T.INV.2T": ([p, df]) =>
    p <= 0 || p > 1
      ? ["#NUM!", "The probability must be above 0 and at most 1"]
      : df < 1
        ? ["#NUM!", "The degrees of freedom must be at least 1"]
        : null,
  "CHISQ.INV": ([p, df]) =>
    p < 0 || p > 1
      ? ["#NUM!", "The probability must be from 0 to 1"]
      : df < 1 || df > 1e10
        ? ["#NUM!", "The degrees of freedom must be from 1 to 10^10"]
        : null,
  "CHISQ.INV.RT": ([p, df]) =>
    p < 0 || p > 1
      ? ["#NUM!", "The probability must be from 0 to 1"]
      : df < 1 || df > 1e10
        ? ["#NUM!", "The degrees of freedom must be from 1 to 10^10"]
        : null,
  "BETA.INV": ([p, a, b]) =>
    p <= 0 || p > 1
      ? ["#NUM!", "The probability must be above 0 and at most 1"]
      : a <= 0 || b <= 0
        ? ["#NUM!", "Alpha and beta must be above 0"]
        : null,
  "EXPON.DIST": ([x, lambda]) =>
    x < 0
      ? ["#NUM!", "x must be 0 or more"]
      : lambda <= 0
        ? ["#NUM!", "Lambda must be above 0"]
        : null,
  "POISSON.DIST": ([x, mean]) =>
    x < 0
      ? ["#NUM!", "x must be 0 or more"]
      : mean < 0
        ? ["#NUM!", "The mean must be 0 or more"]
        : null,
  "WEIBULL.DIST": ([x, a, b]) =>
    x < 0
      ? ["#NUM!", "x must be 0 or more"]
      : a <= 0 || b <= 0
        ? ["#NUM!", "Alpha and beta must be above 0"]
        : null,
  "CONFIDENCE.NORM": ([alpha, sd, size]) =>
    alpha <= 0 || alpha >= 1
      ? ["#NUM!", "Alpha must be between 0 and 1"]
      : sd <= 0
        ? ["#NUM!", "The standard deviation must be above 0"]
        : size < 1
          ? ["#NUM!", "The size must be at least 1"]
          : null,
};
/** BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2]) (R333). */
DOMAIN["BINOM.DIST.RANGE"] = ([n, p, s, s2]) =>
  n < 0 || p < 0 || p > 1
    ? ["#NUM!", "Trials must be 0 or more and the probability from 0 to 1"]
    : s < 0 || s > n
      ? ["#NUM!", "number_s must be from 0 to the trials"]
      : !Number.isNaN(s2) && (s2 < s || s2 > n)
        ? ["#NUM!", "number_s2 must be from number_s to the trials"]
        : null;
// The pre-2010 name formula.js registers by itself, under the same rule.
DOMAIN.EXPONDIST = DOMAIN["EXPON.DIST"];
for (const [name, check] of Object.entries(DOMAIN)) {
  const inner = F[name];
  if (!inner) continue;
  F[name] = (args, ctx) => {
    const xs: number[] = [];
    for (const a of args) {
      if (a.node.k === "empty") {
        xs.push(NaN);
        continue;
      }
      const v = num(a);
      if (isError(v)) return inner(args, ctx);
      xs.push(v);
    }
    const bad = check(xs);
    return bad ? err(bad[0], bad[1]) : inner(args, ctx);
  };
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
  // R331: two more of the pre-2010 names, and the byte functions. Outside
  // the double-byte languages (Japanese, Chinese, Korean) Excel's LENB,
  // LEFTB… count a character as one byte, the same as LEN, LEFT…
  NORMINV: "NORM.INV",
  // R333.
  COVAR: "COVARIANCE.P",
  PEARSON: "CORREL",
  NORMSINV: "NORM.S.INV",
  LENB: "LEN",
  LEFTB: "LEFT",
  RIGHTB: "RIGHT",
  MIDB: "MID",
  FINDB: "FIND",
  SEARCHB: "SEARCH",
  REPLACEB: "REPLACE",
};
for (const [name, now] of Object.entries(SAME_AS)) if (!F[name] && F[now]) F[name] = F[now];
/** NORMSDIST(z): NORM.S.DIST's cumulative curve, Excel's name before 2010 (R331). */
F.NORMSDIST = (args, ctx) =>
  arity(args, 1, 1) ??
  F["NORM.S.DIST"](
    [args[0], { node: { k: "bool", v: true }, value: () => true, isRef: false }],
    ctx,
  );

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
/**
 * The rest of the functions of single values (R329). FOUND IN R329: only the
 * list above lifted, so every other function of one value given a range or
 * an array was #VALUE! (=SIN(A1:A3), =SUM(SIN(A1:A3)), =PMT(5%/12,360,-B2:B9))
 * or, worse, answered for its first cell alone: =GAMMA(A1:A3),
 * =CEILING.MATH(A1:A3) and =IMABS(A1:A3) were one number each. Excel
 * computes each element. Every argument of these takes one value; a function
 * with a range or a list in any argument (GCD, NPV, IMSUM, the statistics)
 * is not here.
 */
const SINGLE_VALUE_FUNCTIONS = [
  // Math and trigonometry.
  ...["SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN", "ATAN2", "SINH", "COSH", "TANH"],
  ...["DEGREES", "RADIANS", "LOG", "EVEN", "ODD", "FACT", "COMBIN", "COMBINA", "PERMUT"],
  ...["PERMUTATIONA", "QUOTIENT", "MROUND", "GAMMA", "GAMMALN", "GAMMALN.PRECISE"],
  ...["CEILING.MATH", "FLOOR.MATH", "RANDBETWEEN"],
  // Number systems and bits.
  ...["BASE", "DECIMAL", "ROMAN", "ARABIC", "BITAND", "BITOR", "BITXOR", "BITLSHIFT", "BITRSHIFT"],
  ...["BIN2DEC", "BIN2HEX", "BIN2OCT", "DEC2BIN", "DEC2HEX", "DEC2OCT"],
  ...["HEX2BIN", "HEX2DEC", "HEX2OCT", "OCT2BIN", "OCT2DEC", "OCT2HEX"],
  // Complex numbers of one or two values (IMSUM and IMPRODUCT take lists).
  ...["COMPLEX", "IMABS", "IMAGINARY", "IMARGUMENT", "IMCONJUGATE", "IMREAL", "IMDIV", "IMSUB"],
  ...["IMPOWER", "IMSQRT", "IMEXP", "IMLN", "IMLOG10", "IMLOG2", "IMSIN", "IMCOS", "IMTAN"],
  ...["IMSINH", "IMCOSH", "IMCOT", "IMCSC", "IMCSCH", "IMSEC", "IMSECH"],
  // Distributions, new names and old.
  ...["NORM.DIST", "NORM.INV", "NORM.S.DIST", "NORM.S.INV", "NORMDIST", "STANDARDIZE", "PHI"],
  ...["GAUSS", "FISHER", "FISHERINV", "LOGNORM.DIST", "LOGNORM.INV", "LOGNORMDIST", "LOGINV"],
  ...["BINOM.DIST", "BINOM.INV", "BINOMDIST", "CRITBINOM", "NEGBINOM.DIST", "NEGBINOMDIST"],
  ...["HYPGEOM.DIST", "HYPGEOMDIST", "POISSON.DIST", "POISSON", "EXPON.DIST", "EXPONDIST"],
  ...["WEIBULL.DIST", "WEIBULL", "GAMMA.DIST", "GAMMA.INV", "GAMMADIST", "GAMMAINV"],
  ...["BETA.DIST", "BETA.INV", "BETADIST", "BETAINV", "CHISQ.DIST", "CHISQ.DIST.RT"],
  ...["CHISQ.INV", "CHISQ.INV.RT", "CHIDIST", "CHIINV", "F.DIST", "F.DIST.RT", "F.INV"],
  ...["F.INV.RT", "FDIST", "FINV", "T.DIST", "T.DIST.2T", "T.DIST.RT", "T.INV", "T.INV.2T"],
  ...["TDIST", "TINV", "CONFIDENCE", "CONFIDENCE.NORM", "CONFIDENCE.T"],
  // Money: one loan, one asset (NPV, IRR and the schedules take lists).
  ...["PMT", "IPMT", "PPMT", "FV", "PV", "NPER", "RATE", "CUMIPMT", "CUMPRINC", "ISPMT"],
  ...["EFFECT", "NOMINAL", "PDURATION", "RRI", "SLN", "SYD", "DB", "DDB", "VDB"],
  // R330's math and engineering.
  ...["ACOSH", "ASINH", "ATANH", "ACOT", "ACOTH", "COT", "COTH", "CSC", "CSCH", "SEC", "SECH"],
  ...["FACTDOUBLE", "SQRTPI", "CEILING.PRECISE", "FLOOR.PRECISE", "ISO.CEILING", "DELTA"],
  ...["GESTEP", "ERF", "ERF.PRECISE", "ERFC", "ERFC.PRECISE", "BESSELI", "BESSELJ", "BESSELK"],
  "BESSELY",
  // R336's.
  ...["PRICE", "YIELD", "DURATION", "MDURATION", "ACCRINT", "ODDFPRICE", "ODDFYIELD", "ODDLPRICE"],
  ...["ODDLYIELD", "AMORDEGRC", "AMORLINC"],
  // R335's securities.
  ...["COUPDAYBS", "COUPDAYS", "COUPDAYSNC", "COUPNCD", "COUPNUM", "COUPPCD", "DISC", "INTRATE"],
  ...["PRICEDISC", "RECEIVED", "YIELDDISC", "ACCRINTM", "PRICEMAT", "YIELDMAT", "TBILLEQ"],
  ...["TBILLPRICE", "TBILLYIELD", "DOLLARDE", "DOLLARFR"],
  // R331's, R332's and R333's.
  "CONVERT",
  "BINOM.DIST.RANGE",
  ...["NORMINV", "NORMSINV", "NORMSDIST", "VALUETOTEXT", "LENB", "LEFTB", "RIGHTB", "MIDB"],
  ...["FINDB", "SEARCHB", "REPLACEB"],
  // Dates, text and information.
  ...["DATEDIF", "YEARFRAC", "WEEKNUM", "ISOWEEKNUM"],
  ...["CLEAN", "DOLLAR", "FIXED", "UNICHAR", "UNICODE", "ADDRESS", "ERROR.TYPE"],
];
/** Working days: the start and the end (or the days) lift; the holidays are a list. */
const firstTwo = () => [0, 1];
export const LIFTS: ReadonlyMap<string, (argCount: number) => number[]> = new Map([
  ...SCALAR_FUNCTIONS.map((name) => [name, all] as const),
  ...SINGLE_VALUE_FUNCTIONS.map((name) => [name, all] as const),
  ...["NETWORKDAYS", "NETWORKDAYS.INTL", "WORKDAY", "WORKDAY.INTL"].map(
    (n) => [n, firstTwo] as const,
  ),
  ["SERIESSUM", () => [0, 1, 2]] as const,
  // R333: x and sigma lift, the array does not; PROB's limits.
  ...["Z.TEST", "ZTEST"].map((n) => [n, () => [1, 2]] as const),
  ["PROB", () => [2, 3]] as const,
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
