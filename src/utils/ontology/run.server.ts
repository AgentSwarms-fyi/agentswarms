// Running compiled ontology SQL: always as the caller, always governed.
//
// Every statement goes through runLakehouseStatement, the lakehouse's one
// chokepoint: it checks the caller may read (or write) each schema the SQL
// names, applies the tables' tag policies and row filters, records the
// statement in the caller's query history and audits it. `auditVia` marks it
// as the ontology's, so Lakehouse → History and the audit log say where a
// query came from. Nothing here runs as the owner on a grantee's behalf.
import { runLakehouseStatement, type LakehouseResult } from "@/utils/lakehouse/core.server";
import type { ColumnMeta } from "@/lib/ontology/compile";

/** One value of a result: what a server function can carry back as-is. */
export type Cell = string | number | boolean | null;

export type ObjectRow = Record<string, Cell>;

export type RunOpts = {
  rowCap: number;
  /** What the query is for, recorded with it: `ontology:explore`, `ontology:rule`. */
  via: string;
  timeoutMs?: number;
};

/** Make a cell JSON-safe: BigInt and Date do not survive a server function. */
export function plainCell(v: unknown): Cell {
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object" && "toString" in v && !Array.isArray(v)) {
    // DuckDB decimals, dates and timestamps arrive as value objects.
    const s = String(v);
    const n = Number(s);
    return s !== "" && Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s) ? n : s;
  }
  if (v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null)
    return v;
  return JSON.stringify(v);
}

export async function runSql(userId: string, sql: string, opts: RunOpts): Promise<LakehouseResult> {
  return runLakehouseStatement(userId, sql, {
    rowCap: opts.rowCap,
    auditVia: opts.via,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

/** Run and return rows as objects keyed by the compiled column keys. */
export async function runRows(
  userId: string,
  sql: string,
  columns: ColumnMeta[] | null,
  opts: RunOpts,
): Promise<{ rows: ObjectRow[]; truncated: boolean; durationMs: number }> {
  const r = await runSql(userId, sql, opts);
  const keys = columns ? columns.map((c) => c.key) : r.columns.map((c) => c.name);
  const byName = new Map(r.columns.map((c, i) => [c.name, i]));
  const rows = r.rows.map((cells) => {
    const o: ObjectRow = {};
    for (const k of keys) {
      const i = byName.get(k);
      o[k] = i === undefined ? null : plainCell(cells[i]);
    }
    return o;
  });
  return { rows, truncated: r.truncated, durationMs: r.duration_ms };
}

/** A one-row, one-number query (`count(*)`). */
export async function runCount(userId: string, sql: string, via: string): Promise<number> {
  const r = await runSql(userId, sql, { rowCap: 1, via });
  const v = plainCell(r.rows[0]?.[0]);
  return typeof v === "number" ? v : Number(v ?? 0);
}

/** A lakehouse error, in words a person can act on. */
export function friendlyLakehouseError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/does not exist|not found/i.test(msg) && /Table/i.test(msg))
    return `A table this ontology is bound to was not found: ${msg.slice(0, 300)}`;
  if (/not allowed|permission|access/i.test(msg))
    return `The lakehouse refused the query for your account: ${msg.slice(0, 300)}`;
  return msg.slice(0, 500);
}
