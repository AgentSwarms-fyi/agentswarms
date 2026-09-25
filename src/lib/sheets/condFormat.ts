// Conditional formatting, as Excel's rules work: each rule covers ranges,
// decides per cell (a comparison, text, dates, top/bottom, averages,
// duplicates, a formula) or paints a scale (color scales, data bars, icon
// sets) from the range's own numbers. Rules are in priority order; for a
// property two rules both set, the higher-priority one wins, and "stop if
// true" ends the list for that cell.

import { parseRangeA1, type RangeAddr } from "./a1";
import { shiftFormula } from "./formula/shift";
import { isError, type Scalar } from "./formula/values";

export type CfStyle = {
  color?: string;
  bg?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  st?: boolean;
};

export type CfOp = "gt" | "ge" | "lt" | "le" | "eq" | "ne" | "between" | "notBetween";
export type CfTextOp = "contains" | "notContains" | "begins" | "ends";
export type CfPeriod =
  | "yesterday"
  | "today"
  | "tomorrow"
  | "last7"
  | "lastWeek"
  | "thisWeek"
  | "nextWeek"
  | "lastMonth"
  | "thisMonth"
  | "nextMonth";

export type ScaleStop = {
  type: "min" | "max" | "num" | "percent" | "percentile";
  value?: number;
  color: string;
};

export type IconSet =
  | "3arrows"
  | "3traffic"
  | "3symbols"
  | "3flags"
  | "4arrows"
  | "5arrows"
  | "3stars";

export type CfRule =
  | { kind: "cell"; op: CfOp; a: string; b?: string; style: CfStyle }
  | { kind: "text"; op: CfTextOp; text: string; style: CfStyle }
  | { kind: "blank" | "notBlank" | "errors" | "noErrors"; style: CfStyle }
  | { kind: "date"; period: CfPeriod; style: CfStyle }
  | { kind: "top"; n: number; percent?: boolean; bottom?: boolean; style: CfStyle }
  | { kind: "average"; below?: boolean; equal?: boolean; style: CfStyle }
  | { kind: "duplicate" | "unique"; style: CfStyle }
  | { kind: "formula"; formula: string; style: CfStyle }
  | { kind: "scale"; min: ScaleStop; mid?: ScaleStop; max: ScaleStop }
  | { kind: "bar"; color: string; min?: ScaleStop; max?: ScaleStop }
  | { kind: "icons"; set: IconSet; reverse?: boolean };

export type CondFormat = {
  id: string;
  /** A1 ranges on this sheet, "B2:B40". */
  ranges: string[];
  rule: CfRule;
  stop?: boolean;
};

export type CfResult = CfStyle & {
  bar?: { start: number; end: number; color: string };
  icon?: string;
};

export type CfEnv = {
  value: (row: number, col: number) => Scalar;
  /** A formula's answer at a cell (relative references already moved there). */
  evaluate: (formula: string, row: number, col: number) => Scalar;
  /** Today, as an Excel serial day. */
  today: number;
  /** A literal or =formula operand, evaluated at a cell. */
  operand?: (text: string, row: number, col: number) => Scalar;
};

const ICONS: Record<IconSet, string[]> = {
  "3arrows": ["🔻", "▶", "🔺"],
  "3traffic": ["🔴", "🟡", "🟢"],
  "3symbols": ["✖", "!", "✔"],
  "3flags": ["🚩", "🏳", "🏁"],
  "3stars": ["☆", "⯪", "★"],
  "4arrows": ["⬇", "↘", "↗", "⬆"],
  "5arrows": ["⬇", "↘", "➡", "↗", "⬆"],
};

export const ICON_SETS = ICONS;

function num(v: Scalar): number | null {
  return typeof v === "number" ? v : null;
}

function lowerText(v: Scalar): string {
  if (v === null) return "";
  if (typeof v === "object") return v.err.toLowerCase();
  return String(v).toLowerCase();
}

function compare(a: Scalar, b: Scalar): number | null {
  if (a === null || b === null) {
    const x = a ?? (typeof b === "number" ? 0 : "");
    const y = b ?? (typeof a === "number" ? 0 : "");
    return compare(x, y);
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  // Excel orders numbers before text before booleans.
  const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  if (typeof a === "object" || typeof b === "object") return null;
  return rank(a) - rank(b);
}

/** Excel's week starts on Sunday. */
function weekStart(day: number): number {
  // Serial 1 (1900-01-01) was a Sunday in Excel's calendar.
  const dow = (((Math.floor(day) - 1) % 7) + 7) % 7;
  return Math.floor(day) - dow;
}

function monthOf(serial: number): { y: number; m: number } {
  const d = new Date(Math.round((serial - 25569) * 86_400_000));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}

export function inPeriod(v: number, period: CfPeriod, today: number): boolean {
  const d = Math.floor(v);
  const t = Math.floor(today);
  switch (period) {
    case "yesterday":
      return d === t - 1;
    case "today":
      return d === t;
    case "tomorrow":
      return d === t + 1;
    case "last7":
      return d > t - 7 && d <= t;
    case "lastWeek":
      return weekStart(d) === weekStart(t) - 7;
    case "thisWeek":
      return weekStart(d) === weekStart(t);
    case "nextWeek":
      return weekStart(d) === weekStart(t) + 7;
    case "lastMonth":
    case "thisMonth":
    case "nextMonth": {
      const a = monthOf(d);
      const b = monthOf(t);
      const diff = (a.y - b.y) * 12 + (a.m - b.m);
      return diff === (period === "lastMonth" ? -1 : period === "thisMonth" ? 0 : 1);
    }
  }
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const k = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

type Stats = {
  nums: number[]; // sorted
  min: number;
  max: number;
  avg: number;
  counts: Map<string, number>;
};

function stopValue(s: ScaleStop, st: Stats): number {
  switch (s.type) {
    case "min":
      return st.min;
    case "max":
      return st.max;
    case "num":
      return s.value ?? 0;
    case "percent":
      return st.min + ((st.max - st.min) * (s.value ?? 0)) / 100;
    case "percentile":
      return percentile(st.nums, (s.value ?? 0) / 100);
  }
}

/**
 * Evaluates a sheet's rules. Built per recalculation; statistics per rule
 * (min, max, top-N threshold, duplicate counts) are computed once, on first use.
 */
export class CondFormatter {
  private parsed: { cf: CondFormat; ranges: RangeAddr[]; anchor: { row: number; col: number } }[];
  private stats = new Map<string, Stats>();
  private cache = new Map<string, CfResult | null>();

  constructor(
    rules: readonly CondFormat[] | undefined,
    private env: CfEnv,
  ) {
    this.parsed = (rules ?? []).map((cf) => {
      const ranges = cf.ranges.map((r) => parseRangeA1(r)).filter((r): r is RangeAddr => !!r);
      const first = ranges[0] ?? { r0: 0, c0: 0, r1: 0, c1: 0 };
      return { cf, ranges, anchor: { row: first.r0, col: first.c0 } };
    });
  }

  get empty(): boolean {
    return this.parsed.length === 0;
  }

  private statsFor(id: string, ranges: RangeAddr[]): Stats {
    let s = this.stats.get(id);
    if (s) return s;
    const nums: number[] = [];
    const counts = new Map<string, number>();
    let cells = 0;
    for (const r of ranges) {
      for (let row = r.r0; row <= r.r1; row++) {
        for (let col = r.c0; col <= r.c1; col++) {
          if (++cells > 1_000_000) break;
          const v = this.env.value(row, col);
          if (v === null || v === "") continue;
          const n = num(v);
          if (n !== null) nums.push(n);
          const key = lowerText(v) + (typeof v === "number" ? "#n" : "");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    nums.sort((a, b) => a - b);
    s = {
      nums,
      min: nums.length ? nums[0] : 0,
      max: nums.length ? nums[nums.length - 1] : 0,
      avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0,
      counts,
    };
    this.stats.set(id, s);
    return s;
  }

  private operand(text: string, row: number, col: number): Scalar {
    if (this.env.operand) return this.env.operand(text, row, col);
    const t = text.trim();
    if (t.startsWith("=")) return this.env.evaluate(t, row, col);
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
    return t;
  }

  /** Whether a style rule matches the cell. */
  private matches(p: (typeof this.parsed)[number], row: number, col: number): boolean {
    const { cf, ranges, anchor } = p;
    const rule = cf.rule;
    const v = this.env.value(row, col);
    switch (rule.kind) {
      case "cell": {
        // An empty cell compares as 0 or "" (Excel highlights blanks as "less than 5").
        if (isError(v)) return false;
        const a = this.operand(rule.a, row, col);
        const c1 = compare(v, a);
        if (c1 === null) return false;
        switch (rule.op) {
          case "gt":
            return c1 > 0;
          case "ge":
            return c1 >= 0;
          case "lt":
            return c1 < 0;
          case "le":
            return c1 <= 0;
          case "eq":
            return c1 === 0;
          case "ne":
            return c1 !== 0;
          case "between":
          case "notBetween": {
            const b = this.operand(rule.b ?? "", row, col);
            const lo = compare(a, b)! <= 0 ? a : b;
            const hi = lo === a ? b : a;
            const inside = (compare(v, lo) ?? -1) >= 0 && (compare(v, hi) ?? 1) <= 0;
            return rule.op === "between" ? inside : !inside;
          }
        }
        return false;
      }
      case "text": {
        const t = lowerText(v);
        const q = rule.text.toLowerCase();
        if (rule.op === "contains") return t.includes(q);
        if (rule.op === "notContains") return !t.includes(q);
        if (rule.op === "begins") return t.startsWith(q);
        return t.endsWith(q);
      }
      case "blank":
        return v === null || (typeof v === "string" && v.trim() === "");
      case "notBlank":
        return !(v === null || (typeof v === "string" && v.trim() === ""));
      case "errors":
        return isError(v);
      case "noErrors":
        return !isError(v);
      case "date": {
        const n = num(v);
        return n !== null && inPeriod(n, rule.period, this.env.today);
      }
      case "top": {
        const n = num(v);
        if (n === null) return false;
        const s = this.statsFor(cf.id, ranges);
        const count = rule.percent
          ? Math.max(1, Math.floor((s.nums.length * rule.n) / 100))
          : Math.max(1, rule.n);
        if (!s.nums.length) return false;
        if (rule.bottom) return n <= s.nums[Math.min(s.nums.length, count) - 1];
        return n >= s.nums[Math.max(0, s.nums.length - count)];
      }
      case "average": {
        const n = num(v);
        if (n === null) return false;
        const s = this.statsFor(cf.id, ranges);
        if (!s.nums.length) return false;
        if (rule.below) return rule.equal ? n <= s.avg : n < s.avg;
        return rule.equal ? n >= s.avg : n > s.avg;
      }
      case "duplicate":
      case "unique": {
        if (v === null || v === "") return false;
        const s = this.statsFor(cf.id, ranges);
        const k = lowerText(v) + (typeof v === "number" ? "#n" : "");
        const dup = (s.counts.get(k) ?? 0) > 1;
        return rule.kind === "duplicate" ? dup : !dup;
      }
      case "formula": {
        const f = rule.formula.startsWith("=") ? rule.formula : `=${rule.formula}`;
        const r = this.env.evaluate(shiftFormula(f, row - anchor.row, col - anchor.col), row, col);
        if (typeof r === "boolean") return r;
        if (typeof r === "number") return r !== 0;
        return false;
      }
      default:
        return false;
    }
  }

  /** What the rules add to a cell, or undefined when none apply. */
  at(row: number, col: number): CfResult | undefined {
    if (!this.parsed.length) return undefined;
    const key = `${row},${col}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    let out: CfResult | null = null;
    const set = (patch: CfResult) => {
      out = out ?? {};
      for (const [k, val] of Object.entries(patch)) {
        // Earlier (higher-priority) rules keep what they set.
        if ((out as Record<string, unknown>)[k] === undefined && val !== undefined)
          (out as Record<string, unknown>)[k] = val;
      }
    };
    for (const p of this.parsed) {
      if (!p.ranges.some((r) => row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1)) continue;
      const rule = p.cf.rule;
      if (rule.kind === "scale" || rule.kind === "bar" || rule.kind === "icons") {
        const n = num(this.env.value(row, col));
        if (n === null) continue;
        const s = this.statsFor(p.cf.id, p.ranges);
        if (rule.kind === "scale") {
          const lo = stopValue(rule.min, s);
          const hi = stopValue(rule.max, s);
          let color: string;
          if (rule.mid) {
            const mid = stopValue(rule.mid, s);
            color =
              n <= mid
                ? mix(
                    rule.min.color,
                    rule.mid.color,
                    mid === lo ? 1 : (Math.max(lo, n) - lo) / (mid - lo),
                  )
                : mix(
                    rule.mid.color,
                    rule.max.color,
                    hi === mid ? 1 : (Math.min(hi, n) - mid) / (hi - mid),
                  );
          } else {
            color = mix(
              rule.min.color,
              rule.max.color,
              hi === lo ? 1 : (Math.min(hi, Math.max(lo, n)) - lo) / (hi - lo),
            );
          }
          set({ bg: color });
        } else if (rule.kind === "bar") {
          const lo = rule.min ? stopValue(rule.min, s) : Math.min(0, s.min);
          const hi = rule.max ? stopValue(rule.max, s) : Math.max(0, s.max);
          const span = hi - lo || 1;
          // Negative values grow left from the zero line, as Excel draws them.
          const zero = Math.max(0, Math.min(1, (0 - lo) / span));
          const at = Math.max(0, Math.min(1, (n - lo) / span));
          set({ bar: { start: Math.min(zero, at), end: Math.max(zero, at), color: rule.color } });
        } else {
          const icons = ICONS[rule.set];
          const k = icons.length;
          const lo = s.min;
          const hi = s.max;
          // Excel's default thresholds: equal percent bands of the range.
          let band = hi === lo ? k - 1 : Math.min(k - 1, Math.floor(((n - lo) / (hi - lo)) * k));
          if (rule.reverse) band = k - 1 - band;
          set({ icon: icons[band] });
        }
        continue;
      }
      if (this.matches(p, row, col)) {
        set(rule.style);
        if (p.cf.stop) break;
      }
    }
    this.cache.set(key, out);
    return out ?? undefined;
  }
}

const OP_WORDS: Record<CfOp, string> = {
  gt: "greater than",
  ge: "at least",
  lt: "less than",
  le: "at most",
  eq: "equal to",
  ne: "not equal to",
  between: "between",
  notBetween: "not between",
};

const PERIOD_WORDS: Record<CfPeriod, string> = {
  yesterday: "yesterday",
  today: "today",
  tomorrow: "tomorrow",
  last7: "in the last 7 days",
  lastWeek: "last week",
  thisWeek: "this week",
  nextWeek: "next week",
  lastMonth: "last month",
  thisMonth: "this month",
  nextMonth: "next month",
};

/** A rule in plain words, for the rules manager. */
export function describeRule(rule: CfRule): string {
  switch (rule.kind) {
    case "cell":
      return `Cell value ${OP_WORDS[rule.op]} ${rule.a}${rule.b !== undefined ? ` and ${rule.b}` : ""}`;
    case "text":
      return `Text ${rule.op === "contains" ? "contains" : rule.op === "notContains" ? "does not contain" : rule.op === "begins" ? "begins with" : "ends with"} "${rule.text}"`;
    case "blank":
      return "Blank cells";
    case "notBlank":
      return "Cells that are not blank";
    case "errors":
      return "Cells with errors";
    case "noErrors":
      return "Cells without errors";
    case "date":
      return `A date ${PERIOD_WORDS[rule.period]}`;
    case "top":
      return `${rule.bottom ? "Bottom" : "Top"} ${rule.n}${rule.percent ? "%" : ""}`;
    case "average":
      return `${rule.below ? "Below" : "Above"} average`;
    case "duplicate":
      return "Duplicate values";
    case "unique":
      return "Unique values";
    case "formula":
      return `Formula: ${rule.formula}`;
    case "scale": {
      // A preset by its name; any other by its colors.
      const preset = SCALE_PRESETS.find(
        (p) =>
          p.min === rule.min.color.toUpperCase() &&
          p.max === rule.max.color.toUpperCase() &&
          (p.mid ?? null) === (rule.mid?.color.toUpperCase() ?? null),
      );
      return preset
        ? `Color scale: ${preset.label}`
        : `Color scale: ${[rule.min, ...(rule.mid ? [rule.mid] : []), rule.max].map((x) => x.color).join(" → ")}`;
    }
    case "bar":
      return `Data bar: ${BAR_COLORS.find((b) => b.color === rule.color.toUpperCase())?.label ?? rule.color}`;
    case "icons":
      return `Icon set: ${ICON_SET_NAMES[rule.set]} ${ICONS[rule.set].join("")}`;
  }
}

/** Excel's preset looks for highlight rules. */
export const CF_PRESETS: { label: string; style: CfStyle }[] = [
  { label: "Light red fill with dark red text", style: { bg: "#FFC7CE", color: "#9C0006" } },
  { label: "Yellow fill with dark yellow text", style: { bg: "#FFEB9C", color: "#9C5700" } },
  { label: "Green fill with dark green text", style: { bg: "#C6EFCE", color: "#006100" } },
  { label: "Light red fill", style: { bg: "#FFC7CE" } },
  { label: "Red text", style: { color: "#9C0006" } },
  { label: "Red border-less bold", style: { color: "#C00000", b: true } },
];

export const SCALE_PRESETS: { label: string; min: string; mid?: string; max: string }[] = [
  { label: "Green – Yellow – Red", min: "#63BE7B", mid: "#FFEB84", max: "#F8696B" },
  { label: "Red – Yellow – Green", min: "#F8696B", mid: "#FFEB84", max: "#63BE7B" },
  { label: "Green – White", min: "#FFFFFF", max: "#63BE7B" },
  { label: "White – Red", min: "#FFFFFF", max: "#F8696B" },
  { label: "Blue – White – Red", min: "#5A8AC6", mid: "#FCFCFF", max: "#F8696B" },
];

/** Excel's data bar colors. */
export const BAR_COLORS: { color: string; label: string }[] = [
  { color: "#638EC6", label: "Blue" },
  { color: "#63C384", label: "Green" },
  { color: "#FF555A", label: "Red" },
  { color: "#FFB628", label: "Orange" },
  { color: "#008AEF", label: "Light blue" },
  { color: "#D6007B", label: "Purple" },
];

export const ICON_SET_NAMES: Record<IconSet, string> = {
  "3arrows": "3 arrows",
  "3traffic": "3 traffic lights",
  "3symbols": "3 symbols",
  "3flags": "3 flags",
  "3stars": "3 stars",
  "4arrows": "4 arrows",
  "5arrows": "5 arrows",
};
