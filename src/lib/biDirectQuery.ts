// SQL builder for BI "Direct query" widgets — the live, full-data alternative
// to the cached "Import" snapshot (QuickSight SPICE vs Direct Query).
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

import { renderAggregateClauses, type AggPlan } from "@/lib/biAggregate";
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

/** Single-quote-escape a string literal. */
function quoteStr(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function stripTrailing(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
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
  const clauses = args.agg
    ? renderAggregateClauses(args.agg, args.columns, args.dialect ?? "postgres")
    : null;
  if (clauses) {
    return `SELECT ${clauses.select} FROM (${base}) AS _dq${where} GROUP BY ${clauses.groupBy} LIMIT ${cap}`;
  }
  return `SELECT * FROM (${base}) AS _dq${where} LIMIT ${cap}`;
}
