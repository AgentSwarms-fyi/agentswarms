// Values in the Sheets engine, and the coercions Excel applies to them.
//
// A cell holds a number, text, a boolean, an error, or nothing (null). Dates
// are numbers: Excel serials, days since 1899-12-30, with the time of day as
// the fraction. A range or an array result is a 2-D array of those.

import type { ErrorCode } from "./lexer";

export type SheetError = { err: ErrorCode; detail?: string };
export type Scalar = number | string | boolean | null | SheetError;
export type Matrix = Scalar[][];
export type Value = Scalar | Matrix;

export const isError = (v: unknown): v is SheetError =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "err" in v;
export const isMatrix = (v: Value): v is Matrix => Array.isArray(v);

export const err = (code: ErrorCode, detail?: string): SheetError =>
  detail ? { err: code, detail } : { err: code };

/** The top-left of a matrix, or the value itself (Excel's implicit intersection, simplified). */
export function scalarOf(v: Value): Scalar {
  if (!isMatrix(v)) return v;
  return v[0]?.[0] ?? null;
}

/** Every value in a range or array, row by row. */
export function flat(v: Value): Scalar[] {
  if (!isMatrix(v)) return [v];
  const out: Scalar[] = [];
  for (const row of v) for (const x of row) out.push(x);
  return out;
}

// ── Numbers ────────────────────────────────────────────────────────────────

/**
 * Excel's coercion to a number for an operator or a scalar argument:
 * blanks are 0, TRUE is 1, numeric text converts, other text is #VALUE!.
 */
export function toNumber(v: Scalar): number | SheetError {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isError(v)) return v;
  const t = v.trim();
  if (t === "") return err("#VALUE!");
  const n = parseNumberText(t);
  return n === null ? err("#VALUE!") : n;
}

/** "1,234.5", "12%", "$3", "(4)", "1e3", ISO dates → a number; null otherwise. */
export function parseNumberText(text: string): number | null {
  let t = text.trim();
  if (!t) return null;
  const date = parseDateText(t);
  if (date !== null) return date;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  let pct = false;
  if (t.endsWith("%")) {
    pct = true;
    t = t.slice(0, -1);
  }
  t = t.replace(/^[$€£¥]/, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  let n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (pct) n /= 100;
  return neg ? -n : n;
}

// ── Text and booleans ──────────────────────────────────────────────────────

/** Excel's coercion to text for "&" and text functions. */
export function toText(v: Scalar): string | SheetError {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isError(v)) return v;
  return formatGeneral(v);
}

export function toBool(v: Scalar): boolean | SheetError {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (isError(v)) return v;
  const u = v.trim().toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return err("#VALUE!");
}

/**
 * Excel's "General" display of a number, as a default-width cell shows it:
 * whole numbers as they are up to 11 digits, fractions to 10 significant
 * digits with no trailing zeros, scientific beyond that.
 */
export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) {
    return n
      .toExponential(5)
      .replace(/\.?0+e/, "e")
      .replace(/e/, "E");
  }
  const s = n.toPrecision(10);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// ── Dates ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
// 1899-12-30 as a UTC epoch offset. Serials are calendar days, never shifted by a time zone.
const EPOCH_UTC = Date.UTC(1899, 11, 30);

/** A calendar date (and optional time) → Excel serial. Month is 1-based; overflow rolls like Excel. */
export function dateSerial(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const ms = Date.UTC(y, m - 1, d, h, mi, s);
  return (ms - EPOCH_UTC) / DAY_MS;
}

/** Excel serial → calendar parts (in UTC, which is how serials are defined here). */
export function serialParts(serial: number): {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  dow: number;
} {
  const ms = EPOCH_UTC + Math.round(serial * DAY_MS);
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
    dow: dt.getUTCDay(),
  };
}

/** A JS Date (as formula.js returns) → serial, by its LOCAL calendar parts. */
export function jsDateToSerial(d: Date): number {
  return dateSerial(
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  );
}

/** "2024-01-05", "2024-01-05 13:30", "2024-01-05T13:30:00" → serial; null otherwise. */
export function parseDateText(text: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    text.trim(),
  );
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return dateSerial(y, mo, d, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
}

/** Today's serial in the viewer's calendar (TODAY()). */
export function todaySerial(now = new Date()): number {
  return dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function nowSerial(now = new Date()): number {
  return dateSerial(
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  );
}

// ── Comparison (for =, <, sorting, MATCH) ──────────────────────────────────

/** Excel's ordering: numbers < text < booleans; text compares case-insensitively. */
export function compareScalars(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) =>
    v === null ? 0 : typeof v === "number" ? 1 : typeof v === "string" ? 2 : 3;
  const an = a === null ? (typeof b === "string" ? "" : 0) : a;
  const bn = b === null ? (typeof a === "string" ? "" : 0) : b;
  const ra = rank(an);
  const rb = rank(bn);
  if (ra !== rb) return ra - rb;
  if (typeof an === "number" && typeof bn === "number") return an - bn;
  if (typeof an === "string" && typeof bn === "string") {
    const x = an.toLowerCase();
    const y = bn.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof an === "boolean" && typeof bn === "boolean") return Number(an) - Number(bn);
  return 0;
}
