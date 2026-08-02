// Server-side execution engine for data-prep flows.
//
// WHY THIS EXISTS: prep used to run in the BROWSER and materialise at most
// 5,000 output rows, so a 200k-row source silently became a 5k-row prepared
// table — the sample WAS the output. Every comparable tool (Tableau Prep,
// Power Query, Alteryx) previews on a sample and executes on the full data.
// This module is that execution path: it runs the same compiled SQL against
// the owner's stored rows on the server, with caps high enough to be real and
// reported honestly when they bite.
//
// It is also the SINGLE path for both interactive "Run & save" and the
// scheduled refresh, so a flow can never produce different numbers depending
// on which button ran it.
import { createRequire } from "node:module";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { registerPrepFns } from "@/lib/alasqlPrepFns";
import type { Json } from "@/integrations/supabase/types";
import {
  buildPrepSql,
  castRows,
  effectiveOutputColumns,
  foldEligibility,
  incrementalEligibility,
  prepTables,
  withIncrementalWindow,
  prepWarehouseBinding,
  PREP_TYPE_META,
  validatePrepConfig,
  type PrepDialect,
  type PrepFlowConfig,
} from "@/lib/dataPrepCore";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read per call, not at module load: an operator's env change takes effect on
// the next run rather than the next deploy, and the caps stay testable.
/** Rows loaded per SOURCE table. Beyond this the input itself is truncated. */
export const prepSourceRowsCap = () => envInt("PREP_SOURCE_ROWS_CAP", 500_000);
/** Rows materialised to the OUTPUT dataset. */
export const prepOutputRowsCap = () => envInt("PREP_OUTPUT_ROWS_CAP", 250_000);

// AlaSQL ships a UMD build whose global-object dance breaks inside Vite's SSR
// module runner. Loading it through Node's own CJS loader sidesteps that.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let alasqlModule: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadAlasql(): any {
  if (!alasqlModule) {
    const require = createRequire(import.meta.url);
    alasqlModule = require("alasql");
  }
  return alasqlModule;
}

export type PrepExecution = {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  /** Per-column count of values that failed their declared type cast. */
  failures: Record<string, number>;
  /** Source tables whose row load hit PREP_SOURCE_ROWS_CAP. */
  truncatedSources: string[];
  /** The result hit PREP_OUTPUT_ROWS_CAP (materialised rows are incomplete). */
  outputCapped: boolean;
  /** Total rows the flow produced before the output cap was applied. */
  producedRows: number;
  sql: string;
  /** "warehouse" when the pipeline was folded into the source system. */
  engine: "local" | "warehouse";
  /** Why folding didn't happen (shown to the user); absent when it did. */
  foldSkipReason?: string;
};

/**
 * Load ONLY the tables a flow references (plus samples it names) into a fresh
 * in-memory database. Loading every dataset — what the old code did — is both
 * slower and a memory hazard on accounts with many datasets.
 */
async function loadFlowTables(
  userId: string,
  needed: Set<string>,
  cfg?: PrepFlowConfig,
): Promise<{ tables: FlowTable[]; truncated: string[] }> {
  const { data: tables, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, columns, user_id, is_sample")
    .or(`user_id.eq.${userId},is_sample.eq.true`);
  if (error) throw new Error(error.message);

  const loaded: FlowTable[] = [];
  const truncated: string[] = [];

  const sourceCap = prepSourceRowsCap();

  // Warehouse-linked tables have no local rows. When folding was refused we
  // still owe the user a correct answer, so their data is BUFFERED locally
  // (bounded, and reported when the bound bites) and the pipeline runs here.
  const wareTables = Object.entries(cfg?.sources ?? {}).filter(([name]) => needed.has(name));
  if (wareTables.length > 0) {
    const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
    const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
    const connCache = new Map<string, Awaited<ReturnType<typeof loadWarehouseConnectionForUser>>>();
    for (const [name, binding] of wareTables) {
      let conn = connCache.get(binding.connectionId);
      if (!conn) {
        conn = await loadWarehouseConnectionForUser(
          supabaseAdmin,
          { connectionId: binding.connectionId },
          userId,
        );
        connCache.set(binding.connectionId, conn);
      }
      const res = await executeWarehouseQuery(
        conn.config,
        `SELECT * FROM ${binding.ref}`,
        sourceCap,
      );
      if (res.rows.length >= sourceCap) truncated.push(name);
      // A buffered warehouse table has no locally declared schema; the column
      // list is derived from the rows so a typed engine can still load it.
      loaded.push({
        name,
        columns: res.columns.map((c) => ({
          name: c.name,
          type: /INT|NUM|DEC|FLOAT|DOUBLE|REAL/i.test(c.type) ? "number" : "string",
        })),
        rows: res.rows,
      });
    }
  }

  for (const t of tables ?? []) {
    if (!needed.has(t.name)) continue;
    if (cfg?.sources?.[t.name]) continue; // already buffered from the warehouse
    const rows: Record<string, unknown>[] = [];
    const PAGE = 1000;
    let hitCap = false;
    for (let start = 0; start < sourceCap; start += PAGE) {
      const { data: chunk, error: rowErr } = await supabaseAdmin
        .from("user_data_rows")
        .select("row")
        .eq("table_id", t.id)
        .range(start, start + PAGE - 1);
      if (rowErr || !chunk || chunk.length === 0) break;
      rows.push(...chunk.map((c) => c.row as Record<string, unknown>));
      if (chunk.length < PAGE) break;
      if (rows.length >= sourceCap) {
        hitCap = true;
        break;
      }
    }
    if (hitCap) truncated.push(t.name);
    loaded.push({
      name: t.name,
      columns: Array.isArray(t.columns) ? (t.columns as FlowTable["columns"]) : [],
      rows,
    });
  }
  return { tables: loaded, truncated };
}

/** Build a fresh AlaSQL database from already-loaded tables. */
function alasqlDatabaseFrom(tables: FlowTable[]): unknown {
  const alasql = loadAlasql();
  registerPrepFns(alasql);
  const db = new alasql.Database();
  for (const t of tables) {
    db.exec(`CREATE TABLE \`${t.name}\``);
    db.tables[t.name].data = t.rows;
  }
  return db;
}

/**
 * Try to run the whole pipeline INSIDE the warehouse (query folding).
 *
 * Returns null whenever folding isn't provably safe or the warehouse won't
 * accept the query — the caller then runs locally, so a refusal can only ever
 * cost performance, never correctness.
 */
async function tryFoldToWarehouse(
  userId: string,
  cfg: PrepFlowConfig,
  rowLimit?: number,
): Promise<{ execution: PrepExecution } | { skip: string } | null> {
  const binding = prepWarehouseBinding(cfg);
  if (!binding) return null; // local (or mixed) sources — nothing to fold

  const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
  const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");

  let conn: Awaited<ReturnType<typeof loadWarehouseConnectionForUser>>;
  try {
    conn = await loadWarehouseConnectionForUser(
      supabaseAdmin,
      { connectionId: binding.connectionId },
      userId,
    );
  } catch (e) {
    return { skip: `the warehouse connection is unavailable (${(e as Error).message})` };
  }

  const dialect = conn.config.provider as PrepDialect;
  const verdict = foldEligibility(cfg, dialect);
  if (!verdict.foldable) {
    return {
      skip:
        verdict.stepIndex !== undefined
          ? `step ${verdict.stepIndex + 1} can't be pushed down — ${verdict.reason}`
          : verdict.reason,
    };
  }

  const sql = buildPrepSql(cfg, {
    dialect,
    physicalTable: (name) => cfg.sources?.[name]?.ref ?? name,
  });

  // PROVE the fold on the real warehouse before trusting it. Ten dialects
  // cannot be verified from here; the warehouse itself is the authority, and
  // a parse/semantic error must degrade to the local path, never to bad data.
  try {
    await executeWarehouseQuery(conn.config, `SELECT * FROM (${sql}) AS _fold_check`, 1);
  } catch (e) {
    return { skip: `the warehouse rejected the pushed-down query (${(e as Error).message})` };
  }

  const outputCap = rowLimit ?? prepOutputRowsCap();
  const res = await executeWarehouseQuery(conn.config, sql, outputCap);
  const cast = castRows(res.rows, cfg);
  return {
    execution: {
      columns: cast.columns,
      rows: cast.rows,
      failures: cast.failures,
      truncatedSources: [],
      // The warehouse driver caps at outputCap; a full page back means there
      // may be more, which is reported the same way the local path reports it.
      outputCapped: res.rows.length >= outputCap,
      producedRows: res.rows.length,
      sql,
      engine: "warehouse",
    },
  };
}

/**
 * Compile and execute a prep flow against the owner's stored data.
 * Never writes anything — callers decide what to do with the result.
 *
 * Prefers PUSHDOWN when every source is a live table on one warehouse
 * connection and every step is provably translatable; otherwise runs locally.
 */
export async function executePrepFlow(
  userId: string,
  cfg: PrepFlowConfig,
  opts: { rowLimit?: number } = {},
): Promise<PrepExecution> {
  const valid = validatePrepConfig(cfg);
  if (!valid.ok) throw new Error(valid.error);

  const folded = await tryFoldToWarehouse(userId, cfg, opts.rowLimit);
  if (folded && "execution" in folded) return folded.execution;
  const foldSkipReason = folded && "skip" in folded ? folded.skip : undefined;

  // Every table the flow touches: base, joins, and any append step's source.
  const needed = new Set(prepTables(cfg));
  for (const s of cfg.steps) {
    if (s.kind === "append" && s.table) needed.add(s.table);
  }

  const { tables, truncated } = await loadFlowTables(userId, needed, cfg);
  const outputCap = opts.rowLimit ?? prepOutputRowsCap();

  // The SAME compiler emits both, parameterised by dialect — so switching
  // engines cannot change what the pipeline means, only how fast it runs.
  const { duckdbEnabled } = await import("@/utils/data/duckdb.server");
  const useDuck = duckdbEnabled();
  const sql = buildPrepSql(cfg, useDuck ? { dialect: "duckdb" } : undefined);

  let produced: Record<string, unknown>[];
  if (useDuck) {
    const { runLocalSqlDuckDB } = await import("@/utils/data/duckdb.server");
    // rowCap is applied after, so `outputCapped` can still be reported
    // honestly rather than silently truncating at the engine.
    const res = await runLocalSqlDuckDB(sql, tables);
    produced = res.rows;
  } else {
    const db = alasqlDatabaseFrom(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (db as any).exec(sql) as Record<string, unknown>[];
    produced = Array.isArray(out) ? out : [];
  }

  const limited = produced.slice(0, outputCap);
  const cast = castRows(limited, cfg);

  return {
    columns: cast.columns,
    rows: cast.rows,
    failures: cast.failures,
    truncatedSources: truncated,
    outputCapped: produced.length > outputCap,
    producedRows: produced.length,
    sql,
    engine: "local",
    foldSkipReason,
  };
}

/** Column semantic tags derived from the flow's declared output types. */
function columnMetaFor(cfg: PrepFlowConfig): Record<string, { semantic_type?: string }> {
  const meta: Record<string, { semantic_type?: string }> = {};
  for (const c of effectiveOutputColumns(cfg)) {
    const semantic = PREP_TYPE_META[c.type]?.semantic;
    if (semantic) meta[c.name] = { semantic_type: semantic };
  }
  return meta;
}

const INSERT_BATCH = 500;

/** A dataset loaded for a flow, in the shape both local engines accept. */
type FlowTable = {
  name: string;
  columns: { name: string; type: "number" | "string" | "date" }[];
  rows: Record<string, unknown>[];
};

/**
 * Materialise rows into a dataset owned by `userId`, replacing its contents.
 *
 * Reuses the existing table when one matches (user_id, name) so the dataset id
 * — and therefore every flow/model/widget pointing at it — survives a re-run.
 */
export async function materialisePrepOutput(args: {
  userId: string;
  tableName: string;
  flowName: string;
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  /** Recorded on the pre-overwrite version snapshot. */
  reason?: "prep_run" | "prep_refresh";
}): Promise<{ tableId: string; name: string; rowCount: number }> {
  const { data: existing } = await supabaseAdmin
    .from("user_data_tables")
    .select("id")
    .eq("name", args.tableName)
    .eq("user_id", args.userId)
    .maybeSingle();

  let tableId: string;
  if (existing) {
    tableId = existing.id;
    // A scheduled rebuild replaces the whole dataset unattended. Keep the
    // outgoing contents first so a flow that quietly started producing
    // garbage is recoverable rather than merely regrettable.
    const { snapshotDatasetQuiet } = await import("@/utils/bi/versions.server");
    await snapshotDatasetQuiet({
      userId: args.userId,
      tableId,
      reason: args.reason ?? "prep_run",
      note: `Rebuilt by the "${args.flowName}" flow`,
    });
    await supabaseAdmin.from("user_data_rows").delete().eq("table_id", tableId);
    const { error } = await supabaseAdmin
      .from("user_data_tables")
      .update({
        source_filename: `prep:${args.flowName}`,
        columns: args.columns as unknown as Json,
        data_loaded_at: new Date().toISOString(),
      })
      .eq("id", tableId);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await supabaseAdmin
      .from("user_data_tables")
      .insert({
        user_id: args.userId,
        name: args.tableName,
        source_filename: `prep:${args.flowName}`,
        columns: args.columns as unknown as Json,
        is_sample: false,
      })
      .select("id")
      .single();
    if (error || !created) throw new Error(error?.message || "Failed to create the dataset");
    tableId = created.id;
  }

  for (let i = 0; i < args.rows.length; i += INSERT_BATCH) {
    const slice = args.rows.slice(i, i + INSERT_BATCH).map((row) => ({
      table_id: tableId,
      row: row as unknown as Json,
    }));
    const { error } = await supabaseAdmin.from("user_data_rows").insert(slice);
    if (error) throw new Error(error.message);
  }

  // Refresh the columnar mirror off the write path. Best-effort: the rows are
  // already committed, and a stale mirror is detected on read (its sync stamp
  // is older than data_loaded_at) so the worst case is the slow path.
  await import("@/utils/data/parquet.server")
    .then((m) => m.refreshDatasetMirror({ userId: args.userId, tableId }))
    .catch(() => null);

  return { tableId, name: args.tableName, rowCount: args.rows.length };
}

/**
 * Refresh a flow's output INCREMENTALLY: reprocess only rows at or after the
 * newest watermark already stored, and replace exactly that range.
 *
 * Strategy is dbt's delete+insert rather than plain append. Appending with
 * `> max` loses rows that share the boundary timestamp; appending with
 * `>= max` duplicates them. Deleting the `>= max` range first and re-running
 * it makes the operation idempotent — run it twice, get the same table.
 *
 * Returns null when incremental isn't applicable (no watermark, ineligible
 * flow, or an empty output that needs a first full build), so the caller
 * falls back to a full refresh.
 */
export async function refreshPrepIncremental(args: {
  userId: string;
  cfg: PrepFlowConfig;
  tableId: string;
}): Promise<{ rowsReplaced: number; since: string; engine: "local" | "warehouse" } | null> {
  const verdict = incrementalEligibility(args.cfg);
  if (!verdict.ok) return null;
  const column = verdict.column;

  // Newest watermark already in the output. Dates are stored as YYYY-MM-DD,
  // so lexicographic ordering IS chronological ordering.
  const { data: newest } = await supabaseAdmin
    .from("user_data_rows")
    .select("row")
    .eq("table_id", args.tableId)
    .order(`row->>${column}`, { ascending: false })
    .limit(1);
  const since = (newest?.[0]?.row as Record<string, unknown> | undefined)?.[column];
  if (typeof since !== "string" || !since) return null; // empty output → full build

  const windowed = withIncrementalWindow(args.cfg, since);
  const result = await executePrepFlow(args.userId, windowed);

  // Snapshot before the partial replace, for the same reason as a full
  // rebuild: the rows about to be deleted are the ones with no other copy.
  const { snapshotDatasetQuiet } = await import("@/utils/bi/versions.server");
  await snapshotDatasetQuiet({
    userId: args.userId,
    tableId: args.tableId,
    reason: "prep_refresh",
    note: `Incremental refresh replacing ${column} >= ${since}`,
  });

  // Replace exactly the reprocessed range.
  const { error: delErr } = await supabaseAdmin
    .from("user_data_rows")
    .delete()
    .eq("table_id", args.tableId)
    .gte(`row->>${column}`, since);
  if (delErr) throw new Error(delErr.message);

  for (let i = 0; i < result.rows.length; i += INSERT_BATCH) {
    const slice = result.rows.slice(i, i + INSERT_BATCH).map((row) => ({
      table_id: args.tableId,
      row: row as unknown as Json,
    }));
    const { error } = await supabaseAdmin.from("user_data_rows").insert(slice);
    if (error) throw new Error(error.message);
  }

  // The output schema can still drift (a renamed column); keep it current.
  await supabaseAdmin
    .from("user_data_tables")
    .update({
      columns: result.columns as unknown as Json,
      data_loaded_at: new Date().toISOString(),
    })
    .eq("id", args.tableId);

  await import("@/utils/data/parquet.server")
    .then((m) => m.refreshDatasetMirror({ userId: args.userId, tableId: args.tableId }))
    .catch(() => null);

  return { rowsReplaced: result.rows.length, since, engine: result.engine };
}

/** Best-effort semantic metadata for a materialised prep output. */
export async function savePrepSemantics(args: {
  userId: string;
  tableId: string;
  flowName: string;
  cfg: PrepFlowConfig;
}): Promise<void> {
  try {
    const meta = columnMetaFor(args.cfg);
    const payload = {
      user_id: args.userId,
      table_id: args.tableId,
      table_description: `Prepared dataset built by the "${args.flowName}" data-prep flow`,
      business_name: args.flowName,
      column_meta: meta as unknown as Json,
      primary_key: null,
    };
    const { data: existing } = await supabaseAdmin
      .from("user_data_semantics")
      .select("id")
      .eq("user_id", args.userId)
      .eq("table_id", args.tableId)
      .maybeSingle();
    if (existing) {
      await supabaseAdmin.from("user_data_semantics").update(payload).eq("id", existing.id);
    } else {
      await supabaseAdmin.from("user_data_semantics").insert(payload);
    }
  } catch {
    /* semantics are an enhancement — the data already saved successfully */
  }
}
