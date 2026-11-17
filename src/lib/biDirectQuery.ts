// SQL builder for BI "Direct query" widgets — the live, full-data alternative
// to the cached "Import" snapshot.
//
// A direct-query widget's stored SQL is wrapped as a subquery and the
// dashboard's global filters + the viewer's row-level-security filters are
// pushed down as a WHERE clause, then LIMITed. Pure + framework-free so the
// injection-safety and fail-closed rules are unit-testable.
//
// SECURITY:
//   • Column identifiers are validated (letters/digits/underscore/dot) — never
//     interpolated raw — so a filter can't inject SQL through a column name.
//   • String values are single-quote-escaped; numbers are coerced/validated;
//     dates are quoted as strings — so filter VALUES can't inject either.
//   • Row-level-security filters (from a BI dashboard IAM grant) FAIL CLOSED:
//     if the widget result doesn't expose a row-filter column we cannot enforce
//     the restriction, so we return a no-rows query rather than leak everything.

import { quoteIdent, renderAggregateClauses, type AggPlan } from "@/lib/biAggregate";
import type { SqlDialect } from "@/lib/semanticLayer";

export const DIRECT_QUERY_MAX_ROWS = 100_000;
export const DIRECT_QUERY_DEFAULT_ROWS = 50_000;

export type DirectFilter =
  | { column: string; kind: "select"; values: string[] }
  | { column: string; kind: "daterange"; from?: string; to?: string }
  | { column: string; kind: "numrange"; min?: number; max?: number };

export type DirectRowFilter = { column: string; values: string[] };

/** A safe SQL identifier: letters, digits, underscore, dot, dollar; else null. */
export function safeIdent(name: string): string | null {
  const n = (name ?? "").trim();
  if (!n || n.length > 128) return null;
  return /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/.test(n) ? n : null;
}

/**
 * Single-quote-escape a string literal.
 *
 * Exported because drill-through (biDrillThrough.ts) builds predicates against
 * the same warehouses from the same untrusted values. Two copies of an escaping
 * rule is one copy that gets fixed.
 */
export function quoteStr(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function stripTrailing(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

/** One term of an ORDER BY a wrapper can repeat: an output column, by name. */
export type CarriedOrder = { column: string; dir: "ASC" | "DESC"; nulls?: "FIRST" | "LAST" };

/** A result column name that is safe to quote and repeat. */
const PLAIN_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The query's own top-level ORDER BY, as output columns, so a wrapper can say
 * it again (R503).
 *
 * `SELECT … FROM (<query>) AS _dq WHERE … LIMIT n` keeps no promise about the
 * inner ORDER BY: a GROUP BY around it hashes the rows (a live line chart came
 * back with its days shuffled, and a moving average over them is noise), and
 * Trino or Athena may reorder even a plain filter. Only what can be named on
 * the outside carries over — a position (`ORDER BY 1`) or a column, quoted or
 * qualified (`d.ride_date`), that the query returns. At the first term that is
 * anything else (an expression, a column the query does not return) the rest is
 * dropped: ordering by a later term alone would be a different order.
 */
export function carriedOrderBy(sql: string, columns: string[]): CarriedOrder[] {
  const src = stripTrailing(sql);
  // The text at depth 0 only: strings, quoted names, comments and anything in
  // brackets (subqueries, window ORDER BYs, function calls) become spaces, so
  // the clause found is the outer query's and its commas split its terms.
  let masked = "";
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    let end = -1;
    if (two === "--") {
      end = src.indexOf("\n", i);
      if (end < 0) end = src.length;
    } else if (two === "/*") {
      end = src.indexOf("*/", i + 2);
      end = end < 0 ? src.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      end = i + 1;
      while (end < src.length) {
        if (src[end] === c) {
          if (src[end + 1] === c) end += 2;
          else break;
        } else end++;
      }
      end = Math.min(end + 1, src.length);
    }
    if (end > i) {
      masked += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    if (c === "(") depth++;
    const keep = depth === 0;
    if (c === ")") depth = Math.max(0, depth - 1);
    masked += keep ? c : " ";
  }

  const orders = [...masked.matchAll(/\border\s+by\b/gi)];
  const last = orders[orders.length - 1];
  if (!last || last.index === undefined) return [];
  const from = last.index + last[0].length;
  const stop = /\b(limit|offset|fetch)\b/i.exec(masked.slice(from));
  const to = stop ? from + stop.index : masked.length;

  const byLower = new Map<string, string>();
  for (const c of columns) if (typeof c === "string") byLower.set(c.toLowerCase(), c);

  const out: CarriedOrder[] = [];
  let start = from;
  for (let i = from; i <= to; i++) {
    if (i < to && masked[i] !== ",") continue;
    const term = src.slice(start, i).trim();
    start = i + 1;
    const m = /^(.+?)(?:\s+(asc|desc))?(?:\s+nulls\s+(first|last))?$/i.exec(term) ?? undefined;
    if (!m) break;
    const expr = m[1].trim();
    let name: string | undefined;
    if (/^\d+$/.test(expr)) {
      name = columns[Number(expr) - 1];
    } else {
      const id =
        /^(?:(?:"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)\.)*(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))$/.exec(
          expr,
        );
      const bare = id ? (id[1] ?? id[2] ?? id[3]) : undefined;
      name = bare ? byLower.get(bare.toLowerCase()) : undefined;
    }
    if (!name || !PLAIN_COLUMN.test(name)) break;
    out.push({
      column: name,
      dir: m[2]?.toUpperCase() === "DESC" ? "DESC" : "ASC",
      ...(m[3] ? { nulls: m[3].toUpperCase() as "FIRST" | "LAST" } : {}),
    });
  }
  return out;
}

function orderByClause(order: CarriedOrder[], dialect: SqlDialect): string {
  if (order.length === 0) return "";
  const terms = order.map(
    (o) => `${quoteIdent(o.column, dialect)} ${o.dir}${o.nulls ? ` NULLS ${o.nulls}` : ""}`,
  );
  return ` ORDER BY ${terms.join(", ")}`;
}

/**
 * Build the effective direct-query SQL. Filter/row-filter columns not present
 * in `columns` are skipped (global) or fail closed (row-level). Returns the
 * wrapped, filtered, LIMITed SQL.
 *
 * With `agg`, the query also groups — and the ORDER MATTERS: filters land in
 * the WHERE, which the database evaluates BEFORE the GROUP BY, so a filtered
 * chart aggregates only the rows that passed the filter. Building it the other
 * way round (aggregate, then filter the totals) would quietly answer a
 * different question.
 */
export function buildDirectQuerySql(args: {
  baseSql: string;
  /** Result column names of baseSql — the only columns a filter may reference. */
  columns: string[];
  filters?: DirectFilter[];
  /** Row-level security filters (ANDed, fail-closed). */
  rowFilters?: DirectRowFilter[];
  rowCap?: number;
  /** Aggregation pushdown plan; omitted or unbuildable → raw rows as before. */
  agg?: AggPlan;
  /** Identifier-quoting dialect for the aggregate clauses. */
  dialect?: SqlDialect;
}): string {
  const colSet = new Set(args.columns.map((c) => c.toLowerCase()));
  const base = stripTrailing(args.baseSql);
  const preds: string[] = [];

  // Row-level security first — fail closed if any can't be enforced.
  //
  // GRANTS ARE ADDITIVE, so the filters from several grants are OR'd. They used
  // to be AND'd along with everything else, which made holding two grants admit
  // FEWER rows than holding either one alone: a user in two groups, one granted
  // `region IN ('EMEA')` and the other `region IN ('APAC')`, matched
  // `region IN ('EMEA') AND region IN ('APAC')` and saw nothing at all, with no
  // error to explain it. The dataset path (sharedDatasets.server) has always
  // used a union — `filters.some(...)` — so the same person saw different data
  // depending on which surface they opened.
  //
  // Fail-closed still applies to the WHOLE query, and matters more under OR
  // than under AND: skipping a filter that cannot be enforced would WIDEN
  // access here rather than narrow it.
  const rlsPreds: string[] = [];
  for (const rf of args.rowFilters ?? []) {
    const id = safeIdent(rf.column);
    const vals = (rf.values ?? []).filter((v) => v != null);
    if (!id || !colSet.has(rf.column.toLowerCase()) || vals.length === 0) {
      return `SELECT * FROM (${base}) AS _dq WHERE 1=0`;
    }
    rlsPreds.push(`${id} IN (${vals.map(quoteStr).join(", ")})`);
  }
  // Parenthesised, so a later AND cannot bind to the last OR branch alone.
  if (rlsPreds.length === 1) preds.push(rlsPreds[0]);
  else if (rlsPreds.length > 1) preds.push(`(${rlsPreds.join(" OR ")})`);

  // Global dashboard filters — best-effort (skip columns not in the result).
  for (const f of args.filters ?? []) {
    const id = safeIdent(f.column);
    if (!id || !colSet.has(f.column.toLowerCase())) continue;
    if (f.kind === "select") {
      const vals = (f.values ?? []).filter((v) => v != null);
      if (vals.length) preds.push(`${id} IN (${vals.map(quoteStr).join(", ")})`);
    } else if (f.kind === "daterange") {
      if (f.from) preds.push(`${id} >= ${quoteStr(f.from)}`);
      if (f.to) preds.push(`${id} <= ${quoteStr(f.to)}`);
    } else if (f.kind === "numrange") {
      if (typeof f.min === "number" && Number.isFinite(f.min)) preds.push(`${id} >= ${f.min}`);
      if (typeof f.max === "number" && Number.isFinite(f.max)) preds.push(`${id} <= ${f.max}`);
    }
  }

  const where = preds.length ? ` WHERE ${preds.join(" AND ")}` : "";
  const cap = Math.max(
    1,
    Math.min(Math.trunc(args.rowCap ?? DIRECT_QUERY_DEFAULT_ROWS), DIRECT_QUERY_MAX_ROWS),
  );

  // Aggregation is best-effort by design: renderAggregateClauses returns null
  // for any field it cannot verify against `columns`, and we then emit exactly
  // the query we always did. A chart that loses pushdown renders as before —
  // it never renders wrong.
  const dialect = args.dialect ?? "postgres";
  const order = carriedOrderBy(base, args.columns);
  const clauses = args.agg ? renderAggregateClauses(args.agg, args.columns, dialect) : null;
  if (clauses) {
    // A plan with no dimensions is a SCALAR aggregate — one row, no grouping —
    // and `GROUP BY` with nothing after it is a syntax error in every dialect.
    // `aggregationPlan` never produces one (it refuses an empty `dims`), so no
    // chart reaches this; an alert asking the database for one measure does.
    const group = clauses.groupBy ? ` GROUP BY ${clauses.groupBy}` : "";
    // Grouped rows come back in hash order, so the query's own order is said
    // again — up to the first term the grouped result no longer has.
    const kept = new Set(
      [...args.agg!.dims, ...args.agg!.measures.map((m) => m.field)].map((f) => f.toLowerCase()),
    );
    const prefix: CarriedOrder[] = [];
    for (const o of order) {
      if (!kept.has(o.column.toLowerCase())) break;
      prefix.push(o);
    }
    const orderBy = clauses.groupBy ? orderByClause(prefix, dialect) : "";
    return `SELECT ${clauses.select} FROM (${base}) AS _dq${where}${group}${orderBy} LIMIT ${cap}`;
  }
  return `SELECT * FROM (${base}) AS _dq${where}${orderByClause(order, dialect)} LIMIT ${cap}`;
}
