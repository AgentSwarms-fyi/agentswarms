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

export type MetricAgg = "sum" | "avg" | "count" | "count_distinct" | "min" | "max" | "custom";

export type SemanticMetric = {
  name: string;
  label?: string;
  description?: string;
  agg: MetricAgg;
  /** Column/expression to aggregate. Optional for `count`. Required for `custom`
   *  (the full aggregate expression, e.g. SUM(revenue) - SUM(cost)). */
  sql?: string;
  /** Trusted boolean SQL fragments ANDed inside the aggregate (a filtered
   *  measure), e.g. ["status = 'paid'"]. Ignored for `custom`. */
  filters?: string[];
  format?: "number" | "currency" | "percent";
  currency?: string;
};

export type SemanticSource =
  | { kind: "data_table"; table: string }
  | { kind: "warehouse"; connectionId: string; table: string };

export type SemanticModel = {
  id?: string;
  name: string;
  label?: string;
  description?: string;
  source: SemanticSource;
  dimensions: SemanticDimension[];
  metrics: SemanticMetric[];
};

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_in" | "contains";

export type SemanticFilter = {
  /** A dimension name (→ WHERE) or metric name (→ HAVING). */
  field: string;
  op: FilterOp;
  value: string | number | boolean | Array<string | number>;
};

export type SemanticQuery = {
  model: string;
  metrics: string[];
  dimensions?: string[];
  filters?: SemanticFilter[];
  orderBy?: Array<{ field: string; dir?: "asc" | "desc" }>;
  limit?: number;
};

export type CompiledQuery = { sql: string; columns: string[] };

/** SQL dialects we compile identifier-quoting for. */
export type SqlDialect =
  | "alasql"
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

/** Escape a scalar into a SQL literal. Only strings/finite numbers/booleans. */
function literal(v: string | number | boolean): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite number in filter value");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new Error("Unsupported filter value type");
}

function aggExpr(m: SemanticMetric): string {
  const filters = (m.filters ?? []).filter((f) => f && f.trim());
  const guarded = (inner: string) =>
    filters.length ? `CASE WHEN (${filters.join(") AND (")}) THEN ${inner} END` : inner;
  switch (m.agg) {
    case "custom":
      if (!m.sql) throw new Error(`Metric "${m.name}" is custom but has no sql`);
      return m.sql; // fully trusted, filters not applied
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

function compileFilter(f: SemanticFilter, exprByField: Map<string, string>): string {
  const expr = exprByField.get(f.field);
  if (!expr) throw new Error(`Filter references unknown field "${f.field}"`);
  switch (f.op) {
    case "=":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=": {
      if (Array.isArray(f.value)) throw new Error(`Operator "${f.op}" needs a scalar`);
      const op = f.op === "!=" ? "<>" : f.op;
      return `${expr} ${op} ${literal(f.value)}`;
    }
    case "in":
    case "not_in": {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      if (arr.length === 0) return f.op === "in" ? "1 = 0" : "1 = 1";
      const list = arr.map((v) => literal(v)).join(", ");
      return `${expr} ${f.op === "in" ? "IN" : "NOT IN"} (${list})`;
    }
    case "contains": {
      if (typeof f.value !== "string") throw new Error('"contains" needs a string');
      const esc = f.value.replace(/'/g, "''").replace(/([%_\\])/g, "\\$1");
      return `${expr} LIKE '%${esc}%' ESCAPE '\\'`;
    }
    default:
      throw new Error(`Unknown filter op "${(f as SemanticFilter).op}"`);
  }
}

/**
 * Compile a structured semantic query against one model into a single read-only
 * SELECT. Throws on any unknown field name or unsafe input.
 */
export function compileSemanticQuery(
  model: SemanticModel,
  q: SemanticQuery,
  opts?: { dialect?: SqlDialect },
): CompiledQuery {
  const dialect: SqlDialect = opts?.dialect ?? "postgres";
  const dimByName = new Map<string, SemanticDimension>();
  for (const d of model.dimensions) {
    if (!isValidFieldName(d.name)) throw new Error(`Invalid dimension name "${d.name}"`);
    dimByName.set(d.name, d);
  }
  const metricByName = new Map<string, SemanticMetric>();
  for (const m of model.metrics) {
    if (!isValidFieldName(m.name)) throw new Error(`Invalid metric name "${m.name}"`);
    metricByName.set(m.name, m);
  }

  const dims = q.dimensions ?? [];
  const metrics = q.metrics ?? [];
  if (dims.length === 0 && metrics.length === 0) {
    throw new Error("A query needs at least one metric or dimension");
  }

  // Expression map for filters/order (raw dim exprs; compiled metric aggs).
  const exprByField = new Map<string, string>();
  for (const [name, d] of dimByName) exprByField.set(name, d.sql);

  const selectParts: string[] = [];
  const columns: string[] = [];

  for (const name of dims) {
    const d = dimByName.get(name);
    if (!d) throw new Error(`Unknown dimension "${name}"`);
    selectParts.push(`${d.sql} AS ${quoteIdent(name, dialect)}`);
    columns.push(name);
  }
  const metricAgg = new Map<string, string>();
  for (const name of metrics) {
    const m = metricByName.get(name);
    if (!m) throw new Error(`Unknown metric "${name}"`);
    const expr = aggExpr(m);
    metricAgg.set(name, expr);
    exprByField.set(name, expr);
    selectParts.push(`${expr} AS ${quoteIdent(name, dialect)}`);
    columns.push(name);
  }

  // Filters: dimension filters → WHERE; metric filters → HAVING.
  const whereParts: string[] = [];
  const havingParts: string[] = [];
  for (const f of q.filters ?? []) {
    if (metricByName.has(f.field)) havingParts.push(compileFilter(f, exprByField));
    else if (dimByName.has(f.field)) whereParts.push(compileFilter(f, exprByField));
    else throw new Error(`Filter references unknown field "${f.field}"`);
  }

  const from = assertTableRef(model.source.table);
  let sql = `SELECT ${selectParts.join(", ")} FROM ${from}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(" AND ")}`;
  // Group by dimension expressions when aggregating.
  if (metrics.length && dims.length) {
    sql += ` GROUP BY ${dims.map((n) => dimByName.get(n)!.sql).join(", ")}`;
  }
  if (havingParts.length) sql += ` HAVING ${havingParts.join(" AND ")}`;

  const order = (q.orderBy ?? []).filter((o) => columns.includes(o.field));
  if (order.length) {
    sql += ` ORDER BY ${order
      .map((o) => `${quoteIdent(o.field, dialect)} ${o.dir === "asc" ? "ASC" : "DESC"}`)
      .join(", ")}`;
  }

  const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  sql += ` LIMIT ${limit}`;
  return { sql, columns };
}

/** A compact catalog string an LLM can read to author semantic queries. */
export function formatSemanticCatalog(models: SemanticModel[]): string {
  if (models.length === 0) return "(no semantic models defined)";
  return models
    .map((m) => {
      const dims = m.dimensions
        .map((d) => `${d.name}${d.type ? `:${d.type}` : ""}${d.label ? ` (${d.label})` : ""}`)
        .join(", ");
      const mets = m.metrics
        .map((x) => `${x.name}${x.label ? ` (${x.label})` : ""}${x.format ? ` [${x.format}]` : ""}`)
        .join(", ");
      return [
        `MODEL ${m.name}${m.label ? ` — ${m.label}` : ""}`,
        m.description ? `  ${m.description}` : "",
        `  dimensions: ${dims || "(none)"}`,
        `  metrics: ${mets || "(none)"}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
