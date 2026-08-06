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
import type { SemanticQuery, SqlDialect } from "@/lib/semanticLayer";
import type { ChartSpec } from "@/lib/biAgent";
import { aggregationPlan } from "@/lib/biAggregate";
import { buildDirectQuerySql } from "@/lib/biDirectQuery";
import {
  incrementalCutoffIso,
  mergeIncrementalRows,
  mergeWidgetResults,
  parseFilters,
  stripWidgetData,
  widgetRowCap,
} from "@/lib/biDashboards";
import { fetchWidgetResultsAdmin, upsertWidgetResultsAdmin } from "@/utils/bi/results.server";
import { sendMail } from "@/lib/email/mailer.server";
import { loadWarehouseConnectionForUser } from "@/utils/warehouse/connections.server";
import { executeWarehouseQuery } from "@/utils/warehouse/drivers.server";
import { parsePrepConfig } from "@/lib/dataPrepCore";
import { assertLocalReadOnlySql } from "@/lib/sqlSafety";
import { STAGING_PREFIX } from "@/lib/datasetParse";
import { localEngineName } from "@/utils/data/localEngine.server";

// One definition, shared with the client that creates the snapshot in the
// first place — a second copy here is how the two silently drift apart.
const WIDGET_ROW_CAP = widgetRowCap();
const LOCAL_ROWS_PER_TABLE_CAP = 20_000;
const MIN_PROCESS_INTERVAL_MS = 30_000;
const SCHEDULES_PER_RUN = 10;

/** Only a well-formed UUID may enter a PostgREST `.or()` filter string. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    grains?: Record<string, import("@/lib/semanticLayer").TimeGrain>;
    compare?: import("@/lib/semanticLayer").ComparePeriod;
  };
  columns?: string[];
  rows?: Record<string, unknown>[];
  refreshed_at?: string;
  chart?: unknown;
  /** Aggregate in SQL rather than summing a capped snapshot in the browser. */
  agg_pushdown?: boolean;
  /** Re-query only the trailing window of `column`; keep older rows. */
  incremental?: { column?: string; days?: number };
  /** Set when a raw snapshot hit the row cap, so the UI can say so. */
  truncated?: boolean;
  [k: string]: unknown;
};

// ── Local SQL (server-side AlaSQL) ───────────────────────────────────────

// The read-only guard lives in lib/sqlSafety so the browser engine, this
// server path and the differential harness all enforce the identical rule.

type LocalTable = {
  name: string;
  columns: { name: string; type: "number" | "string" | "date" }[];
  rows: Record<string, unknown>[];
  /** Set when a current Parquet mirror was found; `rows` is then empty. */
  parquetPath?: string;
};

/**
 * The datasets this user's SQL may read: their own, public samples, and any
 * dataset shared with them by an IAM grant.
 *
 * Shared datasets used to be excluded here. That was fail-closed but wrong in
 * practice: a widget built on a shared dataset worked in the browser (which
 * reads through the shared_dataset_rows RPC) and then failed on every
 * scheduled refresh with "table not found". They are now loaded with the
 * grant's row filter and column mask re-applied in TypeScript — mandatory,
 * because this reads with the SERVICE ROLE and RLS is therefore off.
 */
async function loadLocalTables(userId: string): Promise<LocalTable[]> {
  const { grantedDatasetIds, restrictSharedDataset } =
    await import("@/utils/data/sharedDatasets.server");
  const granted = await grantedDatasetIds(supabaseAdmin, userId);
  const grantedIds = [...granted].filter((id) => UUID_RE.test(id));

  const orParts = [`user_id.eq.${userId}`, "is_sample.eq.true"];
  if (grantedIds.length) orParts.push(`id.in.(${grantedIds.join(",")})`);

  const { data: tables, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, columns, user_id, is_sample, data_loaded_at, parquet_synced_at")
    .not("name", "like", `${STAGING_PREFIX}%`)
    .or(orParts.join(","));
  if (error) throw new Error(error.message);

  const { localParquetPath } = await import("@/utils/data/parquet.server");
  const out: LocalTable[] = [];
  for (const t of tables ?? []) {
    // A current columnar mirror replaces the whole paging loop below with a
    // single file read. Absent or stale, we fall through to the slow path —
    // the mirror is a cache and is never the source of truth.
    const isShared = !t.is_sample && t.user_id !== userId;
    // A mirror is the FULL table with no filter or mask applied, so it must
    // never back a shared dataset. Those go down the row path, where
    // restrictSharedDataset can act on the values.
    const parquetPath = isShared
      ? undefined
      : ((await localParquetPath({
          tableId: t.id,
          userId: t.user_id ?? userId,
          parquet_synced_at: t.parquet_synced_at,
          data_loaded_at: t.data_loaded_at,
        })) ?? undefined);
    if (parquetPath) {
      out.push({
        name: t.name,
        columns: Array.isArray(t.columns) ? (t.columns as LocalTable["columns"]) : [],
        rows: [],
        parquetPath,
      });
      continue;
    }
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
    let columns = Array.isArray(t.columns) ? (t.columns as LocalTable["columns"]) : [];
    let visibleRows = rows;
    if (isShared) {
      const restricted = await restrictSharedDataset(supabaseAdmin, t.id, userId, columns, rows);
      columns = restricted.columns as LocalTable["columns"];
      visibleRows = restricted.rows;
    }
    out.push({ name: t.name, columns, rows: visibleRows, parquetPath });
  }
  return out;
}

/**
 * Run a widget's SQL against the owner's stored datasets, server-side.
 *
 * Two engines: DuckDB (the default) and AlaSQL (LOCAL_ENGINE=alasql, the
 * escape hatch for a deployment that cannot run the native module).
 * tests/differential records exactly how the two differ, and the only
 * differences are cases where DuckDB follows standard SQL. If DuckDB fails for
 * an environmental reason (a missing native binary on an unusual platform),
 * fall back rather than failing a scheduled refresh outright.
 */
export async function runLocalSqlForUser(
  userId: string,
  sql: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  return runLocalSqlOnTables(sql, await loadLocalTables(userId));
}

/**
 * A runner that loads the caller's datasets ONCE and reuses them.
 *
 * For anything that issues several queries in a row. runLocalSqlForUser reloads
 * every dataset the user can see on every call — every row of every table, or a
 * parquet mirror read — which is right for a single query and quadratic for a
 * batch.
 *
 * Semantic-model validation was the case that exposed it: it probes one query
 * per dimension and per metric, sequentially, so a 19-field model meant
 * NINETEEN full reloads of every dataset the user owns. In the browser that
 * showed up as a Validate button stuck on "Validating…" indefinitely.
 */
export async function localSqlRunnerForUser(
  userId: string,
): Promise<(sql: string) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>> {
  const tables = await loadLocalTables(userId);
  return (sql: string) => runLocalSqlOnTables(sql, tables);
}

async function runLocalSqlOnTables(
  sql: string,
  tables: LocalTable[],
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  // Re-checked per statement, not per load: the tables are reusable, the
  // guard is not — each SQL string is separately untrusted.
  const safeSql = assertLocalReadOnlySql(sql);

  const { duckdbEnabled } = await import("@/utils/data/duckdb.server");
  if (duckdbEnabled()) {
    try {
      const { runLocalSqlDuckDB } = await import("@/utils/data/duckdb.server");
      const res = await runLocalSqlDuckDB(safeSql, tables, { rowCap: WIDGET_ROW_CAP });
      return { columns: res.columns, rows: res.rows };
    } catch (e) {
      const message = (e as Error).message;
      // A SQL error is the user's query being wrong and must surface as
      // itself; only an engine-level failure justifies falling back, and it
      // is logged loudly because it means the flag is not actually working.
      if (/cannot find module|native|binding|\.node\b/i.test(message)) {
        console.warn(`[local-engine] DuckDB unavailable, using AlaSQL: ${message}`);
      } else {
        throw e;
      }
    }
  }

  // Fresh database per call — never share state across users/runs.
  const alasql = loadAlasql();
  const db = new alasql.Database();
  for (const t of tables) {
    db.exec(`CREATE TABLE \`${t.name}\``);
    db.tables[t.name].data = t.rows;
  }

  const out = db.exec(safeSql) as Record<string, unknown>[];
  const rows = (Array.isArray(out) ? out : []).slice(0, WIDGET_ROW_CAP);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

/**
 * Rewrite a widget's SQL to aggregate in the database, when it opted in.
 *
 * Returns the ORIGINAL SQL whenever pushdown is off, the chart type needs raw
 * rows, or any field fails validation — so this can never make a widget worse
 * than it was. The widget's own stored `columns` (the result columns of the
 * last successful run) are what the plan is validated against; if they are
 * stale or absent the plan is refused and the raw path runs, which then
 * repopulates them for next time.
 */
function widgetQuerySql(
  w: WidgetJson,
  preserve: string[],
  dialect: SqlDialect,
  /** Incremental window: only rows at or after this ISO date. */
  incremental?: { column: string; fromIso: string },
): string {
  const sql = w.sql!;
  const chart = w.chart as ChartSpec | undefined;
  const plan = w.agg_pushdown ? aggregationPlan(chart, { preserve }) : null;
  if (!plan && !incremental) return sql;
  return buildDirectQuerySql({
    baseSql: sql,
    columns: w.columns ?? [],
    // The window rides the same validated daterange path as dashboard filters,
    // so with pushdown it lands BEFORE the GROUP BY (whole buckets recomputed)
    // and without it after — where the column is the bucket itself.
    filters: incremental
      ? [{ column: incremental.column, kind: "daterange", from: incremental.fromIso }]
      : undefined,
    agg: plan ?? undefined,
    dialect,
    rowCap: WIDGET_ROW_CAP,
  });
}

/** The incremental window for a widget, or undefined for a full refresh. */
function incrementalWindow(w: WidgetJson): { column: string; fromIso: string } | undefined {
  return (
    incrementalCutoffIso(w.incremental, Array.isArray(w.rows) ? w.rows : [], w.columns ?? []) ??
    undefined
  );
}

/**
 * Land a query result on the widget — merged with the prior snapshot when the
 * run was incremental, replacing it when it was full.
 */
function applyResult(
  w: WidgetJson,
  result: { columns: string[]; rows: Record<string, unknown>[] },
  inc?: { column: string; fromIso: string },
): void {
  const prior = Array.isArray(w.rows) ? w.rows : [];
  // Schema drift (the query now returns different columns than the snapshot
  // we would merge into) makes a merge produce mixed-shape rows — treat it as
  // a full refresh instead. Next tick both sides agree again.
  const drifted = inc && JSON.stringify(result.columns) !== JSON.stringify(w.columns ?? []);
  if (inc && !drifted) {
    const merged = mergeIncrementalRows(prior, result.rows, inc.column, inc.fromIso);
    w.rows = merged.slice(0, WIDGET_ROW_CAP);
    // Partial either when the merge overflowed the cap (rows dropped) or when
    // a raw (non-pushdown) window itself came back capped.
    w.truncated =
      merged.length > WIDGET_ROW_CAP || (!w.agg_pushdown && result.rows.length >= WIDGET_ROW_CAP);
  } else {
    w.rows = result.rows.slice(0, WIDGET_ROW_CAP);
    // Only meaningful without pushdown: an aggregated result is complete by
    // construction, but a truncated raw result makes client totals partial.
    w.truncated = !w.agg_pushdown && result.rows.length >= WIDGET_ROW_CAP;
  }
  w.columns = result.columns;
  w.refreshed_at = new Date().toISOString();
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
    .select("id, user_id, name, widgets, filters, updated_at")
    .eq("id", dashboardId)
    .single();
  if (error || !dash) throw new Error(error?.message ?? "Dashboard not found");
  const readUpdatedAt = dash.updated_at;

  // Columns aggregation must not collapse away: every dashboard filter narrows
  // widgets client-side by column name, and filterWidgetRows SKIPS a column it
  // cannot find — so grouping one away would silently stop that filter from
  // applying rather than raise anything.
  const preserve = parseFilters(dash.filters).map((f) => f.column);

  const docWidgetsRaw = (Array.isArray(dash.widgets) ? dash.widgets : []) as WidgetJson[];
  // Hydrate the prior snapshots from the results store: the document's own
  // rows are stripped after the split, so without this (a) the "what changed"
  // diff below would compare everything against empty, firing alerts on every
  // tick, and (b) incremental refresh would have no prior rows to keep.
  let widgets = docWidgetsRaw;
  try {
    const stored = await fetchWidgetResultsAdmin(dashboardId);
    if (stored.length > 0) widgets = mergeWidgetResults(docWidgetsRaw, stored) as WidgetJson[];
  } catch {
    /* full refresh against whatever the document carries */
  }
  // Shallow copies keep the pre-refresh row arrays (the loop below REASSIGNS
  // w.rows, never mutates it), so we can diff snapshots afterwards.
  const before = widgets.map((w) => ({ ...w }));
  const failures: string[] = [];

  for (const w of widgets) {
    if (w.kind !== "chart") continue;
    if (!w.sql && w.source?.kind !== "semantic") continue;
    try {
      let result: { columns: string[]; rows: Record<string, unknown>[] };
      // Incremental only applies to SQL-backed widgets: a semantic widget
      // re-runs its governed metric query in full, so a metric-definition
      // change is always reflected immediately.
      const inc = w.source?.kind === "semantic" ? undefined : incrementalWindow(w);
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
            grains: w.source.grains,
            // Every part of the stored query travels, or refresh answers a
            // different question from the one the widget was built to ask.
            compare: w.source.compare,
          },
          maxRows: WIDGET_ROW_CAP,
        });
        result = { columns: r.columns, rows: r.rows };
      } else if (w.source?.kind === "warehouse" && w.source.connection_id) {
        const conn = await loadWarehouseConnectionForUser(
          supabaseAdmin,
          { connectionId: w.source.connection_id },
          dash.user_id,
        );
        const sql = widgetQuerySql(w, preserve, conn.config.provider as SqlDialect, inc);
        const res = await executeWarehouseQuery(conn.config, sql, WIDGET_ROW_CAP, {
          userId: dash.user_id,
        });
        result = { columns: res.columns.map((c) => c.name), rows: res.rows };
      } else {
        // The dialect MUST match the engine that will run it. Pushdown and
        // incremental refresh wrap the widget's SQL with quoted identifiers,
        // and AlaSQL's backticks are a parser error in DuckDB — so hard-coding
        // "alasql" here silently broke every pushdown/incremental widget the
        // moment LOCAL_ENGINE=duckdb was set.
        const localDialect = await localEngineName();
        result = await runLocalSqlForUser(
          dash.user_id,
          widgetQuerySql(w, preserve, localDialect, inc),
        );
      }
      applyResult(w, result, inc);
    } catch (e) {
      failures.push(`"${w.title ?? w.id}": ${(e as Error).message}`);
    }
  }

  // Data lands in the results store FIRST and unconditionally — per-widget
  // rows, so a concurrent edit cannot be clobbered by them, and hydration
  // shows the fresh numbers even when the document write below loses its race.
  try {
    await upsertWidgetResultsAdmin(dashboardId, dash.user_id, widgets);
  } catch (e) {
    failures.push(`storing results: ${(e as Error).message}`);
  }

  // Conditional write: only land if nobody saved the dashboard while we were
  // querying. If they did, drop this refresh rather than clobber their edit —
  // the next tick picks it up against the new baseline. Losing one refresh
  // cycle is recoverable; losing a user's edits is not. Only definition
  // metadata (columns, refreshed_at, truncated) is written — the row snapshots
  // live in bi_widget_results, which keeps this document write small and the
  // conflict window narrow.
  const docWidgets = stripWidgetData(widgets);
  const { data: written, error: upErr } = await supabaseAdmin
    .from("bi_dashboards")
    .update({ widgets: docWidgets as never, updated_at: new Date().toISOString() })
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
/**
 * SQL NULL, as it arrives in a JSON snapshot row.
 *
 * Not a general emptiness test: `false` and `0` are real values and stay.
 * `[]` and `{}` are included because JS coerces both to 0 or NaN, and neither
 * is a number a user put in a cell.
 */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  return typeof v === "object";
}

export function alertValue(
  rows: Record<string, unknown>[],
  columnName: string,
  aggregation: string,
): number | null {
  if (!columnName || aggregation === "count") return rows.length;
  // SQL aggregates IGNORE NULL, and so must these — an alert is compared
  // against a number a human read off a dashboard.
  //
  // `Number(null)` is 0 and 0 is finite, so a blank cell used to survive the
  // filter as a real zero. On a response-time column with one NULL row that
  // made avg 97.5 instead of 130 and min 0 instead of 120, so "alert when
  // min(ms) < 5" fired on a perfectly healthy service; on an all-negative
  // column it made max 0 instead of the real maximum. `""`, `"   "`, `[]` and
  // `false` coerce to 0 the same way.
  const nums = rows
    .filter((r) => !isBlank(r[columnName]))
    .map((r) => Number(r[columnName]))
    .filter((n) => Number.isFinite(n));
  if (aggregation === "first") {
    const raw = rows[0]?.[columnName];
    if (isBlank(raw)) return null;
    const v = Number(raw);
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
  // In-app row + best-effort mirror to the user's connected notification
  // channels (Slack/Teams/Discord/webhook) — see notify.server.ts.
  const { notifyUser } = await import("@/utils/notify.server");
  await notifyUser(userId, { title, body, link, kind });
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

/**
 * Re-run a saved prep flow and overwrite its output dataset.
 *
 * Delegates to the SHARED engine in prep.server.ts — the same code the
 * interactive "Run & save" uses — so a scheduled refresh can never produce a
 * different result than the button did.
 */
export async function refreshPrepFlowServer(
  flowId: string,
): Promise<{ userId: string; name: string; rowCount: number }> {
  const { data: flow, error } = await supabaseAdmin
    .from("user_prep_flows")
    .select("id, user_id, name, config, output_table_id, output_table_name")
    .eq("id", flowId)
    .single();
  if (error || !flow) throw new Error(error?.message ?? "Prep flow not found");
  if (!flow.output_table_id) throw new Error("Flow has never been run — nothing to refresh");

  const { executePrepFlow, materialisePrepOutput, refreshPrepIncremental } =
    await import("@/utils/bi/prep.server");
  const cfg = parsePrepConfig(flow.config);

  // Incremental first: reprocess only the newest slice when the flow is
  // eligible and already has data. Returns null when a full rebuild is
  // required (no watermark, ineligible pipeline, or an empty output).
  const incremental = await refreshPrepIncremental({
    userId: flow.user_id,
    cfg,
    tableId: flow.output_table_id,
  }).catch((e) => {
    // An incremental failure must never leave the dataset half-written with
    // no fallback — fall through to the full rebuild below.
    console.warn(`[prep-refresh] incremental failed, rebuilding fully: ${(e as Error).message}`);
    return null;
  });
  if (incremental) {
    await checkQualityAfterRefresh(flow.user_id, flow.output_table_id);
    return { userId: flow.user_id, name: flow.name, rowCount: incremental.rowsReplaced };
  }

  const result = await executePrepFlow(flow.user_id, cfg);

  // Keep writing to the SAME dataset row so every model/widget pointing at it
  // survives the refresh; materialise resolves by (user_id, name).
  const { data: outTable } = await supabaseAdmin
    .from("user_data_tables")
    .select("name")
    .eq("id", flow.output_table_id)
    .maybeSingle();
  const tableName = outTable?.name ?? flow.output_table_name;
  if (!tableName) throw new Error("The flow's output dataset no longer exists");

  const saved = await materialisePrepOutput({
    userId: flow.user_id,
    tableName,
    flowName: flow.name,
    columns: result.columns,
    rows: result.rows,
    reason: "prep_refresh",
  });

  await checkQualityAfterRefresh(flow.user_id, saved.tableId);
  return { userId: flow.user_id, name: flow.name, rowCount: saved.rowCount };
}

/**
 * Re-run the dataset's quality tests immediately after a refresh rewrote it.
 *
 * This is the point where a bad upstream change becomes visible, so waiting
 * for the next hourly sweep would mean serving known-suspect data to
 * dashboards in the meantime. Never throws: the refresh itself succeeded, and
 * failing it here would trigger a pointless full rebuild on the next pass.
 */
async function checkQualityAfterRefresh(userId: string, tableId: string): Promise<void> {
  try {
    const { runQualityTestsForTable } = await import("@/utils/bi/quality.server");
    await runQualityTestsForTable({ userId, tableId });
  } catch (e) {
    console.warn("[data-quality] post-refresh check failed:", (e as Error).message);
  }
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
  /** Datasets whose quality tests were re-evaluated this pass. */
  quality_checks: number;
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
    quality_checks: 0,
    catalog_crawls: 0,
    swarm_schedules: 0,
    kernels_reaped: 0,
  };

  const { acquireCronLease, releaseCronLease } = await import("@/utils/cronLock.server");
  if (!(await acquireCronLease("scheduler"))) return empty;
  try {
    const processed = await processDueSchedules(force);
    const prep_flows = await processDuePrepFlows(force);
    // Freshness SLAs only mean something if they fire when nothing happens —
    // a table that stopped refreshing raises no event of its own.
    const quality_checks = await import("@/utils/bi/quality.server")
      .then((m) => m.processDueQualityChecks(force))
      .catch((e) => {
        console.warn("[data-quality] sweep failed:", (e as Error).message);
        return 0;
      });
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
    // A process killed mid-upload leaves a staging dataset nobody can see and
    // nothing else will ever delete.
    await import("@/utils/data/ingest.server")
      .then((m) => m.sweepAbandonedUploads())
      .catch((e) => console.warn("[upload-sweep] failed:", (e as Error).message));
    // Rebuild columnar mirrors that browser-side saves left stale, and drop
    // objects whose dataset is gone.
    await import("@/utils/data/parquet.server")
      .then((m) => m.sweepDatasetMirrors())
      .catch((e) => console.warn("[parquet-sweep] failed:", (e as Error).message));
    await import("@/utils/integrations/health.server")
      .then(async (m) => {
        await m.checkIntegrationHealth(force);
        // Independent of health checks: retire legacy plaintext secrets.
        await m.sweepPlaintextSecrets();
      })
      .catch((e) => console.warn("[integration-health] failed:", (e as Error).message));
    // Data connections get the same treatment as LLM keys: a warehouse
    // password expires on the customer's rotation policy, and without this the
    // first sign is a dashboard erroring in front of someone.
    await import("@/utils/integrations/connectionHealth.server")
      .then((m) => m.checkConnectionHealth(force))
      .catch((e) => console.warn("[connection-health] failed:", (e as Error).message));
    await import("@/utils/observability/retention.server")
      .then((m) => m.purgeTraces(force))
      .catch((e) => console.warn("[trace-retention] failed:", (e as Error).message));
    await import("@/utils/observability/otelExport.server")
      .then((m) => m.exportOtelTraces())
      .catch((e) => console.warn("[otel-export] failed:", (e as Error).message));
    await import("@/utils/saas/schedule.server")
      .then((m) => m.processDueSaasSyncs(force))
      .catch((e) => console.warn("[saas-sync] processing failed:", (e as Error).message));
    // KB connector sources (Drive / Notion / SharePoint / Dropbox) on the same
    // cadence and claim discipline as SaaS data sources.
    await import("@/utils/kb/schedule.server")
      .then((m) => m.processDueKbSyncs(force))
      .catch((e) => console.warn("[kb-sync] processing failed:", (e as Error).message));
    // Traces recorded before their model had a known price re-resolve here —
    // an alias mapping or a price refresh corrects history, not just the
    // future, so budgets stop summing real spend as $0.
    await import("@/utils/observability/reprice.server")
      .then((m) => m.repriceUnpricedTraces(force))
      .catch((e) => console.warn("[trace-reprice] failed:", (e as Error).message));
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
    return {
      ran: true,
      processed,
      prep_flows,
      quality_checks,
      catalog_crawls,
      swarm_schedules,
      kernels_reaped,
    };
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
