// Building a visual from FIELDS instead of SQL (R499).
//
// A BI author thinks "Sales by Region": a measure, an aggregation, a
// category. The builder used to start from `SELECT * FROM t LIMIT 50` and
// leave the GROUP BY to the author — and a chart drawn from that preview
// summed fifty arbitrary rows and presented them as the total. Every BI tool
// people compare us with builds the query from the fields put into a visual's
// slots; this module is that query builder.
//
// It is pure: fields and choices in, SQL and the names of its output columns
// out. The builder runs the SQL through the same read-only path as SQL the
// author types, so nothing here widens what a query may do — it only writes
// the query an author would otherwise have had to write by hand.
//
// SAFETY. Every column comes from the table's own schema (a name the query is
// not told about is refused), every identifier is quoted with its quote
// character doubled, every literal is escaped, and aggregates come from a
// fixed map. A calculated field is an expression the author typed, exactly as
// trusted as the SQL editor beside it, and the whole statement still passes
// the read-only guard before it runs.
import type { MeasureAgg } from "@/lib/biAggregate";
import type { DateGrain } from "@/lib/biChartMath";
import { sqlStringLiteral, truncateExpr, type SqlDialect } from "@/lib/semanticLayer";

export type FieldKind = "number" | "text" | "date";

export type FieldInfo = {
  name: string;
  kind: FieldKind;
  /** How text dates are written, when they are text: 2026-07-04, 7/4/2026 or 4/7/2026. */
  dateFormat?: "iso" | "mdy" | "dmy";
  /** A calculated field: its expression, and whether it aggregates by itself. */
  calc?: { expr: string; aggregated: boolean };
};

/** The pseudo-field "Number of rows" — COUNT(*). */
export const ROWS_FIELD = "__rows";

export type FieldItem = {
  field: string;
  /** Values: how rows are combined. Ignored for an aggregated calculated field. */
  agg?: MeasureAgg;
  /** Group by: the period a date is bucketed into (unset = the value as it is). */
  grain?: DateGrain;
};

export type FilterOp =
  | "in"
  | "not_in"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "not_empty";

export type FieldFilter = { field: string; op: FilterOp; values: string[] };

export type CalcField = { name: string; expr: string; aggregated: boolean; kind?: FieldKind };

export type FieldSort = "value_desc" | "value_asc" | "label_asc" | "label_desc";

export type FieldQuery = {
  table: string;
  dims: FieldItem[];
  measures: FieldItem[];
  filters: FieldFilter[];
  sort?: FieldSort;
  /** Top N groups (after sorting). Unset = up to MAX_GROUPS. */
  limit?: number;
  calcs?: CalcField[];
};

export const MAX_GROUPS = 1000;

export const EMPTY_FIELD_QUERY: FieldQuery = { table: "", dims: [], measures: [], filters: [] };

export const AGG_LABEL: Record<MeasureAgg, string> = {
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  count: "Count",
  count_distinct: "Count distinct",
};

export const GRAIN_LABEL: Record<DateGrain, string> = {
  year: "Year",
  quarter: "Quarter",
  month: "Month",
  week: "Week",
  day: "Day",
};

/** Aggregations a field of this kind can take; text and dates only count. */
export function aggsFor(kind: FieldKind): MeasureAgg[] {
  return kind === "number"
    ? ["sum", "avg", "min", "max", "count", "count_distinct"]
    : ["count", "count_distinct"];
}

/** The aggregation a field gets when it is put into Values. */
export function defaultAgg(kind: FieldKind): MeasureAgg {
  return kind === "number" ? "sum" : "count_distinct";
}

// ── What kind of field is this ───────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** How a column's text dates are written, from a sample; null when they are not dates. */
export function detectDateFormat(values: unknown[]): FieldInfo["dateFormat"] | null {
  const seen = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (seen.length === 0) return null;
  let iso = 0;
  let slash = 0;
  let firstOver12 = false;
  let secondOver12 = false;
  for (const v of seen) {
    if (v instanceof Date) {
      iso++;
      continue;
    }
    const s = String(v).trim();
    if (ISO_DATE.test(s)) iso++;
    else {
      const m = SLASH_DATE.exec(s);
      if (!m) continue;
      slash++;
      if (Number(m[1]) > 12) firstOver12 = true;
      if (Number(m[2]) > 12) secondOver12 = true;
    }
  }
  const n = seen.length;
  if (iso / n >= 0.8) return "iso";
  if (slash / n >= 0.8) {
    // 13/4/2026 settles day-first; 4/13/2026 month-first; all-ambiguous data
    // is read month-first, the more common export format.
    if (firstOver12 && !secondOver12) return "dmy";
    return "mdy";
  }
  return null;
}

function kindFromDeclared(t: string | undefined): FieldKind | null {
  if (!t) return null;
  const s = t.toLowerCase();
  if (/date|time/.test(s)) return "date";
  if (
    /^(number|int|bigint|smallint|tinyint|integer|hugeint|ubigint|numeric|decimal|double|float|real|money)/.test(
      s,
    )
  )
    return "number";
  if (/int|num|dec|float|double|real/.test(s)) return "number";
  return null;
}

/**
 * The fields of a table: its columns with a kind each, read from the
 * declared type where there is one and confirmed against sample rows — a
 * VARCHAR of "11/9/2024" is a date, a number column is a number.
 */
/** A number that labels rather than counts — "Customer ID", order_id, zipCode. */
function isIdName(name: string): boolean {
  return (
    /(^|[\s_.-])(id|code|zip|zipcode|postcode|key|number|no)$/i.test(name) ||
    /[a-z](Id|ID|Code|Key|Zip)$/.test(name)
  );
}

export function inferFields(
  columns: string[],
  sample: Record<string, unknown>[],
  declared: Record<string, string | undefined> = {},
): FieldInfo[] {
  return columns.map((name) => {
    const values = sample.map((r) => r?.[name]);
    const fmt = detectDateFormat(values);
    const decl = kindFromDeclared(declared[name]);
    const present = values.filter((v) => v !== null && v !== undefined && v !== "");
    const numeric =
      present.length > 0 &&
      present.every(
        (v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())),
      );
    let kind: FieldKind;
    if (decl === "date" || fmt) kind = "date";
    // An id labels rows however it is stored: "Row ID" declared as a number
    // would otherwise be offered as something to add up.
    else if ((decl === "number" || numeric) && !isIdName(name)) kind = "number";
    else kind = "text";
    return kind === "date" ? { name, kind, dateFormat: fmt ?? "iso" } : { name, kind };
  });
}

// ── Naming the output columns ────────────────────────────────────────────────

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return !out ? "field" : /^\d/.test(out) ? `f_${out}` : out;
}

const AGG_PREFIX: Record<MeasureAgg, string> = {
  sum: "",
  avg: "avg_",
  min: "min_",
  max: "max_",
  count: "count_",
  count_distinct: "distinct_",
};

/** The display name of an item: "Sales (Sum)", "Order Date (Month)". */
export function itemLabel(item: FieldItem, role: "dim" | "measure", fields: FieldInfo[]): string {
  if (item.field === ROWS_FIELD) return "Number of rows";
  const f = fields.find((x) => x.name === item.field);
  if (role === "dim") return item.grain ? `${item.field} (${GRAIN_LABEL[item.grain]})` : item.field;
  if (f?.calc?.aggregated) return item.field;
  return `${item.field} (${AGG_LABEL[item.agg ?? defaultAgg(f?.kind ?? "number")]})`;
}

function aliasFor(item: FieldItem, role: "dim" | "measure", fields: FieldInfo[]): string {
  if (item.field === ROWS_FIELD) return "rows";
  const base = slug(item.field);
  if (role === "dim") return item.grain ? `${base}_${item.grain}` : base;
  const f = fields.find((x) => x.name === item.field);
  if (f?.calc?.aggregated) return base;
  return `${AGG_PREFIX[item.agg ?? defaultAgg(f?.kind ?? "number")]}${base}`;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const BACKTICK = new Set<SqlDialect>(["alasql", "bigquery", "mysql", "databricks"]);

export function quoteIdent(name: string, dialect: SqlDialect): string {
  return BACKTICK.has(dialect)
    ? `\`${name.replace(/`/g, "``")}\``
    : `"${name.replace(/"/g, '""')}"`;
}

/** "sales" or "analytics.sales" → each part quoted. */
export function tableRef(table: string, dialect: SqlDialect): string {
  const parts = table.split(".");
  if (parts.some((p) => !p.trim())) throw new Error(`Not a table name: ${table}`);
  return parts.map((p) => quoteIdent(p, dialect)).join(".");
}

/**
 * A quoted string — the semantic layer's, so the two builders cannot escape
 * differently: `\'` on Spark and BigQuery, doubled backslashes wherever a
 * backslash escapes (MySQL, Snowflake, Redshift, AlaSQL), `''` elsewhere.
 */
export const stringLiteral = sqlStringLiteral;

/** A value as text, in the dialect's own type name. */
function asText(col: string, dialect: SqlDialect): string {
  const t = dialect === "mysql" ? "CHAR" : BACKTICK.has(dialect) ? "STRING" : "VARCHAR";
  return `CAST(${col} AS ${t})`;
}

const DUCK = new Set<SqlDialect>(["duckdb", "lakehouse"]);

/** A date column as a timestamp the engine can bucket. */
function dateValue(col: string, f: FieldInfo, dialect: SqlDialect): string {
  if (!DUCK.has(dialect)) return col;
  if (f.dateFormat === "mdy") return `TRY_STRPTIME(CAST(${col} AS VARCHAR), '%m/%d/%Y')`;
  if (f.dateFormat === "dmy") return `TRY_STRPTIME(CAST(${col} AS VARCHAR), '%d/%m/%Y')`;
  return `TRY_CAST(${col} AS TIMESTAMP)`;
}

/**
 * A date bucketed to a grain. On the local engine the label is the text our
 * period code reads back ("2026-07", "2026-Q3", "2026-W27"), so a KPI or a
 * narrative over it compares the right periods; elsewhere it is the engine's
 * own truncated date.
 */
function grainExpr(col: string, f: FieldInfo, grain: DateGrain, dialect: SqlDialect): string {
  if (DUCK.has(dialect)) {
    const d = dateValue(col, f, dialect);
    switch (grain) {
      case "year":
        return `STRFTIME(${d}, '%Y')`;
      case "quarter":
        return `STRFTIME(${d}, '%Y') || '-Q' || CAST(QUARTER(${d}) AS VARCHAR)`;
      case "month":
        return `STRFTIME(${d}, '%Y-%m')`;
      case "week":
        return `STRFTIME(${d}, '%G-W%V')`;
      case "day":
        return `STRFTIME(${d}, '%Y-%m-%d')`;
    }
  }
  return truncateExpr(col, grain, dialect);
}

export type FieldSql = {
  sql: string;
  /** Output column names, in order: the groups, then the values. */
  dims: string[];
  measures: string[];
  /** Output column → its display name ("Sales (Sum)"). */
  labels: Record<string, string>;
};

/**
 * The SELECT for a field query, or an Error saying what is missing or wrong.
 */
export function buildFieldSql(q: FieldQuery, fields: FieldInfo[], dialect: SqlDialect): FieldSql {
  if (!q.table) throw new Error("Pick a table.");
  if (q.dims.length === 0 && q.measures.length === 0) {
    throw new Error("Add a field to Group by or Values.");
  }
  const byName = new Map(fields.map((f) => [f.name, f]));
  const fieldOf = (name: string): FieldInfo => {
    const f = byName.get(name);
    if (!f) throw new Error(`This table has no field called ${name}.`);
    return f;
  };
  const colOf = (f: FieldInfo) => (f.calc ? `(${f.calc.expr})` : quoteIdent(f.name, dialect));

  const used = new Set<string>();
  const unique = (a: string) => {
    let out = a;
    for (let i = 2; used.has(out); i++) out = `${a}_${i}`;
    used.add(out);
    return out;
  };

  const select: string[] = [];
  const groupBy: string[] = [];
  const dims: string[] = [];
  const measures: string[] = [];
  const labels: Record<string, string> = {};
  let dateDim: string | null = null;

  for (const item of q.dims) {
    const f = fieldOf(item.field);
    if (f.calc?.aggregated)
      throw new Error(`${f.name} aggregates by itself, so it can only be a value.`);
    const col = colOf(f);
    const grain = f.kind === "date" ? item.grain : undefined;
    const expr = grain ? grainExpr(col, f, grain, dialect) : col;
    const alias = unique(aliasFor({ ...item, grain }, "dim", fields));
    select.push(`${expr} AS ${quoteIdent(alias, dialect)}`);
    groupBy.push(expr);
    dims.push(alias);
    labels[alias] = itemLabel({ ...item, grain }, "dim", fields);
    if (grain && !dateDim) dateDim = alias;
  }

  for (const item of q.measures) {
    let expr: string;
    if (item.field === ROWS_FIELD) expr = "COUNT(*)";
    else {
      const f = fieldOf(item.field);
      if (f.calc?.aggregated) expr = `(${f.calc.expr})`;
      else {
        const agg = item.agg ?? defaultAgg(f.kind);
        if (f.kind !== "number" && agg !== "count" && agg !== "count_distinct") {
          throw new Error(`${f.name} is not a number — count it instead.`);
        }
        const col = colOf(f);
        expr =
          agg === "count_distinct"
            ? `COUNT(DISTINCT ${col})`
            : `${agg === "avg" ? "AVG" : agg.toUpperCase()}(${col})`;
      }
    }
    const alias = unique(aliasFor(item, "measure", fields));
    select.push(`${expr} AS ${quoteIdent(alias, dialect)}`);
    measures.push(alias);
    labels[alias] = itemLabel(item, "measure", fields);
  }

  const where: string[] = [];
  for (const flt of q.filters ?? []) {
    const f = fieldOf(flt.field);
    if (f.calc?.aggregated) throw new Error(`${f.name} aggregates, so it cannot filter rows.`);
    const col = f.kind === "date" ? dateValue(colOf(f), f, dialect) : colOf(f);
    const lit = (v: string) => {
      if (f.kind === "number") {
        const n = Number(v);
        if (!Number.isFinite(n) || v.trim() === "")
          throw new Error(`${f.name} needs a number, not "${v}".`);
        return String(n);
      }
      if (f.kind === "date" && DUCK.has(dialect)) {
        // A date typed the way the column writes it (1/31/2025) is read in
        // that format; anything else must be ISO, never guessed.
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) && f.dateFormat !== "iso") {
          const fmt = f.dateFormat === "dmy" ? "%d/%m/%Y" : "%m/%d/%Y";
          return `STRPTIME(${stringLiteral(v, dialect)}, '${fmt}')`;
        }
        if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v))
          throw new Error(`${f.name} needs a date like 2025-01-31, not "${v}".`);
        return `CAST(${stringLiteral(v, dialect)} AS TIMESTAMP)`;
      }
      return stringLiteral(v, dialect);
    };
    const vals = flt.values.map((v) => v.trim()).filter((v) => v.length > 0);
    switch (flt.op) {
      case "not_empty":
        // An empty string is not NULL on DuckDB and most warehouses.
        where.push(
          f.kind === "text"
            ? `${col} IS NOT NULL AND ${asText(col, dialect)} <> ''`
            : `${col} IS NOT NULL`,
        );
        break;
      case "in":
      case "not_in":
        if (vals.length === 0) break;
        where.push(`${col} ${flt.op === "in" ? "IN" : "NOT IN"} (${vals.map(lit).join(", ")})`);
        break;
      case "between":
        if (vals.length < 2) throw new Error(`${f.name}: "between" needs two values.`);
        where.push(`${col} BETWEEN ${lit(vals[0])} AND ${lit(vals[1])}`);
        break;
      case "contains":
        if (vals.length === 0) break;
        where.push(
          `LOWER(${asText(col, dialect)}) LIKE ${stringLiteral(
            `%${vals[0].toLowerCase()}%`,
            dialect,
          )}`,
        );
        break;
      default: {
        if (vals.length === 0) break;
        const op = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[flt.op];
        where.push(`${col} ${op} ${lit(vals[0])}`);
      }
    }
  }

  let order = "";
  if (dims.length > 0) {
    const firstMeasure = measures[0];
    if (dateDim && (!q.sort || q.sort.startsWith("label"))) {
      order = `${quoteIdent(dateDim, dialect)} ${q.sort === "label_desc" ? "DESC" : "ASC"}`;
    } else if (q.sort === "label_asc" || q.sort === "label_desc") {
      order = `${quoteIdent(dims[0], dialect)} ${q.sort === "label_desc" ? "DESC" : "ASC"}`;
    } else if (firstMeasure) {
      order = `${quoteIdent(firstMeasure, dialect)} ${q.sort === "value_asc" ? "ASC" : "DESC"}`;
    } else {
      order = `${quoteIdent(dims[0], dialect)} ASC`;
    }
  }
  const limit =
    dims.length > 0
      ? Math.max(1, Math.min(MAX_GROUPS, Math.round(q.limit && q.limit > 0 ? q.limit : MAX_GROUPS)))
      : null;

  // "Show top 12" on a time series means the latest 12 periods, still drawn
  // oldest first — not the first 12 the table ever had.
  const latest = Boolean(dateDim && q.limit && (!q.sort || q.sort === "label_asc"));

  const lines = [`SELECT ${select.join(",\n       ")}`, `FROM ${tableRef(q.table, dialect)}`];
  if (where.length) lines.push(`WHERE ${where.join("\n  AND ")}`);
  if (groupBy.length) lines.push(`GROUP BY ${groupBy.join(", ")}`);
  if (latest && dateDim) {
    const d = quoteIdent(dateDim, dialect);
    lines.push(`ORDER BY ${d} DESC`, `LIMIT ${limit}`);
    const inner = lines
      .join("\n")
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    return {
      sql: `SELECT *\nFROM (\n${inner}\n) latest\nORDER BY ${d} ASC`,
      dims,
      measures,
      labels,
    };
  }
  if (order) lines.push(`ORDER BY ${order}`);
  if (limit !== null) lines.push(`LIMIT ${limit}`);
  return { sql: lines.join("\n"), dims, measures, labels };
}

// ── Which chart, and which of its fields is which ────────────────────────────

export type AutoChart = "kpi" | "line" | "bar" | "scolumn" | "table";

/**
 * The visual these fields read best as, the way a BI tool picks one when
 * fields are dropped on an empty visual: one number is a KPI; a date and
 * values a line; a category and values bars; a category split by another
 * stacked columns; anything wider a table.
 */
export function autoChartType(q: FieldQuery, fields: FieldInfo[]): AutoChart {
  const kindOf = (n: string) => fields.find((f) => f.name === n)?.kind;
  const nd = q.dims.length;
  const nm = q.measures.length;
  if (nd === 0) return nm === 1 ? "kpi" : "table";
  if (nm === 0 || nm > 3 || nd > 2) return "table";
  const firstIsDate = kindOf(q.dims[0].field) === "date";
  if (nd === 1) return firstIsDate ? "line" : "bar";
  // Two groups: a date with a split is lines; two categories stack.
  if (nm === 1) return firstIsDate ? "line" : "scolumn";
  return "table";
}

/** The chart's own field names, filled from the query's output columns. */
export type ChartFieldAssignment = Partial<{
  xField: string;
  yField: string;
  seriesField: string;
  nameField: string;
  valueField: string;
  lineField: string;
  sizeField: string;
  rowField: string;
  colField: string;
  rowSubField: string;
  locationField: string;
  targetField: string;
  timeField: string;
  extraMeasures: string[];
  /** KPI and narrative: the period column. */
  dateField: string;
  /** Narrative: the ranked column. */
  categoryField: string;
  label: string;
}>;

/**
 * Charts that draw extra values as their own series (radar: as spokes). A
 * stacked column or bar stacks a Series field instead — measures that overlap,
 * like profit inside sales, would stack into a meaningless total.
 */
export const MULTI_MEASURE_TYPES: ReadonlySet<string> = new Set(["bar", "line", "area", "radar"]);

/**
 * Whether a chart takes extra measures (R506): the series charts above when
 * no field splits them, and always a combo (each drawn as bars or a line) and
 * a pivot (each nested under every column), which no series field splits.
 */
export function takesExtraMeasures(type: string, seriesField = ""): boolean {
  if (type === "combo" || type === "matrix") return true;
  return MULTI_MEASURE_TYPES.has(type) && !seriesField;
}

/** The measures a chart always draws, which its extra measures cannot repeat. */
export function mainMeasures(
  type: string,
  f: { yField: string; lineField: string; valueField: string },
): string[] {
  if (type === "combo") return [f.yField, f.lineField];
  if (type === "matrix") return [f.valueField];
  return [f.yField];
}

export function assignChartFields(
  type: string,
  out: Pick<FieldSql, "dims" | "measures" | "labels">,
  dimKinds: FieldKind[] = [],
): ChartFieldAssignment {
  const [d0, d1, d2] = out.dims;
  const [m0, m1, m2] = out.measures;
  const rest = out.measures.slice(1);
  const a: ChartFieldAssignment = {};
  switch (type) {
    case "bar":
    case "scolumn":
    case "shbar":
    case "hbar":
    case "line":
    case "area":
    case "radar":
    case "waterfall":
    case "boxplot":
      a.xField = d0;
      a.yField = m0;
      if (d1 && type !== "hbar" && type !== "waterfall" && type !== "boxplot") a.seriesField = d1;
      else if (rest.length && MULTI_MEASURE_TYPES.has(type)) a.extraMeasures = rest;
      break;
    case "barrace":
      a.xField = d0;
      a.yField = m0;
      a.timeField = d1;
      break;
    case "pie":
    case "funnel":
    case "treemap":
    case "nightingale":
    case "wordcloud":
      a.nameField = d0;
      a.valueField = m0;
      break;
    case "combo":
      a.xField = d0;
      a.yField = m0;
      a.lineField = m1;
      // R506: the third value on are bars too, until the options make one a line.
      if (out.measures.length > 2) a.extraMeasures = out.measures.slice(2);
      break;
    case "scatter":
      a.xField = m0;
      a.yField = m1;
      a.sizeField = m2;
      break;
    case "heatmap":
    case "sankey":
      a.xField = d0;
      a.yField = d1;
      a.valueField = m0;
      break;
    case "matrix":
      a.rowField = d0;
      a.colField = d1;
      a.valueField = m0;
      a.rowSubField = d2;
      // R506: every value is a column under each column heading.
      if (rest.length) a.extraMeasures = rest;
      break;
    case "map":
    case "bubblemap":
      a.locationField = d0;
      a.valueField = m0;
      break;
    case "kpi":
    case "gauge":
      a.valueField = m0;
      a.targetField = m1;
      if (d0 && dimKinds[0] === "date" && type === "kpi") a.dateField = d0;
      if (m0) a.label = out.labels[m0];
      break;
    case "insight":
      a.valueField = m0;
      if (d0) {
        if (dimKinds[0] === "date") a.dateField = d0;
        else a.categoryField = d0;
      }
      if (d1 && dimKinds[1] === "date") a.dateField = d1;
      break;
  }
  for (const k of Object.keys(a) as (keyof ChartFieldAssignment)[]) {
    if (a[k] === undefined) delete a[k];
  }
  return a;
}

/** "A", "A and B", "A, B and C". */
function listText(xs: string[]): string {
  return xs.length < 3
    ? xs.join(" and ")
    : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const TITLE_AGG: Record<MeasureAgg, (f: string) => string> = {
  sum: (f) => f,
  avg: (f) => `Average ${f}`,
  min: (f) => `Lowest ${f}`,
  max: (f) => `Highest ${f}`,
  count: (f) => `Count of ${f}`,
  count_distinct: (f) => `Distinct ${f}`,
};

/**
 * A measure column's name for a legend or a radar spoke: "avg_profit" →
 * "Average profit", "sales" → "Sales". Reads the aliases Fields mode writes,
 * and turns any other column name into words the same way.
 */
export function measureDisplayName(column: string): string {
  const words = (s: string) => {
    const t = s
      .replace(/[_\s]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : s;
  };
  if (column === "rows") return "Rows";
  for (const agg of Object.keys(AGG_PREFIX) as MeasureAgg[]) {
    const p = AGG_PREFIX[agg];
    if (p && column.startsWith(p) && column.length > p.length) {
      return words(TITLE_AGG[agg](column.slice(p.length)));
    }
  }
  return words(column);
}

/** A title for the visual from its fields: "Sales, Average Discount and Rows by Region". */
export function autoTitle(q: FieldQuery, fields: FieldInfo[]): string {
  const d = q.dims.map((x) => (x.grain ? GRAIN_LABEL[x.grain].toLowerCase() : x.field));
  const by = d.length ? ` by ${listText(d)}` : "";
  // One aggregation for every value is said once: "Average Sales, Profit and
  // Quantity", not "Average Sales, Average Profit and Average Quantity".
  const aggs = q.measures.map((x) => {
    const f = fields.find((y) => y.name === x.field);
    return x.field === ROWS_FIELD || f?.calc?.aggregated
      ? null
      : (x.agg ?? defaultAgg(f?.kind ?? "number"));
  });
  const shared = aggs[0];
  if (q.measures.length > 1 && shared && shared !== "sum" && aggs.every((a) => a === shared)) {
    return `${TITLE_AGG[shared](listText(q.measures.map((x) => x.field)))}${by}`;
  }
  const m = q.measures.map((x) => {
    if (x.field === ROWS_FIELD) return "Rows";
    const f = fields.find((y) => y.name === x.field);
    if (f?.calc?.aggregated) return x.field;
    return TITLE_AGG[x.agg ?? defaultAgg(f?.kind ?? "number")](x.field);
  });
  return `${m.length ? listText(m) : "Rows"}${by}`;
}
