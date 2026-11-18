// A generated widget whose query hit the snapshot cap, aggregated in SQL at
// once (R507).
//
// Found by generating a dashboard in the browser. The model's SQL for "Monthly
// sales for each region" and "Daily sales" returned one row per order, 9,994
// of them; the widget kept the first 500, so the small multiples drew sixteen
// months of three regions and the calendar 67 days, each under a Partial
// badge. Generated widgets start with "Aggregate in SQL" on whenever the chart
// can take it, but that only applies at the next refresh, so the dashboard a
// person first sees was the prefix.
//
// So the generator does what that refresh would: the same plan
// (aggregationPlan), wrapped by the same validated builder
// (buildDirectQuerySql), run on the same source. A plan the builder will not
// render, a failed query or an empty answer leaves the widget as it was —
// still marked Partial, which is true.
import { aggregationPlan, renderAggregateClauses } from "@/lib/biAggregate";
import { buildDirectQuerySql } from "@/lib/biDirectQuery";
import type { BiWidget } from "@/lib/biDashboards";
import type { SqlDialect } from "@/lib/semanticLayer";

export async function aggregateCappedWidget(args: {
  widget: BiWidget;
  dialect: SqlDialect;
  /** The snapshot cap the widget was cut at. */
  cap: number;
  run: (sql: string) => Promise<{
    columns: string[];
    rows: Record<string, unknown>[];
    capped?: boolean;
  }>;
}): Promise<boolean> {
  const w = args.widget;
  if (!w.truncated || !w.agg_pushdown || !w.sql || !w.chart) return false;
  const columns = w.columns ?? [];
  const plan = aggregationPlan(w.chart);
  if (!plan || !renderAggregateClauses(plan, columns, args.dialect)) return false;
  const sql = buildDirectQuerySql({
    baseSql: w.sql,
    columns,
    agg: plan,
    dialect: args.dialect,
    rowCap: args.cap + 1,
  });
  try {
    const res = await args.run(sql);
    if (!Array.isArray(res.rows) || res.rows.length === 0) return false;
    w.columns = res.columns;
    w.rows = res.rows.slice(0, args.cap);
    w.truncated = Boolean(res.capped) || res.rows.length > args.cap;
    return true;
  } catch {
    return false;
  }
}
