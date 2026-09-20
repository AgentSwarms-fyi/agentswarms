// A chart names the columns it draws, and those names get checked too.
//
// Found by driving a generation and looking at what it produced. The model
// returned, for the title "Top 5 Months by Revenue":
//
//   sql:   SELECT month FROM analytics.bi_demo_sales
//          WHERE revenue IS NOT NULL ORDER BY revenue DESC NULLS LAST LIMIT 5
//   chart: { type: "bar", xField: "month", yField: "revenue" }
//
// The query orders BY revenue and never selects it. So the chart had five
// x-axis labels, no y-axis, no bars, and no explanation — a widget that looks
// like it is still loading and never will be.
//
// This is invisible to the title check next door, which compares a title
// against a ROW COUNT: five rows under a title promising five agree perfectly.
// Only something that reads the chart's FIELDS against the query's COLUMNS can
// see it.
//
// Deterministic, and no model call. Two repairs, in order of confidence:
// drop a decoration that is not there, re-point a field when exactly one
// column can possibly be meant, and otherwise say plainly that the measure is
// missing and show the rows instead of an empty frame.
import type { ChartSpec } from "@/lib/biAgent";

/**
 * Which declared fields have to name a NUMBER, per chart type.
 *
 * This cannot be a single set of field names. `yField` is the measure on a
 * bar chart and a node LABEL on a sankey; a heatmap's axes are both
 * categorical and its measure is `valueField`; a scatter's x is a measure too.
 * Getting this wrong would move a repair onto the wrong column, which is worse
 * than the blank chart it set out to fix.
 */
const MEASURE_FIELDS: Record<string, readonly string[]> = {
  bar: ["yField"],
  hbar: ["yField"],
  line: ["yField"],
  area: ["yField"],
  scolumn: ["yField"],
  shbar: ["yField"],
  barrace: ["yField"],
  radar: ["yField"],
  waterfall: ["yField"],
  boxplot: ["yField"],
  scatter: ["xField", "yField", "sizeField"],
  combo: ["barField", "lineField"],
  pie: ["valueField"],
  nightingale: ["valueField"],
  funnel: ["valueField"],
  treemap: ["valueField"],
  heatmap: ["valueField"],
  sankey: ["valueField"],
  matrix: ["valueField"],
  map: ["valueField"],
  bubblemap: ["valueField"],
  wordcloud: ["valueField"],
  kpi: ["valueField", "targetField"],
  gauge: ["valueField", "targetField"],
};

/** Fields a chart still draws without: decorations, not the drawing itself. */
const ALWAYS_OPTIONAL = new Set(["seriesField", "sizeField", "targetField", "rowSubField"]);

/** Keys that belong to every spec and survive a fall back to a table. */
const SHARED_KEYS = ["format", "currency", "decimals", "columnFormats"] as const;

const isOptional = (type: string, key: string) =>
  ALWAYS_OPTIONAL.has(key) || (type === "wordcloud" && key === "valueField");

/** Every `*Field` on a spec that actually names something. */
function declaredFields(chart: ChartSpec): { key: string; column: string }[] {
  return Object.entries(chart as unknown as Record<string, unknown>)
    .filter(([k, v]) => k.endsWith("Field") && typeof v === "string" && v.trim() !== "")
    .map(([k, v]) => ({ key: k, column: (v as string).trim() }));
}

/**
 * Columns whose values are numbers, judged from the rows themselves.
 *
 * A column counts as numeric when every value that is present is a finite
 * number and at least one is — the same test `singleValueKpi` applies, so the
 * two halves of the product agree about what a measure is. A column of nulls
 * is not a measure: there is nothing in it to plot.
 */
export function numericColumns(columns: string[], rows: Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const c of columns) {
    let numbers = 0;
    let onlyNumbers = true;
    for (const r of rows) {
      const v = r[c];
      if (v === null || v === undefined || v === "") continue;
      if (typeof v === "number" && Number.isFinite(v)) numbers++;
      else {
        onlyNumbers = false;
        break;
      }
    }
    if (onlyNumbers && numbers > 0) out.add(c);
  }
  return out;
}

export type ChartFieldVerdict =
  /** Every field the chart names is a column the query returned. */
  | { verdict: "ok" }
  /**
   * Repaired without asking anything: an absent decoration dropped, or a
   * field re-pointed at the ONE column it could have meant.
   */
  | { verdict: "repaired"; chart: ChartSpec; note?: string }
  /**
   * The measure is not in the result and no column can stand in for it. The
   * rows are shown as a table, because five months a reader can see beats an
   * empty frame, and the note says what is missing.
   */
  | { verdict: "unplottable"; chart: ChartSpec; note: string; missing: string[] };

/**
 * Check a chart's declared fields against the columns its query returned.
 *
 * `rows` is used only to tell numbers from labels; no value is read into the
 * chart. A spec that names nothing (a table) is always fine.
 */
export function reconcileChartFields(args: {
  chart: ChartSpec | undefined;
  columns: string[];
  rows: Record<string, unknown>[];
}): ChartFieldVerdict {
  const chart = args.chart;
  if (!chart) return { verdict: "ok" };
  const declared = declaredFields(chart);
  if (!declared.length) return { verdict: "ok" };

  const have = new Set(args.columns);
  const missing = declared.filter((d) => !have.has(d.column));
  if (!missing.length) return { verdict: "ok" };

  const measures = new Set(MEASURE_FIELDS[chart.type] ?? []);
  const numeric = numericColumns(args.columns, args.rows);
  // Columns the spec is already drawing. A repair may not use one: re-pointing
  // a field at a column another field already owns draws the same series twice
  // and calls it a comparison. This grows as repairs are made, which is why the
  // loop below re-reads it rather than working from a list computed up here.
  const taken = new Set(declared.filter((d) => have.has(d.column)).map((d) => d.column));

  const next: Record<string, unknown> = { ...(chart as unknown as Record<string, unknown>) };
  const repairs: string[] = [];
  const unfixable: string[] = [];

  for (const m of missing) {
    if (isOptional(chart.type, m.key)) {
      // A series split that is not in the result is not a chart that cannot
      // draw; it is a chart with one series. Drop it and say nothing.
      delete next[m.key];
      continue;
    }
    const wantsNumber = measures.has(m.key);
    const candidates = args.columns.filter(
      (c) => !taken.has(c) && (wantsNumber ? numeric.has(c) : !numeric.has(c)),
    );
    if (candidates.length === 1) {
      next[m.key] = candidates[0];
      taken.add(candidates[0]);
      repairs.push(`${m.column} → ${candidates[0]}`);
      continue;
    }
    // Two candidates is a guess, and a guess drawn as a chart is indefensible.
    unfixable.push(m.column);
  }

  if (unfixable.length) {
    const table: Record<string, unknown> = { type: "table" };
    for (const k of SHARED_KEYS) {
      const v = (chart as unknown as Record<string, unknown>)[k];
      if (v !== undefined) table[k] = v;
    }
    // Plain text: this lands in a widget TITLE, where markdown is not rendered.
    const names = unfixable.join(", ");
    const plural = unfixable.length === 1 ? "column" : "columns";
    return {
      verdict: "unplottable",
      chart: table as ChartSpec,
      missing: unfixable,
      note: `This query returns no ${names} ${plural}, so the rows are shown instead.`,
    };
  }

  return {
    verdict: "repaired",
    chart: next as ChartSpec,
    note: repairs.length
      ? `Charted ${repairs.join(", ")}; the query named it differently.`
      : undefined,
  };
}

/**
 * How many rows a single-value chart is drawing one of, or null when it is
 * showing everything there is.
 *
 * A KPI renders `rows[0][valueField]` and nothing else. When the query returned
 * one row that is the whole truth; when it returned three, the card shows a
 * third of a breakdown in the type size reserved for a headline. Live examples,
 * off a generated dashboard: "Revenue by Region" displaying AMER's 25,874.92
 * of a 51,749.84 total, and "Units Sold by Plan" displaying `free` of three
 * plans. Neither said so.
 *
 * Restricted to a NUMERIC first value on purpose. "Best Month by Revenue" is a
 * KPI over 36 ordered rows whose `valueField` is `month` — row zero IS the
 * answer there, and a caveat on it would be noise that teaches readers to
 * ignore the caveats that matter. A measure is the case where row zero is one
 * slice presented as the total.
 *
 * Computed where the number is drawn rather than stored with the widget: a
 * count of rows that a refresh can replace is exactly the sentence that goes
 * stale, and this one cannot, because nothing keeps it.
 */
export function unshownRows(
  rows: Record<string, unknown>[] | undefined,
  valueField: string | undefined,
): number | null {
  if (!valueField || !Array.isArray(rows) || rows.length < 2) return null;
  const v = rows[0]?.[valueField];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return rows.length;
}
