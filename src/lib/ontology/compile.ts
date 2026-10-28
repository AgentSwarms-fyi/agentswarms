// From ontology questions to lakehouse SQL.
//
// Everything the ontology does with data is compiled here, as pure functions
// of the spec, so every surface (explorer, object view, graph, metrics,
// rules, agent tools, actions) asks the same questions the same way and the
// tests can read the SQL without a database:
//
//   - an OBJECT SET: one type's objects, filtered and searched, optionally
//     walked along links ("search around": the Customers of these Orders);
//   - ONE OBJECT by key, and the objects one link away from it;
//   - a METRIC, grouped by properties of the type or of types it walks TO ONE
//     of (an Order's Customer's region), never through a link that fans out:
//     summing order amounts "by product" through a many-to-many link would
//     count each order once per product and give a confident wrong number,
//     so it is refused with the reason instead;
//   - a RULE check: how many objects break it, and some that do;
//   - an ACTION's write: the UPDATE / INSERT / DELETE behind it.
//
// Names come from the spec and are validated there; values are literals made
// by expr.ts; fragments are re-emitted from tokens. A restricted property is
// emitted as NULL for a caller who may not see it, and cannot be filtered,
// sorted, grouped or aggregated by them — a filter is a way to read a value
// one comparison at a time.
import { compileExpr, quoteIdent, sqlLiteral, sqlString } from "@/lib/ontology/expr";
import {
  allProperties,
  baseTypeOf,
  findObjectType,
  propertyTitle,
  splitCamel,
  sqlTypeOf,
  supertypes,
  titleOf,
  walksToOne,
  type ActionType,
  type BaseType,
  type LinkType,
  type ObjectType,
  type OntologyProperty,
  type OntologyRule,
  type OntologySpec,
} from "@/lib/ontology/spec";

export class CompileError extends Error {}

export type Scalar = string | number | boolean;

export const FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "in",
  "not_in",
  "between",
  "is_null",
  "not_null",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export type Filter = { property: string; op: FilterOp; value?: Scalar | Scalar[] | null };

export type PathStep = { link: string; direction: "forward" | "inverse" };

export const TIME_GRAINS = ["day", "week", "month", "quarter", "year"] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];

export type ObjectSetQuery = {
  objectType: string;
  filters?: Filter[];
  search?: string;
  /** Walk these links from the start set; the result is the objects at the end. */
  path?: PathStep[];
  /** Filters on the objects at the end of the path. */
  targetFilters?: Filter[];
  properties?: string[];
  orderBy?: { property: string; direction: "asc" | "desc" };
  limit?: number;
  offset?: number;
};

export type GroupBy = { property: string; path?: PathStep[]; grain?: TimeGrain };

export type MetricQuery = {
  objectType: string;
  metric: string;
  groupBy?: GroupBy[];
  filters?: Filter[];
  order?: "metric_desc" | "metric_asc" | "group_asc";
  limit?: number;
};

export type CompileOpts = {
  /** May the caller see restricted properties? Only the ontology's owner may. */
  seeRestricted: boolean;
  maxRows?: number;
  /**
   * What the caller's IAM grant on the ontology allows, when they are not its
   * owner (src/utils/ontology/access.server.ts reads it from their grants).
   */
  policy?: OntologyPolicy;
};

/**
 * The per-grantee policy an ontology share can carry, as dashboard and
 * semantic-model shares do. A MASKED property reads as NULL and cannot be
 * filtered, sorted, grouped or aggregated: `Customer.email`, or `*.email` for
 * every type. A ROW FILTER limits which objects of a type the grantee sees,
 * wherever that type appears in a query: as the start of a set, at the end of
 * a search-around, in a metric's grouping.
 */
export type OntologyPolicy = {
  maskedProperties?: string[];
  rowFilters?: { objectType: string; property: string; values: string[] }[];
};

export type ColumnMeta = {
  key: string;
  property: string;
  /** The type the property belongs to (the end of a path for an object set). */
  objectType: string;
  base: BaseType;
  masked: boolean;
  isKey: boolean;
  /** A metric grouping truncated to a period: its values are that period's first day. */
  grain?: TimeGrain;
};

export type Compiled = { sql: string; countSql?: string; columns: ColumnMeta[] };

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 5000;

// ── Building blocks ─────────────────────────────────────────────────────────

function typeOrThrow(spec: OntologySpec, name: string): ObjectType {
  const t = findObjectType(spec, name);
  if (!t) throw new CompileError(`Unknown object type \`${name}\``);
  if (!t.source) throw new CompileError(`${t.name} is not bound to a table yet`);
  return t;
}

/** The table a type reads, as the lakehouse names it (`schema.table`). */
export function tableSql(t: ObjectType): string {
  if (!t.source) throw new CompileError(`${t.name} is not bound to a table yet`);
  return t.source.table;
}

function propOrThrow(spec: OntologySpec, t: ObjectType, name: string): OntologyProperty {
  const p = allProperties(spec, t).find((x) => x.name === name);
  if (!p) throw new CompileError(`${t.name} has no property \`${name}\``);
  return p;
}

/** Where a property's value comes from: its own mapping, or the nearest supertype's. */
function mappingOf(spec: OntologySpec, t: ObjectType, p: OntologyProperty): OntologyProperty {
  if (p.column || p.expression) return p;
  for (const s of supertypes(spec, t)) {
    const q = s.properties.find((x) => x.name === p.name);
    if (q && (q.column || q.expression)) return q;
  }
  return p;
}

/** The SQL for one property of the type aliased `alias`. */
export function propertySql(
  spec: OntologySpec,
  t: ObjectType,
  name: string,
  alias: string,
): string {
  const p = mappingOf(spec, t, propOrThrow(spec, t, name));
  if (p.expression) return `(${compileExpr(p.expression, (col) => `${alias}.${quoteIdent(col)}`)})`;
  if (p.column) return `${alias}.${quoteIdent(p.column)}`;
  return "NULL";
}

function sourceFilterSql(t: ObjectType, alias: string): string | null {
  if (!t.source?.filter) return null;
  return `(${compileExpr(t.source.filter, (col) => `${alias}.${quoteIdent(col)}`)})`;
}

function restricted(spec: OntologySpec, t: ObjectType, name: string): boolean {
  return propOrThrow(spec, t, name).sensitivity === "restricted";
}

/** Is this property hidden from this caller: restricted, or masked by their grant? */
export function isMasked(
  spec: OntologySpec,
  t: ObjectType,
  name: string,
  opts: CompileOpts,
): boolean {
  if (!opts.seeRestricted && restricted(spec, t, name)) return true;
  const masks = opts.policy?.maskedProperties ?? [];
  if (!masks.length) return false;
  const lower = name.toLowerCase();
  const chain = [t, ...supertypes(spec, t)].map((x) => x.name.toLowerCase());
  return masks.some((m) => {
    const [type, prop] = m.includes(".") ? m.toLowerCase().split(".", 2) : ["*", m.toLowerCase()];
    return prop === lower && (type === "*" || chain.includes(type));
  });
}

/** The grant's row filter for a type, as conditions on the aliased row. */
function policyWhere(
  spec: OntologySpec,
  t: ObjectType,
  alias: string,
  opts: CompileOpts,
): string[] {
  const chain = [t, ...supertypes(spec, t)].map((x) => x.name.toLowerCase());
  const has = (prop: string) => allProperties(spec, t).some((x) => x.name === prop.toLowerCase());
  return (opts.policy?.rowFilters ?? [])
    .filter((f) =>
      f.objectType === "*" ? has(f.property) : chain.includes(f.objectType.toLowerCase()),
    )
    .map((f) => {
      const p = allProperties(spec, t).find((x) => x.name === f.property.toLowerCase());
      // A filter naming a property its type does not have shows nothing,
      // rather than everything: a misconfigured policy fails closed.
      if (!p || !f.values.length) return "FALSE";
      const base = baseTypeOf(spec, p.type) ?? "string";
      const col = propertySql(spec, t, p.name, alias);
      return `${col} IN (${f.values
        .slice(0, 1000)
        .map((v) => typedLiteralOrNull(base, v))
        .join(", ")})`;
    });
}

function typedLiteralOrNull(base: BaseType, v: string): string {
  try {
    return typedLiteral(base, v);
  } catch {
    return "NULL";
  }
}

function guardRestricted(
  spec: OntologySpec,
  t: ObjectType,
  name: string,
  opts: CompileOpts,
  what: string,
) {
  if (isMasked(spec, t, name, opts))
    throw new CompileError(`\`${t.name}.${name}\` is hidden from you; it cannot be ${what}`);
}

/** A literal for a filter value, checked against the property's type. */
export function typedLiteral(base: BaseType, v: Scalar | null): string {
  if (v === null) return "NULL";
  switch (base) {
    case "integer": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isInteger(n)) throw new CompileError(`\`${v}\` is not a whole number`);
      return String(n);
    }
    case "decimal":
    case "float": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n) || String(v).trim() === "")
        throw new CompileError(`\`${v}\` is not a number`);
      return String(n);
    }
    case "boolean": {
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      const s = String(v).trim().toLowerCase();
      if (["true", "yes", "1"].includes(s)) return "TRUE";
      if (["false", "no", "0"].includes(s)) return "FALSE";
      throw new CompileError(`\`${v}\` is not true or false`);
    }
    case "date": {
      const s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
        throw new CompileError(`\`${v}\` is not a date (YYYY-MM-DD)`);
      return `DATE ${sqlString(s)}`;
    }
    case "datetime":
    case "timestamp": {
      const s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s))
        throw new CompileError(`\`${v}\` is not a date and time`);
      return `CAST(${sqlString(s.replace("T", " "))} AS ${sqlTypeOf(base)})`;
    }
    default:
      return sqlLiteral(String(v));
  }
}

function filterSql(
  spec: OntologySpec,
  t: ObjectType,
  alias: string,
  f: Filter,
  opts: CompileOpts,
): string {
  guardRestricted(spec, t, f.property, opts, "filtered on");
  const p = propOrThrow(spec, t, f.property);
  const base = baseTypeOf(spec, p.type) ?? "string";
  const col = propertySql(spec, t, f.property, alias);
  const one = (): Scalar | null => {
    if (Array.isArray(f.value)) throw new CompileError(`${f.op} takes one value`);
    if (f.value === undefined) throw new CompileError(`${f.op} needs a value`);
    return f.value;
  };
  const list = (): Scalar[] => {
    if (!Array.isArray(f.value) || !f.value.length) throw new CompileError(`${f.op} needs a list`);
    if (f.value.length > 1000) throw new CompileError(`${f.op} takes at most 1000 values`);
    return f.value;
  };
  const text = (v: Scalar | null) => sqlLiteral(v === null ? null : String(v).toLowerCase());
  switch (f.op) {
    case "eq":
      return `${col} = ${typedLiteral(base, one())}`;
    case "neq":
      return `${col} IS DISTINCT FROM ${typedLiteral(base, one())}`;
    case "gt":
      return `${col} > ${typedLiteral(base, one())}`;
    case "gte":
      return `${col} >= ${typedLiteral(base, one())}`;
    case "lt":
      return `${col} < ${typedLiteral(base, one())}`;
    case "lte":
      return `${col} <= ${typedLiteral(base, one())}`;
    case "contains":
      return `contains(lower(CAST(${col} AS VARCHAR)), ${text(one())})`;
    case "starts_with":
      return `starts_with(lower(CAST(${col} AS VARCHAR)), ${text(one())})`;
    case "in":
      return `${col} IN (${list()
        .map((v) => typedLiteral(base, v))
        .join(", ")})`;
    case "not_in":
      return `${col} NOT IN (${list()
        .map((v) => typedLiteral(base, v))
        .join(", ")})`;
    case "between": {
      const [a, b] = list();
      if (a === undefined || b === undefined) throw new CompileError("between needs two values");
      return `${col} BETWEEN ${typedLiteral(base, a)} AND ${typedLiteral(base, b)}`;
    }
    case "is_null":
      return `${col} IS NULL`;
    case "not_null":
      return `${col} IS NOT NULL`;
  }
}

function searchSql(
  spec: OntologySpec,
  t: ObjectType,
  alias: string,
  term: string,
  opts: CompileOpts,
): string | null {
  const q = term.trim().toLowerCase();
  if (!q) return null;
  const cols = allProperties(spec, t)
    .filter((p) => (baseTypeOf(spec, p.type) ?? "string") === "string")
    .filter((p) => !isMasked(spec, t, p.name, opts))
    .map((p) => propertySql(spec, t, p.name, alias));
  if (!cols.length) return "FALSE";
  return `(${cols.map((c) => `contains(lower(CAST(${c} AS VARCHAR)), ${sqlString(q.slice(0, 200))})`).join(" OR ")})`;
}

/** The link a step names, read from the type the walk is on. */
export function resolveStep(
  spec: OntologySpec,
  at: ObjectType,
  step: PathStep,
): { link: LinkType; next: ObjectType } {
  const here = at.name.toLowerCase();
  const link = spec.linkTypes.find((l) =>
    step.direction === "forward"
      ? l.name === step.link && l.from.toLowerCase() === here
      : (l.inverseName === step.link || l.name === step.link) && l.to.toLowerCase() === here,
  );
  if (!link)
    throw new CompileError(
      `${at.name} has no ${step.direction === "inverse" ? "inverse " : ""}link \`${step.link}\``,
    );
  const next = typeOrThrow(spec, step.direction === "forward" ? link.to : link.from);
  return { link, next };
}

/** JOIN clauses that walk one step from `a` (aliased) to `b` (aliased). */
function joinSql(
  spec: OntologySpec,
  link: LinkType,
  direction: "forward" | "inverse",
  a: ObjectType,
  aAlias: string,
  b: ObjectType,
  bAlias: string,
  kind: "JOIN" | "LEFT JOIN",
): string {
  const bFilter = sourceFilterSql(b, bAlias);
  const j = link.join;
  if (j.kind === "foreign_key") {
    const [aProps, bProps] =
      direction === "forward"
        ? [j.fromProperties, j.toProperties]
        : [j.toProperties, j.fromProperties];
    const on = aProps.map(
      (p, i) => `${propertySql(spec, a, p, aAlias)} = ${propertySql(spec, b, bProps[i], bAlias)}`,
    );
    if (bFilter) on.push(bFilter);
    return `${kind} ${tableSql(b)} AS ${bAlias} ON ${on.join(" AND ")}`;
  }
  const jt = `${bAlias}_j`;
  const [aCols, aProps, bCols, bProps] =
    direction === "forward"
      ? [j.fromColumns, j.fromProperties, j.toColumns, j.toProperties]
      : [j.toColumns, j.toProperties, j.fromColumns, j.fromProperties];
  const on1 = aCols.map(
    (c, i) => `${jt}.${quoteIdent(c)} = ${propertySql(spec, a, aProps[i], aAlias)}`,
  );
  const on2 = bCols.map(
    (c, i) => `${propertySql(spec, b, bProps[i], bAlias)} = ${jt}.${quoteIdent(c)}`,
  );
  if (bFilter) on2.push(bFilter);
  return `${kind} ${j.table} AS ${jt} ON ${on1.join(" AND ")} ${kind} ${tableSql(b)} AS ${bAlias} ON ${on2.join(" AND ")}`;
}

function clampLimit(n: number | undefined, opts: CompileOpts): number {
  const max = Math.min(opts.maxRows ?? MAX_LIMIT, MAX_LIMIT);
  if (n === undefined) return Math.min(DEFAULT_LIMIT, max);
  if (!Number.isInteger(n) || n < 1)
    throw new CompileError("The limit must be a positive whole number");
  return Math.min(n, max);
}

function selectList(
  spec: OntologySpec,
  t: ObjectType,
  alias: string,
  wanted: string[] | undefined,
  opts: CompileOpts,
): { sql: string[]; columns: ColumnMeta[] } {
  const all = allProperties(spec, t);
  const names = wanted?.length ? wanted : all.map((p) => p.name);
  for (const k of t.primaryKey) if (!names.includes(k)) names.unshift(k);
  const sql: string[] = [];
  const columns: ColumnMeta[] = [];
  for (const name of names) {
    const p = propOrThrow(spec, t, name);
    const masked = isMasked(spec, t, name, opts);
    const key = name;
    sql.push(`${masked ? "NULL" : propertySql(spec, t, name, alias)} AS ${quoteIdent(key)}`);
    columns.push({
      key,
      property: name,
      objectType: t.name,
      base: baseTypeOf(spec, p.type) ?? "string",
      masked,
      isKey: t.primaryKey.includes(name),
    });
  }
  return { sql, columns };
}

// ── Object sets ─────────────────────────────────────────────────────────────

export function compileObjectSet(
  spec: OntologySpec,
  q: ObjectSetQuery,
  opts: CompileOpts,
): Compiled {
  const start = typeOrThrow(spec, q.objectType);
  const from: string[] = [`${tableSql(start)} AS t0`];
  const where: string[] = [];
  const f0 = sourceFilterSql(start, "t0");
  if (f0) where.push(f0);
  where.push(...policyWhere(spec, start, "t0", opts));
  for (const f of q.filters ?? []) where.push(filterSql(spec, start, "t0", f, opts));
  if (q.search) {
    const s = searchSql(spec, start, "t0", q.search, opts);
    if (s) where.push(s);
  }

  let at = start;
  let alias = "t0";
  const path = q.path ?? [];
  if (path.length > 4) throw new CompileError("A search around walks at most four links");
  path.forEach((step, i) => {
    const { link, next } = resolveStep(spec, at, step);
    const nextAlias = `t${i + 1}`;
    from.push(joinSql(spec, link, step.direction, at, alias, next, nextAlias, "JOIN"));
    where.push(...policyWhere(spec, next, nextAlias, opts));
    at = next;
    alias = nextAlias;
  });
  for (const f of q.targetFilters ?? []) where.push(filterSql(spec, at, alias, f, opts));

  const { sql: cols, columns } = selectList(spec, at, alias, q.properties, opts);
  const limit = clampLimit(q.limit, opts);
  const offset = q.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0)
    throw new CompileError("The offset must be 0 or more");

  let order = "";
  if (q.orderBy) {
    guardRestricted(spec, at, q.orderBy.property, opts, "sorted by");
    propOrThrow(spec, at, q.orderBy.property);
    order = ` ORDER BY ${quoteIdent(q.orderBy.property)} ${q.orderBy.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`;
    if (!columns.some((c) => c.property === q.orderBy!.property)) {
      cols.push(
        `${propertySql(spec, at, q.orderBy.property, alias)} AS ${quoteIdent(q.orderBy.property)}`,
      );
    }
  } else if (at.primaryKey.length) {
    order = ` ORDER BY ${at.primaryKey.map(quoteIdent).join(", ")}`;
  }

  const distinct = path.length ? "DISTINCT " : "";
  const body = `FROM ${from.join(" ")}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const sql = `SELECT ${distinct}${cols.join(", ")} ${body}${order} LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ""}`;
  const keyCols = at.primaryKey.map((k) => propertySql(spec, at, k, alias));
  const countSql = path.length
    ? `SELECT count(*) AS n FROM (SELECT DISTINCT ${keyCols.join(", ")} ${body}) AS s`
    : `SELECT count(*) AS n ${body}`;
  return { sql, countSql, columns };
}

/** One object, by its key. LIMIT 2 so a key that is not unique is noticed. */
export function compileGetObject(
  spec: OntologySpec,
  typeName: string,
  key: Record<string, Scalar>,
  opts: CompileOpts,
): Compiled {
  const t = typeOrThrow(spec, typeName);
  if (!t.primaryKey.length) throw new CompileError(`${t.name} has no key`);
  const filters: Filter[] = t.primaryKey.map((k) => {
    if (!(k in key)) throw new CompileError(`The key needs \`${k}\``);
    return { property: k, op: "eq", value: key[k] };
  });
  // Keys are never restricted (validate.ts), so this filter is always allowed.
  const c = compileObjectSet(
    spec,
    { objectType: t.name, filters, limit: 2 },
    { ...opts, maxRows: 2 },
  );
  return { sql: c.sql, columns: c.columns };
}

/** The objects one link away from an object. */
export function compileLinked(
  spec: OntologySpec,
  typeName: string,
  key: Record<string, Scalar>,
  step: PathStep,
  opts: CompileOpts & { limit?: number },
): Compiled {
  const t = typeOrThrow(spec, typeName);
  const filters: Filter[] = t.primaryKey.map((k) => ({ property: k, op: "eq", value: key[k] }));
  return compileObjectSet(
    spec,
    { objectType: t.name, filters, path: [step], limit: opts.limit ?? 25 },
    opts,
  );
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export function metricSqlFor(
  spec: OntologySpec,
  t: ObjectType,
  metricName: string,
  alias: string,
  opts: CompileOpts,
): string {
  const m = t.metrics.find((x) => x.name === metricName);
  if (!m) throw new CompileError(`${t.name} has no metric \`${metricName}\``);
  return compileExpr(m.expression, (name) => {
    guardRestricted(spec, t, name, opts, "aggregated");
    return propertySql(spec, t, name, alias);
  });
}

export function compileMetric(spec: OntologySpec, q: MetricQuery, opts: CompileOpts): Compiled {
  const t = typeOrThrow(spec, q.objectType);
  const metricExpr = metricSqlFor(spec, t, q.metric, "t0", opts);
  const from: string[] = [`${tableSql(t)} AS t0`];
  const where: string[] = [];
  const f0 = sourceFilterSql(t, "t0");
  if (f0) where.push(f0);
  where.push(...policyWhere(spec, t, "t0", opts));
  for (const f of q.filters ?? []) where.push(filterSql(spec, t, "t0", f, opts));

  // Paths are shared: two groupings through Order → Customer join it once.
  const joined = new Map<string, { type: ObjectType; alias: string }>();
  let n = 0;
  const reach = (path: PathStep[]): { type: ObjectType; alias: string } => {
    let at = t;
    let alias = "t0";
    let key = "";
    for (const step of path) {
      const { link, next } = resolveStep(spec, at, step);
      if (!walksToOne(link, step.direction))
        throw new CompileError(
          `Grouping through \`${step.link}\` would count each ${t.name} once per ${next.name}, ` +
            `so the total would be wrong. Group by something each ${t.name} has one of.`,
        );
      key += `/${step.direction}:${link.from}.${link.name}`;
      const have = joined.get(key);
      if (have) {
        at = have.type;
        alias = have.alias;
        continue;
      }
      const nextAlias = `g${++n}`;
      from.push(joinSql(spec, link, step.direction, at, alias, next, nextAlias, "LEFT JOIN"));
      const hidden = policyWhere(spec, next, nextAlias, opts);
      if (hidden.length) {
        const firstKey = next.primaryKey[0];
        const present = firstKey
          ? `${propertySql(spec, next, firstKey, nextAlias)} IS NULL OR `
          : "";
        where.push(`(${present}(${hidden.join(" AND ")}))`);
      }
      joined.set(key, { type: next, alias: nextAlias });
      at = next;
      alias = nextAlias;
    }
    return { type: at, alias };
  };

  const groups: string[] = [];
  const columns: ColumnMeta[] = [];
  (q.groupBy ?? []).forEach((g, i) => {
    if (i >= 4) throw new CompileError("Group by at most four things");
    const { type, alias } = reach(g.path ?? []);
    guardRestricted(spec, type, g.property, opts, "grouped by");
    const p = propOrThrow(spec, type, g.property);
    const base = baseTypeOf(spec, p.type) ?? "string";
    let expr = propertySql(spec, type, g.property, alias);
    if (g.grain) {
      if (!["date", "datetime", "timestamp"].includes(base))
        throw new CompileError(`\`${g.property}\` is not a date, so it has no ${g.grain}`);
      expr = `CAST(date_trunc(${sqlString(g.grain)}, ${expr}) AS DATE)`;
    }
    const key = `g${i}_${g.property}`;
    groups.push(`${expr} AS ${quoteIdent(key)}`);
    columns.push({
      key,
      property: g.property,
      objectType: type.name,
      base: g.grain ? "date" : base,
      masked: false,
      isKey: false,
      ...(g.grain ? { grain: g.grain } : {}),
    });
  });
  const mKey = q.metric;
  columns.push({
    key: mKey,
    property: q.metric,
    objectType: t.name,
    base: "float",
    masked: false,
    isKey: false,
  });

  const limit = clampLimit(q.limit ?? (groups.length ? 500 : 1), opts);
  const order = !groups.length
    ? ""
    : q.order === "metric_asc"
      ? ` ORDER BY ${quoteIdent(mKey)} ASC NULLS LAST`
      : q.order === "group_asc"
        ? ` ORDER BY ${groups.map((_, i) => i + 1).join(", ")}`
        : ` ORDER BY ${quoteIdent(mKey)} DESC NULLS LAST`;
  const sql =
    `SELECT ${[...groups, `${metricExpr} AS ${quoteIdent(mKey)}`].join(", ")} FROM ${from.join(" ")}` +
    `${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
    `${groups.length ? ` GROUP BY ${groups.map((_, i) => i + 1).join(", ")}` : ""}${order} LIMIT ${limit}`;
  return { sql, columns };
}

// ── Rules ───────────────────────────────────────────────────────────────────

export type CompiledRule = {
  /** One row: `checked`, `violations`. */
  checkSql: string;
  /** Some objects that break it: the key properties and the title. */
  sampleSql: string;
};

export function compileRule(
  spec: OntologySpec,
  rule: OntologyRule,
  opts: CompileOpts & { sample?: number },
): CompiledRule {
  const t = typeOrThrow(spec, rule.objectType);
  const base = `${tableSql(t)} AS t0`;
  const scope: string[] = [];
  const f0 = sourceFilterSql(t, "t0");
  if (f0) scope.push(f0);
  const prop = (name: string | undefined) => {
    if (!name) throw new CompileError("The rule names no property");
    return propertySql(spec, t, name, "t0");
  };
  let from = base;
  let applies = "TRUE";
  let violation: string;
  // What an example row shows besides its key and title: the property the
  // rule is about, every property its condition reads, a link's own key.
  const shown: string[] = rule.property ? [rule.property] : [];
  switch (rule.kind) {
    case "required": {
      const p = prop(rule.property);
      const b = baseTypeOf(spec, propOrThrow(spec, t, rule.property!).type);
      violation =
        b === "string" ? `(${p} IS NULL OR trim(CAST(${p} AS VARCHAR)) = '')` : `${p} IS NULL`;
      break;
    }
    case "unique": {
      const p = prop(rule.property);
      applies = `${p} IS NOT NULL`;
      const inner = [`${p} IS NOT NULL`, ...scope].join(" AND ");
      violation = `${p} IN (SELECT ${p} FROM ${base} WHERE ${inner} GROUP BY 1 HAVING count(*) > 1)`;
      break;
    }
    case "pattern": {
      const p = prop(rule.property);
      applies = `${p} IS NOT NULL`;
      violation = `NOT regexp_full_match(CAST(${p} AS VARCHAR), ${sqlString(rule.pattern ?? "")})`;
      break;
    }
    case "range": {
      const p = prop(rule.property);
      applies = `${p} IS NOT NULL`;
      const parts: string[] = [];
      if (rule.min !== undefined) parts.push(`${p} < ${sqlLiteral(rule.min)}`);
      if (rule.max !== undefined) parts.push(`${p} > ${sqlLiteral(rule.max)}`);
      if (!parts.length) throw new CompileError("A range rule needs a minimum or a maximum");
      violation = `(${parts.join(" OR ")})`;
      break;
    }
    case "allowed_values": {
      const p = prop(rule.property);
      applies = `${p} IS NOT NULL`;
      if (!rule.values?.length) throw new CompileError("List the allowed values");
      violation = `CAST(${p} AS VARCHAR) NOT IN (${rule.values.map(sqlString).join(", ")})`;
      break;
    }
    case "referential": {
      const link = spec.linkTypes.find(
        (l) => l.name === rule.link && l.from.toLowerCase() === t.name.toLowerCase(),
      );
      if (!link || link.join.kind !== "foreign_key")
        throw new CompileError("A referential rule needs a link through a key on this type");
      const target = typeOrThrow(spec, link.to);
      from = `${base} ${joinSql(spec, link, "forward", t, "t0", target, "r1", "LEFT JOIN")}`;
      const fks = link.join.fromProperties.map((p) => propertySql(spec, t, p, "t0"));
      shown.push(...link.join.fromProperties);
      applies = fks.map((c) => `${c} IS NOT NULL`).join(" AND ");
      violation = `${propertySql(spec, target, link.join.toProperties[0], "r1")} IS NULL`;
      break;
    }
    case "predicate": {
      if (!rule.predicate) throw new CompileError("The rule has no condition");
      const cond = compileExpr(rule.predicate, (name) => {
        shown.push(name);
        return propertySql(spec, t, name, "t0");
      });
      // As a CHECK constraint reads it: false breaks the rule, unknown does not.
      violation = `NOT COALESCE((${cond}), TRUE)`;
      break;
    }
  }
  const whereScope = scope.length ? ` WHERE ${scope.join(" AND ")}` : "";
  const checkSql =
    `SELECT count(*) FILTER (WHERE ${applies}) AS checked, ` +
    `count(*) FILTER (WHERE ${applies} AND ${violation}) AS violations FROM ${from}${whereScope}`;
  const keySel = t.primaryKey.map((k) => `${propertySql(spec, t, k, "t0")} AS ${quoteIdent(k)}`);
  const title =
    t.titleProperty && !t.primaryKey.includes(t.titleProperty)
      ? [
          `${isMasked(spec, t, t.titleProperty, opts) ? "NULL" : propertySql(spec, t, t.titleProperty, "t0")} AS ${quoteIdent(t.titleProperty)}`,
        ]
      : [];
  const offending = [...new Set(shown)]
    .filter((n) => !t.primaryKey.includes(n) && n !== t.titleProperty)
    .slice(0, 6)
    .map((n) => `${isMasked(spec, t, n, opts) ? "NULL" : prop(n)} AS ${quoteIdent(n)}`);
  const sampleWhere = [...scope, applies, violation].join(" AND ");
  const sampleSql = `SELECT ${[...keySel, ...title, ...offending].join(", ")} FROM ${from} WHERE ${sampleWhere} LIMIT ${Math.min(opts.sample ?? 20, 200)}`;
  return { checkSql, sampleSql };
}

/** A metric that only counts the type's rows (COUNT(*), COUNT(1)): always 1 for a single object. */
export function isRowCount(expression: string): boolean {
  return /^\s*COUNT\s*\(\s*(\*|1)\s*\)\s*$/i.test(expression);
}

/** "a" or "an", by the sound of the first letter: an Order, a Customer, an email address. */
export function article(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

/**
 * The rules the model implies without anyone writing them: a key is present
 * and unique, a required property is filled, a value type's allowed values,
 * pattern and range hold, and a link through a key points at something.
 *
 * A subtype read from its supertype's own table (VIP customers are customers
 * with a filter) is not checked again for what it inherits: the supertype's
 * check already covers every one of its rows, and a second copy would count
 * each broken row twice.
 */
export function impliedRules(spec: OntologySpec): OntologyRule[] {
  const out: OntologyRule[] = [];
  const add = (r: Omit<OntologyRule, "enabled">) => out.push({ ...r, enabled: true });
  for (const t of spec.objectTypes) {
    if (!t.source) continue;
    const slug = t.name.toLowerCase();
    const T = titleOf(t);
    const coveredBy = supertypes(spec, t).find(
      (s) => s.source?.table.toLowerCase() === t.source!.table.toLowerCase(),
    );
    const inherited = (name: string) => !!coveredBy && !t.properties.some((p) => p.name === name);
    const titleFor = (name: string) => {
      const p = allProperties(spec, t).find((x) => x.name === name);
      return p ? propertyTitle(p) : name;
    };
    if (t.primaryKey.length === 1 && !inherited(t.primaryKey[0])) {
      const k = t.primaryKey[0];
      add({
        id: `auto-${slug}-${k}-key`.slice(0, 64),
        name: `${T} key is unique`,
        statement: `Every ${T} has its own ${titleFor(k)}.`,
        objectType: t.name,
        kind: "unique",
        property: k,
        severity: "critical",
      });
    }
    for (const k of t.primaryKey) {
      if (inherited(k)) continue;
      const K = titleFor(k);
      add({
        id: `auto-${slug}-${k}-present`.slice(0, 64),
        name: `${T} has ${article(K)} ${K}`,
        statement: `No ${T} is missing its ${K}.`,
        objectType: t.name,
        kind: "required",
        property: k,
        severity: "critical",
      });
    }
    for (const p of allProperties(spec, t)) {
      if (inherited(p.name)) continue;
      const P = propertyTitle(p);
      if (p.required && !t.primaryKey.includes(p.name))
        add({
          id: `auto-${slug}-${p.name}-required`.slice(0, 64),
          name: `${T}: ${P.toLowerCase()} is filled in`,
          statement: `${P} is filled in for every ${T}.`,
          objectType: t.name,
          kind: "required",
          property: p.name,
          severity: "warning",
        });
      const vt = spec.valueTypes.find((v) => v.name.toLowerCase() === p.type.toLowerCase());
      if (!vt) continue;
      const V = splitCamel(vt.name).toLowerCase();
      if (vt.enum)
        add({
          id: `auto-${slug}-${p.name}-values`.slice(0, 64),
          name: `${T} ${P.toLowerCase()} is a known ${V}`,
          statement: `${P} is one of: ${vt.enum.slice(0, 8).join(", ")}${vt.enum.length > 8 ? ", …" : ""}.`,
          objectType: t.name,
          kind: "allowed_values",
          property: p.name,
          values: vt.enum,
          severity: "warning",
        });
      if (vt.pattern)
        add({
          id: `auto-${slug}-${p.name}-pattern`.slice(0, 64),
          name: `${T} ${P.toLowerCase()} is a valid ${V}`,
          statement: `${P} matches the ${V} format.`,
          objectType: t.name,
          kind: "pattern",
          property: p.name,
          pattern: vt.pattern,
          severity: "warning",
        });
      if (vt.min !== undefined || vt.max !== undefined)
        add({
          id: `auto-${slug}-${p.name}-range`.slice(0, 64),
          name: `${T} ${P.toLowerCase()} is in range`,
          statement: `${P} is${vt.min !== undefined ? ` at least ${vt.min}` : ""}${vt.min !== undefined && vt.max !== undefined ? " and" : ""}${vt.max !== undefined ? ` at most ${vt.max}` : ""}.`,
          objectType: t.name,
          kind: "range",
          property: p.name,
          ...(vt.min !== undefined ? { min: vt.min } : {}),
          ...(vt.max !== undefined ? { max: vt.max } : {}),
          severity: "warning",
        });
    }
  }
  for (const l of spec.linkTypes) {
    const from = findObjectType(spec, l.from);
    const to = findObjectType(spec, l.to);
    if (!from?.source || !to?.source || l.join.kind !== "foreign_key") continue;
    if (!walksToOne(l, "forward")) continue;
    const F = titleOf(from);
    const To = titleOf(to);
    add({
      id: `auto-${from.name.toLowerCase()}-${l.name}-exists`.slice(0, 64),
      name: `${F} “${l.label ?? l.name.replace(/_/g, " ")}” points at a real ${To}`,
      statement: `When ${article(F)} ${F} names its ${To}, that ${To} exists.`,
      objectType: from.name,
      kind: "referential",
      link: l.name,
      severity: "warning",
    });
  }
  return out;
}

// ── Actions (write-back) ────────────────────────────────────────────────────

export type ActionWrite = {
  /** Read the object before (modify / delete): checks it exists and meets the criteria. */
  beforeSql: string | null;
  /** Does the object meet the action's criteria? One row, `ok`. */
  criteriaSql: string | null;
  writeSql: string;
  /** Read the object after (modify / create). */
  afterSql: string | null;
};

export function compileAction(
  spec: OntologySpec,
  action: ActionType,
  key: Record<string, Scalar> | null,
  params: Record<string, Scalar | null>,
): ActionWrite {
  const t = typeOrThrow(spec, action.objectType);
  const props = allProperties(spec, t);
  const writable = (name: string) => {
    const p = mappingOf(spec, t, propOrThrow(spec, t, name));
    if (!p.column) throw new CompileError(`\`${name}\` is not a column, so it cannot be written`);
    return p;
  };
  const sets: { column: string; value: string }[] = [];
  for (const def of action.parameters) {
    const v = params[def.name];
    if (v === undefined || v === null || v === "") {
      if (def.required) throw new CompileError(`\`${def.label ?? def.name}\` is required`);
      if (v === undefined) continue;
    }
    const p = writable(def.property);
    const base = baseTypeOf(spec, props.find((x) => x.name === def.property)!.type) ?? "string";
    sets.push({
      column: p.column!,
      value: v === null || v === "" ? "NULL" : typedLiteral(base, v),
    });
  }
  // Only objects of THIS type: a type that is a filtered view of its table
  // (a VIP Customer) must not reach the table's other rows through an action.
  const scope = (alias: string | null) =>
    t.source?.filter
      ? [
          `(${compileExpr(t.source.filter, (col) => (alias ? `${alias}.${quoteIdent(col)}` : quoteIdent(col)))})`,
        ]
      : [];
  const keyWhere = (alias: string | null) => {
    const k0 = key;
    if (!k0) throw new CompileError("Which object? The key is missing");
    return [
      ...t.primaryKey.map((k) => {
        if (!(k in k0)) throw new CompileError(`The key needs \`${k}\``);
        const base = baseTypeOf(spec, propOrThrow(spec, t, k).type) ?? "string";
        const col = alias ? propertySql(spec, t, k, alias) : quoteIdent(writable(k).column!);
        return `${col} = ${typedLiteral(base, k0[k])}`;
      }),
      ...scope(alias),
    ].join(" AND ");
  };
  const read = () =>
    `SELECT ${props
      .filter((p) => mappingOf(spec, t, p).column || mappingOf(spec, t, p).expression)
      .map((p) => `${propertySql(spec, t, p.name, "t0")} AS ${quoteIdent(p.name)}`)
      .join(", ")} FROM ${tableSql(t)} AS t0 WHERE ${keyWhere("t0")} LIMIT 2`;
  const criteriaSql =
    action.criteria && action.kind !== "create"
      ? `SELECT COALESCE((${compileExpr(action.criteria, (n) => propertySql(spec, t, n, "t0"))}), FALSE) AS ok FROM ${tableSql(t)} AS t0 WHERE ${keyWhere("t0")} LIMIT 1`
      : null;

  if (action.kind === "modify") {
    if (!sets.length) throw new CompileError("Nothing to change");
    return {
      beforeSql: read(),
      criteriaSql,
      writeSql: `UPDATE ${tableSql(t)} SET ${sets.map((s) => `${quoteIdent(s.column)} = ${s.value}`).join(", ")} WHERE ${keyWhere(null)}`,
      afterSql: read(),
    };
  }
  if (action.kind === "delete") {
    return {
      beforeSql: read(),
      criteriaSql,
      writeSql: `DELETE FROM ${tableSql(t)} WHERE ${keyWhere(null)}`,
      afterSql: null,
    };
  }
  // create: the key comes from the parameters.
  const newKey: Record<string, Scalar> = {};
  for (const k of t.primaryKey) {
    const def = action.parameters.find((p) => p.property === k);
    const v = def ? params[def.name] : undefined;
    if (v === undefined || v === null || v === "")
      throw new CompileError(`A new ${t.name} needs its ${k}`);
    newKey[k] = v;
  }
  if (!sets.length) throw new CompileError("Nothing to create");
  key = newKey;
  return {
    beforeSql: read(),
    criteriaSql: null,
    writeSql: `INSERT INTO ${tableSql(t)} (${sets.map((s) => quoteIdent(s.column)).join(", ")}) VALUES (${sets.map((s) => s.value).join(", ")})`,
    afterSql: read(),
  };
}
