// Data monitors, the running half: execute one check against its table,
// judge it against its history, record the run, open or close the incident,
// tell the owner. And the sweep that finds the due ones on the platform's
// clock, sharing the ETL scheduler's lease so several replicas never run the
// same monitor twice.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { nextEtlRunAt } from "@/utils/etl/schedule.server";
import { lakehouseSnapshotId, runLakehouseStatement } from "@/utils/lakehouse/core.server";
import { listLakehouseTablesForUser } from "@/utils/lakehouse/tables.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { notifyUser } from "@/utils/notify.server";
import {
  ageMinutes,
  baselineOf,
  buildMonitorSql,
  evaluateMonitor,
  validateMonitorConfig,
  type Baseline,
  type ColumnSnapshot,
  type MonitorConfig,
  type MonitorKind,
} from "@/utils/dataMonitors/core";

export type DataMonitorRow = Database["public"]["Tables"]["data_monitors"]["Row"];
export type DataMonitorRunRow = Database["public"]["Tables"]["data_monitor_runs"]["Row"];
export type DataIncidentRow = Database["public"]["Tables"]["data_incidents"]["Row"];

/** Runs the baseline is learned from. Long enough to average a week of daily ticks. */
const HISTORY = 14;
/** One check must answer within this, or it is an error, not a finding. */
const CHECK_TIMEOUT_MS = 60_000;

export function nextMonitorRunAt(
  schedule: string,
  cronExpr?: string | null,
  timezone?: string | null,
  from = new Date(),
): string | null {
  return nextEtlRunAt(schedule, from, cronExpr ?? null, timezone ?? null);
}

type Measured = {
  value: number | null;
  latest?: string | null;
  columns?: ColumnSnapshot[];
  snapshotId?: string | null;
  sql?: string;
};

function firstNumber(rows: unknown[][] | Record<string, unknown>[]): number | null {
  const row = rows[0];
  if (!row) return null;
  const cell = Array.isArray(row) ? row[0] : Object.values(row)[0];
  if (cell === null || cell === undefined) return null;
  const n = typeof cell === "number" ? cell : Number(cell);
  return Number.isFinite(n) ? n : null;
}

function firstCell(rows: unknown[][] | Record<string, unknown>[]): unknown {
  const row = rows[0];
  if (!row) return null;
  return Array.isArray(row) ? row[0] : Object.values(row)[0];
}

/** Run the check's SQL where the table lives and read back what it measured. */
async function measure(m: DataMonitorRow): Promise<Measured> {
  const kind = m.kind as MonitorKind;
  const config = (m.config ?? {}) as MonitorConfig;
  const sql = buildMonitorSql(kind, config, m.schema_name, m.table_name);
  let rows: unknown[][] | Record<string, unknown>[];
  let snapshotId: string | null = null;
  if (m.source_kind === "lakehouse" && kind === "schema") {
    // information_schema is not a user schema, so the per-user statement
    // guard rightly refuses it. The catalog listing already answers the
    // question - after the same access check - so the schema check reads the
    // column list from there, exactly as the Lakehouse page does.
    const listing = await listLakehouseTablesForUser(m.user_id);
    const found = listing.tables.find(
      (t) => t.schema === m.schema_name && t.table === m.table_name,
    );
    if (!found) {
      throw new Error(
        `No access to table "${m.schema_name}.${m.table_name}" - it doesn't exist, or nobody shared it with you`,
      );
    }
    const columns: ColumnSnapshot[] = found.columns.map((c) => ({ name: c.name, type: c.type }));
    snapshotId = await lakehouseSnapshotId().catch(() => null);
    return { value: columns.length, columns, snapshotId };
  }
  if (m.source_kind === "lakehouse") {
    const res = await runLakehouseStatement(m.user_id, sql, {
      rowCap: kind === "schema" ? 2000 : 1,
      timeoutMs: CHECK_TIMEOUT_MS,
      auditVia: "data_monitor",
      // A check reads the table as it is now; a cached answer would report the
      // freshness of the cache.
      useCache: false,
    });
    rows = res.rows;
    snapshotId = await lakehouseSnapshotId().catch(() => null);
  } else {
    const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
    const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
    const conn = await loadWarehouseConnectionForUser(
      supabaseAdmin,
      { connectionId: m.warehouse_id ?? undefined },
      m.user_id,
    );
    const res = await executeWarehouseQuery(conn.config, sql, kind === "schema" ? 2000 : 1, {
      userId: m.user_id,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    rows = res.rows;
  }
  if (kind === "schema") {
    const columns: ColumnSnapshot[] = rows.map((r) => {
      const cells = Array.isArray(r) ? r : Object.values(r);
      return { name: String(cells[0] ?? ""), type: String(cells[1] ?? "") };
    });
    return { value: columns.length, columns, snapshotId, sql };
  }
  if (kind === "freshness") {
    const latest = firstCell(rows);
    const age = ageMinutes(latest);
    return {
      value: age,
      latest: latest === null || latest === undefined ? null : String(latest),
      snapshotId,
      sql,
    };
  }
  return { value: firstNumber(rows), snapshotId, sql };
}

async function recentRuns(monitorId: string): Promise<DataMonitorRunRow[]> {
  const { data } = await supabaseAdmin
    .from("data_monitor_runs")
    .select("*")
    .eq("monitor_id", monitorId)
    .neq("status", "error")
    .order("ran_at", { ascending: false })
    .limit(HISTORY + 1);
  return (data ?? []) as DataMonitorRunRow[];
}

/**
 * Execute one monitor now and record what happened. Never throws: an error
 * in the check is a run with status "error", and an error writing the run is
 * logged, because a monitor that crashes the sweep silences every other one.
 */
export async function runDataMonitor(
  m: DataMonitorRow,
  trigger: "schedule" | "manual" | "pipeline" = "schedule",
): Promise<{ status: "ok" | "alert" | "error"; message: string; runId: string | null }> {
  const started = Date.now();
  const kind = m.kind as MonitorKind;
  const config = (m.config ?? {}) as MonitorConfig;
  const invalid = validateMonitorConfig(kind, config);
  let status: "ok" | "alert" | "error" = "error";
  let message = "";
  let value: number | null = null;
  let baseline: Baseline | null = null;
  let detail: Record<string, unknown> = {};
  let snapshotId: string | null = null;
  try {
    if (invalid) throw new Error(invalid);
    const measured = await measure(m);
    value = measured.value;
    snapshotId = measured.snapshotId ?? null;
    const history = await recentRuns(m.id);
    const previous = history[0] ?? null;
    if (kind === "volume") {
      const settings = await getPlatformResources();
      // The baseline is learned from what the monitor judges: deltas between
      // runs for an append-only table, totals for a table that is replaced.
      const mode = config.mode ?? "delta";
      const series = history
        .map((r) => {
          const d = (r.detail ?? {}) as { delta?: number | null; total?: number | null };
          return mode === "delta" ? d.delta : (d.total ?? r.value);
        })
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
        .slice(0, HISTORY);
      baseline = baselineOf(series, settings.dataMonitorAnomalySigma);
    }
    const previousColumns =
      kind === "schema"
        ? (((previous?.detail ?? {}) as { columns?: ColumnSnapshot[] }).columns ?? null)
        : null;
    const previousTotal =
      kind === "volume"
        ? (((previous?.detail ?? {}) as { total?: number }).total ?? previous?.value ?? null)
        : null;
    const ev = evaluateMonitor({
      kind,
      config,
      value,
      previousValue: previousTotal,
      baseline,
      latest: measured.latest ?? null,
      columns: measured.columns,
      previousColumns,
    });
    status = ev.status;
    message = ev.message;
    detail = { ...ev.detail, sql: measured.sql };
  } catch (e) {
    status = "error";
    message = (e as Error).message || "The check failed";
    detail = { error: message };
  }
  const durationMs = Date.now() - started;

  const { data: run, error: runErr } = await supabaseAdmin
    .from("data_monitor_runs")
    .insert({
      monitor_id: m.id,
      user_id: m.user_id,
      trigger,
      status,
      value,
      baseline: baseline
        ? (baseline as unknown as Database["public"]["Tables"]["data_monitor_runs"]["Insert"]["baseline"])
        : null,
      detail: detail as Database["public"]["Tables"]["data_monitor_runs"]["Insert"]["detail"],
      message: message.slice(0, 1000),
      duration_ms: durationMs,
      snapshot_id: snapshotId,
    })
    .select("id")
    .single();
  if (runErr) console.warn(`[data-monitor] run insert failed for "${m.name}": ${runErr.message}`);

  const alerts = status === "alert" ? (m.consecutive_alerts ?? 0) + 1 : 0;
  await supabaseAdmin
    .from("data_monitors")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: status,
      last_value: value,
      last_message: message.slice(0, 1000),
      consecutive_alerts: alerts,
    })
    .eq("id", m.id);

  await reconcileIncident(m, status, message, detail, run?.id ?? null).catch((e) =>
    console.warn(`[data-monitor] incident update failed for "${m.name}": ${(e as Error).message}`),
  );
  return { status, message, runId: run?.id ?? null };
}

/**
 * Open, extend, or resolve the monitor's incident. One open incident per
 * monitor: a failing run reopens nothing and resolves nothing, it extends;
 * a passing run resolves; a person's acknowledgement stops the repeat
 * notifications but the incident stays until a run passes or they resolve it.
 */
async function reconcileIncident(
  m: DataMonitorRow,
  status: "ok" | "alert" | "error",
  message: string,
  detail: Record<string, unknown>,
  runId: string | null,
): Promise<void> {
  const { data: open } = await supabaseAdmin
    .from("data_incidents")
    .select("*")
    .eq("monitor_id", m.id)
    .neq("status", "resolved")
    .maybeSingle();
  const link = "/data-monitors";
  const where = `${m.schema_name}.${m.table_name}`;
  if (status === "alert") {
    if (open) {
      await supabaseAdmin
        .from("data_incidents")
        .update({
          last_seen_at: new Date().toISOString(),
          occurrences: (open.occurrences ?? 1) + 1,
          detail: {
            ...(open.detail as Record<string, unknown>),
            last_message: message,
            last_run_id: runId,
          },
        })
        .eq("id", open.id);
      return;
    }
    const { data: created } = await supabaseAdmin
      .from("data_incidents")
      .insert({
        monitor_id: m.id,
        user_id: m.user_id,
        severity: m.severity,
        title: `${m.name}: ${message}`.slice(0, 300),
        detail: {
          ...detail,
          last_message: message,
          last_run_id: runId,
        } as Database["public"]["Tables"]["data_incidents"]["Insert"]["detail"],
        notified_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    auditEvent({
      userId: m.user_id,
      action: "data.monitor.alert",
      resourceType: "data_monitor",
      resourceId: m.id,
      resourceName: m.name,
      detail: {
        table: where,
        kind: m.kind,
        severity: m.severity,
        message,
        incident_id: created?.id ?? null,
        run_id: runId,
      },
    });
    await notifyUser(m.user_id, {
      kind: "alert",
      title: `${m.severity === "critical" ? "Critical: " : ""}${m.name}`,
      body: `${where}: ${message}`,
      link,
    });
    return;
  }
  if (status === "ok" && open) {
    await supabaseAdmin
      .from("data_incidents")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: "run" })
      .eq("id", open.id);
    auditEvent({
      userId: m.user_id,
      action: "data.incident.resolved",
      resourceType: "data_monitor",
      resourceId: m.id,
      resourceName: m.name,
      detail: { table: where, incident_id: open.id, by: "run", message },
    });
    await notifyUser(m.user_id, {
      kind: "alert",
      title: `Recovered: ${m.name}`,
      body: `${where}: ${message}`,
      link,
    });
  }
  // An error is neither: the check could not answer, which the run records
  // and the page shows, but a table is not declared broken on a timeout.
}

/**
 * Run every active monitor whose time has come. Claim-by-clock: the update
 * that advances next_run_at is conditioned on the value we read, so of
 * several replicas sweeping at once exactly one wins each monitor.
 */
export async function processDueDataMonitors(force = false): Promise<number> {
  const settings = await getPlatformResources();
  const nowIso = new Date().toISOString();
  let query = supabaseAdmin
    .from("data_monitors")
    .select("*")
    .eq("is_active", true)
    .order("next_run_at", { ascending: true })
    .limit(settings.dataMonitorsPerSweep);
  if (!force) query = query.lte("next_run_at", nowIso);
  const { data: due } = await query;
  let ran = 0;
  for (const m of (due ?? []) as DataMonitorRow[]) {
    let claim = supabaseAdmin
      .from("data_monitors")
      .update({ next_run_at: nextMonitorRunAt(m.schedule, m.cron_expr, m.timezone) })
      .eq("id", m.id);
    claim =
      m.next_run_at === null
        ? claim.is("next_run_at", null)
        : claim.eq("next_run_at", m.next_run_at);
    const { data: won } = await claim.select("id");
    if (!won?.length) continue; // another replica claimed this tick
    await runDataMonitor(m, "schedule");
    ran++;
  }
  return ran;
}

/** Monitors on one table, for the catalog, the lakehouse page and the agent tool. */
export async function monitorsForTable(
  userId: string,
  sourceKind: "lakehouse" | "warehouse",
  schema: string,
  table: string,
): Promise<
  Pick<
    DataMonitorRow,
    "id" | "name" | "kind" | "last_status" | "last_message" | "last_run_at" | "is_active"
  >[]
> {
  const { data } = await supabaseAdmin
    .from("data_monitors")
    .select("id, name, kind, last_status, last_message, last_run_at, is_active")
    .eq("user_id", userId)
    .eq("source_kind", sourceKind)
    .eq("schema_name", schema)
    .eq("table_name", table)
    .order("created_at");
  return (data ?? []) as Pick<
    DataMonitorRow,
    "id" | "name" | "kind" | "last_status" | "last_message" | "last_run_at" | "is_active"
  >[];
}
