// The query log (R531): what one row says, and what a query cost.
//
// Pure, so the server that writes rows and the page that reads them use the
// same words and the same arithmetic. The table is public.query_log
// (migration 20261127000000); the server writer is
// src/utils/queryLog/record.server.ts.

/** What a query was run for. A caller that says nothing is "app". */
export const QUERY_VIAS = [
  "workbench",
  "dashboard",
  "report",
  "sheet",
  "agent",
  "analyst",
  "schedule",
  "monitor",
  "metric",
  "data_prep",
  "pipeline",
  "sql_model",
  "ml",
  "replay",
  "lakehouse",
  "app",
] as const;
export type QueryVia = (typeof QUERY_VIAS)[number];

export const VIA_LABEL: Record<QueryVia, string> = {
  workbench: "Workbench",
  dashboard: "Dashboard",
  report: "Report",
  sheet: "Sheet",
  agent: "Agent",
  analyst: "AI Analyst",
  schedule: "Schedule",
  monitor: "Data monitor",
  metric: "Metric",
  data_prep: "Data prep",
  pipeline: "Pipeline",
  sql_model: "SQL model",
  ml: "ML model",
  replay: "Replay",
  lakehouse: "Lakehouse",
  app: "App",
};

/**
 * What a lakehouse statement was for, from the label its caller already gives
 * the audit trail (`auditVia`). Forty-odd callers name themselves that way;
 * reading the name keeps them from each saying it twice.
 */
export function viaFromAuditLabel(label: string | null | undefined): QueryVia {
  const l = (label ?? "").toLowerCase();
  if (!l || l === "ui" || l.startsWith("ui-")) return "lakehouse";
  if (l.startsWith("sheets")) return "sheet";
  if (l === "prep") return "data_prep";
  if (l === "workflow") return "pipeline";
  if (l.startsWith("replay")) return "replay";
  if (l.startsWith("sql-model")) return "sql_model";
  if (l.startsWith("ml") || l.startsWith("feature")) return "ml";
  if (l.includes("monitor")) return "monitor";
  return "lakehouse";
}

export const viaLabel = (v: string): string =>
  (VIA_LABEL as Record<string, string>)[v] ?? v.replace(/_/g, " ");

const ENGINE_LABEL: Record<string, string> = {
  browser: "In your browser",
  local: "Local engine",
  lakehouse: "Lakehouse",
  spark: "Spark",
  objectstore: "Object store",
  athena: "Athena",
  bigquery: "BigQuery",
  trino: "Trino",
  snowflake: "Snowflake",
  databricks: "Databricks",
  redshift: "Redshift",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  clickhouse: "ClickHouse",
  oracle: "Oracle",
};

export const engineLabel = (e: string): string =>
  ENGINE_LABEL[e] ?? e.charAt(0).toUpperCase() + e.slice(1).replace(/_/g, " ");

// ── Cost ─────────────────────────────────────────────────────────────────

const MiB = 1024 * 1024;
const TiB = 1024 ** 4;

/**
 * Engines that charge by what a query reads, at their published on-demand
 * list price. Others (a cluster billed by the hour, a database you run) have
 * no per-query price, so their rows say what was scanned and no amount.
 */
export type ScanPrices = { athenaPerTB: number; bigqueryPerTiB: number };
export const DEFAULT_SCAN_PRICES: ScanPrices = { athenaPerTB: 5, bigqueryPerTiB: 6.25 };

/**
 * The prices to use, from the server's settings, falling back to list price
 * for anything unset or not a usable number. An account with a negotiated
 * rate or another region sets its own.
 */
export function scanPricesFrom(env: Record<string, string | undefined>): ScanPrices {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    athenaPerTB: num(env.QUERY_COST_ATHENA_USD_PER_TB, DEFAULT_SCAN_PRICES.athenaPerTB),
    bigqueryPerTiB: num(env.QUERY_COST_BIGQUERY_USD_PER_TIB, DEFAULT_SCAN_PRICES.bigqueryPerTiB),
  };
}

export type ScanCost = { usd: number; basis: string };

/**
 * What a query that read `bytes` cost on `engine`, or null where the engine
 * has no per-query price or said nothing about what it read.
 *
 * Athena bills what it scanned, rounded up to the megabyte, with a 10 MB
 * minimum for a query that read anything. BigQuery reports the bytes it
 * BILLED, its own minimums applied (and 0 for a cached answer), so that
 * figure is priced as it is.
 */
export function estimateScanCost(
  engine: string,
  bytes: number | null | undefined,
  prices: ScanPrices = DEFAULT_SCAN_PRICES,
): ScanCost | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (engine === "athena") {
    const billed = bytes === 0 ? 0 : Math.max(Math.ceil(bytes / MiB) * MiB, 10 * MiB);
    return {
      usd: tidy((billed / TiB) * prices.athenaPerTB),
      basis: `Athena at $${prices.athenaPerTB} per TB scanned, 10 MB minimum`,
    };
  }
  if (engine === "bigquery") {
    return {
      usd: tidy((bytes / TiB) * prices.bigqueryPerTiB),
      basis: `BigQuery on demand at $${prices.bigqueryPerTiB} per TiB billed`,
    };
  }
  return null;
}

/**
 * Float noise off (0.30000000000000004), digits kept: a cost below a millionth
 * of a dollar keeps them (the R318 lesson; the columns are unconstrained
 * numeric for the same reason).
 */
const tidy = (n: number) => Number(n.toPrecision(12));

// ── One row ──────────────────────────────────────────────────────────────

/** What a writer knows about one query. */
export type QueryRun = {
  /** Whose history and whose bill: for a shared dashboard, its owner. */
  userId: string;
  /** Who caused it, when that is someone else. */
  actorUserId?: string | null;
  via?: string | null;
  engine: string;
  connectionId?: string | null;
  connectionName?: string | null;
  sql: string;
  ok: boolean;
  error?: string | null;
  rowCount?: number | null;
  durationMs?: number | null;
  bytesScanned?: number | null;
  engineQueryId?: string | null;
  costUsd?: number | null;
  costBasis?: string | null;
  aiCostUsd?: number | null;
};

const intOrNull = (n: number | null | undefined, max: number) =>
  n === null || n === undefined || !Number.isFinite(n) || n < 0
    ? null
    : Math.min(Math.round(n), max);
const textOrNull = (s: string | null | undefined, max: number) =>
  s === null || s === undefined || s.trim() === "" ? null : s.slice(0, max);
const usdOrNull = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) || n < 0 ? null : tidy(n);

/**
 * The row to insert, inside every limit the table checks: a value the table
 * would refuse is shortened or dropped here, so a long error or an odd engine
 * name never costs the query its record.
 */
export function queryLogRow(run: QueryRun) {
  const via = (QUERY_VIAS as readonly string[]).includes(run.via ?? "") ? run.via! : "app";
  const engine =
    (run.engine || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^[^a-z]+/, "")
      .slice(0, 32) || "unknown";
  return {
    user_id: run.userId,
    actor_user_id: run.actorUserId && run.actorUserId !== run.userId ? run.actorUserId : null,
    via,
    engine,
    connection_id: textOrNull(run.connectionId, 80),
    connection_name: textOrNull(run.connectionName, 200),
    sql: run.sql.slice(0, 20_000),
    status: run.ok ? "ok" : "error",
    error: run.ok ? null : (textOrNull(run.error, 500) ?? "failed"),
    row_count: intOrNull(run.rowCount, 2_147_483_647),
    duration_ms: intOrNull(run.durationMs, 2_147_483_647),
    bytes_scanned: intOrNull(run.bytesScanned, Number.MAX_SAFE_INTEGER),
    engine_query_id: textOrNull(run.engineQueryId, 200),
    cost_usd: usdOrNull(run.costUsd),
    cost_basis: textOrNull(run.costBasis, 200),
    ai_cost_usd: usdOrNull(run.aiCostUsd),
  };
}

// ── Showing it ───────────────────────────────────────────────────────────

/** Bytes as people read them: 0 B, 512 KB, 1.4 GB. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Dollars: "$0.00" for nothing, "<$0.01" for a fraction of a cent, else two places. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** A query's time: "84 ms", "2.4 s", "3 min 05 s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(sec).padStart(2, "0")} s`;
}

/**
 * Where "Open in workbench" points a logged query: the workbench's own name
 * for the source it ran on, or null where the workbench cannot run it (the
 * lakehouse has its own editor).
 */
export function workbenchSourceFor(row: {
  engine: string;
  connection_id: string | null;
}): string | null {
  if (row.engine === "browser" || row.engine === "local") return "local";
  if (row.engine === "lakehouse" || row.engine === "spark") return null;
  return row.connection_id ?? null;
}
