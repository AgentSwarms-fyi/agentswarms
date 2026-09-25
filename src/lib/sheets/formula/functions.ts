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
import { formatValue } from "../format";
import {
  compareScalars,
  dateSerial,
  err,
  flat,
  isError,
  isMatrix,
  jsDateToSerial,
  nowSerial,
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

/** Pairs of (range, criterion) → a mask over the first range's cells. */
function criteriaMask(pairs: [Arg, Arg][]): boolean[] | SheetError {
  let mask: boolean[] | null = null;
  let size = -1;
  for (const [rangeArg, critArg] of pairs) {
    const cells = flat(rangeArg.value());
    if (size >= 0 && cells.length !== size) return err("#VALUE!", "Criteria ranges differ in size");
    size = cells.length;
    const c = scalarOf(critArg.value());
    const pred = makeCriterion(c);
    const m = cells.map((v) => pred(v));
    mask = mask ? mask.map((x, i) => x && m[i]) : m;
  }
  return mask ?? [];
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

/** Wrap a formula.js function: arguments evaluated eagerly, converted both ways. */
function fromLibrary(name: string): FnImpl | undefined {
  const fn = (formulajs as unknown as Record<string, unknown>)[name.replace(/\./g, "")];
  if (typeof fn !== "function") return undefined;
  return (args) => {
    const vals = args.map((a) => (a.node.k === "empty" ? undefined : toFormulaJs(a.value())));
    try {
      return fromFormulaJs((fn as (...x: unknown[]) => unknown)(...vals));
    } catch {
      return err("#VALUE!");
    }
  };
}

// ── The library ────────────────────────────────────────────────────────────

const F: Record<string, FnImpl> = {};

// Aggregates
F.SUM = (args) => {
  const n = collectNumbers(args);
  return isError(n) ? n : n.reduce((s, x) => s + x, 0);
};
F.PRODUCT = (args) => {
  const n = collectNumbers(args);
  return isError(n) ? n : n.length ? n.reduce((s, x) => s * x, 1) : 0;
};
F.AVERAGE = (args) => {
  const n = collectNumbers(args);
  if (isError(n)) return n;
  return n.length ? n.reduce((s, x) => s + x, 0) / n.length : err("#DIV/0!");
};
F.MIN = (args) => {
  const n = collectNumbers(args);
  return isError(n) ? n : n.length ? Math.min(...n) : 0;
};
F.MAX = (args) => {
  const n = collectNumbers(args);
  return isError(n) ? n : n.length ? Math.max(...n) : 0;
};
F.MEDIAN = (args) => {
  const n = collectNumbers(args);
  if (isError(n)) return n;
  if (!n.length) return err("#NUM!");
  const s = [...n].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
F.COUNT = (args) => {
  let c = 0;
  for (const a of args) {
    if (a.node.k === "empty") continue;
    const v = a.value();
    if (a.isRef || isMatrix(v)) c += flat(v).filter((x) => typeof x === "number").length;
    else if (!isError(toNumber(scalarOf(v))) && scalarOf(v) !== null) c++;
  }
  return c;
};
F.COUNTA = (args) => {
  let c = 0;
  for (const a of args) {
    if (a.node.k === "empty") continue;
    c += flat(a.value()).filter((x) => x !== null).length;
  }
  return c;
};
F.COUNTBLANK = (args) => {
  const e = arity(args, 1, 1);
  if (e) return e;
  return flat(args[0].value()).filter((x) => x === null || x === "").length;
};
F.SUMPRODUCT = (args) => {
  if (!args.length) return err("#VALUE!");
  const ms = args.map((a) => asMatrix(a.value()));
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
  const mask = criteriaMask(pairs);
  if (isError(mask)) return mask;
  const vals = flat(valuesArg.value());
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
F.COUNTIF = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  const mask = criteriaMask([[args[0], args[1]]]);
  return isError(mask) ? mask : mask.filter(Boolean).length;
};
F.COUNTIFS = (args) => {
  if (args.length < 2 || args.length % 2) return err("#N/A", "Wrong number of arguments");
  const pairs: [Arg, Arg][] = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  const mask = criteriaMask(pairs);
  return isError(mask) ? mask : mask.filter(Boolean).length;
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
    const f = Math.pow(10, Math.trunc(d));
    const x = Math.abs(n) * f;
    // Guard against float noise: 2.675 * 100 = 267.49999999999997.
    const eps = 1e-9;
    let r: number;
    if (mode === "half") r = Math.floor(x + 0.5 + eps);
    else if (mode === "up") r = Math.ceil(x - eps);
    else r = Math.floor(x + eps);
    return (Math.sign(n) * r) / f;
  };
};
F.ROUND = roundTo("half");
F.ROUNDUP = roundTo("up");
F.ROUNDDOWN = roundTo("down");
F.TRUNC = (args) => {
  const n = num(args[0]);
  const d = num(args[1], 0);
  if (isError(n)) return n;
  if (isError(d)) return d;
  const f = Math.pow(10, Math.trunc(d));
  return Math.trunc(n * f) / f;
};
F.CEILING = (args) => {
  const n = num(args[0]);
  const s = num(args[1], 1);
  if (isError(n)) return n;
  if (isError(s)) return s;
  if (s === 0) return 0;
  return Math.ceil(n / s) * s;
};
F.FLOOR = (args) => {
  const n = num(args[0]);
  const s = num(args[1], 1);
  if (isError(n)) return n;
  if (isError(s)) return s;
  if (s === 0) return err("#DIV/0!");
  return Math.floor(n / s) * s;
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
    return c.map((row) =>
      row.map((x) => {
        const b = toBool(x);
        if (isError(b)) return b;
        const pick = b ? args[1] : args[2];
        if (!pick) return b;
        return pick.node.k === "empty" ? 0 : scalarOf(pick.value());
      }),
    );
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
  if (isMatrix(v)) {
    const fb = scalarOf(args[1].value());
    return v.map((row) => row.map((x) => (isError(x) ? fb : x)));
  }
  return isError(v) ? args[1].value() : v;
};
F.IFNA = (args) => {
  const e = arity(args, 2, 2);
  if (e) return e;
  const v = args[0].value();
  return isError(v) && v.err === "#N/A" ? args[1].value() : v;
};
const logical =
  (combine: (xs: boolean[]) => boolean): FnImpl =>
  (args) => {
    const xs: boolean[] = [];
    for (const a of args) {
      const v = a.value();
      for (const x of flat(v)) {
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
F.UPPER = textFn((s) => s.toUpperCase());
F.LOWER = textFn((s) => s.toLowerCase());
F.PROPER = textFn((s) =>
  s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, a, b) => a + b.toUpperCase()),
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
  const n = typeof v === "string" ? (parseNumberText(v) ?? v) : v;
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
  if (type === 1) return dow + 1;
  if (type === 2) return ((dow + 6) % 7) + 1;
  if (type === 3) return (dow + 6) % 7;
  return err("#NUM!");
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
  if (r < 0 || c < 0 || r > m.length || c > (m[0]?.length ?? 0)) return err("#REF!");
  if (r === 0 && c === 0) return m;
  if (r === 0) return m.map((row) => [row[c - 1]]);
  if (c === 0) return [m[r - 1]];
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
F.ROWS = (args) => asMatrix(args[0].value()).length;
F.COLUMNS = (args) => asMatrix(args[0].value())[0]?.length ?? 0;
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

// ── Long tail from formula.js ──────────────────────────────────────────────

const LIBRARY_NAMES = [
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
  "CLEAN",
  "UNICHAR",
  "UNICODE",
  "FIXED",
  "DOLLAR",
];
for (const name of LIBRARY_NAMES) {
  if (F[name]) continue;
  const impl = fromLibrary(name);
  if (impl) F[name] = impl;
}

export const FUNCTIONS: Readonly<Record<string, FnImpl>> = F;

/** Every function name the engine knows, sorted (for autocomplete and the AI's context). */
export const FUNCTION_NAMES: readonly string[] = Object.keys(F).sort();

export type { FnCtx };
