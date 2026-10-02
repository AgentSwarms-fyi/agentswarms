// Conditional formatting and data validation in and out of an .xlsx, in
// ExcelJS's model. A rule this workbook has no equivalent for is left out on
// the way in and counted, so the import can say so.

import { a1, parseRangeA1, rangeA1 } from "./a1";
import type { CfRule, CfStyle, CondFormat, IconSet, ScaleStop } from "./condFormat";
import { literalValue } from "./engine";
import { timeValue, type DvOp, type Validation } from "./validation";
import { resolveColor, toArgb, type FileColor } from "./xlsxColors";

/* eslint-disable @typescript-eslint/no-explicit-any */
type XRule = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** How a formula is written in the file vs. here (_xlfn. prefixes). */
export type FormulaMap = (formula: string) => string;
const same: FormulaMap = (f) => f;

const OP_IN: Record<string, DvOp> = {
  greaterThan: "gt",
  lessThan: "lt",
  between: "between",
  notBetween: "notBetween",
  equal: "eq",
  notEqual: "ne",
  greaterThanOrEqual: "ge",
  lessThanOrEqual: "le",
};
const OP_OUT = Object.fromEntries(Object.entries(OP_IN).map(([k, v]) => [v, k])) as Record<
  DvOp,
  string
>;

const ICONS_IN: Record<string, IconSet> = {
  "3Arrows": "3arrows",
  "3ArrowsGray": "3arrows",
  "3TrafficLights1": "3traffic",
  "3TrafficLights2": "3traffic",
  "3Symbols": "3symbols",
  "3Symbols2": "3symbols",
  "3Flags": "3flags",
  "3Stars": "3stars",
  "4Arrows": "4arrows",
  "4ArrowsGray": "4arrows",
  "5Arrows": "5arrows",
  "5ArrowsGray": "5arrows",
};
const ICONS_OUT: Record<IconSet, string> = {
  "3arrows": "3Arrows",
  "3traffic": "3TrafficLights1",
  "3symbols": "3Symbols",
  "3flags": "3Flags",
  "3stars": "3Stars",
  "4arrows": "4Arrows",
  "5arrows": "5Arrows",
};

const PERIODS = new Set([
  "yesterday",
  "today",
  "tomorrow",
  "lastWeek",
  "thisWeek",
  "nextWeek",
  "lastMonth",
  "thisMonth",
  "nextMonth",
]);

const A1_RANGE = /^[A-Z]{1,3}\d+(:[A-Z]{1,3}\d+)?$/;

function styleIn(style: XRule | undefined, theme: string[]): CfStyle {
  const s: CfStyle = {};
  const fill = style?.fill;
  // A rule's fill is a dxf: its solid color is in bgColor (fgColor in some writers).
  const bg = resolveColor((fill?.bgColor ?? fill?.fgColor) as FileColor | undefined, theme);
  if (bg) s.bg = bg;
  const fc = resolveColor(style?.font?.color as FileColor | undefined, theme);
  if (fc) s.color = fc;
  if (style?.font?.bold) s.b = true;
  if (style?.font?.italic) s.i = true;
  if (style?.font?.underline) s.u = true;
  if (style?.font?.strike) s.st = true;
  return s;
}

function styleOut(s: CfStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.bg) out.fill = { type: "pattern", pattern: "solid", bgColor: { argb: toArgb(s.bg) } };
  const font: Record<string, unknown> = {};
  if (s.color) font.color = { argb: toArgb(s.color) };
  if (s.b) font.bold = true;
  if (s.i) font.italic = true;
  if (s.u) font.underline = true;
  if (s.st) font.strike = true;
  if (Object.keys(font).length) out.font = font;
  return out;
}

function stopIn(cfvo: XRule | undefined, color: FileColor | undefined, theme: string[]): ScaleStop {
  const t = cfvo?.type;
  const type: ScaleStop["type"] =
    t === "min" || t === "max" || t === "num" || t === "percent" || t === "percentile" ? t : "min";
  const value = Number(cfvo?.value);
  return {
    type,
    ...(cfvo?.value !== undefined && Number.isFinite(value) ? { value } : {}),
    color: resolveColor(color, theme) ?? "#FFFFFF",
  };
}

/** An operand from a file: a number or a quoted string stays literal; anything else is a formula. */
function operandIn(v: unknown, fromFile: FormulaMap): string {
  const t = String(v ?? "").trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (/^"(.*)"$/.test(t)) return t.slice(1, -1).replace(/""/g, '"');
  return `=${fromFile(t)}`;
}

function operandOut(v: string, toFile: FormulaMap): string {
  const t = v.trim();
  if (t.startsWith("=")) return toFile(t.slice(1));
  if (t !== "" && Number.isFinite(Number(t))) return t;
  return `"${t.replace(/"/g, '""')}"`;
}

/** The text a text rule looks for, from the formula Excel writes for it. */
function textFromFormula(f: string | undefined): string | null {
  const m = /(?:SEARCH|LEN)\("((?:[^"]|"")*)"/i.exec(f ?? "");
  return m ? m[1].replace(/""/g, '"') : null;
}

const quoted = (t: string) => `"${t.replace(/"/g, '""')}"`;

/**
 * A rule written as the formula it means (by this writer, or by another
 * that does the same), read back as that rule when the formula is about the
 * range's first cell.
 */
function expressionRule(f: string, range: string, style: CfStyle): CfRule | null {
  const first = range.split(":")[0];
  const ref = first.replace(/[A-Z]+/, (c) => `\\$?${c}`).replace(/(\d+)$/, "\\$?$1");
  const cell = `(?:${ref})`;
  const text = `"((?:[^"]|"")*)"`;
  const t = (s: string) => s.replace(/""/g, '"');
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^ISERROR\\(SEARCH\\(${text},${cell}\\)\\)$`, "i").exec(f)))
    return { kind: "text", op: "notContains", text: t(m[1]), style };
  if ((m = new RegExp(`^NOT\\(ISERROR\\(SEARCH\\(${text},${cell}\\)\\)\\)$`, "i").exec(f)))
    return { kind: "text", op: "contains", text: t(m[1]), style };
  if (
    (m = new RegExp(`^LEFT\\(${cell},LEN\\(${text}\\)\\)=${text}$`, "i").exec(f)) &&
    m[1] === m[2]
  )
    return { kind: "text", op: "begins", text: t(m[1]), style };
  if (
    (m = new RegExp(`^RIGHT\\(${cell},LEN\\(${text}\\)\\)=${text}$`, "i").exec(f)) &&
    m[1] === m[2]
  )
    return { kind: "text", op: "ends", text: t(m[1]), style };
  if ((m = new RegExp(`^COUNTIF\\([^,]+,${cell}\\)(>1|=1)$`, "i").exec(f)))
    return { kind: m[1] === ">1" ? "duplicate" : "unique", style };
  if ((m = new RegExp(`^LEN\\(TRIM\\(${cell}\\)\\)(=0|>0)$`, "i").exec(f)))
    return { kind: m[1] === "=0" ? "blank" : "notBlank", style };
  if (new RegExp(`^ISERROR\\(${cell}\\)$`, "i").test(f)) return { kind: "errors", style };
  if (new RegExp(`^NOT\\(ISERROR\\(${cell}\\)\\)$`, "i").test(f))
    return { kind: "noErrors", style };
  return null;
}

/** A file's conditional formats as rules here; the rest are counted. */
export function condFormatsIn(
  list: { ref: string; rules: XRule[] }[] | undefined,
  theme: string[],
  fromFile: FormulaMap = same,
): { rules: CondFormat[]; skipped: number } {
  const out: CondFormat[] = [];
  let skipped = 0;
  let n = 0;
  for (const cf of list ?? []) {
    const ranges = String(cf.ref ?? "")
      .split(/\s+/)
      .map((r) => r.replace(/\$/g, ""))
      .filter((r) => A1_RANGE.test(r));
    if (!ranges.length) {
      skipped += cf.rules?.length ?? 0;
      continue;
    }
    const sorted = [...(cf.rules ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const r of sorted) {
      let rule: CfRule | null = null;
      const style = styleIn(r.style, theme);
      const f0 = r.formulae?.[0] === undefined ? "" : String(r.formulae[0]);
      switch (r.type) {
        case "cellIs": {
          const op = OP_IN[r.operator];
          if (op && r.formulae?.length)
            rule = {
              kind: "cell",
              op,
              a: operandIn(r.formulae[0], fromFile),
              ...(r.formulae[1] !== undefined ? { b: operandIn(r.formulae[1], fromFile) } : {}),
              style,
            };
          break;
        }
        // ExcelJS reads the blank and error rules as containsText with the type as operator.
        case "containsText": {
          const op = r.operator;
          if (op === "containsBlanks") rule = { kind: "blank", style };
          else if (op === "notContainsBlanks") rule = { kind: "notBlank", style };
          else if (op === "containsErrors") rule = { kind: "errors", style };
          else if (op === "notContainsErrors") rule = { kind: "noErrors", style };
          else {
            const text = r.text ?? textFromFormula(f0);
            if (text !== null && text !== undefined)
              rule = { kind: "text", op: "contains", text: String(text), style };
          }
          break;
        }
        case "notContainsText":
        case "beginsWith":
        case "endsWith": {
          const text = r.text ?? textFromFormula(f0);
          if (text !== null && text !== undefined)
            rule = {
              kind: "text",
              op:
                r.type === "notContainsText"
                  ? "notContains"
                  : r.type === "beginsWith"
                    ? "begins"
                    : "ends",
              text: String(text),
              style,
            };
          break;
        }
        case "top10": {
          const rank = Number(r.rank ?? 10);
          if (Number.isInteger(rank) && rank >= 1 && rank <= 1000)
            rule = { kind: "top", n: rank, percent: !!r.percent, bottom: !!r.bottom, style };
          break;
        }
        case "aboveAverage":
          rule = {
            kind: "average",
            ...(r.aboveAverage === false ? { below: true } : {}),
            ...(r.equalAverage ? { equal: true } : {}),
            style,
          };
          break;
        case "expression":
          // The formulas this writer uses for rules ExcelJS cannot write come
          // back as those rules; any other is a formula rule.
          if (f0)
            rule = expressionRule(f0, ranges[0], style) ?? {
              kind: "formula",
              formula: `=${fromFile(f0)}`,
              style,
            };
          break;
        case "duplicateValues":
          rule = { kind: "duplicate", style };
          break;
        case "uniqueValues":
          rule = { kind: "unique", style };
          break;
        case "timePeriod": {
          const p = String(r.timePeriod ?? "");
          if (p === "last7Days") rule = { kind: "date", period: "last7", style };
          else if (PERIODS.has(p))
            rule = { kind: "date", period: p as Exclude<CfPeriodIn, "last7">, style };
          break;
        }
        case "colorScale": {
          const cfvo = r.cfvo ?? [];
          const colors = r.color ?? [];
          if (cfvo.length === 3)
            rule = {
              kind: "scale",
              min: stopIn(cfvo[0], colors[0], theme),
              mid: stopIn(cfvo[1], colors[1], theme),
              max: stopIn(cfvo[2], colors[2], theme),
            };
          else if (cfvo.length === 2)
            rule = {
              kind: "scale",
              min: stopIn(cfvo[0], colors[0], theme),
              max: stopIn(cfvo[1], colors[1], theme),
            };
          break;
        }
        case "dataBar":
          rule = { kind: "bar", color: resolveColor(r.color, theme) ?? "#638EC6" };
          break;
        case "iconSet": {
          const set = ICONS_IN[String(r.iconSet ?? "3TrafficLights1")];
          if (set) rule = { kind: "icons", set, ...(r.reverse ? { reverse: true } : {}) };
          break;
        }
      }
      if (rule) out.push({ id: `x${++n}`, ranges, rule, ...(r.stopIfTrue ? { stop: true } : {}) });
      else skipped++;
    }
  }
  return { rules: out, skipped };
}

type CfPeriodIn = Extract<CfRule, { kind: "date" }>["period"];

/** Rules here as ExcelJS conditional formats, priority from list order. */
export function condFormatsOut(
  rules: readonly CondFormat[] | undefined,
  toFile: FormulaMap = same,
): { ref: string; rules: XRule[] }[] {
  const out: { ref: string; rules: XRule[] }[] = [];
  (rules ?? []).forEach((cf, i) => {
    const rule = cf.rule;
    const base = { priority: i + 1, ...(cf.stop ? { stopIfTrue: true } : {}) };
    // A formula rule is written for the first range's top-left cell.
    const first = (cf.ranges[0] ?? "A1").replace(/\$/g, "").split(":")[0];
    const expr = (formula: string, style: CfStyle) => ({
      ...base,
      type: "expression",
      formulae: [formula],
      style: styleOut(style),
    });
    let x: XRule | null = null;
    switch (rule.kind) {
      case "cell":
        x = {
          ...base,
          type: "cellIs",
          operator: OP_OUT[rule.op],
          formulae: [
            operandOut(rule.a, toFile),
            ...(rule.b !== undefined ? [operandOut(rule.b, toFile)] : []),
          ],
          style: styleOut(rule.style),
        };
        break;
      case "text": {
        const t = quoted(rule.text);
        // Contains, begins with and ends with go out as Excel's own rules
        // (ExcelJS writes the rule's type from its operator, with the formula
        // Excel keeps beside it). "Does not contain" has no operator ExcelJS
        // can write, so it goes out as the formula that rule means.
        if (rule.op === "notContains") {
          x = expr(`ISERROR(SEARCH(${t},${first}))`, rule.style);
          break;
        }
        x = {
          ...base,
          type: "containsText",
          operator:
            rule.op === "begins" ? "beginsWith" : rule.op === "ends" ? "endsWith" : "containsText",
          text: rule.text,
          formulae: [
            rule.op === "begins"
              ? `LEFT(${first},LEN(${t}))=${t}`
              : rule.op === "ends"
                ? `RIGHT(${first},LEN(${t}))=${t}`
                : `NOT(ISERROR(SEARCH(${t},${first})))`,
          ],
          style: styleOut(rule.style),
        };
        break;
      }
      case "top":
        x = {
          ...base,
          type: "top10",
          rank: rule.n,
          percent: !!rule.percent,
          bottom: !!rule.bottom,
          style: styleOut(rule.style),
        };
        break;
      case "average":
        x = {
          ...base,
          type: "aboveAverage",
          aboveAverage: !rule.below,
          style: styleOut(rule.style),
        };
        break;
      case "formula":
        x = expr(toFile(rule.formula.replace(/^=/, "")), rule.style);
        break;
      case "duplicate":
      case "unique": {
        const abs = (cf.ranges[0] ?? "A1").replace(/\$/g, "").replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");
        x = expr(`COUNTIF(${abs},${first})${rule.kind === "duplicate" ? ">1" : "=1"}`, rule.style);
        break;
      }
      case "blank":
      case "notBlank":
        x = expr(`LEN(TRIM(${first}))${rule.kind === "blank" ? "=0" : ">0"}`, rule.style);
        break;
      case "errors":
        x = expr(`ISERROR(${first})`, rule.style);
        break;
      case "noErrors":
        x = expr(`NOT(ISERROR(${first}))`, rule.style);
        break;
      case "date":
        x = {
          ...base,
          type: "timePeriod",
          timePeriod: rule.period === "last7" ? "last7Days" : rule.period,
          style: styleOut(rule.style),
        };
        break;
      case "scale": {
        const stops = [rule.min, ...(rule.mid ? [rule.mid] : []), rule.max];
        x = {
          ...base,
          type: "colorScale",
          cfvo: stops.map((s) => ({
            type: s.type,
            ...(s.value !== undefined ? { value: s.value } : {}),
          })),
          color: stops.map((s) => ({ argb: toArgb(s.color) })),
        };
        break;
      }
      case "bar":
        x = {
          ...base,
          type: "dataBar",
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: toArgb(rule.color) },
        };
        break;
      case "icons":
        x = {
          ...base,
          type: "iconSet",
          iconSet: ICONS_OUT[rule.set],
          // Excel's default thresholds: equal percent bands (ExcelJS needs them spelled out).
          cfvo: Array.from({ length: Number(rule.set[0]) }, (_, k) => ({
            type: "percent",
            value: Math.round((k * 100) / Number(rule.set[0])),
          })),
          ...(rule.reverse ? { reverse: true } : {}),
        };
        break;
    }
    if (x) out.push({ ref: cf.ranges.map((r) => r.replace(/\$/g, "")).join(" "), rules: [x] });
  });
  return out;
}

const DV_TYPE_IN: Record<
  string,
  "list" | "whole" | "decimal" | "date" | "time" | "length" | "custom"
> = {
  list: "list",
  whole: "whole",
  decimal: "decimal",
  date: "date",
  time: "time",
  textLength: "length",
  custom: "custom",
};

/** Cells as the fewest column runs, joined across columns with the same runs ("B2:C40"). */
export function cellsToRanges(cells: { row: number; col: number }[]): string[] {
  const byCol = new Map<number, number[]>();
  for (const { row, col } of cells) {
    const list = byCol.get(col) ?? [];
    list.push(row);
    byCol.set(col, list);
  }
  const runs: { r0: number; r1: number; c0: number; c1: number }[] = [];
  for (const col of [...byCol.keys()].sort((a, b) => a - b)) {
    const rows = [...new Set(byCol.get(col))].sort((a, b) => a - b);
    let start = rows[0];
    for (let i = 1; i <= rows.length; i++) {
      if (i < rows.length && rows[i] === rows[i - 1] + 1) continue;
      const end = rows[i - 1];
      // Join with the same run in the column just left of this one.
      const left = runs.find((x) => x.c1 === col - 1 && x.r0 === start && x.r1 === end);
      if (left) left.c1 = col;
      else runs.push({ r0: start, r1: end, c0: col, c1: col });
      start = rows[i];
    }
  }
  return runs.map((r) => rangeA1(r));
}

/**
 * A file's data validations. ExcelJS keys a rule by every cell it covers
 * (one shared object per rule), so cells are gathered back into ranges.
 */
export function validationsIn(
  model: Record<string, XRule> | undefined,
  fromFile: FormulaMap = same,
  /** Each rule's limits as the file writes them, by its first cell (see xlsxParts). */
  raw?: Map<string, string[]>,
): { validations: Validation[]; skipped: number } {
  const out: Validation[] = [];
  let skipped = 0;
  let n = 0;
  const groups = new Map<XRule, { row: number; col: number }[]>();
  for (const [ref, v] of Object.entries(model ?? {})) {
    if (!v) continue;
    const at = parseRangeA1(ref.replace(/\$/g, ""));
    if (!at) continue;
    const list = groups.get(v) ?? [];
    for (let row = at.r0; row <= at.r1; row++)
      for (let col = at.c0; col <= at.c1; col++) list.push({ row, col });
    groups.set(v, list);
  }
  for (const [v, cells] of groups) {
    if (v.type === "any") continue;
    const kind = DV_TYPE_IN[v.type];
    if (!kind) {
      skipped++;
      continue;
    }
    const f = (i: number): unknown => v.formulae?.[i];
    let rule: Validation["rule"] | null = null;
    if (kind === "list") {
      const src = String(f(0) ?? "").trim();
      rule = /^".*"$/.test(src)
        ? {
            kind: "list",
            items: src
              .slice(1, -1)
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            ...(v.showDropDown ? { dropdown: false } : {}),
          }
        : src
          ? {
              kind: "list",
              source: `=${fromFile(src.replace(/^=/, ""))}`,
              ...(v.showDropDown ? { dropdown: false } : {}),
            }
          : null;
    } else if (kind === "custom") {
      const src = String(f(0) ?? "").replace(/^=/, "");
      rule = src ? { kind: "custom", formula: `=${fromFile(src)}` } : null;
    } else {
      // ExcelJS reads a date limit as a Date and a whole-number or length
      // limit with parseInt, so a limit that was a formula comes back NaN.
      // The file's own text for this rule's limits, when ExcelJS parsed them away.
      const rawText = cells.map((c) => raw?.get(a1(c.row, c.col))).find((x) => x !== undefined);
      const bound = (x: unknown, i: number): string | null => {
        if (x === undefined) return null;
        const text = (): string | null => {
          const t = rawText?.[i]?.trim();
          if (!t) return null;
          return /^-?\d+(\.\d+)?$/.test(t) ? t : `=${fromFile(t.replace(/^=/, ""))}`;
        };
        if (x instanceof Date) {
          const t = x.getTime();
          return Number.isFinite(t) ? String(Math.round(t / 86_400_000 + 25_569)) : text();
        }
        if (typeof x === "number") return Number.isFinite(x) ? String(x) : text();
        const t = String(x).trim();
        if (/^-?\d+(\.\d+)?$/.test(t)) return t;
        return t ? `=${fromFile(t.replace(/^=/, ""))}` : null;
      };
      const a = bound(f(0), 0);
      const b = f(1) === undefined ? undefined : bound(f(1), 1);
      if (a !== null && b !== null)
        rule = {
          kind,
          op: OP_IN[v.operator ?? "between"] ?? "between",
          a,
          ...(b !== undefined ? { b } : {}),
        };
    }
    if (!rule) {
      skipped++;
      continue;
    }
    out.push({
      id: `v${++n}`,
      ranges: cellsToRanges(cells),
      rule,
      ...(v.allowBlank ? { allowBlank: true } : { allowBlank: false }),
      ...(v.showInputMessage && v.prompt
        ? {
            prompt: {
              ...(v.promptTitle ? { title: String(v.promptTitle) } : {}),
              message: String(v.prompt),
            },
          }
        : {}),
      error: {
        style:
          v.errorStyle === "warning" ? "warning" : v.errorStyle === "information" ? "info" : "stop",
        ...(v.errorTitle ? { title: String(v.errorTitle) } : {}),
        ...(v.error ? { message: String(v.error) } : {}),
      },
    });
  }
  return { validations: out, skipped };
}

/**
 * A rule here in ExcelJS's shape. A date limit that is a formula is written
 * as a decimal rule with that formula (the same test on the serial day),
 * because ExcelJS writes date limits through new Date().
 */
export function validationOut(v: Validation, toFile: FormulaMap = same): XRule {
  const r = v.rule;
  const base = {
    allowBlank: v.allowBlank !== false,
    showErrorMessage: true,
    errorStyle:
      v.error?.style === "warning" ? "warning" : v.error?.style === "info" ? "information" : "stop",
    ...(v.error?.title ? { errorTitle: v.error.title } : {}),
    ...(v.error?.message ? { error: v.error.message } : {}),
    ...(v.prompt
      ? {
          showInputMessage: true,
          prompt: v.prompt.message,
          ...(v.prompt.title ? { promptTitle: v.prompt.title } : {}),
        }
      : {}),
  };
  if (r.kind === "list") {
    const formulae = r.items
      ? [`"${r.items.join(",")}"`]
      : [toFile(String(r.source ?? "").replace(/^=/, ""))];
    return {
      ...base,
      type: "list",
      formulae,
      ...(r.dropdown === false ? { showDropDown: true } : {}),
    };
  }
  if (r.kind === "custom")
    return { ...base, type: "custom", formulae: [toFile(r.formula.replace(/^=/, ""))] };
  const bounds = [r.a, ...(r.b !== undefined ? [r.b] : [])];
  const isFormula = bounds.some((x) => x.trim().startsWith("="));
  const lit = (x: string): number | string => {
    const t = x.trim();
    if (t.startsWith("=")) return toFile(t.slice(1));
    const n = r.kind === "time" ? (timeValue(t) ?? literalValue(t)) : literalValue(t);
    return typeof n === "number" ? n : t;
  };
  const type =
    r.kind === "length" ? "textLength" : r.kind === "date" && isFormula ? "decimal" : r.kind;
  const formulae = bounds.map((x) => {
    const val = lit(x);
    // ExcelJS converts a date rule's limits with new Date(); give it one.
    return type === "date" && typeof val === "number"
      ? new Date(Math.round((val - 25_569) * 86_400_000))
      : val;
  });
  return { ...base, type, operator: OP_OUT[r.op], formulae };
}

/** The cells of an address, for ExcelJS's dataValidations.add (a range works as the key). */
export const dvAddress = (range: string): string => {
  const r = parseRangeA1(range.replace(/\$/g, ""));
  return r ? rangeA1(r) : a1(0, 0);
};
