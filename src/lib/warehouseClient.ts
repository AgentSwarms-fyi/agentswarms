// Browser-side helpers for querying external warehouse connections through
// the authenticated /api/warehouse/* routes. Results are mapped into the
// same QueryResult shape the local AlaSQL engine produces so charts, the BI
// agent and dashboards treat both sources identically.
import type { QueryResult, DatasetMeta } from "@/lib/sqlEngine";
import type { WarehouseTable } from "@/utils/warehouse/types";
import type { DirectFilter } from "@/lib/biDirectQuery";

/**
 * Live "Direct query" for a BI widget — re-runs the widget's SQL against the
 * warehouse AS THE DASHBOARD OWNER (server-side), with global filters pushed
 * down and the caller's row-level-security filter enforced. Used only for
 * authenticated dashboard views; public embeds/shares render snapshots.
 */
export async function runBiDirectQuery(
  accessToken: string,
  args: { dashboardId: string; widgetId: string; filters?: DirectFilter[] },
): Promise<QueryResult> {
  const resp = await fetch("/api/bi/direct-query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      dashboard_id: args.dashboardId,
      widget_id: args.widgetId,
      filters: args.filters ?? [],
    }),
  });
  const j = (await resp.json()) as {
    columns?: ({ name: string } | string)[];
    rows?: Record<string, unknown>[];
    row_count?: number;
    truncated?: boolean;
    message?: string;
    error?: string;
  };
  if (!resp.ok) throw new Error(j.message || j.error || "Direct query failed");
  return {
    columns: (j.columns ?? []).map((c) => (typeof c === "string" ? c : c.name)),
    rows: j.rows ?? [],
    row_count: j.row_count ?? 0,
    total_matched: j.row_count ?? 0,
    capped: Boolean(j.truncated),
    duration_ms: 0,
  };
}

export async function fetchWarehouseSchema(
  accessToken: string,
  connectionId: string,
): Promise<WarehouseTable[]> {
  const resp = await fetch("/api/warehouse/schema", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ connection_id: connectionId }),
  });
  const j = (await resp.json()) as {
    tables?: WarehouseTable[];
    message?: string;
    error?: string;
  };
  if (!resp.ok) throw new Error(j.message || j.error || "Failed to load warehouse schema");
  return j.tables ?? [];
}

export async function runWarehouseQuery(
  accessToken: string,
  connectionId: string,
  sql: string,
): Promise<QueryResult> {
  const resp = await fetch("/api/warehouse/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ connection_id: connectionId, sql }),
  });
  const j = (await resp.json()) as {
    columns?: { name: string }[];
    rows?: Record<string, unknown>[];
    row_count?: number;
    truncated?: boolean;
    duration_ms?: number;
    message?: string;
    error?: string;
  };
  if (!resp.ok) throw new Error(j.message || j.error || "Warehouse query failed");
  return {
    columns: (j.columns ?? []).map((c) => c.name),
    rows: j.rows ?? [],
    row_count: j.row_count ?? 0,
    total_matched: j.row_count ?? 0,
    capped: Boolean(j.truncated),
    duration_ms: j.duration_ms ?? 0,
  };
}

/** Present warehouse tables in DatasetMeta shape for the BI agent. */
export function warehouseTablesAsDatasets(
  connectionId: string,
  tables: WarehouseTable[],
  userId: string | null,
): DatasetMeta[] {
  return tables.map((t) => ({
    id: `${connectionId}:${t.schema}.${t.name}`,
    name: `${t.schema}.${t.name}`,
    source_filename: null,
    is_sample: false,
    user_id: userId,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: /INT|NUM|DEC|FLOAT|DOUBLE|REAL|LONG|BIGNUMERIC/i.test(c.type)
        ? ("number" as const)
        : /DATE|TIME/i.test(c.type)
          ? ("date" as const)
          : ("string" as const),
    })),
    row_count: 0,
  }));
}
