// The pivot (matrix) widget's arithmetic (R506): rows × column values ×
// measures, with an optional second row level, and the totals each measure
// can honestly have. Pure, so the rule is tested where it lives.
import { isPreAggregated } from "@/lib/biColumnKinds";

/**
 * How a measure's cells combine into a total.
 *
 * Sums and counts add up; the lowest of the lowest values is the lowest, and
 * the same for the highest. An average, a rate, a percentage or a count of
 * distinct values does not add up, and nothing in the cells says how to
 * weight them, so it gets no total at all — a blank is true, a sum of
 * averages is a number nobody can use. The name rule is the table's totals
 * row's (isPreAggregated), plus the prefixes Fields mode writes for its
 * aggregations (min_, max_, distinct_).
 */
export type PivotTotal = "sum" | "min" | "max" | "none";

export function pivotTotalKind(column: string, format?: string): PivotTotal {
  const c = column.toLowerCase();
  if (isPreAggregated(c) || format === "percent") return "none";
  if (/^distinct_|(^|_)distinct($|_)/.test(c)) return "none";
  if (/^min_/.test(c)) return "min";
  if (/^max_/.test(c)) return "max";
  return "sum";
}

type Acc = { v: number; n: number };

function combine(kind: PivotTotal, acc: Acc | undefined, v: number): Acc {
  if (!acc) return { v, n: 1 };
  const n = acc.n + 1;
  if (kind === "min") return { v: Math.min(acc.v, v), n };
  if (kind === "max") return { v: Math.max(acc.v, v), n };
  return { v: acc.v + v, n };
}

/**
 * A cell's value: undefined when no row has one, null when several rows meet
 * there and the measure cannot be combined, else the number.
 */
export type PivotValue = number | null | undefined;

function read(kind: PivotTotal, acc: Acc | undefined): PivotValue {
  if (!acc) return undefined;
  return kind === "none" && acc.n > 1 ? null : acc.v;
}

export type PivotModel = {
  rowKeys: string[];
  colKeys: string[];
  /** The measures drawn: the main one first, then each extra one rows carry. */
  measures: string[];
  /** Second-level values under each row value (hierarchy mode). */
  children: Map<string, string[]>;
  /** Row value × column value (a group's subtotal in hierarchy mode). */
  cell: (r: string, c: string, m: string) => PivotValue;
  leaf: (r: string, sub: string, c: string, m: string) => PivotValue;
  rowTotal: (r: string, m: string) => PivotValue;
  leafTotal: (r: string, sub: string, m: string) => PivotValue;
  colTotal: (c: string, m: string) => PivotValue;
  grand: (m: string) => PivotValue;
  /** Each measure's lowest and highest finest cell, for a colour scale. */
  extent: (m: string) => { min: number; max: number };
};

/** Row values kept, and column values: a pivot is read, not scrolled through. */
export const PIVOT_MAX_ROWS = 200;
export const PIVOT_MAX_COLS = 30;

export function buildPivot(
  rows: Record<string, unknown>[],
  f: {
    rowField: string;
    colField: string;
    valueField: string;
    rowSubField?: string;
    extraMeasures?: unknown;
    /** A measure's number format: a percentage is never totalled. */
    formatOf?: (m: string) => string | undefined;
  },
): PivotModel {
  const sub = f.rowSubField && f.rowSubField !== f.rowField ? f.rowSubField : undefined;
  const measures = [f.valueField];
  for (const m of Array.isArray(f.extraMeasures) ? f.extraMeasures : []) {
    if (typeof m !== "string" || !m || measures.includes(m)) continue;
    if (rows.length > 0 && !rows.some((r) => m in r)) continue;
    measures.push(m);
  }
  const kinds = new Map(measures.map((m) => [m, pivotTotalKind(m, f.formatOf?.(m))]));

  const rowKeys: string[] = [];
  const colKeys: string[] = [];
  const children = new Map<string, string[]>();
  const acc = new Map<string, Acc>();
  const put = (key: string, m: string, v: number) =>
    acc.set(key, combine(kinds.get(m) ?? "sum", acc.get(key), v));

  for (const row of rows) {
    const vals = measures.map((m) => Number(row[m]));
    if (!vals.some((v) => Number.isFinite(v))) continue;
    const r = String(row[f.rowField] ?? "—");
    const c = String(row[f.colField] ?? "—");
    if (!rowKeys.includes(r)) {
      if (rowKeys.length >= PIVOT_MAX_ROWS) continue;
      rowKeys.push(r);
    }
    if (!colKeys.includes(c)) {
      if (colKeys.length >= PIVOT_MAX_COLS) continue;
      colKeys.push(c);
    }
    const sv = sub ? String(row[sub] ?? "—") : "";
    if (sub) {
      const kids = children.get(r) ?? [];
      if (!kids.includes(sv) && kids.length < 100) {
        kids.push(sv);
        children.set(r, kids);
      }
    }
    measures.forEach((m, i) => {
      const v = vals[i];
      if (!Number.isFinite(v)) return;
      put(`c\0${r}\0${c}\0${m}`, m, v);
      put(`r\0${r}\0${m}`, m, v);
      put(`k\0${c}\0${m}`, m, v);
      put(`g\0${m}`, m, v);
      if (sub) {
        put(`l\0${r}\0${sv}\0${c}\0${m}`, m, v);
        put(`t\0${r}\0${sv}\0${m}`, m, v);
      }
    });
  }

  const get = (m: string, key: string) => read(kinds.get(m) ?? "sum", acc.get(key));
  const extents = new Map<string, { min: number; max: number }>();
  for (const m of measures) {
    let min = Infinity;
    let max = -Infinity;
    const prefix = sub ? "l\0" : "c\0";
    for (const [key, a] of acc) {
      if (!key.startsWith(prefix) || !key.endsWith(`\0${m}`)) continue;
      const v = read(kinds.get(m) ?? "sum", a);
      if (typeof v !== "number") continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    extents.set(m, Number.isFinite(min) ? { min, max } : { min: 0, max: 0 });
  }

  return {
    rowKeys,
    colKeys,
    measures,
    children,
    cell: (r, c, m) => get(m, `c\0${r}\0${c}\0${m}`),
    leaf: (r, s, c, m) => get(m, `l\0${r}\0${s}\0${c}\0${m}`),
    rowTotal: (r, m) => get(m, `r\0${r}\0${m}`),
    leafTotal: (r, s, m) => get(m, `t\0${r}\0${s}\0${m}`),
    colTotal: (c, m) => get(m, `k\0${c}\0${m}`),
    grand: (m) => get(m, `g\0${m}`),
    extent: (m) => extents.get(m) ?? { min: 0, max: 0 },
  };
}
