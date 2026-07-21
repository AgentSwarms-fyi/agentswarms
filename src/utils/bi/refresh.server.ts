// Server-side scheduled refresh + data alerts for BI dashboards.
//
// Runs with the service role on behalf of each dashboard's owner:
//   - warehouse widgets execute through the existing driver layer with the
//     owner's stored (encrypted) credentials;
//   - local widgets run through a per-call AlaSQL database hydrated from the
//     owner's stored dataset rows (plus shared samples) — the same data the
//     browser engine uses;
//   - after a refresh, active alert rules are evaluated against the fresh
//     snapshots; a rule notifies once when it trips and re-arms when the
//     condition clears. Refresh failures notify too.
//
// Triggering: `ensureScheduler()` starts a 60s interval inside the running
// node server (lazily, on first request that imports this module) and
// `/api/bi/cron` lets external cron services drive it on serverless hosts.
import alasql from "alasql";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadWarehouseConnection } from "@/utils/warehouse/connections.server";
import { executeWarehouseQuery } from "@/utils/warehouse/drivers.server";

const WIDGET_ROW_CAP = 500;
const LOCAL_ROWS_PER_TABLE_CAP = 20_000;
const MIN_PROCESS_INTERVAL_MS = 30_000;
const SCHEDULES_PER_RUN = 10;

type WidgetJson = {
  id?: string;
  kind?: string;
  title?: string;
  sql?: string;
  source?: { kind?: string; connection_id?: string };
  columns?: string[];
  rows?: Record<string, unknown>[];
  refreshed_at?: string;
  [k: string]: unknown;
};

// ── Local SQL (server-side AlaSQL) ───────────────────────────────────────

function assertReadOnly(sql: string): string {
  const cleaned = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+\s*$/, "");
  if (cleaned.includes(";")) throw new Error("Only a single statement is allowed");
  if (!/^(select|with)\b/i.test(cleaned)) throw new Error("Only SELECT queries are allowed");
  return cleaned;
}

/** Run a widget's SQL against the owner's stored datasets, server-side. */
export async function runLocalSqlForUser(
  userId: string,
  sql: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const safeSql = assertReadOnly(sql);
  const { data: tables, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, user_id, is_sample")
    .or(`user_id.eq.${userId},is_sample.eq.true`);
  if (error) throw new Error(error.message);

  // Fresh database per call — never share state across users/runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new (alasql as any).Database();
  for (const t of tables ?? []) {
    const rows: Record<string, unknown>[] = [];
    const PAGE = 1000;
    for (let start = 0; start < LOCAL_ROWS_PER_TABLE_CAP; start += PAGE) {
      const { data: chunk, error: rowErr } = await supabaseAdmin
        .from("user_data_rows")
        .select("row")
        .eq("table_id", t.id)
        .range(start, start + PAGE - 1);
      if (rowErr || !chunk || chunk.length === 0) break;
      rows.push(...chunk.map((c) => c.row as Record<string, unknown>));
      if (chunk.length < PAGE) break;
    }
    db.exec(`CREATE TABLE \`${t.name}\``);
    db.tables[t.name].data = rows;
  }

  const out = db.exec(safeSql) as Record<string, unknown>[];
  const rows = (Array.isArray(out) ? out : []).slice(0, WIDGET_ROW_CAP);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

// ── Dashboard refresh ────────────────────────────────────────────────────

export async function refreshDashboardServer(
  dashboardId: string,
): Promise<{ userId: string; name: string; widgets: WidgetJson[]; failures: string[] }> {
  const { data: dash, error } = await supabaseAdmin
    .from("bi_dashboards")
    .select("id, user_id, name, widgets")
    .eq("id", dashboardId)
    .single();
  if (error || !dash) throw new Error(error?.message ?? "Dashboard not found");

  const widgets = (Array.isArray(dash.widgets) ? dash.widgets : []) as WidgetJson[];
  const failures: string[] = [];

  for (const w of widgets) {
    if (w.kind !== "chart" || !w.sql) continue;
    try {
      let result: { columns: string[]; rows: Record<string, unknown>[] };
      if (w.source?.kind === "warehouse" && w.source.connection_id) {
        const conn = await loadWarehouseConnection(
          supabaseAdmin,
          { connectionId: w.source.connection_id },
          dash.user_id,
        );
        const res = await executeWarehouseQuery(conn.config, w.sql, WIDGET_ROW_CAP);
        result = { columns: res.columns.map((c) => c.name), rows: res.rows };
      } else {
        result = await runLocalSqlForUser(dash.user_id, w.sql);
      }
      w.columns = result.columns;
      w.rows = result.rows.slice(0, WIDGET_ROW_CAP);
      w.refreshed_at = new Date().toISOString();
    } catch (e) {
      failures.push(`"${w.title ?? w.id}": ${(e as Error).message}`);
    }
  }

  const { error: upErr } = await supabaseAdmin
    .from("bi_dashboards")
    .update({ widgets: widgets as never, updated_at: new Date().toISOString() })
    .eq("id", dashboardId);
  if (upErr) throw new Error(upErr.message);

  return { userId: dash.user_id, name: dash.name, widgets, failures };
}

// ── Alerts ───────────────────────────────────────────────────────────────

/** Compute an alert's metric from a widget's snapshot rows. Pure. */
export function alertValue(
  rows: Record<string, unknown>[],
  columnName: string,
  aggregation: string,
): number | null {
  if (!columnName || aggregation === "count") return rows.length;
  const nums = rows.map((r) => Number(r[columnName])).filter((n) => Number.isFinite(n));
  if (aggregation === "first") {
    const v = Number(rows[0]?.[columnName]);
    return Number.isFinite(v) ? v : null;
  }
  if (nums.length === 0) return null;
  switch (aggregation) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    default:
      return null;
  }
}

/** Pure comparison used by the alert engine. */
export function alertFires(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    case "neq":
      return value !== threshold;
    default:
      return false;
  }
}

const OP_LABEL: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
  neq: "≠",
};

async function notify(userId: string, title: string, body: string, link: string, kind = "alert") {
  await supabaseAdmin.from("notifications").insert({ user_id: userId, kind, title, body, link });
}

export async function evaluateAlerts(
  dashboardId: string,
  dashboardName: string,
  userId: string,
  widgets: WidgetJson[],
): Promise<void> {
  const { data: alerts } = await supabaseAdmin
    .from("bi_alerts")
    .select("*")
    .eq("dashboard_id", dashboardId)
    .eq("is_active", true);
  const now = new Date().toISOString();
  for (const a of alerts ?? []) {
    const widget = widgets.find((w) => w.id === a.widget_id);
    if (!widget) continue;
    const value = alertValue(widget.rows ?? [], a.column_name, a.aggregation);
    if (value === null) continue;
    const fires = alertFires(value, a.operator, Number(a.threshold));
    if (fires && a.last_state !== "triggered") {
      const metric = a.column_name ? `${a.aggregation}(${a.column_name})` : "row count";
      await notify(
        userId,
        a.label || `Alert on "${widget.title ?? "widget"}"`,
        `${metric} is ${Math.round(value * 100) / 100} (${OP_LABEL[a.operator] ?? a.operator} ${a.threshold}) on "${dashboardName}".`,
        `/bi/${dashboardId}`,
      );
    }
    await supabaseAdmin
      .from("bi_alerts")
      .update({ last_state: fires ? "triggered" : "ok", last_value: value, last_checked_at: now })
      .eq("id", a.id);
  }
}

// ── Schedule processing ──────────────────────────────────────────────────

/** Next run after `from`, in UTC. Pure — exported for tests. */
export function computeNextRun(cadence: string, atHour: number, weekday: number, from: Date): Date {
  const next = new Date(from.getTime());
  if (cadence === "hourly") {
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  next.setUTCHours(atHour, 0, 0, 0);
  if (cadence === "daily") {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  // weekly
  const delta = (weekday - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + delta);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

let lastProcessed = 0;
let processing = false;

/** Refresh every due schedule (idempotent, internally throttled). */
export async function processDueSchedules(force = false): Promise<number> {
  const now = Date.now();
  if (processing) return 0;
  if (!force && now - lastProcessed < MIN_PROCESS_INTERVAL_MS) return 0;
  processing = true;
  lastProcessed = now;
  try {
    const { data: due } = await supabaseAdmin
      .from("bi_schedules")
      .select("*")
      .eq("enabled", true)
      .lte("next_run_at", new Date().toISOString())
      .order("next_run_at")
      .limit(SCHEDULES_PER_RUN);
    let ran = 0;
    for (const s of due ?? []) {
      let status = "ok";
      let lastError: string | null = null;
      try {
        const res = await refreshDashboardServer(s.dashboard_id);
        await evaluateAlerts(s.dashboard_id, res.name, res.userId, res.widgets);
        if (res.failures.length > 0) {
          status = "partial";
          lastError = res.failures.join("; ").slice(0, 500);
          await notify(
            res.userId,
            `Scheduled refresh had failures — "${res.name}"`,
            res.failures.join("\n").slice(0, 500),
            `/bi/${s.dashboard_id}`,
            "warning",
          );
        }
      } catch (e) {
        status = "error";
        lastError = (e as Error).message.slice(0, 500);
        await notify(
          s.user_id,
          "Scheduled dashboard refresh failed",
          lastError,
          `/bi/${s.dashboard_id}`,
          "error",
        );
      }
      await supabaseAdmin
        .from("bi_schedules")
        .update({
          last_run_at: new Date().toISOString(),
          last_status: status,
          last_error: lastError,
          next_run_at: computeNextRun(s.cadence, s.at_hour, s.weekday, new Date()).toISOString(),
        })
        .eq("id", s.id);
      ran++;
    }
    return ran;
  } finally {
    processing = false;
  }
}

// ── In-process scheduler (long-running node server) ──────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __biSchedulerStarted: boolean | undefined;
}

export function ensureScheduler(): void {
  if (globalThis.__biSchedulerStarted) return;
  globalThis.__biSchedulerStarted = true;
  setInterval(() => {
    processDueSchedules().catch((e) =>
      console.warn("[bi-scheduler] processing failed:", (e as Error).message),
    );
  }, 60_000).unref?.();
}
