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
import { createRequire } from "node:module";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import type { SemanticQuery } from "@/lib/semanticLayer";
import { sendMail } from "@/lib/email/mailer.server";
import { loadWarehouseConnection } from "@/utils/warehouse/connections.server";
import { executeWarehouseQuery } from "@/utils/warehouse/drivers.server";
import {
  buildPrepSql,
  castRows,
  parsePrepConfig,
  validatePrepConfig,
  PREP_SAVE_ROW_CAP,
} from "@/lib/dataPrepCore";

const WIDGET_ROW_CAP = 500;
const LOCAL_ROWS_PER_TABLE_CAP = 20_000;
const MIN_PROCESS_INTERVAL_MS = 30_000;
const SCHEDULES_PER_RUN = 10;

// AlaSQL ships a UMD build whose global-object dance breaks inside Vite's
// SSR module runner ("Cannot set properties of undefined"). Loading it
// lazily through Node's own CJS loader sidesteps the runner entirely, and
// keeps server boot free of the dependency.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let alasqlModule: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAlasql(): any {
  if (!alasqlModule) {
    const require = createRequire(import.meta.url);
    alasqlModule = require("alasql");
  }
  return alasqlModule;
}

type WidgetJson = {
  id?: string;
  kind?: string;
  title?: string;
  sql?: string;
  source?: {
    kind?: string;
    connection_id?: string;
    // semantic-source widgets carry the governed query instead of raw SQL
    model?: string;
    metrics?: string[];
    dimensions?: string[];
    filters?: unknown[];
  };
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
  const alasql = loadAlasql();
  const db = new alasql.Database();
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

export async function refreshDashboardServer(dashboardId: string): Promise<{
  userId: string;
  name: string;
  widgets: WidgetJson[];
  failures: string[];
  /** Human-readable "what changed vs the previous snapshots" lines. */
  changes: string[];
}> {
  // `updated_at` is read as an optimistic-concurrency token: the editor
  // autosaves the whole widgets array from browser state, so without a guard a
  // refresh landing mid-edit would silently overwrite the user's work. A
  // BEFORE UPDATE trigger maintains this column, so it changes on every save.
  const { data: dash, error } = await supabaseAdmin
    .from("bi_dashboards")
    .select("id, user_id, name, widgets, updated_at")
    .eq("id", dashboardId)
    .single();
  if (error || !dash) throw new Error(error?.message ?? "Dashboard not found");
  const readUpdatedAt = dash.updated_at;

  const widgets = (Array.isArray(dash.widgets) ? dash.widgets : []) as WidgetJson[];
  // Shallow copies keep the pre-refresh row arrays (the loop below REASSIGNS
  // w.rows, never mutates it), so we can diff snapshots afterwards.
  const before = widgets.map((w) => ({ ...w }));
  const failures: string[] = [];

  for (const w of widgets) {
    if (w.kind !== "chart") continue;
    if (!w.sql && w.source?.kind !== "semantic") continue;
    try {
      let result: { columns: string[]; rows: Record<string, unknown>[] };
      if (w.source?.kind === "semantic") {
        // Re-run the GOVERNED metric query so the widget reflects the CURRENT
        // metric definition (not a frozen SQL snapshot). Dynamic import breaks a
        // cycle: query.server imports runLocalSqlForUser from this module.
        const { runSemanticQuery } = await import("@/utils/semantic/query.server");
        const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
        const grantedModelIds = [
          ...(await resolveGrantedResourceIds(supabaseAdmin, dash.user_id, "semantic_model")),
        ];
        const r = await runSemanticQuery({
          sb: supabaseAdmin,
          userId: dash.user_id,
          scopeUserId: dash.user_id,
          grantedModelIds,
          query: {
            model: w.source.model ?? "",
            metrics: w.source.metrics ?? [],
            dimensions: w.source.dimensions ?? [],
            filters: (w.source.filters ?? []) as SemanticQuery["filters"],
          },
          maxRows: WIDGET_ROW_CAP,
        });
        result = { columns: r.columns, rows: r.rows };
      } else if (w.source?.kind === "warehouse" && w.source.connection_id) {
        const conn = await loadWarehouseConnection(
          supabaseAdmin,
          { connectionId: w.source.connection_id },
          dash.user_id,
        );
        const res = await executeWarehouseQuery(conn.config, w.sql!, WIDGET_ROW_CAP);
        result = { columns: res.columns.map((c) => c.name), rows: res.rows };
      } else {
        result = await runLocalSqlForUser(dash.user_id, w.sql!);
      }
      w.columns = result.columns;
      w.rows = result.rows.slice(0, WIDGET_ROW_CAP);
      w.refreshed_at = new Date().toISOString();
    } catch (e) {
      failures.push(`"${w.title ?? w.id}": ${(e as Error).message}`);
    }
  }

  // Conditional write: only land if nobody saved the dashboard while we were
  // querying. If they did, drop this refresh rather than clobber their edit —
  // the next tick picks it up against the new baseline. Losing one refresh
  // cycle is recoverable; losing a user's edits is not.
  const { data: written, error: upErr } = await supabaseAdmin
    .from("bi_dashboards")
    .update({ widgets: widgets as never, updated_at: new Date().toISOString() })
    .eq("id", dashboardId)
    .eq("updated_at", readUpdatedAt)
    .select("id");
  if (upErr) throw new Error(upErr.message);
  if (!written || written.length === 0) {
    throw new Error(
      "Dashboard changed while refreshing (concurrent edit) — skipped this cycle to avoid " +
        "overwriting it; the next scheduled refresh will retry.",
    );
  }

  return {
    userId: dash.user_id,
    name: dash.name,
    widgets,
    failures,
    changes: computeSnapshotChanges(before, widgets),
  };
}

// ── Insight digest: what changed between refreshes ───────────────────────

type ChartFields = {
  type?: string;
  valueField?: string;
  yField?: string;
  xField?: string;
  nameField?: string;
};

/**
 * Diff pre/post-refresh snapshots into short "what changed" lines. Pure.
 * KPIs report their value shift; categorical charts report the biggest
 * mover (by absolute delta of the per-category sum); other widgets fall
 * back to a row-count shift. Small moves are filtered out so the digest
 * only surfaces things worth reading.
 */
export function computeSnapshotChanges(before: WidgetJson[], after: WidgetJson[]): string[] {
  const out: string[] = [];
  const prevById = new Map(before.map((w) => [w.id, w]));
  const pctStr = (pct: number) =>
    ` (${pct > 0 ? "+" : ""}${Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%)`;
  for (const w of after) {
    if (w.kind !== "chart" || !w.refreshed_at) continue;
    const prev = prevById.get(w.id);
    if (!prev) continue;
    const chart = (w.chart ?? {}) as ChartFields;
    const oldRows = prev.rows ?? [];
    const newRows = w.rows ?? [];
    if (oldRows.length === 0 && newRows.length === 0) continue;
    const title = w.title ?? "Widget";

    if (chart.type === "kpi" && chart.valueField) {
      const a = Number(oldRows[0]?.[chart.valueField]);
      const b = Number(newRows[0]?.[chart.valueField]);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
        const pct = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null;
        if (pct === null || Math.abs(pct) >= 2) {
          out.push(`${title}: ${fmtNum(a)} → ${fmtNum(b)}${pct !== null ? pctStr(pct) : ""}`);
        }
      }
      continue;
    }

    const cat = chart.xField ?? chart.nameField;
    const val = chart.yField ?? chart.valueField;
    if (cat && val) {
      const agg = (rows: Record<string, unknown>[]) => {
        const m = new Map<string, number>();
        for (const r of rows) {
          const v = Number(r[val]);
          if (!Number.isFinite(v)) continue;
          const k = String(r[cat] ?? "—");
          m.set(k, (m.get(k) ?? 0) + v);
        }
        return m;
      };
      const a = agg(oldRows);
      const b = agg(newRows);
      let best: { k: string; av: number; bv: number; delta: number } | null = null;
      for (const k of new Set([...a.keys(), ...b.keys()])) {
        const av = a.get(k) ?? 0;
        const bv = b.get(k) ?? 0;
        const delta = Math.abs(bv - av);
        if (delta > 0 && (!best || delta > best.delta)) best = { k, av, bv, delta };
      }
      if (best) {
        const pct =
          Math.abs(best.av) > 1e-9 ? ((best.bv - best.av) / Math.abs(best.av)) * 100 : null;
        if (pct === null || Math.abs(pct) >= 10) {
          out.push(
            `${title} — ${best.k}: ${fmtNum(best.av)} → ${fmtNum(best.bv)}${pct !== null ? pctStr(pct) : ""}`,
          );
        }
      }
      continue;
    }

    if (oldRows.length > 0 && Math.abs(newRows.length - oldRows.length) / oldRows.length >= 0.1) {
      out.push(
        `${title}: ${oldRows.length.toLocaleString()} rows → ${newRows.length.toLocaleString()} rows`,
      );
    }
  }
  return out.slice(0, 8);
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

/** Owner's email address for alert/report delivery (null = none/unknown). */
async function ownerEmail(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

function siteUrl(): string {
  return (process.env.SITE_URL || "http://localhost:8080").replace(/\/+$/, "");
}

const EMAIL_STYLE =
  "font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#1a1a2e;line-height:1.5";

function emailShell(title: string, bodyHtml: string, link: string, linkLabel: string): string {
  return `<div style="${EMAIL_STYLE};max-width:560px;margin:0 auto;padding:24px">
  <p style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin:0 0 4px">AgentSwarms BI</p>
  <h2 style="margin:0 0 12px;font-size:19px">${title}</h2>
  ${bodyHtml}
  <p style="margin:20px 0 0"><a href="${link}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px">${linkLabel}</a></p>
</div>`;
}

/** Compact numeric rendering for email digests. */
function fmtNum(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** HTML digest of a dashboard's fresh snapshots: KPI strip + widget lines. */
export function buildReportDigest(
  dashboardName: string,
  widgets: WidgetJson[],
  changes: string[] = [],
): { html: string; text: string } {
  const charts = widgets.filter((w) => w.kind === "chart");
  const kpis = charts.filter(
    (w) => (w.chart as { type?: string } | undefined)?.type === "kpi" && (w.rows?.length ?? 0) > 0,
  );
  const kpiCells = kpis
    .slice(0, 6)
    .map((w) => {
      const chart = w.chart as { valueField?: string } | undefined;
      const v = chart?.valueField ? w.rows?.[0]?.[chart.valueField] : undefined;
      return `<td style="padding:10px 14px;border:1px solid #e5e7eb;border-radius:8px">
        <div style="font-size:11px;color:#6b7280">${w.title ?? ""}</div>
        <div style="font-size:20px;font-weight:600">${fmtNum(v)}</div></td>`;
    })
    .join('<td style="width:8px"></td>');
  const lines = charts
    .filter((w) => (w.chart as { type?: string } | undefined)?.type !== "kpi")
    .slice(0, 10)
    .map(
      (w) =>
        `<li style="margin:2px 0">${w.title ?? "Widget"} — ${(w.rows?.length ?? 0).toLocaleString()} rows${
          w.refreshed_at ? "" : " (not refreshed)"
        }</li>`,
    )
    .join("");
  const changeItems = changes.map((c) => `<li style="margin:2px 0">${c}</li>`).join("");
  const html =
    (changeItems
      ? `<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#111827">What changed</p><ul style="margin:0 0 14px;padding-left:18px;font-size:13px;color:#374151">${changeItems}</ul>`
      : "") +
    (kpiCells
      ? `<table role="presentation" style="border-collapse:separate;margin:0 0 14px"><tr>${kpiCells}</tr></table>`
      : "") +
    (lines
      ? `<p style="margin:0 0 4px;font-size:13px;color:#374151">Refreshed widgets:</p><ul style="margin:0;padding-left:18px;font-size:13px;color:#374151">${lines}</ul>`
      : "");
  const text =
    (changes.length ? `What changed:\n${changes.join("\n")}\n\n` : "") +
    kpis
      .map((w) => {
        const chart = w.chart as { valueField?: string } | undefined;
        const v = chart?.valueField ? w.rows?.[0]?.[chart.valueField] : undefined;
        return `${w.title}: ${fmtNum(v)}`;
      })
      .join("\n") +
    (charts.length ? `\n${charts.length} widgets refreshed on "${dashboardName}".` : "");
  return { html, text };
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
      const title = a.label || `Alert on "${widget.title ?? "widget"}"`;
      const body = `${metric} is ${Math.round(value * 100) / 100} (${OP_LABEL[a.operator] ?? a.operator} ${a.threshold}) on "${dashboardName}".`;
      await notify(userId, title, body, `/bi/${dashboardId}`);
      // Optional email delivery — never blocks the alert pipeline.
      if (a.email_enabled) {
        const to = await ownerEmail(userId);
        if (to) {
          void sendMail({
            to,
            subject: `⚠ ${title} — ${dashboardName}`,
            html: emailShell(
              title,
              `<p style="font-size:14px;margin:0">${body}</p>`,
              `${siteUrl()}/bi/${dashboardId}`,
              "Open dashboard",
            ),
            text: body,
          }).catch((e) => console.warn("[bi-alert] email failed:", (e as Error).message));
        }
      }
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
        // Insight digest: notify what moved since the previous snapshots.
        if (res.changes.length > 0) {
          await notify(
            res.userId,
            `What changed — "${res.name}"`,
            res.changes.join("\n").slice(0, 800),
            `/bi/${s.dashboard_id}`,
            "insight",
          );
        }
        // Scheduled email report: digest of the freshly refreshed snapshots.
        if (s.email_report) {
          const to = await ownerEmail(res.userId);
          if (to) {
            const digest = buildReportDigest(res.name, res.widgets, res.changes);
            void sendMail({
              to,
              subject: `📊 ${res.name} — scheduled report`,
              html: emailShell(
                res.name,
                digest.html ||
                  '<p style="font-size:14px;margin:0">Your dashboard was refreshed.</p>',
                `${siteUrl()}/bi/${s.dashboard_id}`,
                "Open dashboard",
              ),
              text: digest.text,
            }).catch((e) => console.warn("[bi-report] email failed:", (e as Error).message));
          }
        }
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

// ── Prep-flow scheduled refresh ──────────────────────────────────────────
// Re-runs a saved data-prep flow server-side (source + ordered transform
// steps) against the owner's stored datasets and overwrites the materialised
// output dataset. Shares the scheduler tick / cron path with dashboards.

let prepFnsRegistered = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerPrepFns(alasql: any): void {
  if (prepFnsRegistered) return;
  const fn = alasql.fn as Record<string, (...a: unknown[]) => unknown>;
  const toDate = (v: unknown): Date | null => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  fn.SPLIT_PART = (s, d, n) => {
    if (s == null) return null;
    const parts = String(s).split(String(d ?? ""));
    const i = Number(n);
    return i >= 1 && i <= parts.length ? parts[i - 1] : null;
  };
  fn.split_part = fn.SPLIT_PART;
  const year = (v: unknown) => {
    const d = toDate(v);
    return d ? d.getFullYear() : null;
  };
  const month = (v: unknown) => {
    const d = toDate(v);
    return d ? d.getMonth() + 1 : null;
  };
  const day = (v: unknown) => {
    const d = toDate(v);
    return d ? d.getDate() : null;
  };
  fn.YEAR = year;
  fn.year = year;
  fn.MONTH = month;
  fn.month = month;
  fn.DAY = day;
  fn.day = day;
  fn.DATE_TRUNC = (u, v) => {
    const d = toDate(v);
    if (!d || typeof u !== "string") return null;
    const y = d.getFullYear();
    const m = d.getMonth();
    switch (u.toLowerCase()) {
      case "year":
        return `${y}-01-01`;
      case "quarter":
        return `${y}-${pad(Math.floor(m / 3) * 3 + 1)}-01`;
      case "month":
        return `${y}-${pad(m + 1)}-01`;
      case "day":
        return `${y}-${pad(m + 1)}-${pad(d.getDate())}`;
      default:
        return null;
    }
  };
  fn.date_trunc = fn.DATE_TRUNC;
  const date = (v: unknown) => {
    const d = toDate(v);
    return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
  };
  fn.DATE = date;
  fn.date = date;
  prepFnsRegistered = true;
}

export async function refreshPrepFlowServer(
  flowId: string,
): Promise<{ userId: string; name: string; rowCount: number }> {
  const { data: flow, error } = await supabaseAdmin
    .from("user_prep_flows")
    .select("id, user_id, name, config, output_table_id")
    .eq("id", flowId)
    .single();
  if (error || !flow) throw new Error(error?.message ?? "Prep flow not found");
  if (!flow.output_table_id) throw new Error("Flow has never been run — nothing to refresh");

  const cfg = parsePrepConfig(flow.config);
  const valid = validatePrepConfig(cfg);
  if (!valid.ok) throw new Error(valid.error);
  const sql = buildPrepSql(cfg);

  const { data: tables } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, user_id, is_sample")
    .or(`user_id.eq.${flow.user_id},is_sample.eq.true`);

  const alasql = loadAlasql();
  registerPrepFns(alasql);
  const db = new alasql.Database();
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

  const out = db.exec(sql) as Record<string, unknown>[];
  const raw = (Array.isArray(out) ? out : []).slice(0, PREP_SAVE_ROW_CAP);
  const cast = castRows(raw, cfg);

  // Overwrite the materialised output dataset in place.
  await supabaseAdmin.from("user_data_rows").delete().eq("table_id", flow.output_table_id);
  const BATCH = 500;
  for (let i = 0; i < cast.rows.length; i += BATCH) {
    const slice = cast.rows.slice(i, i + BATCH).map((row) => ({
      table_id: flow.output_table_id!,
      row: row as unknown as Json,
    }));
    const { error: insErr } = await supabaseAdmin.from("user_data_rows").insert(slice);
    if (insErr) throw new Error(insErr.message);
  }
  await supabaseAdmin
    .from("user_data_tables")
    .update({ columns: cast.columns as unknown as Json })
    .eq("id", flow.output_table_id);

  return { userId: flow.user_id, name: flow.name, rowCount: cast.rows.length };
}

let lastPrepProcessed = 0;
export async function processDuePrepFlows(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPrepProcessed < MIN_PROCESS_INTERVAL_MS) return 0;
  lastPrepProcessed = now;
  const { data: flows } = await supabaseAdmin
    .from("user_prep_flows")
    .select("id, name, user_id, refresh_interval_minutes, last_refresh_at, output_table_id")
    .eq("refresh_enabled", true)
    .not("output_table_id", "is", null)
    .order("last_refresh_at", { ascending: true, nullsFirst: true })
    .limit(SCHEDULES_PER_RUN);
  if (!flows || flows.length === 0) return 0;
  let ran = 0;
  for (const f of flows) {
    const intervalMs = (f.refresh_interval_minutes ?? 1440) * 60_000;
    const due =
      !f.last_refresh_at || now - new Date(f.last_refresh_at).getTime() >= intervalMs - 30_000;
    if (!due) continue;
    let lastError: string | null = null;
    try {
      await refreshPrepFlowServer(f.id);
    } catch (e) {
      lastError = (e as Error).message.slice(0, 500);
      await notify(
        f.user_id,
        `Scheduled prep refresh failed — "${f.name}"`,
        lastError,
        "/bi",
        "error",
      );
    }
    await supabaseAdmin
      .from("user_prep_flows")
      .update({ last_refresh_at: new Date().toISOString(), last_refresh_error: lastError })
      .eq("id", f.id);
    ran++;
  }
  return ran;
}

// ── Scheduled-work pass (shared by the interval and /api/bi/cron) ─────────

export type CronPassResult = {
  /** false when another instance/runner held the lease and we skipped. */
  ran: boolean;
  processed: number;
  prep_flows: number;
  catalog_crawls: number;
  swarm_schedules: number;
  kernels_reaped: number;
};

/**
 * Run one pass of ALL scheduled work — BI refreshes + data alerts, prep flows,
 * catalog crawls, audit purge, swarm schedules, notebook-kernel reaping — under
 * a cross-instance lease so that running many app instances behind a load
 * balancer (or an external cron alongside the in-process tick) never
 * double-fires. Every job is isolated so one failure never blocks the rest.
 *
 * Called from the in-process interval (`ensureScheduler`) and from
 * `/api/bi/cron`. Both share the "scheduler" lease, so at most one pass runs at
 * a time across the whole fleet.
 */
export async function runCronPass(opts: { force?: boolean } = {}): Promise<CronPassResult> {
  const force = opts.force ?? false;
  const empty: CronPassResult = {
    ran: false,
    processed: 0,
    prep_flows: 0,
    catalog_crawls: 0,
    swarm_schedules: 0,
    kernels_reaped: 0,
  };

  const { acquireCronLease, releaseCronLease } = await import("@/utils/cronLock.server");
  if (!(await acquireCronLease("scheduler"))) return empty;
  try {
    const processed = await processDueSchedules(force);
    const prep_flows = await processDuePrepFlows(force);
    // Lazy imports keep these module graphs out of server boot and avoid cycles.
    const catalog_crawls = await import("@/utils/catalog/schedule.server")
      .then((m) => m.processDueCatalogCrawls(force))
      .catch((e) => {
        console.warn("[catalog-scheduler] processing failed:", (e as Error).message);
        return 0;
      });
    await import("@/utils/audit.server")
      .then((m) => m.purgeAuditEvents(force))
      .catch((e) => console.warn("[audit-purge] failed:", (e as Error).message));
    await import("@/utils/chatRetention.server")
      .then(async (m) => {
        await m.purgeExpiredChats(force);
        await m.purgeExpiredEmbedTranscripts(force);
      })
      .catch((e) => console.warn("[chat-retention] failed:", (e as Error).message));
    await import("@/utils/swarmWebhook.server")
      .then((m) => m.purgeIdempotencyRecords())
      .catch((e) => console.warn("[idempotency-purge] failed:", (e as Error).message));
    await import("@/utils/observability/retention.server")
      .then((m) => m.purgeTraces(force))
      .catch((e) => console.warn("[trace-retention] failed:", (e as Error).message));
    await import("@/utils/observability/otelExport.server")
      .then((m) => m.exportOtelTraces())
      .catch((e) => console.warn("[otel-export] failed:", (e as Error).message));
    const swarm_schedules = await import("@/utils/swarmSchedules.server")
      .then((m) => m.processDueSwarmSchedules(force))
      .catch((e) => {
        console.warn("[swarm-scheduler] processing failed:", (e as Error).message);
        return 0;
      });
    let kernels_reaped = 0;
    try {
      kernels_reaped = await import("@/utils/notebookRuntime/service.server").then((m) =>
        m.reapSessions(),
      );
    } catch (e) {
      console.warn("[cron] notebook kernel reap failed:", (e as Error).message);
    }
    return { ran: true, processed, prep_flows, catalog_crawls, swarm_schedules, kernels_reaped };
  } finally {
    await releaseCronLease("scheduler");
  }
}

// ── In-process scheduler (long-running node server) ──────────────────────

declare global {
  var __biSchedulerStarted: boolean | undefined;
}

export function ensureScheduler(): void {
  if (globalThis.__biSchedulerStarted) return;
  // Opt out of the in-process tick — set on an autoscaled/multi-instance web
  // tier that is driven by ONE external cron hitting /api/bi/cron instead.
  // (The lease already prevents double-firing; this just avoids every replica
  // waking up every 60s to lose a race.) Accepts 1/true/yes.
  if (/^(1|true|yes)$/i.test(process.env.DISABLE_INPROCESS_SCHEDULER ?? "")) return;
  globalThis.__biSchedulerStarted = true;
  setInterval(() => {
    runCronPass().catch((e) => console.warn("[scheduler] pass failed:", (e as Error).message));
  }, 60_000).unref?.();
}
