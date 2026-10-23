// Values in the Sheets engine, and the coercions Excel applies to them.
//
// A cell holds a number, text, a boolean, an error, or nothing (null). Dates
// are numbers: Excel serials, days since 1899-12-30, with the time of day as
// the fraction. A range or an array result is a 2-D array of those.

import type { ErrorCode } from "./lexer";

/**
 * `fn` is set on the #CALC! a LAMBDA evaluates to (R328): Excel shows #CALC!
 * for a cell holding an uncalled function, and everything that does not call
 * one treats it as that error. LET, a call and the LAMBDA helpers look inside.
 */
export type SheetError = { err: ErrorCode; detail?: string; fn?: unknown };
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

/** "1,234.5", "12%", "$3", "(4)", "1e3", dates, times → a number; null otherwise. */
export function parseNumberText(text: string): number | null {
  let t = text.trim();
  if (!t) return null;
  const date = parseDateText(t);
  if (date !== null) return date;
  // FOUND IN R166: a typed time (12:30, 9:00 AM) stayed text, so a column
  // of them summed to 0.
  const time = parseTimeText(t);
  if (time !== null) return time;
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
  // A currency sign after the minus (-$350) or before it ($-350), as Excel reads both.
  t = t.replace(/^([+-]?)[$€£¥]/, "$1").replace(/,(?=\d{3}(\D|$))/g, "");
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
  return numberText(v);
}

/**
 * A number as text, as Excel turns one into text in a formula (=A1&"",
 * LEN, LEFT, TEXTJOIN): to 15 significant digits, whole numbers written out
 * below 1E+15, scientific from there and below 1E-9. FOUND IN R175: text
 * took the cell's narrow General display (11 digits, 10 significant), so
 * =A1&"-"&B1 over 123456789012 gave "1.23457E+11-…", and a lookup on such a
 * key found nothing.
 */
export function numberText(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (n === 0) return "0";
  const r = Number(n.toPrecision(15));
  const abs = Math.abs(r);
  // The exponent as written, not Math.log10's, which is 14 just under 1E+14.
  const [mantissa, exp] = r.toExponential().split("e");
  const e = Number(exp);
  if (abs >= 1e15 || abs < 1e-9) {
    // At 1E+15 and up, or under 1E-9, the exponent always has two digits.
    return `${mantissa}E${e < 0 ? "-" : "+"}${Math.abs(e)}`;
  }
  const s = r.toFixed(Math.max(0, 14 - e));
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
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
  // Ten significant digits, and eleven from 1E+10, so that a whole part of
  // eleven digits is written out as an eleven-digit whole number is.
  const s = n.toPrecision(abs >= 1e10 ? 11 : 10);
  // FOUND IN R201: toPrecision writes an exponent of its own for eleven whole
  // digits and under 1E-6, and the zero trim below then cut it short:
  // 12345678901.005 showed as "1.234567890e+1", about 12, in a table sheet
  // and as #### in a grid; 1.5E-07 showed as "1.500000000e-7". Excel
  // writes those as 12345678901 and 1.5E-07.
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9 || s.includes("e"))) {
    return n
      .toExponential(5)
      .replace(/\.?0+e/, "e")
      .replace(/e([+-])(\d)$/, "e$10$2")
      .replace(/e/, "E");
  }
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// ── Dates ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
// 1899-12-30 as a UTC epoch offset. Serials are calendar days, never shifted by a time zone.
const EPOCH_UTC = Date.UTC(1899, 11, 30);

/**
 * Excel's 1900 date system, kept from Lotus 1-2-3: serial 1 is 1900-01-01,
 * serial 60 is 1900-02-29, a day that never was, and from 61 (1900-03-01)
 * a serial counts days from 1899-12-30. Serial 0 reads as 1900-01-00.
 *
 * FOUND IN R205: every serial counted from 1899-12-30, which is right only
 * from 1900-03-01. YEAR, MONTH and DAY of a blank cell (serial 0) were 1899,
 * 12 and 30, where Excel says 1900, 1 and 0; TEXT(1,"yyyy-mm-dd") was
 * 1899-12-31; DATE(1900,3,1)-DATE(1900,2,28) was 1, where Excel says 2; and
 * DATEDIF, which formula.js reads by Excel's rule, gave 0 for that pair and
 * 2 for 1900-03-01 to 03-02.
 */
const MAR_1_1900 = 61;

/** A calendar date (and optional time) → Excel serial. Month is 1-based; overflow rolls like Excel. */
export function dateSerial(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const time = (h * 3600 + mi * 60 + s) / 86_400;
  // The day Excel counts and the calendar does not.
  if (y === 1900 && m === 2 && d === 29) return 60 + time;
  const serial = (Date.UTC(y, m - 1, d, h, mi, s) - EPOCH_UTC) / DAY_MS;
  return serial < MAR_1_1900 ? serial - 1 : serial;
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
  if (serial >= 0 && serial < MAR_1_1900) {
    // Before 1900-03-01, by Excel's count (see MAR_1_1900).
    const all = Math.round(serial * DAY_MS);
    const day = Math.floor(all / DAY_MS);
    const t = new Date(all - day * DAY_MS);
    const time = { h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
    // Excel's weekday runs on from serial 1, a Sunday by its count.
    const dow = (day + 6) % 7;
    if (day === 0) return { y: 1900, m: 1, d: 0, ...time, dow };
    if (day === 60) return { y: 1900, m: 2, d: 29, ...time, dow };
    const dt = new Date(Date.UTC(1900, 0, day));
    return { y: 1900, m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), ...time, dow };
  }
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

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** A month by its name or its first three letters (Mar, March), 1-12; 0 when it is neither. */
function monthNumber(name: string): number {
  const n = name.toLowerCase();
  return MONTH_NAMES.findIndex((m) => m === n || m.slice(0, 3) === n) + 1;
}

/** A calendar date, when it is one: the day within its month (FOUND IN R165: 2023-02-31 rolled over). */
function calendarDate(y: number, mo: number, d: number): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return dateSerial(y, mo, d);
}

/** Excel's two-digit years: 00-29 are 2000s, 30-99 1900s. */
const fullYear = (y: string) =>
  y.length === 4 ? Number(y) : Number(y) + (Number(y) < 30 ? 2000 : 1900);

/**
 * "12:30", "9:05:30", "9:00 AM", "25:00" → a fraction of a day (R166), as
 * Excel reads a typed time; hours past 24 only without AM/PM. Null otherwise.
 */
export function parseTimeText(text: string): number | null {
  const m = /^(\d{1,4}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AP]M?)?$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (mi > 59 || s >= 60) return null;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/^p/i.test(m[4]) ? 12 : 0);
  } else if (h > 9999) return null;
  return (h * 3600 + mi * 60 + s) / 86400;
}

/**
 * "2024-01-05", "2024-01-05 13:30", "2024-01-05T13:30:00", "2024-01-05 1:30 PM",
 * and dates with a month's name (R166): "15-Mar-2023", "15 March 2023",
 * "Mar 15, 2023", "Mar 2023" (the 1st) → serial; null otherwise.
 */
export function parseDateText(text: string): number | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](.+))?$/.exec(t);
  if (iso) {
    const day = calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (day === null) return null;
    if (iso[4] === undefined) return day;
    const time = parseTimeText(iso[4]);
    return time === null || time >= 1 ? null : day + time;
  }
  // FOUND IN R166: a date typed with its month's name stayed text, so
  // =B1+1 was #VALUE! where Excel gives the next day.
  let m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{4}|\d{2})$/.exec(t);
  if (m)
    return monthNumber(m[2]) ? calendarDate(fullYear(m[3]), monthNumber(m[2]), Number(m[1])) : null;
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}|\d{2})$/.exec(t);
  if (m)
    return monthNumber(m[1]) ? calendarDate(fullYear(m[3]), monthNumber(m[1]), Number(m[2])) : null;
  m = /^([A-Za-z]{3,9})[-\s](\d{4})$/.exec(t);
  if (m) return monthNumber(m[1]) ? calendarDate(Number(m[2]), monthNumber(m[1]), 1) : null;
  return null;
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
/**
 * Excel's order for text, the same in a sort, a lookup and a comparison:
 * character by character, case aside, so A10 comes before A2. FOUND IN
 * R167: the ribbon's sort put numbers inside text in order of their value
 * (A2 before A10), so an approximate VLOOKUP or MATCH over data it had
 * sorted took the wrong row, and =SORT() and the ribbon disagreed.
 */
export function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export function compareScalars(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) =>
    v === null ? 0 : typeof v === "number" ? 1 : typeof v === "string" ? 2 : 3;
  const an = a === null ? (typeof b === "string" ? "" : 0) : a;
  const bn = b === null ? (typeof a === "string" ? "" : 0) : b;
  const ra = rank(an);
  const rb = rank(bn);
  if (ra !== rb) return ra - rb;
  if (typeof an === "number" && typeof bn === "number") return an - bn;
  if (typeof an === "string" && typeof bn === "string") return compareText(an, bn);
  if (typeof an === "boolean" && typeof bn === "boolean") return Number(an) - Number(bn);
  return 0;
}
