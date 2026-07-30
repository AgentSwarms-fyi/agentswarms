// Aggregation pushdown: compile a chart spec into a GROUP BY query so the
// DATABASE aggregates instead of the browser.
//
// WHY THIS EXISTS. A widget's snapshot is capped (WIDGET_ROW_CAP), and the
// renderer sums duplicate categories client-side (aggregateByField /
// pivotSeries in BiChartRender). Together those mean a chart over a table
// larger than the cap silently shows the sum of an ARBITRARY subset and
// presents it as the total — no error, just a wrong number. Pushing the
// GROUP BY into SQL returns one row per category instead of N raw rows, so the
// totals are complete and the cap stops mattering.
//
// WHY IT IS SAFE TO WRAP. `SUM(x) ... GROUP BY k` over rows whose `k` is
// already unique returns exactly the input, so wrapping SQL that already
// aggregates is a no-op. And because the default aggregate (`sum`) is the same
// one the renderer applies to duplicates, a pushed-down chart agrees with the
// pre-pushdown chart wherever the old one was reading complete data. The
// renderer needs no changes: aggregating already-unique keys is idempotent.
//
// SECURITY. Field names arrive from a stored chart spec, which may have been
// authored by a model. Every dimension and measure must (a) match a strict
// identifier pattern and (b) appear in the base query's result columns —
// otherwise the whole plan is refused (`null`) and the caller falls back to the
// existing un-aggregated path. Nothing is ever interpolated unchecked, and the
// aggregate function comes from a fixed map, never from input.
import type { ChartSpec } from "@/lib/biAgent";
import type { SqlDialect } from "@/lib/semanticLayer";

export type MeasureAgg = "sum" | "avg" | "min" | "max" | "count" | "count_distinct";

export type AggPlan = {
  /** GROUP BY columns, in output order. */
  dims: string[];
  measures: { field: string; agg: MeasureAgg }[];
};

/** SQL template per aggregate. The only place an aggregate name is produced. */
const AGG_SQL: Record<MeasureAgg, (col: string) => string> = {
  sum: (c) => `SUM(${c})`,
  avg: (c) => `AVG(${c})`,
  min: (c) => `MIN(${c})`,
  max: (c) => `MAX(${c})`,
  count: (c) => `COUNT(${c})`,
  count_distinct: (c) => `COUNT(DISTINCT ${c})`,
};

export function isMeasureAgg(v: unknown): v is MeasureAgg {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(AGG_SQL, v);
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const BACKTICK_DIALECTS = new Set<SqlDialect>(["alasql", "bigquery", "mysql", "databricks"]);

/** Quote an identifier that has ALREADY been validated against IDENT_RE. */
function quoteIdent(name: string, dialect: SqlDialect): string {
  return BACKTICK_DIALECTS.has(dialect) ? `\`${name}\`` : `"${name}"`;
}

/**
 * Chart types whose renderer sums duplicate category keys.
 *
 * Deliberately derived from what BiChartRender actually does (the call sites of
 * `aggregateByField` / `pivotSeries`), not from what seems aggregatable. Types
 * that need raw rows — table, scatter, boxplot, wordcloud — or that aggregate
 * inside their own sub-renderer are absent, so they keep today's behaviour
 * untouched.
 *
 * `kpi` and `gauge` are deliberately EXCLUDED even though they look like the
 * obvious case: they read `rows[0]`, so pushing down a SUM would change the
 * number an existing dashboard displays. That is a semantic change, not a
 * truncation fix, and belongs in its own opt-in.
 */
const AGGREGATABLE = new Set([
  "bar",
  "scolumn",
  "hbar",
  "line",
  "area",
  "shbar",
  "radar",
  "pie",
  "funnel",
  "waterfall",
  "treemap",
  "combo",
]);

export function isAggregatableChart(chart: ChartSpec | null | undefined): boolean {
  return !!chart && AGGREGATABLE.has(chart.type);
}

/**
 * Derive the GROUP BY plan for a chart, or null when it must see raw rows.
 *
 * `preserve` lists columns that must survive aggregation because something
 * downstream filters on them client-side — dashboard filter columns, and the
 * drill hierarchy. Dropping one of those would not error: `filterWidgetRows`
 * skips columns it cannot find, so the filter would silently stop narrowing the
 * widget. Keeping them as dimensions is what makes pushdown invisible to the
 * rest of the dashboard.
 */
export function aggregationPlan(
  chart: ChartSpec | null | undefined,
  opts?: { preserve?: string[] },
): AggPlan | null {
  if (!chart || !AGGREGATABLE.has(chart.type)) return null;

  const c = chart as ChartSpec & Record<string, unknown>;
  const agg: MeasureAgg = isMeasureAgg(c.measureAgg) ? c.measureAgg : "sum";

  const dims: string[] = [];
  const measures: { field: string; agg: MeasureAgg }[] = [];
  const addDim = (v: unknown) => {
    if (typeof v === "string" && v && !dims.includes(v)) dims.push(v);
  };

  if (chart.type === "combo") {
    addDim(chart.xField);
    // Two independent measures share one category axis.
    for (const f of [chart.barField, chart.lineField]) {
      if (typeof f === "string" && f && !measures.some((m) => m.field === f)) {
        measures.push({ field: f, agg });
      }
    }
  } else if (chart.type === "pie" || chart.type === "funnel" || chart.type === "treemap") {
    addDim(chart.nameField);
    measures.push({ field: chart.valueField, agg });
  } else {
    // bar / scolumn / hbar / line / area / shbar / radar
    addDim((c as { xField?: string }).xField);
    addDim((c as { seriesField?: string }).seriesField);
    measures.push({ field: (c as { yField: string }).yField, agg });
  }

  // The drill hierarchy swaps which field is the category, so every level has
  // to be in the result or drilling down lands on a missing column.
  for (const f of chart.drillFields ?? []) addDim(f);
  for (const f of opts?.preserve ?? []) addDim(f);

  if (measures.length === 0 || dims.length === 0) return null;
  // A field used as both a dimension and a measure cannot be both grouped and
  // aggregated; refuse rather than emit SQL the database will reject.
  if (measures.some((m) => dims.includes(m.field))) return null;
  return { dims, measures };
}

/**
 * Render the aggregate SELECT list + GROUP BY for a plan, or null if any field
 * fails validation.
 *
 * Measures are aliased back to their ORIGINAL names so the chart spec — which
 * refers to `yField: "revenue"` — keeps working without rewriting the spec.
 */
export function renderAggregateClauses(
  plan: AggPlan,
  columns: string[],
  dialect: SqlDialect,
): { select: string; groupBy: string } | null {
  // Case-insensitive membership: warehouses fold case differently, and the
  // stored spec may not match the result column's casing exactly.
  const byLower = new Map<string, string>();
  for (const c of columns) {
    if (typeof c === "string") byLower.set(c.toLowerCase(), c);
  }
  const resolve = (field: string): string | null => {
    if (!IDENT_RE.test(field)) return null;
    return byLower.get(field.toLowerCase()) ?? null;
  };

  const dimSql: string[] = [];
  for (const d of plan.dims) {
    const actual = resolve(d);
    // Unknown or unsafe column → refuse the whole plan. Emitting a partial
    // GROUP BY would change the grain and quietly alter the numbers.
    if (!actual || !IDENT_RE.test(actual)) return null;
    dimSql.push(quoteIdent(actual, dialect));
  }

  const selectParts = [...dimSql];
  for (const m of plan.measures) {
    const actual = resolve(m.field);
    if (!actual || !IDENT_RE.test(actual)) return null;
    if (!isMeasureAgg(m.agg)) return null;
    const col = quoteIdent(actual, dialect);
    selectParts.push(`${AGG_SQL[m.agg](col)} AS ${quoteIdent(actual, dialect)}`);
  }

  return { select: selectParts.join(", "), groupBy: dimSql.join(", ") };
}
