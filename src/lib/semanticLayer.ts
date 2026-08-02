// Semantic layer — governed, compilable metrics + dimensions.
//
// A SemanticModel binds a physical source to DIMENSIONS (how you slice) and
// METRICS (what you measure), each authored as a trusted SQL fragment by the
// model owner. A structured SemanticQuery (metric/dimension NAMES + filters)
// compiles deterministically to SQL via compileSemanticQuery().
//
// SECURITY: the only SQL that ever reaches the database comes from (a) the
// model's own authored fragments and (b) values that are literal-escaped here.
// A query references fields by NAME only; unknown names are rejected. That's
// what makes an AI-authored semantic query safe — the model picks names, never
// writes SQL.

export type SemanticFieldType = "categorical" | "time" | "number" | "boolean";

export type SemanticDimension = {
  /** Stable id, ^[a-zA-Z_][a-zA-Z0-9_]*$ — used as the SQL alias. */
  name: string;
  label?: string;
  description?: string;
  /** Trusted SQL expression: a column, or e.g. DATE_TRUNC('month', created_at). */
  sql: string;
  type?: SemanticFieldType;
};

export type MetricAgg =
  | "sum"
  | "avg"
  | "count"
  | "count_distinct"
  | "min"
  | "max"
  | "custom"
  | "derived";

export type SemanticMetric = {
  name: string;
  label?: string;
  description?: string;
  agg: MetricAgg;
  /**
   * Column/expression to aggregate. Optional for `count`. Required for `custom`
   * (the full aggregate expression, e.g. SUM(revenue) - SUM(cost)) and for
   * `derived` (a formula over OTHER metrics referenced as `{metric_name}`,
   * e.g. "{revenue} / NULLIF({orders}, 0)" — the compiler substitutes each
   * with that metric's own aggregate, so the ratio tracks its parts' current
   * definitions). No raw aggregate may wrap a `{ref}` (a metric is already
   * aggregated).
   */
  sql?: string;
  /** Trusted boolean SQL fragments ANDed inside the aggregate (a filtered
   *  measure), e.g. ["status = 'paid'"]. Ignored for `custom`/`derived`. */
  filters?: string[];
  format?: "number" | "currency" | "percent";
  currency?: string;
};

export type SemanticSource =
  | { kind: "data_table"; table: string }
  | { kind: "warehouse"; connectionId: string; table: string };

/**
 * A join from the model's source table to a related table, so dimensions and
 * metrics can reference columns across a star schema instead of forcing the
 * owner to pre-join in a view or prep flow.
 *
 * `on` is a trusted SQL fragment authored by the MODEL OWNER — exactly the
 * same trust class as a dimension's `sql` — e.g. "orders.customer_id =
 * customers.id". The table reference and alias, by contrast, are validated to
 * strict identifier shapes, because they are also used to build the query's
 * structure.
 */
export type SemanticJoin = {
  /** Table to join (bare or dotted identifier, validated). */
  table: string;
  /** Optional alias, ^[a-zA-Z_][a-zA-Z0-9_]*$ — how fragments refer to it. */
  alias?: string;
  /** Join type; LEFT keeps unmatched source rows (the safe default). */
  type?: "left" | "inner";
  /** Trusted boolean SQL fragment: the ON condition. */
  on: string;
};

export const MAX_JOINS = 8;

export type SemanticModel = {
  id?: string;
  name: string;
  label?: string;
  description?: string;
  source: SemanticSource;
  joins?: SemanticJoin[];
  dimensions: SemanticDimension[];
  metrics: SemanticMetric[];
};

/**
 * Filters whose window is derived from TODAY rather than from a supplied value.
 *
 * These are the filters every dashboard actually wants — "this month", "last
 * 30 days" — and writing them by hand means editing a hard-coded date every
 * time the question is asked again.
 *
 * They are ordinary WHERE predicates over a half-open date range, so unlike
 * period-over-period comparisons they need no window functions and work on
 * every dialect, including AlaSQL.
 */
export const RELATIVE_DATE_OPS = [
  "last_n_days",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "ytd",
] as const;

export type RelativeDateOp = (typeof RELATIVE_DATE_OPS)[number];

export type FilterOp =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "in"
  | "not_in"
  | "contains"
  | RelativeDateOp;

export function isRelativeDateOp(op: FilterOp): op is RelativeDateOp {
  return (RELATIVE_DATE_OPS as readonly string[]).includes(op);
}

export type SemanticFilter = {
  /** A dimension name (→ WHERE) or metric name (→ HAVING). */
  field: string;
  op: FilterOp;
  /** Not used by the relative-date ops except `last_n_days`, which reads N. */
  value?: string | number | boolean | Array<string | number>;
};

export const TIME_GRAINS = ["day", "week", "month", "quarter", "year"] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];

/**
 * Period-over-period comparisons.
 *
 * `prior_period` shifts by ONE UNIT OF THE QUERY'S GRAIN — at a month grain
 * that is month-on-month, at a day grain day-on-day. `mom` and `yoy` shift by
 * a fixed month or year whatever the grain, so a daily series can be compared
 * against the same day a year ago.
 */
export const COMPARE_PERIODS = ["prior_period", "mom", "yoy"] as const;
export type ComparePeriod = (typeof COMPARE_PERIODS)[number];

/** Suffixes added to each metric's column when a comparison is requested. */
export const COMPARE_SUFFIXES = ["_prev", "_change", "_pct_change"] as const;

export type SemanticQuery = {
  model: string;
  metrics: string[];
  dimensions?: string[];
  /**
   * Optional per-dimension time rollup, e.g. { order_date: "month" }. Only
   * valid on dimensions typed "time"; the compiler renders the right
   * truncation per dialect. A COMPARISON filter on that dimension compares
   * against the ROLLED-UP bucket (what the user sees); a RELATIVE-DATE filter
   * deliberately compares the raw value instead, because a day window has no
   * meaning against a month label.
   */
  grains?: Record<string, TimeGrain>;
  filters?: SemanticFilter[];
  orderBy?: Array<{ field: string; dir?: "asc" | "desc" }>;
  limit?: number;
  /**
   * Compare each row against the equivalent earlier period, adding
   * `<metric>_prev`, `<metric>_change` and `<metric>_pct_change`.
   *
   * Requires exactly one grained time dimension — the axis being compared —
   * and a dialect with CTEs and date arithmetic, which excludes AlaSQL.
   */
  compare?: ComparePeriod;
};

export type CompiledQuery = { sql: string; columns: string[] };

/** SQL dialects we compile identifier-quoting for. */
export type SqlDialect =
  | "alasql"
  /** Local columnar engine. ANSI on every axis that matters here: double-quoted
   *  identifiers, no backslash escapes, standard DATE_TRUNC and an ESCAPE clause. */
  | "duckdb"
  | "postgres"
  | "mysql"
  | "snowflake"
  | "bigquery"
  | "redshift"
  | "databricks"
  | "azure_synapse";

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 10000;

// Backtick dialects vs. double-quote (ANSI) dialects. Aliases are validated to
// IDENT_RE, so quoting them can never inject.
const BACKTICK_DIALECTS = new Set<SqlDialect>(["alasql", "bigquery", "mysql", "databricks"]);
function quoteIdent(name: string, dialect: SqlDialect): string {
  return BACKTICK_DIALECTS.has(dialect) ? `\`${name}\`` : `"${name}"`;
}

export function isValidFieldName(name: string): boolean {
  return IDENT_RE.test(name);
}

/** A FROM target: a bare identifier or a dotted/quoted qualified name. */
function assertTableRef(t: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(t) && !/^"[^"]+"$/.test(t)) {
    throw new Error(`Unsafe source table reference: ${JSON.stringify(t)}`);
  }
  return t;
}

// Dialects whose string LITERALS treat backslash as an escape character
// (MySQL default mode, Spark/Databricks, BigQuery, Snowflake, Redshift —
// and AlaSQL, proven empirically: its lexer honours \' inside strings, so
// the local engine is exactly as injectable as MySQL without this).
// On these, doubling quotes alone is NOT enough: a value ending in `\` turns
// the "doubled" quote into an escaped one and the rest of the value goes
// live as SQL. Backslashes must be doubled too. Postgres (standard strings)
// and T-SQL treat backslash literally — doubling there would corrupt values.
const BACKSLASH_ESCAPE_DIALECTS = new Set<SqlDialect>([
  "alasql",
  "mysql",
  "databricks",
  "bigquery",
  "snowflake",
  "redshift",
]);

/** Escape string CONTENT for a single-quoted literal in `dialect`. */
function escapeString(v: string, dialect: SqlDialect): string {
  let s = v.replace(/'/g, "''");
  if (BACKSLASH_ESCAPE_DIALECTS.has(dialect)) s = s.replace(/\\/g, "\\\\");
  return s;
}

/**
 * Rewrite quoted identifiers in an AUTHORED SQL fragment to the target
 * dialect's quoting.
 *
 * A semantic model stores `sql` fragments written by the model author or by
 * "Generate with AI" — `` `Order Date` `` for a local dataset, `"Order Date"`
 * for a warehouse. Those fragments are inserted verbatim into the compiled
 * query, so a model authored against AlaSQL produced backticks that DuckDB
 * rejects outright ("Parser Error: syntax error at or near ..."), and the
 * dialect option could not help because the dialect never reached them.
 *
 * Normalising here means the STORED form no longer decides which engines a
 * model works on — which is what a semantic layer is supposed to guarantee —
 * and existing saved models start working without a migration.
 *
 * Quoting inside string literals is left alone: `WHERE note = 'a `b` c'`
 * contains no identifier.
 */
export function normaliseIdentQuotes(sql: string, dialect: SqlDialect): string {
  const target = BACKTICK_DIALECTS.has(dialect) ? "`" : '"';
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // Copy the literal verbatim, honouring '' as an escaped quote.
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push(sql.slice(start, i));
      continue;
    }
    if (ch === "`" || ch === '"') {
      const close = sql.indexOf(ch, i + 1);
      if (close === -1) {
        // Unbalanced quote — leave the rest untouched rather than guess.
        out.push(sql.slice(i));
        break;
      }
      const inner = sql.slice(i + 1, close);
      // An embedded target quote is doubled so the result stays parseable.
      out.push(target + inner.split(target).join(target + target) + target);
      i = close + 1;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/** Escape a scalar into a SQL literal. Only strings/finite numbers/booleans. */
function literal(v: string | number | boolean, dialect: SqlDialect): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite number in filter value");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return `'${escapeString(v, dialect)}'`;
  throw new Error("Unsupported filter value type");
}

/**
 * Per-dialect time truncation for grained time dimensions.
 *
 * AlaSQL (local datasets) has no DATE_TRUNC, so buckets compile to sortable
 * numeric composites (2024, 202401, 20240115…) — verified against the real
 * engine. Week starts Monday everywhere it's supported; AlaSQL refuses the
 * week grain outright rather than shipping a wrong bucket.
 */
export function truncateExpr(sql: string, grain: TimeGrain, dialect: SqlDialect): string {
  if (dialect === "alasql") {
    switch (grain) {
      case "year":
        return `YEAR(${sql})`;
      case "quarter":
        return `YEAR(${sql}) * 10 + FLOOR((MONTH(${sql}) + 2) / 3)`;
      case "month":
        return `YEAR(${sql}) * 100 + MONTH(${sql})`;
      case "day":
        return `YEAR(${sql}) * 10000 + MONTH(${sql}) * 100 + DAY(${sql})`;
      case "week":
        throw new Error("The week grain isn't supported for local datasets — use day or month.");
    }
  }
  if (dialect === "duckdb") {
    // Local date columns are stored as ISO TEXT, so they must be cast before
    // truncation — DuckDB is strict and `DATE_TRUNC('month', <varchar>)` is a
    // binder error, not a silent coercion. TRY_CAST degrades an unparseable
    // value to NULL rather than aborting the whole query, which matters
    // because these columns are typed by inference from a 50-row sample.
    //
    // The result is rendered back to an ISO day so bucket labels stay text,
    // matching how dates are stored everywhere else in the app.
    return `CAST(CAST(DATE_TRUNC('${grain}', TRY_CAST(${sql} AS DATE)) AS DATE) AS VARCHAR)`;
  }
  if (dialect === "bigquery") {
    const unit = grain === "week" ? "WEEK(MONDAY)" : grain.toUpperCase();
    return `DATE_TRUNC(DATE(${sql}), ${unit})`;
  }
  if (dialect === "azure_synapse") return `DATETRUNC(${grain}, ${sql})`;
  if (dialect === "mysql") {
    switch (grain) {
      case "day":
        return `DATE(${sql})`;
      case "week":
        return `DATE_SUB(DATE(${sql}), INTERVAL WEEKDAY(${sql}) DAY)`;
      case "month":
        return `DATE_FORMAT(${sql}, '%Y-%m-01')`;
      case "quarter":
        return `MAKEDATE(YEAR(${sql}), 1) + INTERVAL (QUARTER(${sql}) - 1) QUARTER`;
      case "year":
        return `DATE_FORMAT(${sql}, '%Y-01-01')`;
    }
  }
  // postgres / redshift / snowflake / databricks all accept these unit names.
  return `DATE_TRUNC('${grain}', ${sql})`;
}

/** A window longer than this is a mistake, not a filter. */
export const MAX_RELATIVE_DAYS = 3650;

/** The UTC calendar day `d` falls on, as an ISO date. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDay(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

/**
 * The half-open date window `[start, end)` a relative filter covers.
 *
 * Exported because the filter UI shows the resolved dates — "last 30 days"
 * with no way to see which 30 days is how someone ends up disputing a number
 * they cannot reproduce.
 *
 * HALF-OPEN ON PURPOSE. `>= start AND < end` is correct whether the column
 * holds a plain date or a timestamp; a closed `<= end` silently drops
 * everything after midnight on the final day, which is a whole day of missing
 * data on the most recent — and most looked-at — bucket.
 *
 * WINDOWS ARE UTC. The app has no per-user timezone, and picking the server's
 * local zone would mean the same dashboard answered differently depending on
 * where it was deployed.
 *
 * `last_n_days` INCLUDES today: n=30 is today plus the 29 days before it, so
 * the window is exactly n days long.
 */
export function relativeDateRange(
  op: RelativeDateOp,
  opts: { n?: number; now?: Date } = {},
): { start: string; end: string } {
  const now = opts.now ?? new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = utcDay(y, m, now.getUTCDate());
  const tomorrow = utcDay(y, m, now.getUTCDate() + 1);

  switch (op) {
    case "last_n_days": {
      const n = opts.n;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 1 || n > MAX_RELATIVE_DAYS) {
        throw new Error(
          `"last_n_days" needs a whole number of days between 1 and ${MAX_RELATIVE_DAYS}`,
        );
      }
      const days = Math.trunc(n);
      return { start: isoDay(utcDay(y, m, now.getUTCDate() - (days - 1))), end: isoDay(tomorrow) };
    }
    case "this_month":
      return { start: isoDay(utcDay(y, m, 1)), end: isoDay(utcDay(y, m + 1, 1)) };
    case "last_month":
      return { start: isoDay(utcDay(y, m - 1, 1)), end: isoDay(utcDay(y, m, 1)) };
    case "this_quarter": {
      const q = Math.floor(m / 3) * 3;
      return { start: isoDay(utcDay(y, q, 1)), end: isoDay(utcDay(y, q + 3, 1)) };
    }
    case "last_quarter": {
      const q = Math.floor(m / 3) * 3;
      return { start: isoDay(utcDay(y, q - 3, 1)), end: isoDay(utcDay(y, q, 1)) };
    }
    case "ytd":
      // To DATE — through today, not through the end of the year.
      return { start: isoDay(utcDay(y, 0, 1)), end: isoDay(tomorrow) };
    default:
      throw new Error(`Unknown relative date op "${op as string}"`);
  }
}

/**
 * A date literal for `dialect`.
 *
 * Everywhere except BigQuery an ISO string compares correctly against a date
 * column (the engine casts) and against the ISO TEXT that local datasets store
 * — see the `date` → VARCHAR decision in duckdb.server. BigQuery will not
 * compare DATE to STRING at all and needs the explicit constructor.
 *
 * The input is generated here from a Date, never taken from a user, so it
 * cannot carry a quote; it is escaped anyway rather than trusted by argument.
 */
function dateLiteral(iso: string, dialect: SqlDialect): string {
  const quoted = `'${escapeString(iso, dialect)}'`;
  return dialect === "bigquery" ? `DATE ${quoted}` : quoted;
}

/**
 * A relative date filter as a plain WHERE predicate.
 *
 * Deliberately NOT emitted as `CURRENT_DATE - INTERVAL n DAY`. Compiling the
 * boundaries to literals here means one implementation for every dialect
 * instead of a date-function matrix per engine — AlaSQL has no CURRENT_DATE
 * and no INTERVAL at all — and it makes the compiled SQL reproducible, so a
 * number someone disputes can be re-run and get the same answer.
 *
 * That is only safe because compileSemanticQuery runs on every execution
 * rather than being cached (see query.server), so the window is recomputed
 * each time the question is asked.
 */
export function relativeDateExpr(
  sql: string,
  op: RelativeDateOp,
  dialect: SqlDialect,
  opts: { n?: number; now?: Date } = {},
): string {
  const { start, end } = relativeDateRange(op, opts);
  return `(${sql} >= ${dateLiteral(start, dialect)} AND ${sql} < ${dateLiteral(end, dialect)})`;
}

/** Units `dateAddExpr` shifts by, after quarters and weeks are normalised away. */
type DateAddUnit = "day" | "month" | "year";

/**
 * Shift a date expression by a whole number of units, per dialect.
 *
 * QUARTER AND WEEK ARE NORMALISED AWAY (3 months, 7 days) rather than passed
 * through. Support for them as interval units is uneven — and a dialect that
 * silently rounds an unsupported unit would produce a comparison against the
 * wrong period, which looks like a business result rather than a bug.
 *
 * AlaSQL has no date arithmetic at all and is rejected by the caller before
 * reaching here.
 */
function dateAddExpr(sql: string, n: number, unit: DateAddUnit, dialect: SqlDialect): string {
  if (!Number.isInteger(n)) throw new Error(`Date shift must be a whole number, got ${n}`);
  const U = unit.toUpperCase();
  switch (dialect) {
    case "alasql":
      throw new Error("The AlaSQL engine has no date arithmetic.");
    case "duckdb":
      // TRY_CAST for the same reason truncateExpr uses it: local date columns
      // are ISO TEXT typed by inference, so one unparseable value must become
      // NULL rather than abort the query.
      return `(TRY_CAST(${sql} AS DATE) + INTERVAL ${n} ${U})`;
    case "postgres":
    case "redshift":
      return `(CAST(${sql} AS DATE) + INTERVAL '${n} ${unit}')`;
    case "databricks":
      return `(CAST(${sql} AS DATE) + INTERVAL ${n} ${U})`;
    case "snowflake":
    case "azure_synapse":
      return `DATEADD(${unit}, ${n}, CAST(${sql} AS DATE))`;
    case "bigquery":
      return `DATE_ADD(DATE(${sql}), INTERVAL ${n} ${U})`;
    case "mysql":
      return `DATE_ADD(${sql}, INTERVAL ${n} ${U})`;
    default: {
      const exhaustive: never = dialect;
      throw new Error(`No date arithmetic defined for dialect "${exhaustive as string}"`);
    }
  }
}

/** How far back a comparison looks, as a unit `dateAddExpr` understands. */
function compareShift(period: ComparePeriod, grain: TimeGrain): { n: number; unit: DateAddUnit } {
  if (period === "yoy") return { n: 1, unit: "year" };
  if (period === "mom") return { n: 1, unit: "month" };
  switch (grain) {
    case "day":
      return { n: 1, unit: "day" };
    case "week":
      return { n: 7, unit: "day" };
    case "month":
      return { n: 1, unit: "month" };
    case "quarter":
      return { n: 3, unit: "month" };
    case "year":
      return { n: 1, unit: "year" };
  }
}

/**
 * A NULL-safe equality, for joining a period to its predecessor.
 *
 * Plain `=` is WRONG here. A dimension value of NULL — a region that was never
 * recorded, say — makes `b.region = p.region` evaluate to NULL, the join finds
 * no partner, and that entire group silently loses its comparison while every
 * other group keeps one. The result looks complete and is not.
 */
function nullSafeEq(left: string, right: string, dialect: SqlDialect): string {
  // MySQL spells it `<=>`; everything else we target accepts the ANSI form.
  return dialect === "mysql" ? `${left} <=> ${right}` : `${left} IS NOT DISTINCT FROM ${right}`;
}

const METRIC_REF_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Aggregate expression for a NON-derived metric (a leaf measure). */
function aggExpr(m: SemanticMetric): string {
  const filters = (m.filters ?? []).filter((f) => f && f.trim());
  const guarded = (inner: string) =>
    filters.length ? `CASE WHEN (${filters.join(") AND (")}) THEN ${inner} END` : inner;
  switch (m.agg) {
    case "custom":
      if (!m.sql) throw new Error(`Metric "${m.name}" is custom but has no sql`);
      return m.sql; // fully trusted, filters not applied
    case "derived":
      // A derived metric is only meaningful with the sibling metric map, so it
      // is resolved by resolveMetricExpr, never here.
      throw new Error(`Derived metric "${m.name}" must be resolved with its model's metrics`);
    case "count":
      return filters.length ? `COUNT(${guarded("1")})` : "COUNT(*)";
    case "count_distinct":
      if (!m.sql) throw new Error(`Metric "${m.name}" (count_distinct) needs sql`);
      return `COUNT(DISTINCT ${guarded(m.sql)})`;
    case "sum":
    case "avg":
    case "min":
    case "max": {
      if (!m.sql) throw new Error(`Metric "${m.name}" (${m.agg}) needs sql`);
      return `${m.agg.toUpperCase()}(${guarded(m.sql)})`;
    }
    default:
      throw new Error(`Unknown aggregation "${(m as SemanticMetric).agg}"`);
  }
}

/**
 * Full SQL for a metric, resolving `derived` formulas by substituting each
 * `{ref}` with the referenced metric's own expression (recursively). Cycles
 * and unknown references throw — a derived metric with a broken graph must
 * fail loudly, not compute a silently-wrong number.
 */
function resolveMetricExpr(
  m: SemanticMetric,
  byName: Map<string, SemanticMetric>,
  resolving: Set<string> = new Set(),
): string {
  if (m.agg !== "derived") return aggExpr(m);
  if (!m.sql) throw new Error(`Derived metric "${m.name}" needs an sql formula`);
  if (resolving.has(m.name)) {
    throw new Error(`Derived metric "${m.name}" has a circular reference`);
  }
  resolving.add(m.name);
  let referenced = false;
  const out = m.sql.replace(METRIC_REF_RE, (_full, ref: string) => {
    referenced = true;
    const target = byName.get(ref);
    if (!target) throw new Error(`Derived metric "${m.name}" references unknown metric "${ref}"`);
    return `(${resolveMetricExpr(target, byName, resolving)})`;
  });
  resolving.delete(m.name);
  if (!referenced) {
    throw new Error(
      `Derived metric "${m.name}" references no other metric — use {metric_name} tokens.`,
    );
  }
  return out;
}

/**
 * The full aggregate SQL for a metric — the SAME rendering compileSemanticQuery
 * uses, exported so prompt surfaces (the BI analyst) can show the governed
 * formula instead of letting the model improvise its own. Pass the model's
 * metrics so a `derived` metric resolves its `{ref}` tokens.
 */
export function metricExpression(m: SemanticMetric, allMetrics?: SemanticMetric[]): string {
  if (m.agg !== "derived") return aggExpr(m);
  const byName = new Map((allMetrics ?? [m]).map((x) => [x.name, x]));
  return resolveMetricExpr(m, byName);
}

function compileFilter(
  f: SemanticFilter,
  exprByField: Map<string, string>,
  dialect: SqlDialect,
  opts: { dim?: SemanticDimension; now?: Date } = {},
): string {
  const expr = exprByField.get(f.field);
  if (!expr) throw new Error(`Filter references unknown field "${f.field}"`);

  if (isRelativeDateOp(f.op)) {
    const dim = opts.dim;
    // A relative date window over a non-date column would compare a string to
    // whatever that column holds and quietly return nothing — a filter that
    // silently empties a dashboard is the exact failure this layer exists to
    // prevent, so it must be impossible to express rather than merely unwise.
    if (!dim) {
      throw new Error(
        `"${f.op}" filters a time dimension; "${f.field}" is a metric. ` +
          `Filter the date dimension instead.`,
      );
    }
    if (dim.type !== "time") {
      throw new Error(`"${f.op}" needs a time dimension; "${f.field}" is ${dim.type}.`);
    }
    // The RAW column, never the grain-wrapped expression. Filtering "last 30
    // days" against a dimension grained to month would compare the bucket
    // label rather than the row's date, so a query grouped by month would
    // silently filter by month — right-looking output, wrong rows.
    const n = typeof f.value === "number" ? f.value : Number(f.value);
    return relativeDateExpr(dim.sql, f.op, dialect, { n, now: opts.now });
  }

  switch (f.op) {
    case "=":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=": {
      if (Array.isArray(f.value)) throw new Error(`Operator "${f.op}" needs a scalar`);
      if (f.value === undefined) throw new Error(`Operator "${f.op}" needs a value`);
      const op = f.op === "!=" ? "<>" : f.op;
      return `${expr} ${op} ${literal(f.value, dialect)}`;
    }
    case "in":
    case "not_in": {
      if (f.value === undefined) throw new Error(`Operator "${f.op}" needs a value`);
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      if (arr.length === 0) return f.op === "in" ? "1 = 0" : "1 = 1";
      const list = arr.map((v) => literal(v, dialect)).join(", ");
      return `${expr} ${f.op === "in" ? "IN" : "NOT IN"} (${list})`;
    }
    case "contains": {
      if (typeof f.value !== "string") throw new Error('"contains" needs a string');
      // LIKE metacharacters are escaped with `~` — a dialect-neutral escape
      // char sidesteps the backslash-as-string-escape minefield entirely.
      // BigQuery's LIKE has no ESCAPE clause; backslash is its built-in
      // pattern escape, and escapeString doubles it for the literal.
      if (dialect === "bigquery") {
        const pattern = f.value.replace(/([\\%_])/g, "\\$1");
        return `${expr} LIKE '%${escapeString(pattern, dialect)}%'`;
      }
      const pattern = f.value.replace(/~/g, "~~").replace(/([%_])/g, "~$1");
      return `${expr} LIKE '%${escapeString(pattern, dialect)}%' ESCAPE '~'`;
    }
    default:
      throw new Error(`Unknown filter op "${(f as SemanticFilter).op}"`);
  }
}

/**
 * Render a model's JOIN clauses, validating everything structural.
 *
 * Throws (rather than skipping) on a bad join: silently dropping one would
 * change which rows every metric aggregates over — the same "quietly wrong
 * number" failure this layer exists to prevent.
 */
function compileJoins(joins: SemanticJoin[] | undefined, dialect: SqlDialect): string {
  if (!joins || joins.length === 0) return "";
  if (joins.length > MAX_JOINS) throw new Error(`At most ${MAX_JOINS} joins per model`);
  let out = "";
  for (const j of joins) {
    const table = assertTableRef(j.table);
    if (j.alias !== undefined && !IDENT_RE.test(j.alias)) {
      throw new Error(`Invalid join alias ${JSON.stringify(j.alias)}`);
    }
    // Whitelist, not string interpolation: `type` becomes SQL structure.
    const kw = j.type === "inner" ? "INNER JOIN" : "LEFT JOIN";
    const on = normaliseIdentQuotes((j.on ?? "").trim(), dialect);
    if (!on) throw new Error(`Join on "${j.table}" is missing its ON condition`);
    if (on.length > 500) throw new Error(`Join ON condition too long (max 500 chars)`);
    out += ` ${kw} ${table}${j.alias ? ` AS ${j.alias}` : ""} ON (${on})`;
  }
  return out;
}

/**
 * Compile a structured semantic query against one model into a single read-only
 * SELECT. Throws on any unknown field name or unsafe input.
 */
export function compileSemanticQuery(
  model: SemanticModel,
  q: SemanticQuery,
  /** `now` pins the reference date for relative-date filters; tests use it so
   *  a compiled window is reproducible rather than dependent on the clock. */
  opts?: { dialect?: SqlDialect; now?: Date },
): CompiledQuery {
  const dialect: SqlDialect = opts?.dialect ?? "postgres";

  // Authored fragments are re-quoted for the target dialect ONCE, here, so
  // every consumer below (dimExpr, aggExpr, derived formulas, filters, order,
  // joins) inherits it. A model authored against a local dataset stores
  // `` `Order Date` ``, which DuckDB rejects outright; normalising at the point
  // of use in eight places would have been eight chances to miss one.
  const q0 = (sql: string) => normaliseIdentQuotes(sql, dialect);

  const dimByName = new Map<string, SemanticDimension>();
  for (const d of model.dimensions) {
    if (!isValidFieldName(d.name)) throw new Error(`Invalid dimension name "${d.name}"`);
    dimByName.set(d.name, { ...d, sql: q0(d.sql) });
  }
  const metricByName = new Map<string, SemanticMetric>();
  for (const m of model.metrics) {
    if (!isValidFieldName(m.name)) throw new Error(`Invalid metric name "${m.name}"`);
    // `filters` (a filtered measure's CASE WHEN condition) is an authored
    // fragment too, and is embedded just as verbatim as `sql`.
    metricByName.set(m.name, {
      ...m,
      ...(m.sql ? { sql: q0(m.sql) } : {}),
      ...(m.filters ? { filters: m.filters.map(q0) } : {}),
    });
  }

  const dims = q.dimensions ?? [];
  const metrics = q.metrics ?? [];
  if (dims.length === 0 && metrics.length === 0) {
    throw new Error("A query needs at least one metric or dimension");
  }

  /**
   * The aggregate SELECT, with every reference to the comparison axis
   * optionally shifted FORWARD by one period.
   *
   * Shifting forward rather than backward is what makes the join trivial: last
   * year's rows land in this year's buckets, so the two results line up on
   * equality. It also means a date FILTER needs no special handling — the same
   * predicate applied to a shifted column selects the prior window by
   * construction, so "this year, compared to last" cannot end up comparing
   * against rows the filter excluded.
   */
  const buildAggregate = (shift?: { name: string; n: number; unit: DateAddUnit }) => {
    const dimFor = (name: string): SemanticDimension => {
      const d = dimByName.get(name);
      if (!d) throw new Error(`Unknown dimension "${name}"`);
      return shift && shift.name === name
        ? { ...d, sql: dateAddExpr(d.sql, shift.n, shift.unit, dialect) }
        : d;
    };

    // Effective dimension expression: the authored SQL, wrapped in the
    // dialect's time truncation when the query asks for a grain.
    const dimExpr = (name: string): string => {
      const d = dimFor(name);
      const grain = q.grains?.[name];
      if (!grain) return d.sql;
      if (!TIME_GRAINS.includes(grain)) {
        throw new Error(`Unknown time grain "${grain}" for dimension "${name}"`);
      }
      if (d.type !== "time") {
        throw new Error(`Grain "${grain}" set on "${name}", which is not a time dimension`);
      }
      return truncateExpr(d.sql, grain, dialect);
    };

    // Expression map for filters/order (grained dim exprs; compiled metric aggs).
    const exprByField = new Map<string, string>();
    for (const name of dimByName.keys()) exprByField.set(name, dimExpr(name));

    const selectParts: string[] = [];
    const cols: string[] = [];

    for (const name of dims) {
      selectParts.push(`${dimExpr(name)} AS ${quoteIdent(name, dialect)}`);
      cols.push(name);
    }
    for (const name of metrics) {
      const m = metricByName.get(name);
      if (!m) throw new Error(`Unknown metric "${name}"`);
      const expr = resolveMetricExpr(m, metricByName);
      exprByField.set(name, expr);
      selectParts.push(`${expr} AS ${quoteIdent(name, dialect)}`);
      cols.push(name);
    }

    // Filters: dimension filters → WHERE; metric filters → HAVING.
    const whereParts: string[] = [];
    const havingParts: string[] = [];
    for (const f of q.filters ?? []) {
      if (metricByName.has(f.field)) {
        havingParts.push(compileFilter(f, exprByField, dialect, { now: opts?.now }));
      } else if (dimByName.has(f.field)) {
        // The dimension itself goes through so a relative-date filter can reach
        // its type and its ungrained SQL — shifted here when this is the prior
        // period, so the window moves with it.
        whereParts.push(
          compileFilter(f, exprByField, dialect, { dim: dimFor(f.field), now: opts?.now }),
        );
      } else throw new Error(`Filter references unknown field "${f.field}"`);
    }

    const from = assertTableRef(model.source.table);
    let out = `SELECT ${selectParts.join(", ")} FROM ${from}${compileJoins(model.joins, dialect)}`;
    if (whereParts.length) out += ` WHERE ${whereParts.join(" AND ")}`;
    // Group by dimension expressions (grain-wrapped) when aggregating.
    if (metrics.length && dims.length) {
      out += ` GROUP BY ${dims.map(dimExpr).join(", ")}`;
    }
    if (havingParts.length) out += ` HAVING ${havingParts.join(" AND ")}`;
    return { sql: out, columns: cols };
  };

  // The clamp used to be Math.max(1, Math.min(q.limit ?? DEFAULT, MAX)), which
  // passes NaN straight through — Math.min(NaN, x) is NaN and Math.max(1, NaN)
  // is NaN — so a query whose limit did not parse reached the database as the
  // literal `LIMIT NaN`. A fractional one reached it as `LIMIT 2.7`, which
  // Postgres rejects. Both surfaced as a syntax error from the warehouse
  // rather than as the caller mistake they are. Strings still coerce, because
  // an AI-authored query may send "50" and that is unambiguous.
  //
  // Only a number, or a non-blank numeric string, is accepted. Passing the
  // value through bare `Number()` is not enough: Number([]) and Number("") are
  // both 0, so `limit: []` clamped to `LIMIT 1` and quietly returned a single
  // row for a query that asked for a page of them.
  // Typed `unknown`, not `number`: the declared type says number, but a
  // SemanticQuery arrives as JSON from a model or an API caller, so the value
  // here is whatever they sent. Narrowing off the declared type would make the
  // string branch unreachable to the compiler and the guard a no-op.
  const rawLimit: unknown = q.limit ?? DEFAULT_LIMIT;
  const limitNum =
    typeof rawLimit === "number"
      ? rawLimit
      : typeof rawLimit === "string" && rawLimit.trim() !== ""
        ? Number(rawLimit)
        : NaN;
  if (!Number.isFinite(limitNum)) {
    throw new Error(`Limit must be a finite number, got ${JSON.stringify(q.limit)}`);
  }
  const limit = Math.max(1, Math.min(Math.floor(limitNum), MAX_LIMIT));

  /** ORDER BY … LIMIT …, appended once, over the query's own output columns. */
  const tail = (available: string[]) => {
    // REFUSE, DO NOT DEGRADE — the same rule this file already applies to an
    // AlaSQL comparison below, and to every unknown metric, dimension, filter
    // field and grain above.
    //
    // This used to `.filter()` unknown fields out, which is the one place the
    // compiler quietly accepted a name it did not recognise. The result is the
    // worst shape a bug can take here: "top 10 customers by revenue" with a
    // mistyped or renamed order field drops the ORDER BY and returns an
    // ARBITRARY ten rows, still labelled "top 10". Nothing errors, and the
    // number on the dashboard is wrong in a way no one can see. An unknown
    // filter field has always thrown; this is now consistent with it.
    for (const o of q.orderBy ?? []) {
      if (!available.includes(o.field)) {
        throw new Error(
          `Order references "${o.field}", which this query does not return ` +
            `(available: ${available.join(", ")})`,
        );
      }
    }
    const parts = (q.orderBy ?? []).map(
      (o) => `${quoteIdent(o.field, dialect)} ${o.dir === "asc" ? "ASC" : "DESC"}`,
    );
    return `${parts.length ? ` ORDER BY ${parts.join(", ")}` : ""} LIMIT ${limit}`;
  };

  if (!q.compare) {
    const base = buildAggregate();
    return { sql: base.sql + tail(base.columns), columns: base.columns };
  }

  // ── Period over period ────────────────────────────────────────────────
  if (!COMPARE_PERIODS.includes(q.compare)) {
    throw new Error(`Unknown comparison "${q.compare as string}"`);
  }
  if (dialect === "alasql") {
    // Refused, not degraded. AlaSQL has neither CTEs nor date arithmetic, and
    // there is no partial version of this that is still correct.
    throw new Error(
      "Period-over-period comparisons need CTEs and date arithmetic, which the AlaSQL " +
        "engine does not have. Remove LOCAL_ENGINE=alasql to use the default engine.",
    );
  }
  if (metrics.length === 0) {
    throw new Error("A comparison needs at least one metric to compare.");
  }
  // The comparison axis has to be unambiguous. With two grained time
  // dimensions there is no single "previous period" to shift along, and
  // picking one for the user would silently answer a different question.
  const grainedTime = dims.filter((n) => q.grains?.[n] && dimByName.get(n)?.type === "time");
  if (grainedTime.length !== 1) {
    throw new Error(
      grainedTime.length === 0
        ? "A comparison needs exactly one time dimension with a grain — that is the axis being compared."
        : `A comparison needs exactly one grained time dimension, but this query has ${grainedTime.length} (${grainedTime.join(", ")}).`,
    );
  }
  const axis = grainedTime[0];
  const { n, unit } = compareShift(q.compare, q.grains![axis]!);

  const cur = buildAggregate();
  const prev = buildAggregate({ name: axis, n, unit });

  const CUR = "semantic_cur";
  const PREV = "semantic_prev";
  const ref = (t: string, col: string) => `${t}.${quoteIdent(col, dialect)}`;

  const selectParts = cur.columns.map((c) => ref(CUR, c));
  const columns = [...cur.columns];
  for (const name of metrics) {
    const c = ref(CUR, name);
    const p = ref(PREV, name);
    const delta = `(${c} - ${p})`;
    selectParts.push(`${p} AS ${quoteIdent(`${name}_prev`, dialect)}`);
    selectParts.push(`${delta} AS ${quoteIdent(`${name}_change`, dialect)}`);
    // A percentage change from zero (or from a period with no data) is not
    // zero and not infinity — it does not exist. NULL says so; any number
    // here would be read as a real result.
    selectParts.push(
      `CASE WHEN ${p} IS NULL OR ${p} = 0 THEN NULL ELSE ${delta} * 1.0 / ${p} END ` +
        `AS ${quoteIdent(`${name}_pct_change`, dialect)}`,
    );
    columns.push(`${name}_prev`, `${name}_change`, `${name}_pct_change`);
  }

  // LEFT JOIN: a bucket with no predecessor still appears, with NULL
  // comparisons. An INNER JOIN would silently drop the first period of every
  // series — including the oldest bucket a user is looking at.
  const on = dims.map((d) => nullSafeEq(ref(CUR, d), ref(PREV, d), dialect)).join(" AND ");
  const sql =
    `WITH ${CUR} AS (${cur.sql}), ${PREV} AS (${prev.sql}) ` +
    `SELECT ${selectParts.join(", ")} FROM ${CUR} LEFT JOIN ${PREV} ON ${on}` +
    tail(columns);
  return { sql, columns };
}

/** A compact catalog string an LLM can read to author semantic queries. */
export function formatSemanticCatalog(models: SemanticModel[]): string {
  if (models.length === 0) return "(no semantic models defined)";
  const hasTimeDim = models.some((m) => m.dimensions.some((d) => d.type === "time"));
  const grainNote = hasTimeDim
    ? `\n\nTime dimensions accept a rollup via "grains", e.g. {"order_date":"month"} (day|week|month|quarter|year).` +
      `\nFor "compared to last year" style questions set "compare" to yoy, mom or prior_period rather than` +
      ` running two queries — it adds <metric>_prev, <metric>_change and <metric>_pct_change, and needs exactly` +
      ` one grained time dimension.` +
      `\nFor date ranges prefer a relative filter op (last_n_days, this_month, last_month, this_quarter,` +
      ` last_quarter, ytd) over hard-coded dates.`
    : "";
  return models
    .map((m) => {
      const dims = m.dimensions
        .map((d) => `${d.name}${d.type ? `:${d.type}` : ""}${d.label ? ` (${d.label})` : ""}`)
        .join(", ");
      const mets = m.metrics
        .map((x) => `${x.name}${x.label ? ` (${x.label})` : ""}${x.format ? ` [${x.format}]` : ""}`)
        .join(", ");
      const joins = (m.joins ?? [])
        .map((j) => `${j.table}${j.alias ? ` AS ${j.alias}` : ""}`)
        .join(", ");
      return [
        `MODEL ${m.name}${m.label ? ` — ${m.label}` : ""}`,
        m.description ? `  ${m.description}` : "",
        joins ? `  joined tables: ${joins}` : "",
        `  dimensions: ${dims || "(none)"}`,
        `  metrics: ${mets || "(none)"}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n")
    .concat(grainNote);
}
