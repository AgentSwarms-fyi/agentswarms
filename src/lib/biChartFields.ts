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
import { readsAsRatios } from "@/lib/biColumnKinds";
import { dateLikeColumns } from "@/lib/biPeriods";

export { readsAsRatios };

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
  insight: ["valueField"],
  gauge: ["valueField", "targetField"],
  // R500-R502 visuals, which generation can choose since R507.
  pareto: ["valueField"],
  calendar: ["valueField"],
  smallmultiples: ["yField"],
  pictogram: ["valueField"],
  radialbar: ["valueField"],
  range: ["startField", "endField"],
  bump: ["yField"],
  pointmap: ["latField", "lngField", "sizeField"],
  journey: ["valueField"],
};

/**
 * Fields a chart cannot draw without, per type (R507).
 *
 * The check above reads the fields a spec DECLARES, so a spec that left one
 * out entirely passed: `{ type: "pareto" }` reached the renderer with no
 * category and drew an empty frame. A required field that is absent is
 * treated as one that names a missing column: filled when exactly one column
 * can be meant, otherwise the rows are shown and the note says why.
 *
 * "label" is any column that is not a number (dates included), "date" one
 * whose values read as dates, "number" a measure. A KPI's value may be a
 * label: "Best month by revenue" shows the month. A series split is never
 * required: without one the chart draws a single series, as it always has.
 */
export type RequiredFieldKind = "number" | "label" | "date" | "any";

export const REQUIRED_FIELDS: Record<string, Record<string, RequiredFieldKind>> = {
  kpi: { valueField: "any" },
  gauge: { valueField: "number" },
  insight: { valueField: "number" },
  bar: { xField: "label", yField: "number" },
  hbar: { xField: "label", yField: "number" },
  scolumn: { xField: "label", yField: "number" },
  shbar: { xField: "label", yField: "number" },
  line: { xField: "label", yField: "number" },
  area: { xField: "label", yField: "number" },
  combo: { xField: "label", barField: "number", lineField: "number" },
  scatter: { xField: "number", yField: "number" },
  pie: { nameField: "label", valueField: "number" },
  nightingale: { nameField: "label", valueField: "number" },
  radialbar: { nameField: "label", valueField: "number" },
  treemap: { nameField: "label", valueField: "number" },
  pareto: { categoryField: "label", valueField: "number" },
  funnel: { nameField: "label", valueField: "number" },
  waterfall: { xField: "label", yField: "number" },
  heatmap: { xField: "label", yField: "label", valueField: "number" },
  matrix: { rowField: "label", colField: "label", valueField: "number" },
  calendar: { dateField: "date", valueField: "number" },
  smallmultiples: { xField: "label", yField: "number", splitField: "label" },
  pictogram: { categoryField: "label", valueField: "number" },
  range: { categoryField: "label", startField: "number", endField: "number" },
  bump: { xField: "any", yField: "number" },
  barrace: { xField: "label", yField: "number", timeField: "label" },
  sankey: { xField: "label", yField: "label", valueField: "number" },
  radar: { xField: "label", yField: "number" },
  wordcloud: { textField: "label" },
  boxplot: { xField: "label", yField: "number" },
  map: { locationField: "label", valueField: "number" },
  bubblemap: { locationField: "label", valueField: "number" },
  pointmap: { latField: "number", lngField: "number" },
  journey: { categoryField: "label", valueField: "number" },
};

/** Fields a chart still draws without: decorations, not the drawing itself. */
// dateField and categoryField (R498) decorate a KPI and drive a narrative; a
// narrative missing one says which in its own body, which beats a table. A
// colour column (R500, a treemap's tiles since R505) only colours: without it
// the palette does, so it is dropped rather than re-pointed or turned into a
// table.
const ALWAYS_OPTIONAL = new Set([
  "seriesField",
  "sizeField",
  "targetField",
  "rowSubField",
  "dateField",
  "categoryField",
  "colorField",
]);

/** Keys that belong to every spec and survive a fall back to a table. */
const SHARED_KEYS = ["format", "percentOf", "currency", "decimals", "columnFormats"] as const;

// A field the type REQUIRES is never optional: a calendar without its date,
// or a pareto without its category, has nothing to draw.
const isOptional = (type: string, key: string) =>
  !(REQUIRED_FIELDS[type] && key in REQUIRED_FIELDS[type]) &&
  (ALWAYS_OPTIONAL.has(key) || (type === "wordcloud" && key === "valueField"));

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

/**
 * The chart with its percent formats' scale read from the rows (R512): the
 * chart's own, from the columns its measure fields name, and each column
 * format's, from its column. A scale the spec states is kept. A gauge or KPI
 * whose target is a percentage (15) is not ratios, and its own reading
 * (gaugeReading) puts the two on one scale.
 */
export function resolvePercentOf(chart: ChartSpec, rows: Record<string, unknown>[]): ChartSpec {
  let next = chart;
  const spec = chart as unknown as Record<string, unknown>;
  if (chart.format === "percent" && !chart.percentOf) {
    const columns = [
      ...(MEASURE_FIELDS[chart.type] ?? []).map((k) => spec[k]),
      ...(Array.isArray(spec.extraMeasures) ? (spec.extraMeasures as unknown[]) : []),
    ].filter((c): c is string => typeof c === "string" && c !== "");
    if (columns.length && readsAsRatios(rows, columns)) next = { ...next, percentOf: "ratio" };
  }
  const formats = chart.columnFormats;
  if (formats) {
    let changed = false;
    const out = { ...formats };
    for (const [column, f] of Object.entries(formats)) {
      if (f?.format === "percent" && !f.percentOf && readsAsRatios(rows, [column])) {
        out[column] = { ...f, percentOf: "ratio" };
        changed = true;
      }
    }
    if (changed) next = { ...next, columnFormats: out };
  }
  return next;
}

/**
 * The spec without the list-named measures its result cannot draw, or null
 * when every one is there. A measure already drawn by a field is dropped from
 * the list too: the same column twice is one series drawn twice.
 */
function trimDecorations(
  chart: ChartSpec,
  have: Set<string>,
  numeric: Set<string>,
  declared: { key: string; column: string }[],
): ChartSpec | null {
  const src = chart as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...src };
  let changed = false;
  const drawn = new Set(declared.map((d) => d.column));
  if (Array.isArray(src.extraMeasures)) {
    const keep = (src.extraMeasures as unknown[]).filter(
      (m): m is string => typeof m === "string" && have.has(m) && numeric.has(m) && !drawn.has(m),
    );
    const unique = [...new Set(keep)];
    if (unique.length !== (src.extraMeasures as unknown[]).length) changed = true;
    if (unique.length) next.extraMeasures = unique;
    else delete next.extraMeasures;
  }
  if (Array.isArray(src.extraLines)) {
    const extras = new Set((next.extraMeasures as string[] | undefined) ?? []);
    const keep = (src.extraLines as unknown[]).filter(
      (m): m is string => typeof m === "string" && extras.has(m),
    );
    if (keep.length !== (src.extraLines as unknown[]).length) changed = true;
    if (keep.length) next.extraLines = keep;
    else delete next.extraLines;
  }
  if (typeof src.colorMeasure === "string") {
    const ok = have.has(src.colorMeasure) && numeric.has(src.colorMeasure);
    if (!ok) {
      delete next.colorMeasure;
      delete next.scale;
      changed = true;
    }
  }
  if (Array.isArray(src.iconFields)) {
    const keep = (src.iconFields as unknown[]).filter(
      (m): m is string => typeof m === "string" && have.has(m),
    );
    if (keep.length !== (src.iconFields as unknown[]).length) changed = true;
    if (keep.length) next.iconFields = keep;
    else delete next.iconFields;
  }
  return changed ? (next as ChartSpec) : null;
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
 * A chart of one category and one measure named the wrong way round: numbers
 * as the category and labels as the measure (R511). Asked for "the top 10
 * customers as horizontal bars", a model put the sales on the bar axis and
 * the names in the value, reading "horizontal" as "the value runs across";
 * the chart labelled its rows 43893.0424 and drew no bars. A measure that is
 * not a number cannot be drawn, so the only reading is the swap.
 */
function swapCategoryAndMeasure(
  chart: ChartSpec,
  have: Set<string>,
  numeric: Set<string>,
): ChartSpec | null {
  const req = REQUIRED_FIELDS[chart.type];
  if (!req) return null;
  const keys = Object.keys(req);
  if (keys.length !== 2) return null;
  const labelKey = keys.find((k) => req[k] === "label");
  const numberKey = keys.find((k) => req[k] === "number");
  if (!labelKey || !numberKey) return null;
  const spec = chart as unknown as Record<string, unknown>;
  const category = spec[labelKey];
  const measure = spec[numberKey];
  if (typeof category !== "string" || typeof measure !== "string") return null;
  if (!have.has(category) || !have.has(measure)) return null;
  if (!numeric.has(category) || numeric.has(measure)) return null;
  return { ...spec, [labelKey]: measure, [numberKey]: category } as unknown as ChartSpec;
}

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
  const given = args.chart;
  if (!given) return { verdict: "ok" };
  const have = new Set(args.columns);
  const numeric = numericColumns(args.columns, args.rows);
  const swapped = swapCategoryAndMeasure(given, have, numeric);
  const chart = swapped ?? given;
  const declared = declaredFields(chart);
  // Measures named in lists rather than fields (R507): more measures, the
  // ones of them drawn as lines, a treemap's colour. They decorate (the chart
  // draws without them), so one the result lacks is dropped, not repaired.
  const decorated = trimDecorations(chart, have, numeric, declared);
  const required = REQUIRED_FIELDS[chart.type] ?? {};
  const absent = Object.keys(required)
    .filter((k) => !declared.some((d) => d.key === k))
    .map((k) => ({ key: k, column: "" }));
  const missing = [...declared.filter((d) => !have.has(d.column)), ...absent];
  if (!missing.length) {
    if (decorated) return { verdict: "repaired", chart: decorated };
    return swapped ? { verdict: "repaired", chart: swapped } : { verdict: "ok" };
  }

  const measures = new Set(MEASURE_FIELDS[chart.type] ?? []);
  const dates = dateLikeColumns(args.columns, args.rows);
  // Columns the spec is already drawing. A repair may not use one: re-pointing
  // a field at a column another field already owns draws the same series twice
  // and calls it a comparison. This grows as repairs are made, which is why the
  // loop below re-reads it rather than working from a list computed up here.
  const taken = new Set(declared.filter((d) => have.has(d.column)).map((d) => d.column));

  const next: Record<string, unknown> = {
    ...((decorated ?? chart) as unknown as Record<string, unknown>),
  };
  const repairs: string[] = [];
  const unfixable: string[] = [];

  for (const m of missing) {
    if (isOptional(chart.type, m.key)) {
      // A series split that is not in the result is not a chart that cannot
      // draw; it is a chart with one series. Drop it and say nothing.
      delete next[m.key];
      continue;
    }
    const kind: RequiredFieldKind = required[m.key] ?? (measures.has(m.key) ? "number" : "label");
    const wantsNumber = kind === "number" || measures.has(m.key);
    const candidates = args.columns.filter(
      (c) =>
        !taken.has(c) &&
        (kind === "any"
          ? true
          : kind === "date"
            ? dates.includes(c)
            : wantsNumber
              ? numeric.has(c)
              : !numeric.has(c)),
    );
    if (candidates.length === 1) {
      next[m.key] = candidates[0];
      taken.add(candidates[0]);
      // A field the model left out is filled without a note: nothing it
      // named was renamed, so there is nothing for a reader to reconcile.
      if (m.column) repairs.push(`${m.column} → ${candidates[0]}`);
      continue;
    }
    // Two candidates is a guess, and a guess drawn as a chart is indefensible.
    unfixable.push(m.column || `${m.key.replace(/Field$/, "")} (not chosen)`);
  }

  if (unfixable.length) {
    const table: Record<string, unknown> = { type: "table" };
    for (const k of SHARED_KEYS) {
      const v = (chart as unknown as Record<string, unknown>)[k];
      if (v !== undefined) table[k] = v;
    }
    // Plain text: this lands in a widget TITLE, where markdown is not rendered.
    const named = unfixable.filter((u) => !u.endsWith("(not chosen)"));
    const unnamed = unfixable
      .filter((u) => u.endsWith("(not chosen)"))
      .map((u) => u.replace(/ \(not chosen\)$/, ""));
    const plural = named.length === 1 ? "column" : "columns";
    const note = named.length
      ? `This query returns no ${named.join(", ")} ${plural}, so the rows are shown instead.`
      : `The chart did not say which column is its ${unnamed.join(" or ")}, so the rows are shown instead.`;
    return {
      verdict: "unplottable",
      chart: table as ChartSpec,
      missing: unfixable,
      note,
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
