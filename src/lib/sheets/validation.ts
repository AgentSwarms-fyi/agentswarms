// Data validation, as Excel's Data > Data Validation works: a rule on a range
// that a typed value must pass (a list, whole or decimal numbers, dates,
// times, text length, or a formula), with an input message shown on the
// cell and an error alert of three strengths: Stop refuses the value,
// Warning asks, Information tells and keeps it.

import { parseRangeA1 } from "./a1";
import { literalValue } from "./engine";
import { isError, type Scalar } from "./formula/values";

export type DvOp = "between" | "notBetween" | "eq" | "ne" | "gt" | "lt" | "ge" | "le";

export type DvRule =
  | {
      kind: "list";
      /** Items typed in the rule, or a range that holds them ("=$F$2:$F$9"). */
      items?: string[];
      source?: string;
      /** Show the in-cell dropdown (Excel's default). */
      dropdown?: boolean;
    }
  | { kind: "whole" | "decimal" | "date" | "time" | "length"; op: DvOp; a: string; b?: string }
  | { kind: "custom"; formula: string };

export type Validation = {
  id: string;
  ranges: string[];
  rule: DvRule;
  /** A blank cell passes (Excel's "Ignore blank"). */
  allowBlank?: boolean;
  prompt?: { title?: string; message: string };
  error?: { style: "stop" | "warning" | "info"; title?: string; message?: string };
};

export type DvEnv = {
  /**
   * A formula's answer at a cell; `self`, when given, is the value that cell
   * holds for the question (the value being typed, not yet kept).
   */
  evaluate: (formula: string, row: number, col: number, self?: Scalar) => Scalar;
  /** The values of a range ("=$F$2:$F$9" or "=Lists!A2:A9"), flattened. */
  rangeValues: (ref: string, row: number, col: number) => Scalar[];
};

/** The rule covering a cell, if any (the first one, as Excel keeps one per cell). */
export function validationAt(
  list: readonly Validation[] | undefined,
  row: number,
  col: number,
): Validation | undefined {
  for (const v of list ?? []) {
    for (const r of v.ranges) {
      const a = parseRangeA1(r.replace(/\$/g, ""));
      if (a && row >= a.r0 && row <= a.r1 && col >= a.c0 && col <= a.c1) return v;
    }
  }
  return undefined;
}

/** The choices a list rule offers, as text, first occurrence of each. */
export function listItems(v: Validation, env: DvEnv, row: number, col: number): string[] {
  if (v.rule.kind !== "list") return [];
  if (v.rule.items) return v.rule.items;
  if (!v.rule.source) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of env.rangeValues(v.rule.source, row, col)) {
    if (x === null || x === "" || isError(x)) continue;
    const t = typeof x === "boolean" ? (x ? "TRUE" : "FALSE") : String(x);
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/** "9:30", "17:05:10", "9:30 PM" → a fraction of a day; null when it is not a time. */
export function timeValue(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3] ?? 0);
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[4].toUpperCase() === "PM" ? 12 : 0);
  }
  if (h > 23 || min > 59 || sec > 59) return null;
  return (h * 3600 + min * 60 + sec) / 86_400;
}

function valueOf(text: string, kind: DvRule["kind"]): Scalar {
  if (kind === "time") {
    const t = timeValue(text);
    if (t !== null) return t;
  }
  return literalValue(text);
}

function bound(
  text: string | undefined,
  kind: DvRule["kind"],
  env: DvEnv,
  row: number,
  col: number,
): Scalar {
  const t = (text ?? "").trim();
  if (t.startsWith("=")) return env.evaluate(t, row, col);
  return valueOf(t, kind);
}

function compare(op: DvOp, v: number, a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  switch (op) {
    case "between":
      return v >= lo && v <= hi;
    case "notBetween":
      return v < lo || v > hi;
    case "eq":
      return v === a;
    case "ne":
      return v !== a;
    case "gt":
      return v > a;
    case "lt":
      return v < a;
    case "ge":
      return v >= a;
    case "le":
      return v <= a;
  }
}

const OP_TEXT: Record<DvOp, string> = {
  between: "between",
  notBetween: "not between",
  eq: "equal to",
  ne: "not equal to",
  gt: "greater than",
  lt: "less than",
  ge: "greater than or equal to",
  le: "less than or equal to",
};

const WHAT: Record<"whole" | "decimal" | "date" | "time" | "length", string> = {
  whole: "a whole number",
  decimal: "a number",
  date: "a date",
  time: "a time",
  length: "text whose length is",
};

function show(v: Scalar): string {
  if (v === null) return "0";
  if (typeof v === "object") return v.err;
  return String(v);
}

/** The rule in words, for the error alert when the rule has no message of its own. */
export function describeValidation(v: Validation, shownBounds?: [string, string?]): string {
  const r = v.rule;
  if (r.kind === "list")
    return r.items ? `Choose one of: ${r.items.join(", ")}` : `Choose a value from ${r.source}`;
  if (r.kind === "custom") return `The value must meet the rule ${r.formula}`;
  const [a, b] = shownBounds ?? [r.a, r.b];
  return r.op === "between" || r.op === "notBetween"
    ? `Enter ${WHAT[r.kind]} ${OP_TEXT[r.op]} ${a} and ${b ?? a}`
    : `Enter ${WHAT[r.kind]} ${OP_TEXT[r.op]} ${a}`;
}

function fail(v: Validation, fallback: string): { ok: false; message: string } {
  return { ok: false, message: v.error?.message || fallback };
}

/**
 * Whether a typed input passes a rule, and when not, what to tell the person
 * (the rule's own message if it has one, else a sentence that names the rule).
 */
export function checkValidation(
  v: Validation,
  input: string,
  env: DvEnv,
  row: number,
  col: number,
): { ok: true } | { ok: false; message: string } {
  const rule = v.rule;
  const value = input.startsWith("=") ? env.evaluate(input, row, col) : valueOf(input, rule.kind);
  const blank = value === null || value === "";
  if (blank)
    return v.allowBlank !== false ? { ok: true } : fail(v, "This cell cannot be left blank");
  switch (rule.kind) {
    case "list": {
      const items = listItems(v, env, row, col);
      const t =
        typeof value === "boolean"
          ? value
            ? "TRUE"
            : "FALSE"
          : isError(value)
            ? ""
            : String(value);
      return items.some((x) => x.toLowerCase() === t.toLowerCase())
        ? { ok: true }
        : fail(
            v,
            `Choose one of: ${items.slice(0, 12).join(", ")}${items.length > 12 ? ", …" : ""}`,
          );
    }
    case "custom": {
      const f = rule.formula.startsWith("=") ? rule.formula : `=${rule.formula}`;
      const r = env.evaluate(f, row, col, value);
      return r === true || (typeof r === "number" && r !== 0)
        ? { ok: true }
        : fail(v, describeValidation(v));
    }
    default: {
      const a = bound(rule.a, rule.kind, env, row, col);
      const b = bound(rule.b, rule.kind, env, row, col);
      // Limits read as typed (a date as the date); a formula's as its answer.
      const shown = (text: string | undefined, val: Scalar) =>
        text?.trim().startsWith("=") ? show(val) : (text ?? "").trim();
      const message = describeValidation(v, [
        shown(rule.a, a),
        rule.b !== undefined ? shown(rule.b, b) : undefined,
      ]);
      let n: number | null;
      if (rule.kind === "length") n = isError(value) ? null : String(value).length;
      else n = typeof value === "number" ? value : null;
      if (n === null) return fail(v, message);
      if (rule.kind === "whole" && !Number.isInteger(n)) return fail(v, message);
      if (rule.kind === "time" && (n < 0 || n >= 1)) return fail(v, message);
      const na = typeof a === "number" ? a : Number.NaN;
      const nb = typeof b === "number" ? b : Number.NaN;
      if (!Number.isFinite(na)) return fail(v, message);
      return compare(rule.op, n, na, Number.isFinite(nb) ? nb : na)
        ? { ok: true }
        : fail(v, message);
    }
  }
}
