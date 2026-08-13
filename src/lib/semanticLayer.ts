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
  /**
   * Business words that mean this field ("turnover", "GMV" for revenue).
   * Shown in the agent catalog AND resolved server-side by metric_query, so
   * an agent asking in the business's own vocabulary still lands on the
   * governed field instead of being refused.
   */
  synonyms?: string[];
  /**
   * Sampled distinct values for a LOW-CARDINALITY categorical dimension,
   * refreshed by Validate (measured from the live source, never authored
   * folklore). What turns the agent's `region = "Europe"` guess — zero rows,
   * no error — into `region = "EMEA"`.
   */
  values?: string[];
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
  /** Business words that mean this metric — see SemanticDimension.synonyms. */
  synonyms?: string[];
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
/**
 * Declared relationship from the model's SOURCE rows to the joined table.
 *
 * This exists because of a measured failure, not a hypothetical one: orders
 * (A=100, B=50) LEFT JOINed to order_items (A has three lines) compiles
 * SUM(orders.amount) to 350 against a truth of 150 — each base row is repeated
 * per matching joined row, and every duplicate-sensitive aggregate silently
 * inflates. Declaring the cardinality lets the compiler REFUSE that query
 * instead of returning a wrong number that looks right.
 *
 * Direction is source → joined: `many_to_one` means many source rows share one
 * joined row (orders → customers, a lookup — safe), `one_to_many` means one
 * source row matches many joined rows (orders → order_items — FANS OUT).
 */
export const JOIN_CARDINALITIES = [
  "many_to_one",
  "one_to_one",
  "one_to_many",
  "many_to_many",
] as const;
export type JoinCardinality = (typeof JOIN_CARDINALITIES)[number];

export type SemanticJoin = {
  /** Table to join (bare or dotted identifier, validated). */
  table: string;
  /** Optional alias, ^[a-zA-Z_][a-zA-Z0-9_]*$ — how fragments refer to it. */
  alias?: string;
  /** Join type; LEFT keeps unmatched source rows (the safe default). */
  type?: "left" | "inner";
  /** Trusted boolean SQL fragment: the ON condition. */
  on: string;
  /**
   * Declared source→joined cardinality. Optional for backwards compatibility:
   * models saved before this existed compile exactly as before, and
   * semanticValidateModel MEASURES the real cardinality either way, so an
   * undeclared fanning join is reported at authoring time rather than
   * silently trusted.
   */
  cardinality?: JoinCardinality;
};

export const MAX_JOINS = 8;

/** Certification states — the same vocabulary catalog assets use. */
export const SEMANTIC_STATUSES = ["draft", "certified", "deprecated"] as const;
export type SemanticStatus = (typeof SEMANTIC_STATUSES)[number];

/**
 * A declared what-if input. Authored SQL fragments reference it as
 * `{{name}}`; the compiler substitutes a literal-escaped value — the query's,
 * else the default — and REFUSES an undeclared or missing-with-no-default
 * parameter. Same trust story as filter values: the NAME is validated, the
 * VALUE is escaped, and no caller-supplied SQL ever passes through.
 */
export type SemanticParameter = {
  /** ^[a-zA-Z_][a-zA-Z0-9_]*$ — how fragments reference it: {{name}}. */
  name: string;
  type: "number" | "string";
  /** Used when the query supplies nothing. Omit to make the parameter required. */
  default?: string | number;
  label?: string;
  description?: string;
};

/** A declared drill path: ordered dimension names, coarsest first. */
export type SemanticHierarchy = {
  name: string;
  /** 2+ existing dimension names, e.g. ["region", "subregion", "city"]. */
  levels: string[];
};

export type SemanticModel = {
  id?: string;
  /** Owner's user id — consumers use it to tell own from shared models. */
  ownerId?: string;
  name: string;
  label?: string;
  description?: string;
  /**
   * Month the fiscal year starts (1–12). Unset = January = calendar. The
   * fiscal grains and fiscal relative windows read this; a fiscal year is
   * NAMED BY THE CALENDAR YEAR IT ENDS IN (July start: Jul 2025–Jun 2026 is
   * FY2026).
   */
  fiscalYearStartMonth?: number;
  /**
   * A fiscal CALENDAR TABLE — for calendars month arithmetic cannot express
   * (retail 4-4-5, 13-period, ISO-week years). One row per day, mapping the
   * day to each declared grain's period via a sequence number (dense integer,
   * increasing with time) and the period's start date. Buckets compile to the
   * START DATE; comparisons step the SEQUENCE, so "previous period" is exact
   * even when neighbouring periods have different lengths. Mutually exclusive
   * with fiscalYearStartMonth — two sources of truth for the same fiscal year
   * would disagree quietly.
   */
  calendar?: SemanticCalendar;
  parameters?: SemanticParameter[];
  hierarchies?: SemanticHierarchy[];
  /**
   * Certification state. "certified" is set only by a server fn that re-ran
   * the full validation pipeline clean, and a DB trigger drops it back to
   * draft when the definition changes — so the badge always refers to the
   * definition that was actually validated.
   */
  status?: SemanticStatus;
  source: SemanticSource;
  /**
   * Column (or expression) that uniquely identifies one row of the SOURCE
   * table — the model's grain, e.g. `order_id`. Owner-trusted fragment, same
   * class as dimension SQL. Optional; when set, Validate measures that it
   * really is unique, and fan-out refusals can name the right count_distinct
   * fix.
   */
  primaryKey?: string;
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
  // Fiscal windows roll along the model's fiscal year (fiscal_year_start_month,
  // default January — in which case they equal their calendar counterparts).
  // On a model with a fiscal CALENDAR TABLE they resolve against that table
  // instead — the window is the set of days the calendar assigns to the
  // period, so a 53-week year or a 5-week period is honoured exactly.
  "this_fiscal_year",
  "last_fiscal_year",
  "this_fiscal_quarter",
  "last_fiscal_quarter",
  "fiscal_ytd",
  // Period windows exist ONLY on calendar-table models — month arithmetic has
  // no notion of a 4-4-5 period, so without a calendar they refuse.
  "this_fiscal_period",
  "last_fiscal_period",
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

export const TIME_GRAINS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  // Fiscal buckets are NUMBERS, not dates: fiscal_year → 2026 (the calendar
  // year the fiscal year ENDS in), fiscal_quarter → 20261 (FY2026 Q1) — a
  // sortable composite, the same trick the AlaSQL grains already use. With a
  // January fiscal start they equal the calendar year/quarter numbers.
  // On a model with a fiscal CALENDAR TABLE, fiscal grains bucket by the
  // period's START DATE from that table instead — a 4-4-5 period has no
  // honest number, but its first day is exact, sortable and chartable.
  "fiscal_year",
  "fiscal_quarter",
  // Calendar-table-only grains: refuse without a declared fiscal calendar.
  "fiscal_period",
  "fiscal_week",
] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];

/** The grains a fiscal calendar table can define, finest to coarsest last. */
export const CALENDAR_GRAINS = [
  "fiscal_year",
  "fiscal_quarter",
  "fiscal_period",
  "fiscal_week",
] as const;
export type CalendarGrain = (typeof CALENDAR_GRAINS)[number];

/** How one calendar grain is stored: its sequence and start-date columns. */
export type SemanticCalendarGrain = {
  /**
   * Column holding a DENSE INTEGER that increases by one per period, across
   * year boundaries (FY2025 P12 → FY2026 P1 must be n → n+1). Comparisons
   * step this number, which is what makes "previous period" exact when
   * neighbouring periods have different lengths.
   */
  seq: string;
  /** Column holding the period's first day, the value queries bucket by. */
  start: string;
};

export type SemanticCalendar = {
  /** The calendar table, one row per day (same reference rules as a join). */
  table: string;
  /** The day column queries join dimension dates against. */
  dateColumn: string;
  /** Grains this calendar defines; at least one. */
  grains: Partial<Record<CalendarGrain, SemanticCalendarGrain>>;
};

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
  /**
   * Values for the model's declared parameters, by name. Undeclared names
   * are refused; a declared parameter with no value and no default is too.
   */
  params?: Record<string, string | number>;
};

/**
 * A pinned metric value: "this metric, under these filters, equals this".
 *
 * Assertions are what turn Validate from "the SQL still runs" into "revenue
 * still means what the board was told". Each one is re-computed on Validate
 * and fails loudly when a definition edit moves a signed-off number.
 *
 * Filters must be ABSOLUTE (no relative-date ops): "ytd = 1.2M" is false by
 * itself next week, and an assertion that goes stale on its own teaches
 * people to ignore assertions.
 */
export type MetricAssertion = {
  /** Metric name on the same model. */
  metric: string;
  /** Absolute filters pinning the window/slice (validated: no relative ops). */
  filters?: SemanticFilter[];
  /** The value the metric must produce. */
  expected: number;
  /**
   * Absolute tolerance. Defaults to |expected| × 1e-9 — enough to absorb
   * float-sum noise across engines, far too small to hide definition drift.
   */
  tolerance?: number;
  /** Why this value is trusted, e.g. "Q1-2025 board deck". */
  label?: string;
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
export function truncateExpr(
  sql: string,
  grain: TimeGrain,
  dialect: SqlDialect,
  /** Fiscal year start month (1–12); only the fiscal grains read it. */
  fiscalStartMonth?: number,
): string {
  // The compiler resolves calendar-table grains BEFORE reaching here; a
  // fiscal_period/fiscal_week that arrives means no calendar is declared, and
  // month arithmetic has nothing honest to say about a 4-4-5 period.
  if (grain === "fiscal_period" || grain === "fiscal_week") {
    throw new Error(
      `The "${grain}" grain needs a fiscal calendar table — declare one in the Source tab.`,
    );
  }
  if (grain === "fiscal_year" || grain === "fiscal_quarter") {
    return fiscalBucketExpr(sql, grain, dialect, fiscalStartMonth ?? 1);
  }
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
  opts: { n?: number; now?: Date; fiscalStartMonth?: number } = {},
): { start: string; end: string } {
  const now = opts.now ?? new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = utcDay(y, m, now.getUTCDate());
  const tomorrow = utcDay(y, m, now.getUTCDate() + 1);

  // Fiscal windows anchor on the model's fiscal year start (default January,
  // in which case they equal the calendar ops). Start of the CURRENT fiscal
  // year: the most recent occurrence of the start month on the 1st.
  const fsm = opts.fiscalStartMonth ?? 1;
  if (!Number.isInteger(fsm) || fsm < 1 || fsm > 12) {
    throw new Error(`Fiscal year start month must be 1–12, got ${String(opts.fiscalStartMonth)}`);
  }
  const fyStart = m >= fsm - 1 ? utcDay(y, fsm - 1, 1) : utcDay(y - 1, fsm - 1, 1);
  /** Months elapsed since the fiscal year started (0–11). */
  const monthsIntoFy = (m - (fsm - 1) + 12) % 12;

  switch (op) {
    case "this_fiscal_period":
    case "last_fiscal_period":
      // A 4-4-5 period is calendar-table DATA; month arithmetic cannot place
      // its boundaries, and guessing "a month" would answer with a different
      // calendar than the one the question was about.
      throw new Error(
        `"${op}" needs a fiscal calendar table — declare one in the model's Source tab.`,
      );
    case "this_fiscal_year":
      return {
        start: isoDay(fyStart),
        end: isoDay(utcDay(fyStart.getUTCFullYear(), fyStart.getUTCMonth() + 12, 1)),
      };
    case "last_fiscal_year":
      return {
        start: isoDay(utcDay(fyStart.getUTCFullYear() - 1, fyStart.getUTCMonth(), 1)),
        end: isoDay(fyStart),
      };
    case "fiscal_ytd":
      // To DATE — fiscal year start through today, half-open like ytd.
      return { start: isoDay(fyStart), end: isoDay(tomorrow) };
    case "this_fiscal_quarter": {
      const qStartMonths = Math.floor(monthsIntoFy / 3) * 3;
      const qs = utcDay(fyStart.getUTCFullYear(), fyStart.getUTCMonth() + qStartMonths, 1);
      return {
        start: isoDay(qs),
        end: isoDay(utcDay(qs.getUTCFullYear(), qs.getUTCMonth() + 3, 1)),
      };
    }
    case "last_fiscal_quarter": {
      const qStartMonths = Math.floor(monthsIntoFy / 3) * 3;
      const qs = utcDay(fyStart.getUTCFullYear(), fyStart.getUTCMonth() + qStartMonths, 1);
      return {
        start: isoDay(utcDay(qs.getUTCFullYear(), qs.getUTCMonth() - 3, 1)),
        end: isoDay(qs),
      };
    }
    default:
      break;
  }

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
  opts: { n?: number; now?: Date; fiscalStartMonth?: number } = {},
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

/** Per-dialect YEAR(x) over a date expression. */
function yearExpr(sql: string, dialect: SqlDialect): string {
  switch (dialect) {
    case "azure_synapse":
    case "mysql":
    case "snowflake":
    case "databricks":
      return `YEAR(${sql})`;
    default:
      // duckdb / postgres / redshift / bigquery.
      return `EXTRACT(YEAR FROM ${sql})`;
  }
}

/** Per-dialect QUARTER(x) (1–4) over a date expression. */
function quarterExpr(sql: string, dialect: SqlDialect): string {
  switch (dialect) {
    case "azure_synapse":
      return `DATEPART(QUARTER, ${sql})`;
    case "mysql":
    case "snowflake":
    case "databricks":
      return `QUARTER(${sql})`;
    case "redshift":
      return `DATE_PART(qtr, ${sql})`;
    default:
      // duckdb / postgres / bigquery.
      return `EXTRACT(QUARTER FROM ${sql})`;
  }
}

/**
 * A FISCAL bucket as a sortable NUMBER: fiscal_year → 2026, fiscal_quarter →
 * 20261 (FY2026 Q1).
 *
 * The trick: shift the date FORWARD by the months remaining to the next
 * fiscal-year boundary, then read the CALENDAR year/quarter of the shifted
 * date. With a July start, 2025-07-15 + 6 months lands in Jan 2026 → FY2026 —
 * the fiscal year is named by the calendar year it ENDS in, and each fiscal
 * quarter maps onto a calendar quarter of the shifted date exactly. With a
 * January start the shift is zero months and the buckets equal the calendar
 * numbers, so a model that never sets a fiscal start is unaffected.
 *
 * Numbers rather than dates or labels because they sort correctly in every
 * engine and chart with zero per-dialect string formatting.
 */
function fiscalBucketExpr(
  sql: string,
  grain: "fiscal_year" | "fiscal_quarter",
  dialect: SqlDialect,
  startMonth: number,
): string {
  if (dialect === "alasql") {
    throw new Error(
      "Fiscal grains need date arithmetic, which the AlaSQL engine does not have. " +
        "Remove LOCAL_ENGINE=alasql to use the default engine.",
    );
  }
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new Error(`Fiscal year start month must be 1–12, got ${String(startMonth)}`);
  }
  const offset = (13 - startMonth) % 12;
  const shifted = dateAddExpr(sql, offset, "month", dialect);
  return grain === "fiscal_year"
    ? yearExpr(shifted, dialect)
    : `(${yearExpr(shifted, dialect)} * 10 + ${quarterExpr(shifted, dialect)})`;
}

// ── Fiscal calendar tables ─────────────────────────────────────────────────
//
// A 4-4-5 (or 13-period, or ISO-week) calendar cannot be computed from a
// date — it is DATA: one row per day, declaring which period the day belongs
// to. The compiler joins that table and buckets by the period's START DATE.
// Two properties are load-bearing:
//
//   * The base join is a GROUPED derived table (one row per day BY
//     CONSTRUCTION), so a dirty calendar with duplicate days can surface as
//     wrong period labels for those days but can never multiply fact rows —
//     the layer's cardinal sin. Validate measures the duplication instead.
//   * Comparisons step the period's SEQUENCE NUMBER via a second, DISTINCT
//     (seq, start) derived table joined on `seq + n` — the prior side buckets
//     each row into its successor period's start, so the existing equality
//     stitch works untouched and no window functions are needed (Synapse has
//     no WITH-in-derived-table; every dialect here accepts a plain subquery).

/** `CAST(x AS DATE)` in the dialect's spelling (lossy-tolerant on DuckDB). */
function castDateExpr(sql: string, dialect: SqlDialect): string {
  switch (dialect) {
    case "alasql":
      throw new Error(
        "Fiscal calendar tables need real SQL joins, which the AlaSQL engine does not have. " +
          "Remove LOCAL_ENGINE=alasql to use the default engine.",
      );
    case "duckdb":
      // Local date columns are ISO TEXT typed by inference; one unparseable
      // value must become NULL, not abort the query.
      return `TRY_CAST(${sql} AS DATE)`;
    case "bigquery":
      return `DATE(${sql})`;
    default:
      return `CAST(${sql} AS DATE)`;
  }
}

/** A calendar column name: bare identifier only, checked before embedding. */
function assertCalendarIdent(name: string, what: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Fiscal calendar ${what} ${JSON.stringify(name)} must be a bare identifier`);
  }
  return name;
}

/**
 * The calendar mapping for `grain`, or a refusal that names the fix — an
 * unmapped grain must not fall back to month arithmetic, which would answer
 * with a DIFFERENT calendar than the one the model declared.
 */
function calendarGrainCols(cal: SemanticCalendar, grain: CalendarGrain): SemanticCalendarGrain {
  const cols = cal.grains[grain];
  if (!cols) {
    const mapped = Object.keys(cal.grains).join(", ") || "none";
    throw new Error(
      `The fiscal calendar does not define "${grain}" (defined: ${mapped}). ` +
        `Map its sequence and start columns in the Source tab.`,
    );
  }
  assertCalendarIdent(cols.seq, `"${grain}" sequence column`);
  assertCalendarIdent(cols.start, `"${grain}" start column`);
  return cols;
}

/** FROM-clause alias of the per-day calendar join for dimension `name`. */
function calAlias(dimName: string): string {
  return `semantic_cal__${dimName}`;
}

/** FROM-clause alias of the shifted (seq + n) period join for `name`. */
function cal2Alias(dimName: string): string {
  return `semantic_cal2__${dimName}`;
}

/**
 * The per-day calendar join for one time dimension: a grouped derived table
 * keyed on the day, projecting every mapped grain's seq/start via MIN() —
 * one row per day whatever the table holds, so this join can never fan out.
 */
function calendarBaseJoin(
  cal: SemanticCalendar,
  dimName: string,
  rawSql: string,
  dialect: SqlDialect,
): string {
  const table = assertTableRef(cal.table);
  const day = assertCalendarIdent(cal.dateColumn, "day column");
  const cols = new Set<string>();
  for (const grain of CALENDAR_GRAINS) {
    const g = cal.grains[grain];
    if (!g) continue;
    cols.add(assertCalendarIdent(g.seq, `"${grain}" sequence column`));
    cols.add(assertCalendarIdent(g.start, `"${grain}" start column`));
  }
  if (cols.size === 0) throw new Error("The fiscal calendar defines no grains.");
  const projected = [...cols].map((c) => `MIN(${c}) AS ${c}`).join(", ");
  const inner = `SELECT ${day} AS semantic_cal_day, ${projected} FROM ${table} GROUP BY ${day}`;
  return ` LEFT JOIN (${inner}) AS ${calAlias(dimName)} ON ${calAlias(dimName)}.semantic_cal_day = ${castDateExpr(rawSql, dialect)}`;
}

/**
 * The comparison join: the DISTINCT (seq, start) period list, joined `n`
 * periods ahead of the row's own period. Reading its start buckets each prior
 * row into the period it should be COMPARED AGAINST — the calendar-table
 * analogue of the shift-forward date arithmetic below. A period beyond the
 * calendar's edge finds no row and buckets NULL, which the stitch reads as
 * "no predecessor", the same honesty rule as everywhere else.
 */
function calendarShiftJoin(
  cal: SemanticCalendar,
  dimName: string,
  grain: CalendarGrain,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Calendar comparison shift must be a positive whole number, got ${String(n)}`);
  }
  const table = assertTableRef(cal.table);
  const g = calendarGrainCols(cal, grain);
  const inner = `SELECT DISTINCT ${g.seq} AS semantic_seq, ${g.start} AS semantic_start FROM ${table}`;
  return ` LEFT JOIN (${inner}) AS ${cal2Alias(dimName)} ON ${cal2Alias(dimName)}.semantic_seq = ${calAlias(dimName)}.${g.seq} + ${n}`;
}

/**
 * The relative fiscal windows, resolved against the CALENDAR TABLE: the
 * window is the set of days the calendar assigns to the anchor period, found
 * by an uncorrelated scalar subquery on today's sequence number. MIN() keeps
 * the subquery scalar even on a dirty calendar; a `now` outside the calendar
 * yields NULL → an empty window — an honest nothing, and Validate reports the
 * coverage gap.
 */
function calendarWindowExpr(
  rawSql: string,
  op: RelativeDateOp,
  cal: SemanticCalendar,
  dialect: SqlDialect,
  now: Date | undefined,
): string {
  const table = assertTableRef(cal.table);
  const day = assertCalendarIdent(cal.dateColumn, "day column");
  const spec: Partial<
    Record<RelativeDateOp, { grain: CalendarGrain; back: number; toDate?: boolean }>
  > = {
    this_fiscal_year: { grain: "fiscal_year", back: 0 },
    last_fiscal_year: { grain: "fiscal_year", back: 1 },
    fiscal_ytd: { grain: "fiscal_year", back: 0, toDate: true },
    this_fiscal_quarter: { grain: "fiscal_quarter", back: 0 },
    last_fiscal_quarter: { grain: "fiscal_quarter", back: 1 },
    this_fiscal_period: { grain: "fiscal_period", back: 0 },
    last_fiscal_period: { grain: "fiscal_period", back: 1 },
  };
  const s = spec[op];
  if (!s) throw new Error(`"${op}" is not a fiscal window`);
  const g = calendarGrainCols(cal, s.grain);
  const nowIso = isoDay(now ?? new Date());
  const nowLit = dateLiteral(nowIso, dialect);
  const nowSeq = `SELECT MIN(${g.seq}) FROM ${table} WHERE ${day} = ${nowLit}`;
  const seqRef = s.back === 0 ? `(${nowSeq})` : `(${nowSeq}) - ${s.back}`;
  // The projection is cast so the IN compares DATE to DATE everywhere — local
  // datasets store days as ISO TEXT, and DuckDB coerces `=` but refuses a
  // mixed-type IN.
  let daysOfPeriod = `SELECT ${castDateExpr(day, dialect)} FROM ${table} WHERE ${g.seq} = ${seqRef}`;
  if (s.toDate) daysOfPeriod += ` AND ${day} <= ${nowLit}`;
  return `${castDateExpr(rawSql, dialect)} IN (${daysOfPeriod})`;
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
    // One fiscal quarter back is three months back whatever the start month —
    // shifting the raw date moves the fiscal bucket by exactly one, so the
    // calendar shifts carry over unchanged.
    case "fiscal_quarter":
      return { n: 3, unit: "month" };
    case "year":
    case "fiscal_year":
      return { n: 1, unit: "year" };
    case "fiscal_period":
    case "fiscal_week":
      // Only reachable without a declared calendar (axisShiftSpec routes
      // calendar models to a sequence shift); the grain itself needs one.
      throw new Error(
        `The "${grain}" grain needs a fiscal calendar table — declare one in the Source tab.`,
      );
  }
}

/**
 * How a comparison steps the axis: date arithmetic for computable calendars,
 * a SEQUENCE step for calendar-table grains — where only steps with a
 * provably constant length are allowed. `prior_period` is always one period.
 * `yoy` is one fiscal year (seq +1) or four fiscal quarters (+4); a fiscal
 * year holds no fixed number of PERIODS (12 in 4-4-5, 13 in four-week
 * calendars) or WEEKS (52 vs 53), so those refuse rather than guess.
 */
function axisShiftSpec(
  model: SemanticModel,
  period: ComparePeriod,
  grain: TimeGrain,
): { n: number; unit: DateAddUnit } | { n: number; calendarGrain: CalendarGrain } {
  if (model.calendar && (CALENDAR_GRAINS as readonly string[]).includes(grain)) {
    const g = grain as CalendarGrain;
    // Refuse an unmapped grain here with the naming error, not deeper in.
    calendarGrainCols(model.calendar, g);
    if (period === "prior_period") return { n: 1, calendarGrain: g };
    if (period === "yoy") {
      if (g === "fiscal_year") return { n: 1, calendarGrain: g };
      if (g === "fiscal_quarter") return { n: 4, calendarGrain: g };
      throw new Error(
        `"yoy" cannot step a ${g === "fiscal_period" ? "fiscal period" : "fiscal week"} on a ` +
          `calendar table — a fiscal year holds no fixed number of them ` +
          `(${g === "fiscal_period" ? "12 in 4-4-5, 13 in four-week calendars" : "52 vs 53 weeks"}). ` +
          `Use prior_period.`,
      );
    }
    throw new Error(
      `"mom" has no meaning on a fiscal calendar's ${g.replace(/_/g, " ")} — use prior_period.`,
    );
  }
  return compareShift(period, grain);
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
  opts: {
    dim?: SemanticDimension;
    now?: Date;
    fiscalStartMonth?: number;
    calendar?: SemanticCalendar;
  } = {},
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
    // Fiscal windows on a calendar-table model resolve against the TABLE —
    // the window is the set of days the calendar assigns to the period, so a
    // 53-week year or a 5-week period is honoured exactly. (Still the RAW
    // column, same as below.)
    if (opts.calendar && f.op.includes("fiscal")) {
      return calendarWindowExpr(dim.sql, f.op, opts.calendar, dialect, opts.now);
    }
    // The RAW column, never the grain-wrapped expression. Filtering "last 30
    // days" against a dimension grained to month would compare the bucket
    // label rather than the row's date, so a query grouped by month would
    // silently filter by month — right-looking output, wrong rows.
    const n = typeof f.value === "number" ? f.value : Number(f.value);
    return relativeDateExpr(dim.sql, f.op, dialect, {
      n,
      now: opts.now,
      fiscalStartMonth: opts.fiscalStartMonth,
    });
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
    // {{parameters}} are for dimension/metric fragments. A parameterised join
    // would change the GRAPH per caller — cardinality declarations, fan-out
    // refusals and measured probes would all be describing a different query.
    // Refused here with a real message, not left to die as an engine syntax
    // error on the literal braces. (match(), not test() — the shared regex is
    // /g and test() would carry lastIndex state between joins.)
    if (on.match(PARAM_TOKEN_RE)) {
      throw new Error(
        `Join on "${j.table}" uses a {{parameter}} — join conditions must stay structural.`,
      );
    }
    out += ` ${kw} ${table}${j.alias ? ` AS ${j.alias}` : ""} ON (${on})`;
  }
  return out;
}

// ── Fan-out safety ─────────────────────────────────────────────────────────
//
// A join declared one_to_many/many_to_many repeats each source row per match,
// so SUM/AVG/COUNT over source-side columns double-counts — measured: 350
// against a truth of 150 on a two-line fixture. These checks make that query
// impossible to COMPILE rather than merely unwise. Joins with no declared
// cardinality are exempt here (existing models must keep compiling) and are
// measured by semanticValidateModel instead.

/** Does this join multiply source rows? */
function isFanningJoin(j: SemanticJoin): boolean {
  return j.cardinality === "one_to_many" || j.cardinality === "many_to_many";
}

/** How authored SQL refers to a joined table: alias, else last name segment. */
export function joinQualifier(j: SemanticJoin): string {
  return (j.alias ?? j.table.split(".").pop() ?? j.table).toLowerCase();
}

/**
 * The bare identifiers used as `qualifier.` prefixes in an authored fragment.
 *
 * String literals and quoted identifiers are stripped first, so `'a.b'` in a
 * literal and a dot inside a quoted name are not misread as references. A
 * QUOTED qualifier therefore reads as "no reference", which errs toward
 * refusal — the safe direction — and the refusal message says how to qualify.
 */
export function qualifiedRefsIn(sql: string): string[] {
  const cleaned = sql
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/`[^`]*`/g, " ");
  const refs = new Set<string>();
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) refs.add(m[1].toLowerCase());
  return [...refs];
}

type FanoutContext = {
  /** Joins declared one_to_many / many_to_many. */
  fanning: SemanticJoin[];
  fanningQuals: Set<string>;
  /** Every qualifier the model defines: source table + all join qualifiers. */
  knownQuals: Set<string>;
  primaryKey?: string;
};

function fanoutContext(model: SemanticModel): FanoutContext | null {
  const joins = model.joins ?? [];
  const fanning = joins.filter(isFanningJoin);
  if (fanning.length === 0) return null;
  const knownQuals = new Set<string>([
    (model.source.table.split(".").pop() ?? model.source.table).toLowerCase(),
    ...joins.map(joinQualifier),
  ]);
  return {
    fanning,
    fanningQuals: new Set(fanning.map(joinQualifier)),
    knownQuals,
    primaryKey: model.primaryKey,
  };
}

/** Metric names referenced by a derived formula (non-recursive). */
function metricRefsIn(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(METRIC_REF_RE)) out.push(m[1]);
  return out;
}

/**
 * Throw unless `m` is safe to aggregate over this model's fanned join result.
 *
 * Duplicate-INSENSITIVE aggregations (count_distinct, min, max) pass — a
 * repeated value changes none of them. `custom` passes because it is the
 * documented owner-trusted escape hatch (e.g. an author who pre-aggregates in
 * a subquery); `derived` is checked at its leaves. SUM/AVG must reference the
 * fanning table's columns ONLY, and COUNT must count something on the fanning
 * side (a filtered count over its columns) — never raw joined rows.
 */
function assertMetricFanoutSafe(
  m: SemanticMetric,
  ctx: FanoutContext,
  byName: Map<string, SemanticMetric>,
  resolving: Set<string> = new Set(),
): void {
  if (m.agg === "count_distinct" || m.agg === "min" || m.agg === "max") return;
  if (m.agg === "custom") return;
  if (m.agg === "derived") {
    if (resolving.has(m.name)) return; // cycle — resolveMetricExpr reports it properly
    resolving.add(m.name);
    for (const ref of metricRefsIn(m.sql ?? "")) {
      const target = byName.get(ref);
      if (target) assertMetricFanoutSafe(target, ctx, byName, resolving);
    }
    resolving.delete(m.name);
    return;
  }

  // sum / avg / count — duplicate-sensitive from here on.
  const joinList = ctx.fanning.map((j) => `"${joinQualifier(j)}"`).join(" and ");
  if (ctx.fanning.length > 1) {
    throw new Error(
      `Metric "${m.name}" (${m.agg}) cannot be computed on this model: joins ${joinList} ` +
        `both fan out, so their matches multiply each other and any SUM/AVG/COUNT ` +
        `double-counts whichever table it reads. Use count_distinct/min/max, a custom ` +
        `metric that pre-aggregates, or split the model.`,
    );
  }
  const fan = joinQualifier(ctx.fanning[0]);

  // For SUM/AVG the aggregated EXPRESSION decides; a metric filter is a
  // per-row condition and cannot duplicate values. For COUNT there is no
  // expression, so the filter is what places the count on the fanning side.
  const frags = m.agg === "count" ? (m.filters ?? []) : [m.sql ?? ""];
  const refs = frags.flatMap(qualifiedRefsIn);
  const known = refs.filter((r) => ctx.knownQuals.has(r));

  if (m.agg === "count") {
    if (known.length > 0 && known.every((r) => ctx.fanningQuals.has(r))) return;
    throw new Error(
      `Metric "${m.name}" (count) counts JOINED rows — with the fanning join "${fan}" that ` +
        `is once per match, not once per ${srcName(ctx)} row (and once even with no match). ` +
        `Count the source with count_distinct${ctx.primaryKey ? ` over ${ctx.primaryKey}` : " over its key"}, ` +
        `or count "${fan}" rows with a filtered count over its columns (e.g. ${fan}.id IS NOT NULL).`,
    );
  }

  if (known.length === 0) {
    throw new Error(
      `Metric "${m.name}" (${m.agg}) is ambiguous with the fanning join "${fan}": qualify the ` +
        `column(s) in ${JSON.stringify(m.sql ?? "")} (e.g. ${fan}.amount or ${srcName(ctx)}.amount) ` +
        `so the compiler can verify it does not double-count.`,
    );
  }
  if (!known.every((r) => ctx.fanningQuals.has(r))) {
    const offender = known.find((r) => !ctx.fanningQuals.has(r));
    throw new Error(
      `Metric "${m.name}" (${m.agg} over ${JSON.stringify(m.sql ?? "")}) would double-count: ` +
        `the join "${fan}" is one-to-many, so each "${offender}" row is repeated once per ` +
        `matching "${fan}" row before aggregation. Aggregate "${fan}" columns instead, use ` +
        `count_distinct/min/max, or make it a custom metric that pre-aggregates "${offender}".`,
    );
  }
}

function srcName(ctx: FanoutContext): string {
  for (const q of ctx.knownQuals) if (!ctx.fanningQuals.has(q)) return q;
  return "source";
}

// ── Chasm resolution ───────────────────────────────────────────────────────
//
// When the fan-out check above would refuse a query, the compiler now tries a
// MULTI-FACT PLAN before giving up: each metric is aggregated inside its own
// branch — the source plus only the fanning join its columns actually need —
// at the grain of the requested dimensions, and the per-branch aggregates are
// stitched back together on a dimension spine. Measured on the two-order
// fixture that motivated the refusal: SUM(orders.amount) joined to line items
// said 350 against a truth of 150; the same query now compiles to a plan
// where orders total 150 AND the item metrics are right, in one result.
//
// The envelope is deliberately explicit, and everything outside it still
// REFUSES with the original error plus the reason resolution did not apply:
//   - every declared fanning join must be LEFT (an INNER fanning join is a
//     row filter that cannot be kept without duplicating source rows);
//   - dimensions must not read from a fanning join's columns (grouping base
//     metrics by a fanning table needs primary-key deduplication — roadmap);
//   - a metric may reference at most ONE fanning join (an expression over two
//     facts has no single grain to aggregate at);
//   - period-over-period over a multi-fact plan is not supported yet;
//   - AlaSQL is refused (no CTEs), matching the comparison path.

/**
 * A derived metric's formula with every non-derived leaf rendered by
 * `leafRef` instead of inlined — the multi-fact plan computes leaves inside
 * their branches and evaluates the formula OVER the branch columns, which is
 * algebraically the single-pass inlining evaluated in two steps.
 */
function expandDerivedFormula(
  m: SemanticMetric,
  byName: Map<string, SemanticMetric>,
  leafRef: (name: string) => string,
  resolving: Set<string> = new Set(),
): string {
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
    return target.agg === "derived"
      ? `(${expandDerivedFormula(target, byName, leafRef, resolving)})`
      : leafRef(target.name);
  });
  resolving.delete(m.name);
  if (!referenced) {
    throw new Error(
      `Derived metric "${m.name}" references no other metric — use {metric_name} tokens.`,
    );
  }
  return out;
}

/** The non-derived metrics a metric ultimately computes from (itself if a leaf). */
function chasmLeaves(
  m: SemanticMetric,
  byName: Map<string, SemanticMetric>,
  resolving: Set<string> = new Set(),
): SemanticMetric[] {
  if (m.agg !== "derived") return [m];
  if (resolving.has(m.name)) {
    throw new Error(`Derived metric "${m.name}" has a circular reference`);
  }
  resolving.add(m.name);
  const out: SemanticMetric[] = [];
  for (const ref of metricRefsIn(m.sql ?? "")) {
    const target = byName.get(ref);
    if (!target) throw new Error(`Derived metric "${m.name}" references unknown metric "${ref}"`);
    out.push(...chasmLeaves(target, byName, resolving));
  }
  resolving.delete(m.name);
  return out;
}

/**
 * Which branch computes a leaf metric.
 *
 * Keys: "" is the base branch (source + non-fanning joins only), a fanning
 * join's qualifier is its own branch (base joins + that join), and "*" is the
 * FULL single-pass scope (every join) — reserved for duplicate-insensitive
 * and custom metrics whose binding today's single pass already accepts, so a
 * multi-fact plan never changes what an already-legal metric computes.
 *
 * The rules resolve only what is PROVABLY unambiguous:
 *   - sum/avg reading exactly one fanning join → that branch, at that fact's
 *     grain (a mixed source×fact expression evaluates once per fact row —
 *     the parent column is an attribute there, not a duplication);
 *   - sum/avg reading only source/lookup columns → the base branch;
 *   - sum/avg with NO qualified reference stays REFUSED: assigning a branch
 *     would silently choose which table an ambiguous column binds to;
 *   - count is anchored by its FILTERS (it has no expression): fanning-side
 *     filters → that branch, source-side filters → base, and a bare count
 *     stays refused — "count of what" has no provable answer on this model;
 *   - count_distinct/min/max/custom keep their single-pass scope ("*") unless
 *     they name exactly one side, in which case the cheaper branch is
 *     equivalent (duplicates change none of them; custom is owner-trusted).
 */
function chasmBranchOf(m: SemanticMetric, ctx: FanoutContext): string {
  const dupSensitive = m.agg === "sum" || m.agg === "avg" || m.agg === "count";
  const frags = m.agg === "count" ? (m.filters ?? []) : [m.sql ?? "", ...(m.filters ?? [])];
  const known = [...new Set(frags.flatMap(qualifiedRefsIn).filter((r) => ctx.knownQuals.has(r)))];
  const fanRefs = known.filter((r) => ctx.fanningQuals.has(r));

  if (fanRefs.length > 1) {
    if (!dupSensitive) return "*";
    throw new Error(
      `Metric "${m.name}" reads from ${fanRefs.map((r) => `"${r}"`).join(" and ")}, which both ` +
        `fan out — an expression across two facts has no single grain to aggregate at. ` +
        `Split it into per-fact metrics and combine them with a derived metric.`,
    );
  }
  if (dupSensitive && known.length === 0) {
    const what = m.agg === "count" ? "a bare count has no anchor" : "an unqualified column";
    throw new Error(
      `Metric "${m.name}" (${m.agg}) is ambiguous on this model: ${what}, so no branch of a ` +
        `multi-fact plan can prove which table it aggregates. Qualify the column(s) ` +
        `(e.g. ${srcName(ctx)}.amount or ${[...ctx.fanningQuals][0]}.amount)` +
        (m.agg === "count"
          ? `, or use count_distinct over ${ctx.primaryKey ?? "the source key"}.`
          : `.`),
    );
  }
  if (fanRefs.length === 1) return fanRefs[0];
  return dupSensitive ? "" : known.length > 0 ? "" : "*";
}

/**
 * The model's primary key as a query expression — a bare identifier is
 * qualified with the source table so it stays unambiguous once joins are
 * present; an authored expression is trusted as written. The same rule
 * fanoutProbeSql applies, for the same reason.
 */
function qualifiedPkExpr(model: SemanticModel, dialect: SqlDialect): string {
  const pk = (model.primaryKey ?? "").trim();
  const from = assertTableRef(model.source.table);
  const baseQual = from.startsWith('"') ? from : (from.split(".").pop() ?? from);
  return IDENT_RE.test(pk) ? `${baseQual}.${pk}` : normaliseIdentQuotes(pk, dialect);
}

/**
 * A duplicate-sensitive aggregate rebuilt to run OVER the deduplicated
 * subquery's aliased columns: the inner SELECT DISTINCT carries the metric's
 * value expression and each filter fragment as named columns, and the outer
 * aggregate references only those names. Anything else reaching here is an
 * internal error — planChasm routes duplicate-insensitive and custom
 * metrics to the full-scope branch under deduplication.
 */
function dedupAggParts(
  m: SemanticMetric,
  idx: number,
  qi: (name: string) => string,
): { innerCols: string[]; outerExpr: string } {
  const vAlias = qi(`semantic_v${idx}`);
  const fAliases = (m.filters ?? []).map((_, j) => qi(`semantic_v${idx}_f${j}`));
  const innerCols: string[] = [];
  if (m.agg !== "count") innerCols.push(`(${m.sql ?? ""}) AS ${vAlias}`);
  (m.filters ?? []).forEach((frag, j) => innerCols.push(`(${frag}) AS ${fAliases[j]}`));

  const guard = fAliases.length ? fAliases.join(" AND ") : null;
  let outerExpr: string;
  switch (m.agg) {
    case "sum":
    case "avg": {
      const arg = guard ? `CASE WHEN ${guard} THEN ${vAlias} END` : vAlias;
      outerExpr = `${m.agg.toUpperCase()}(${arg})`;
      break;
    }
    case "count":
      // Anchored counts only — a bare count was refused long before here.
      outerExpr = `COUNT(${guard ? `CASE WHEN ${guard} THEN 1 END` : "*"})`;
      break;
    default:
      throw new Error(`Metric "${m.name}" (${m.agg}) cannot be deduplicated — internal error`);
  }
  return { innerCols, outerExpr };
}

type ChasmPlan = {
  /** Branch key ("" = base) → the leaf metrics that branch computes. */
  branches: Array<{ key: string; join: SemanticJoin | null; metricNames: string[] }>;
  /** Requested metrics in order, with how the outer SELECT renders each. */
  outer: Array<{ name: string; leaf: boolean }>;
  /**
   * Set when the requested dimensions read from ONE fanning join: the base
   * branch (and the spine) must include this join, and the base branch
   * deduplicates by the model's primary key — each source row counted once
   * per distinct dimension combination it relates to, the standard
   * related-table attribution semantics.
   */
  dedupJoin: SemanticJoin | null;
};

/**
 * Decide whether the refused query fits the multi-fact envelope, and lay out
 * its branches if so. Throws the ORIGINAL refusal — with the reason
 * resolution could not apply appended — whenever it does not.
 */
function planChasm(args: {
  model: SemanticModel;
  q: SemanticQuery;
  dims: string[];
  metrics: string[];
  dimByName: Map<string, SemanticDimension>;
  metricByName: Map<string, SemanticMetric>;
  ctx: FanoutContext;
  dialect: SqlDialect;
  refusal: Error;
}): ChasmPlan {
  const { model, q, dims, metrics, dimByName, metricByName, ctx, dialect, refusal } = args;
  const blocked = (why: string): never => {
    throw new Error(`${refusal.message} A multi-fact plan could not resolve this: ${why}`);
  };

  if (dialect === "alasql") {
    blocked("the AlaSQL engine has no CTEs. Remove LOCAL_ENGINE=alasql to use the default engine.");
  }
  for (const j of ctx.fanning) {
    if (j.type === "inner") {
      blocked(
        `join "${joinQualifier(j)}" is INNER and fans out; its row filter cannot be kept ` +
          `without duplicating source rows. Make it LEFT, or pre-aggregate in a custom metric.`,
      );
    }
  }
  // A non-fanning join whose ON reads a fanning alias cannot be compiled into
  // a branch that lacks that fanning join.
  for (const j of model.joins ?? []) {
    if (isFanningJoin(j)) continue;
    const onRefs = qualifiedRefsIn(j.on ?? "");
    const bad = onRefs.find((r) => ctx.fanningQuals.has(r));
    if (bad) {
      blocked(
        `join "${joinQualifier(j)}" is chained through the fanning join "${bad}", so no ` +
          `branch can include it alone.`,
      );
    }
  }
  // Dimensions reading from a fanning join: allowed from exactly ONE such
  // join, and only with a declared primary key — the base branch keeps that
  // join and DEDUPLICATES by the key, so each source row counts once per
  // distinct dimension combination it relates to (Tableau's related-table
  // attribution). Two fact-side dimension sources have no shared row
  // identity to deduplicate on, so they stay refused.
  const joinByQual = new Map((model.joins ?? []).map((j) => [joinQualifier(j), j]));
  const dimFanQuals = new Set<string>();
  for (const name of dims) {
    const d = dimByName.get(name);
    if (!d) continue; // authoritative unknown-dimension error comes from the builder
    for (const r of qualifiedRefsIn(d.sql)) if (ctx.fanningQuals.has(r)) dimFanQuals.add(r);
  }
  if (dimFanQuals.size > 1) {
    blocked(
      `the requested dimensions read from ${[...dimFanQuals].map((r) => `"${r}"`).join(" and ")}, ` +
        `which both fan out — there is no shared row identity to deduplicate on.`,
    );
  }
  const dedupQual = [...dimFanQuals][0] ?? null;
  if (dedupQual && !model.primaryKey?.trim()) {
    blocked(
      `dimension(s) read from the fanning join "${dedupQual}", and grouping the other metrics ` +
        `by it needs primary-key deduplication — declare the model's primary key (Source tab).`,
    );
  }
  const dedupJoin = dedupQual ? (joinByQual.get(dedupQual) ?? null) : null;

  // Assign every leaf metric a branch; requested order is preserved.
  const byBranch = new Map<string, string[]>();
  const outer: ChasmPlan["outer"] = [];
  for (const name of metrics) {
    const m = metricByName.get(name);
    if (!m) {
      throw new Error(
        `Unknown metric "${name}" (available: ${[...metricByName.keys()].join(", ") || "none"})`,
      );
    }
    outer.push({ name, leaf: m.agg !== "derived" });
    for (const leaf of chasmLeaves(m, metricByName)) {
      let key = chasmBranchOf(leaf, ctx);
      if (dedupQual) {
        const dupSensitive = leaf.agg === "sum" || leaf.agg === "avg" || leaf.agg === "count";
        if (!dupSensitive && key !== dedupQual) {
          // Deduplication rewrites aggregates over aliased columns, which a
          // custom expression cannot survive — and duplicate-insensitive
          // metrics need no dedup at all. They take the full single-pass
          // scope instead, which contains every join the dimensions need.
          key = "*";
        } else if (dupSensitive && key !== "" && key !== dedupQual) {
          blocked(
            `metric "${leaf.name}" reads from the fanning join "${key}", but the dimensions ` +
              `group by "${dedupQual}" — "${key}" rows have no key to deduplicate by under ` +
              `that grouping. Split the query, or add a dimension from "${key}" instead.`,
          );
        }
      }
      const list = byBranch.get(key) ?? [];
      if (!list.includes(leaf.name)) list.push(leaf.name);
      byBranch.set(key, list);
    }
  }

  const branches: ChasmPlan["branches"] = [...byBranch.entries()].map(([key, metricNames]) => ({
    key,
    join: key === "" ? null : (joinByQual.get(key) ?? null),
    metricNames,
  }));
  return { branches, outer, dedupJoin };
}

/**
 * The COUNT probes semanticValidateModel runs to MEASURE a model instead of
 * trusting it: the base row count (plus COUNT(DISTINCT primary_key), which is
 * the grain check), then the same count after each join cumulatively — the
 * step where the count jumps is the join that fans out, whatever its
 * declaration says.
 *
 * When a primary key is declared the probes also count DISTINCT keys through
 * the joins, which catches fan-out that an INNER join's row-dropping would
 * hide from a bare COUNT(*).
 *
 * Built here because it must render joins EXACTLY as compiled queries do
 * (same compileJoins, same quoting) — a measurement of slightly different SQL
 * would measure a slightly different question.
 */
export function fanoutProbeSql(
  model: SemanticModel,
  dialect: SqlDialect,
): { baseSql: string; steps: Array<{ join: SemanticJoin; sql: string }> } | null {
  const joins = model.joins ?? [];
  const pk = model.primaryKey?.trim();
  if (joins.length === 0 && !pk) return null;
  const from = assertTableRef(model.source.table);
  const baseQual = from.startsWith('"') ? from : (from.split(".").pop() ?? from);
  // A bare-identifier key is qualified with the source table so it stays
  // unambiguous once joins are added; an expression (or already-qualified
  // key) is trusted as authored.
  const qpk = pk
    ? IDENT_RE.test(pk)
      ? `${baseQual}.${pk}`
      : normaliseIdentQuotes(pk, dialect)
    : null;
  const select =
    `SELECT COUNT(*) AS ${quoteIdent("n", dialect)}` +
    (qpk ? `, COUNT(DISTINCT ${qpk}) AS ${quoteIdent("d", dialect)}` : "") +
    ` FROM ${from}`;
  return {
    baseSql: select,
    steps: joins.map((j, i) => ({
      join: j,
      sql: select + compileJoins(joins.slice(0, i + 1), dialect),
    })),
  };
}

/** `days between a and b` (b − a), in the dialect's spelling. */
function dateDiffDaysExpr(a: string, b: string, dialect: SqlDialect): string {
  switch (dialect) {
    case "alasql":
      throw new Error("The AlaSQL engine has no date arithmetic.");
    case "snowflake":
    case "azure_synapse":
    case "databricks":
      return `DATEDIFF(day, ${a}, ${b})`;
    case "mysql":
      return `DATEDIFF(${b}, ${a})`;
    case "bigquery":
      return `DATE_DIFF(${b}, ${a}, DAY)`;
    default:
      // duckdb / postgres / redshift: DATE − DATE is integer days.
      return `(${b} - ${a})`;
  }
}

/**
 * The probes Validate runs against a declared FISCAL CALENDAR TABLE — the
 * compiler already guarantees a dirty calendar cannot multiply rows (the join
 * is grouped), so these measure what dirt CAN do: mislabel days, leave days
 * unmapped, or break the sequence order comparisons step along.
 */
export function calendarProbeSql(
  model: SemanticModel,
  dialect: SqlDialect,
): {
  /** COUNT(*), COUNT(DISTINCT day), MIN(day), MAX(day), span in days. */
  shapeSql: string;
  grains: Array<{
    grain: CalendarGrain;
    /** Sequences mapped to MORE THAN ONE start date (must be 0). */
    conflictSql: string;
    /** Consecutive sequences whose starts are not strictly increasing (0). */
    orderSql: string;
  }>;
} | null {
  const cal = model.calendar;
  if (!cal) return null;
  const table = assertTableRef(cal.table);
  const day = assertCalendarIdent(cal.dateColumn, "day column");
  const qd = (name: string) => quoteIdent(name, dialect);
  const dayDate = castDateExpr(day, dialect);
  const shapeSql =
    `SELECT COUNT(*) AS ${qd("n")}, COUNT(DISTINCT ${day}) AS ${qd("days")}, ` +
    `MIN(${dayDate}) AS ${qd("lo")}, MAX(${dayDate}) AS ${qd("hi")}, ` +
    `${dateDiffDaysExpr(`MIN(${dayDate})`, `MAX(${dayDate})`, dialect)} AS ${qd("span")} ` +
    `FROM ${table}`;
  const grains = CALENDAR_GRAINS.filter((g) => cal.grains[g]).map((grain) => {
    const g = calendarGrainCols(cal, grain);
    const periods = `SELECT DISTINCT ${g.seq} AS q, ${g.start} AS st FROM ${table}`;
    return {
      grain,
      conflictSql:
        `SELECT COUNT(*) AS ${qd("bad")} FROM (` +
        `SELECT ${g.seq} AS q FROM ${table} GROUP BY ${g.seq} HAVING COUNT(DISTINCT ${g.start}) > 1` +
        `) AS semantic_conflicts`,
      orderSql:
        `SELECT COUNT(*) AS ${qd("bad")} FROM (${periods}) AS a ` +
        `JOIN (${periods}) AS b ON b.q = a.q + 1 WHERE b.st <= a.st`,
    };
  });
  return { shapeSql, grains };
}

/**
 * The DISTINCT-values probe Validate runs per CATEGORICAL dimension.
 *
 * Asks for `cap + 1` values so the caller can tell "exactly cap" from "more
 * than cap" — a dimension with more distinct values than the cap is
 * high-cardinality and gets NO stored values, because a partial value list in
 * the agent catalog reads as a complete one.
 *
 * Built here because it must render the dimension expression, FROM and joins
 * EXACTLY as compiled queries do — a probe of slightly different SQL would
 * sample a slightly different question.
 */
export function sampleValuesSql(
  model: SemanticModel,
  dimensionName: string,
  dialect: SqlDialect,
  cap: number,
): string {
  const dim = model.dimensions.find((d) => d.name === dimensionName);
  if (!dim) throw new Error(`Unknown dimension "${dimensionName}"`);
  const expr = normaliseIdentQuotes(dim.sql, dialect);
  const from = assertTableRef(model.source.table);
  return (
    `SELECT DISTINCT ${expr} AS ${quoteIdent("v", dialect)} FROM ${from}` +
    `${compileJoins(model.joins, dialect)} WHERE ${expr} IS NOT NULL LIMIT ${Math.max(1, Math.trunc(cap)) + 1}`
  );
}

const PARAM_TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Resolve the model's declared parameters against a query's `params` into
 * SQL literals, refusing everything undeclared or unusable.
 *
 * The trust model matches filter values exactly: parameter NAMES are
 * validated identifiers, VALUES are literal-escaped (numbers must be finite
 * numbers; strings go through the dialect's escaping), and a caller can only
 * set parameters the model DECLARED — a query naming an unknown parameter is
 * refused with the declared list, and a declared parameter with neither a
 * value nor a default is refused rather than silently compiled as an empty
 * token. Applies to dimension/metric fragments only; join ON conditions stay
 * purely structural.
 */
export function resolveParamValues(
  model: SemanticModel,
  q: SemanticQuery,
  dialect: SqlDialect,
): Map<string, string> {
  const declared = model.parameters ?? [];
  const supplied = q.params ?? {};
  for (const name of Object.keys(supplied)) {
    if (!declared.some((p) => p.name === name)) {
      throw new Error(
        `Unknown parameter "${name}" (declared: ${declared.map((p) => p.name).join(", ") || "none"})`,
      );
    }
  }
  const out = new Map<string, string>();
  for (const p of declared) {
    if (!isValidFieldName(p.name)) throw new Error(`Invalid parameter name "${p.name}"`);
    const raw = supplied[p.name] ?? p.default;
    if (raw === undefined || raw === null || raw === "") {
      throw new Error(`Parameter "${p.name}" needs a value — it has no default.`);
    }
    if (p.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(`Parameter "${p.name}" must be a number, got ${JSON.stringify(raw)}`);
      }
      out.set(p.name, String(n));
    } else {
      out.set(p.name, `'${escapeString(String(raw), dialect)}'`);
    }
  }
  return out;
}

/** Replace every {{name}} token; an unresolved token is a refusal, not SQL. */
export function substituteParams(sql: string, values: Map<string, string>): string {
  return sql.replace(PARAM_TOKEN_RE, (_full, name: string) => {
    const v = values.get(name);
    if (v === undefined) {
      throw new Error(
        `Fragment references undeclared parameter "{{${name}}}" — declare it on the model.`,
      );
    }
    return v;
  });
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

  // Two fiscal declarations are two sources of truth for the same year —
  // whichever silently won, some number would be answering a different
  // question than the model claims. Zod refuses this at save; refusing here
  // too keeps every other caller (tests, direct compilers) equally honest.
  if (model.calendar && model.fiscalYearStartMonth && model.fiscalYearStartMonth !== 1) {
    throw new Error(
      "This model declares BOTH a fiscal year start month and a fiscal calendar table — " +
        "remove one; the calendar table would silently win otherwise.",
    );
  }

  // Authored fragments are re-quoted for the target dialect ONCE, here, so
  // every consumer below (dimExpr, aggExpr, derived formulas, filters, order,
  // joins) inherits it. A model authored against a local dataset stores
  // `` `Order Date` ``, which DuckDB rejects outright; normalising at the point
  // of use in eight places would have been eight chances to miss one.
  //
  // Parameter substitution rides the same single point: every {{name}} token
  // in a dimension/metric fragment becomes a literal-escaped value here, so
  // no fragment below can carry an unresolved token — and a fragment that
  // references an undeclared parameter is refused, not passed through.
  const paramValues = resolveParamValues(model, q, dialect);
  const q0 = (sql: string) => substituteParams(normaliseIdentQuotes(sql, dialect), paramValues);

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

  // Check duplicate-sensitive metrics over a declared fanning join BEFORE
  // building any SQL. A single-pass compile of such a metric is a wrong
  // number, so it is never emitted; where the check fires, the compiler now
  // attempts a MULTI-FACT PLAN (per-branch aggregation, see planChasm) and
  // only if the query is outside that envelope does the refusal reach the
  // caller — with the reason resolution did not apply appended. Unknown
  // names still fall through to the authoritative "Unknown metric" error.
  const fanCtx = fanoutContext(model);
  let chasm: ChasmPlan | null = null;
  if (fanCtx) {
    let refusal: Error | null = null;
    for (const name of metrics) {
      const m = metricByName.get(name);
      if (!m) continue;
      try {
        assertMetricFanoutSafe(m, fanCtx, metricByName);
      } catch (e) {
        refusal = e as Error;
        break;
      }
    }
    if (refusal) {
      chasm = planChasm({
        model,
        q,
        dims,
        metrics,
        dimByName,
        metricByName,
        ctx: fanCtx,
        dialect,
        refusal,
      });
    }
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
  const buildAggregate = (
    shift?:
      | { name: string; n: number; unit: DateAddUnit }
      | { name: string; n: number; calendarGrain: CalendarGrain },
    /**
     * Multi-fact branch mode: compile with only `joins`, only `metricNames`,
     * and leave metric filters to the outer stitch (dimension filters still
     * apply — every branch must see the same row scope). `distinct` builds
     * the dimension spine.
     */
    branch?: {
      joins: SemanticJoin[];
      metricNames: string[];
      distinct?: boolean;
      /** Primary-key expression: aggregate over SELECT DISTINCT (dims, pk, inputs). */
      dedupPk?: string;
    },
  ) => {
    const dimFor = (name: string): SemanticDimension => {
      const d = dimByName.get(name);
      // Name the alternatives: the caller is usually an LLM, and "unknown"
      // without options costs a full round trip to discover what exists.
      if (!d) {
        throw new Error(
          `Unknown dimension "${name}" (available: ${[...dimByName.keys()].join(", ") || "none"})`,
        );
      }
      return shift && shift.name === name && "unit" in shift
        ? { ...d, sql: dateAddExpr(d.sql, shift.n, shift.unit, dialect) }
        : d;
    };

    /** Does `grain` on this model resolve through the fiscal calendar table? */
    const calendarGrainOf = (grain: TimeGrain | undefined): CalendarGrain | null =>
      grain && model.calendar && (CALENDAR_GRAINS as readonly string[]).includes(grain)
        ? (grain as CalendarGrain)
        : null;

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
      const calGrain = calendarGrainOf(grain);
      if (calGrain) {
        // Bucket by the period's start date from the calendar join. On the
        // shifted side of a comparison the SUCCESSOR period's start is read
        // instead — the sequence-step analogue of the date shift in dimFor.
        const g = calendarGrainCols(model.calendar!, calGrain);
        return shift && shift.name === name && "calendarGrain" in shift
          ? `${cal2Alias(name)}.semantic_start`
          : `${calAlias(name)}.${g.start}`;
      }
      return truncateExpr(d.sql, grain, dialect, model.fiscalYearStartMonth);
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
    const activeMetrics = branch ? branch.metricNames : metrics;
    if (!branch?.dedupPk) {
      for (const name of activeMetrics) {
        const m = metricByName.get(name);
        if (!m) {
          throw new Error(
            `Unknown metric "${name}" (available: ${[...metricByName.keys()].join(", ") || "none"})`,
          );
        }
        const expr = resolveMetricExpr(m, metricByName);
        exprByField.set(name, expr);
        selectParts.push(`${expr} AS ${quoteIdent(name, dialect)}`);
        cols.push(name);
      }
    }

    // Filters: dimension filters → WHERE; metric filters → HAVING (in branch
    // mode metric filters are the outer stitch's job — a branch does not
    // compute the other branches' metrics).
    const whereParts: string[] = [];
    const havingParts: string[] = [];
    for (const f of q.filters ?? []) {
      if (metricByName.has(f.field)) {
        if (!branch) havingParts.push(compileFilter(f, exprByField, dialect, { now: opts?.now }));
      } else if (dimByName.has(f.field)) {
        // A calendar sequence cannot shift the RAW column the way date
        // arithmetic can, so the prior side of a calendar comparison SKIPS
        // the axis dimension's filters instead: it computes every bucket and
        // the equality stitch keeps only the buckets the (filtered) current
        // side has — the same rows the shifted-filter trick would have kept.
        if (shift && "calendarGrain" in shift && f.field === shift.name) continue;
        // The dimension itself goes through so a relative-date filter can reach
        // its type and its ungrained SQL — shifted here when this is the prior
        // period, so the window moves with it.
        whereParts.push(
          compileFilter(f, exprByField, dialect, {
            dim: dimFor(f.field),
            now: opts?.now,
            fiscalStartMonth: model.fiscalYearStartMonth,
            calendar: model.calendar,
          }),
        );
      } else throw new Error(`Filter references unknown field "${f.field}"`);
    }

    const from = assertTableRef(model.source.table);
    const joins = branch ? branch.joins : model.joins;

    // ── Fiscal-calendar joins ────────────────────────────────────────────
    // One per time dimension whose grain resolves through the calendar table
    // and whose expression this query embeds (selected or filtered). The
    // grouped derived table cannot fan out, so every branch, the spine and
    // the dedup inner can carry it identically.
    let calendarJoins = "";
    if (model.calendar) {
      const embedded = new Set<string>(dims);
      for (const f of q.filters ?? []) if (dimByName.has(f.field)) embedded.add(f.field);
      for (const name of embedded) {
        const calGrain = calendarGrainOf(q.grains?.[name]);
        if (!calGrain || dimByName.get(name)?.type !== "time") continue;
        calendarGrainCols(model.calendar, calGrain); // refuse unmapped grains loudly
        calendarJoins += calendarBaseJoin(model.calendar, name, dimByName.get(name)!.sql, dialect);
        if (shift && shift.name === name && "calendarGrain" in shift) {
          calendarJoins += calendarShiftJoin(model.calendar, name, shift.calendarGrain, shift.n);
        }
      }
    }

    // ── Primary-key deduplication ────────────────────────────────────────
    // The inner SELECT DISTINCT carries (dims, pk, each metric's value
    // expression and filter flags): the key collapses the fanning join's
    // row multiplication to one row per source row per distinct dimension
    // combination, and the outer aggregate reads only those named columns.
    if (branch?.dedupPk) {
      const qd = (name: string) => quoteIdent(name, dialect);
      const innerCols = [...selectParts, `${branch.dedupPk} AS ${qd("semantic_pk")}`];
      const outerParts: string[] = dims.map((d) => `${qd(d)} AS ${qd(d)}`);
      activeMetrics.forEach((name, i) => {
        const m = metricByName.get(name);
        if (!m) {
          throw new Error(
            `Unknown metric "${name}" (available: ${[...metricByName.keys()].join(", ") || "none"})`,
          );
        }
        const parts = dedupAggParts(m, i, qd);
        innerCols.push(...parts.innerCols);
        outerParts.push(`${parts.outerExpr} AS ${qd(name)}`);
        cols.push(name);
      });
      let inner = `SELECT DISTINCT ${innerCols.join(", ")} FROM ${from}${compileJoins(joins, dialect)}${calendarJoins}`;
      if (whereParts.length) inner += ` WHERE ${whereParts.join(" AND ")}`;
      let out = `SELECT ${outerParts.join(", ")} FROM (${inner}) AS semantic_dedup`;
      if (dims.length) out += ` GROUP BY ${dims.map(qd).join(", ")}`;
      return { sql: out, columns: cols };
    }

    let out =
      `SELECT ${branch?.distinct ? "DISTINCT " : ""}${selectParts.join(", ")}` +
      ` FROM ${from}${compileJoins(joins, dialect)}${calendarJoins}`;
    if (whereParts.length) out += ` WHERE ${whereParts.join(" AND ")}`;
    // Group by dimension expressions (grain-wrapped) when aggregating.
    if (activeMetrics.length && dims.length) {
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

  // ── Multi-fact plan (chasm resolution) ────────────────────────────────
  if (chasm) {
    const qi = (name: string) => quoteIdent(name, dialect);
    // Under primary-key deduplication the dimensions read from one fanning
    // join, so the spine and the base branch must carry it too — DISTINCT
    // (spine) and the key (base) absorb the row multiplication.
    const spineJoins = (model.joins ?? []).filter(
      (j) => !isFanningJoin(j) || j === chasm!.dedupJoin,
    );
    const dedupPk = chasm.dedupJoin ? qualifiedPkExpr(model, dialect) : undefined;
    // Every branch keeps ALL non-fanning joins in model order — lookups do
    // not multiply rows and INNER lookups are row filters that must scope
    // every branch (and the spine) identically — plus its own fanning join.
    // The "*" branch is the untouched single-pass scope, reserved for
    // duplicate-insensitive and custom metrics.
    const branchJoins = (b: ChasmPlan["branches"][number]): SemanticJoin[] =>
      b.key === "*"
        ? (model.joins ?? [])
        : (model.joins ?? []).filter(
            (j) => !isFanningJoin(j) || j === b.join || (b.key === "" && j === chasm!.dedupJoin),
          );

    /**
     * One full plan — branch CTEs, spine, stitched SELECT — under a CTE name
     * prefix, with every reference to the comparison axis optionally shifted.
     * Prefixing is what lets the CURRENT and PRIOR plans coexist flat in one
     * top-level WITH: Synapse rejects a WITH inside a derived table, so the
     * comparison below hoists both plans' CTEs instead of nesting them.
     */
    const buildPlan = (
      prefix: string,
      shift?:
        | { name: string; n: number; unit: DateAddUnit }
        | { name: string; n: number; calendarGrain: CalendarGrain },
    ): { ctes: string[]; select: string; columns: string[] } => {
      const aliasOf = new Map<string, string>();
      chasm!.branches.forEach((b, i) => aliasOf.set(b.key, `${prefix}f${i}`));
      const leafAlias = (name: string): string => {
        for (const b of chasm!.branches) {
          if (b.metricNames.includes(name)) return aliasOf.get(b.key)!;
        }
        // Unreachable: planChasm assigned every leaf a branch.
        throw new Error(`Leaf metric "${name}" was not assigned a branch`);
      };
      const leafRef = (name: string) => `${leafAlias(name)}.${qi(name)}`;

      const ctes: string[] = [];
      for (const b of chasm!.branches) {
        ctes.push(
          `${aliasOf.get(b.key)} AS (` +
            buildAggregate(shift, {
              joins: branchJoins(b),
              metricNames: b.metricNames,
              dedupPk: b.key === "" ? dedupPk : undefined,
            }).sql +
            `)`,
        );
      }

      const SP = `${prefix}spine`;
      const selectParts: string[] = [];
      const columns: string[] = [];
      let fromClause: string;
      if (dims.length > 0) {
        // The spine enumerates every dimension combination the source produces
        // under the same joins and dimension filters, so a group missing from
        // one fact still appears — with NULL for that fact's metrics, the same
        // honesty rule the comparison path uses for a missing period.
        ctes.unshift(
          `${SP} AS (` +
            buildAggregate(shift, { joins: spineJoins, metricNames: [], distinct: true }).sql +
            `)`,
        );
        for (const d of dims) {
          selectParts.push(`${SP}.${qi(d)} AS ${qi(d)}`);
          columns.push(d);
        }
        fromClause =
          `${SP}` +
          chasm!.branches
            .map((b) => {
              const a = aliasOf.get(b.key)!;
              const on = dims
                .map((d) => nullSafeEq(`${SP}.${qi(d)}`, `${a}.${qi(d)}`, dialect))
                .join(" AND ");
              return ` LEFT JOIN ${a} ON ${on}`;
            })
            .join("");
      } else {
        // Grand total: each branch is a single aggregate row.
        fromClause = chasm!.branches
          .map((b, i) => (i === 0 ? aliasOf.get(b.key)! : ` CROSS JOIN ${aliasOf.get(b.key)!}`))
          .join("");
      }

      // Requested metrics in order: leaves project their branch column;
      // derived formulas evaluate OVER the branch columns — the single-pass
      // inlining, evaluated in two steps.
      const outerExpr = new Map<string, string>();
      for (const om of chasm!.outer) {
        const expr = om.leaf
          ? leafRef(om.name)
          : expandDerivedFormula(metricByName.get(om.name)!, metricByName, leafRef);
        outerExpr.set(om.name, expr);
        selectParts.push(`${expr} AS ${qi(om.name)}`);
        columns.push(om.name);
      }

      // Metric filters land here — post-aggregation, so a plain WHERE over
      // the stitched columns is the HAVING of this plan. Applied inside BOTH
      // sides of a comparison, exactly as single-pass HAVING is.
      const outerWhere: string[] = [];
      for (const f of q.filters ?? []) {
        if (!metricByName.has(f.field)) continue; // dimension filters ran inside every branch
        const expr = outerExpr.get(f.field);
        if (!expr) {
          throw new Error(
            `A multi-fact plan can only filter on metrics the query returns — add "${f.field}" ` +
              `to the requested metrics or drop the filter.`,
          );
        }
        outerWhere.push(compileFilter(f, outerExpr, dialect, { now: opts?.now }));
      }

      return {
        ctes,
        select:
          `SELECT ${selectParts.join(", ")} FROM ${fromClause}` +
          (outerWhere.length ? ` WHERE ${outerWhere.join(" AND ")}` : ""),
        columns,
      };
    };

    if (!q.compare) {
      const plan = buildPlan("semantic_");
      return {
        sql: `WITH ${plan.ctes.join(", ")} ${plan.select}` + tail(plan.columns),
        columns: plan.columns,
      };
    }

    // ── Period over period ACROSS the plan ─────────────────────────────
    // The same contract as the single-pass comparison: one grained time
    // axis, the prior side shifted FORWARD so the join is plain equality,
    // NULL for a period with no predecessor. The axis is necessarily a
    // base-side dimension — fanning-side dimensions were refused above.
    if (!COMPARE_PERIODS.includes(q.compare)) {
      throw new Error(`Unknown comparison "${q.compare as string}"`);
    }
    if (metrics.length === 0) {
      throw new Error("A comparison needs at least one metric to compare.");
    }
    const planGrained = dims.filter((n) => q.grains?.[n] && dimByName.get(n)?.type === "time");
    if (planGrained.length !== 1) {
      throw new Error(
        planGrained.length === 0
          ? "A comparison needs exactly one time dimension with a grain — that is the axis being compared."
          : `A comparison needs exactly one grained time dimension, but this query has ${planGrained.length} (${planGrained.join(", ")}).`,
      );
    }
    const planAxis = planGrained[0];
    const planShift = axisShiftSpec(model, q.compare, q.grains![planAxis]!);

    const cur = buildPlan("semantic_c", undefined);
    const prev = buildPlan("semantic_p", { name: planAxis, ...planShift });

    const CUR = "semantic_cur";
    const PREV = "semantic_prev";
    const ref = (t: string, col: string) => `${t}.${qi(col)}`;
    const cmpSelect = cur.columns.map((c) => `${ref(CUR, c)} AS ${qi(c)}`);
    const cmpColumns = [...cur.columns];
    for (const name of metrics) {
      const c = ref(CUR, name);
      const p = ref(PREV, name);
      const delta = `(${c} - ${p})`;
      cmpSelect.push(`${p} AS ${qi(`${name}_prev`)}`);
      cmpSelect.push(`${delta} AS ${qi(`${name}_change`)}`);
      cmpSelect.push(
        `CASE WHEN ${p} IS NULL OR ${p} = 0 THEN NULL ELSE ${delta} * 1.0 / ${p} END ` +
          `AS ${qi(`${name}_pct_change`)}`,
      );
      cmpColumns.push(`${name}_prev`, `${name}_change`, `${name}_pct_change`);
    }
    const cmpOn = dims.map((d) => nullSafeEq(ref(CUR, d), ref(PREV, d), dialect)).join(" AND ");
    const sql =
      `WITH ${[...cur.ctes, ...prev.ctes].join(", ")}, ` +
      `${CUR} AS (${cur.select}), ${PREV} AS (${prev.select}) ` +
      `SELECT ${cmpSelect.join(", ")} FROM ${CUR} LEFT JOIN ${PREV} ON ${cmpOn}` +
      tail(cmpColumns);
    return { sql, columns: cmpColumns };
  }

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
  const shiftSpec = axisShiftSpec(model, q.compare, q.grains![axis]!);

  const cur = buildAggregate();
  const prev = buildAggregate({ name: axis, ...shiftSpec });

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

/**
 * Resolve a requested field name against a model's names AND synonyms.
 *
 * Agents ask in the business's vocabulary — "turnover", "GMV" — and refusing
 * a word the owner explicitly declared as a synonym costs a round trip at
 * best and a wrong ad-hoc query at worst. Resolution order: exact name,
 * case-insensitive name, then case-insensitive synonym. An AMBIGUOUS synonym
 * (declared on two fields) throws rather than guessing — picking one silently
 * would answer a different question than the one asked. An unknown name is
 * returned unchanged so the compiler's own error (which lists what exists)
 * stays the single source of refusal.
 */
export function resolveFieldName(
  model: SemanticModel,
  requested: string,
): { name: string; note?: string } {
  const fields: Array<{ name: string; synonyms?: string[] }> = [
    ...model.dimensions,
    ...model.metrics,
  ];
  if (fields.some((f) => f.name === requested)) return { name: requested };
  const lower = requested.trim().toLowerCase();
  const byCase = fields.filter((f) => f.name.toLowerCase() === lower);
  if (byCase.length === 1) return { name: byCase[0].name };
  const bySynonym = fields.filter((f) =>
    (f.synonyms ?? []).some((s) => s.trim().toLowerCase() === lower),
  );
  if (bySynonym.length === 1) {
    return {
      name: bySynonym[0].name,
      note: `"${requested}" resolved to "${bySynonym[0].name}" via synonym`,
    };
  }
  if (bySynonym.length > 1) {
    throw new Error(
      `"${requested}" is a synonym of ${bySynonym.length} fields on "${model.name}" ` +
        `(${bySynonym.map((f) => f.name).join(", ")}) — use the field name itself.`,
    );
  }
  return { name: requested };
}

/** Clip free text for the catalog — it rides in the system prompt every turn. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * A compact catalog string an LLM can read to author semantic queries.
 *
 * One line per FIELD (not per model): the description the owner wrote
 * ("excludes refunds"), the governed formula, the synonyms and the sampled
 * values are exactly what separates an agent that queries the right field
 * with the right filter value from one that guesses — and they were being
 * authored, validated, stored… and then discarded here.
 */
export function formatSemanticCatalog(
  models: SemanticModel[],
  /** `notes` adds a per-model disclosure line (e.g. a share restriction). */
  opts: { notes?: Map<string, string> } = {},
): string {
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
  const aka = (syn?: string[]) =>
    syn && syn.length > 0 ? ` aka: ${syn.slice(0, 6).join(", ")}` : "";
  return models
    .map((m) => {
      const dims = m.dimensions.map((d) => {
        const vals =
          d.values && d.values.length > 0
            ? ` values: ${d.values
                .slice(0, 8)
                .map((v) => clip(v, 24))
                .join("|")}`
            : "";
        const desc = d.description ? ` — ${clip(d.description, 120)}` : "";
        return `  - ${d.name}${d.type ? `:${d.type}` : ""}${d.label ? ` (${d.label})` : ""}${aka(d.synonyms)}${vals}${desc}`;
      });
      const mets = m.metrics.map((x) => {
        // The governed formula — the SAME rendering the BI analyst gets. A
        // malformed metric must not take the whole catalog down.
        let formula = "";
        try {
          formula = ` = ${clip(metricExpression(x, m.metrics), 100)}`;
        } catch {
          /* skip formula, keep the field listed */
        }
        const desc = x.description ? ` — ${clip(x.description, 120)}` : "";
        return `  - ${x.name}${x.label ? ` (${x.label})` : ""}${formula}${x.format ? ` [${x.format}]` : ""}${aka(x.synonyms)}${desc}`;
      });
      const joins = (m.joins ?? [])
        .map((j) => `${j.table}${j.alias ? ` AS ${j.alias}` : ""}`)
        .join(", ");
      // Certification is signal an agent should weigh: prefer certified
      // models; treat deprecated ones as answers of last resort.
      const statusTag =
        m.status === "certified"
          ? " [certified]"
          : m.status === "deprecated"
            ? " [DEPRECATED — prefer another model]"
            : "";
      const note = opts.notes?.get(m.name);
      // Declared drill paths — so "drill into EMEA" has a governed next level
      // instead of a guess.
      const hierarchies = (m.hierarchies ?? []).map(
        (h) => `  hierarchy ${h.name}: ${h.levels.join(" → ")}`,
      );
      // What-if inputs the agent may set via "params": {name: value}.
      const params = (m.parameters ?? []).map(
        (p) =>
          `  param {{${p.name}}}:${p.type} (default ${JSON.stringify(p.default ?? null)})` +
          (p.description ? ` — ${clip(p.description, 100)}` : ""),
      );
      const fiscalNote =
        m.fiscalYearStartMonth && m.fiscalYearStartMonth !== 1
          ? `  fiscal year starts in month ${m.fiscalYearStartMonth}; use fiscal_year/fiscal_quarter grains ` +
            `and fiscal_ytd / this_fiscal_year / last_fiscal_year / this_fiscal_quarter / ` +
            `last_fiscal_quarter windows for FY questions (a fiscal year is named by the calendar ` +
            `year it ends in).`
          : "";
      return [
        `MODEL ${m.name}${m.label ? ` — ${m.label}` : ""}${statusTag}`,
        m.description ? `  ${clip(m.description, 200)}` : "",
        note ? `  ${note}` : "",
        fiscalNote,
        joins ? `  joined tables: ${joins}` : "",
        `  dimensions:${dims.length ? "" : " (none)"}`,
        ...dims,
        `  metrics:${mets.length ? "" : " (none)"}`,
        ...mets,
        ...hierarchies,
        ...params,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n")
    .concat(grainNote);
}
