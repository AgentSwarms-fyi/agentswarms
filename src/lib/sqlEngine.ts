// In-browser SQL engine, backed by DuckDB compiled to WebAssembly.
//
// Responsibilities:
//   - Parse uploaded CSV → JSON rows + inferred schema (PapaParse)
//   - Materialise those tables in a per-tab DuckDB-Wasm database
//   - Run only SELECT/WITH queries (read-only enforcement)
//   - Cap result row count at 50 for the playground
//   - Hydrate the engine from the user's persisted Supabase rows
//
// IT USED TO BE ALASQL, AND THE ENGINES DISAGREED. Local datasets execute in
// two places — here, and on the server for scheduled refreshes, prep flows,
// the semantic runner and the agents' sql_query tool. AlaSQL answered 56 of
// the 61 NL-to-SQL reference queries against DuckDB's 61, and three of the
// failures were SILENT: "share of total" dropped its computed column and a
// running total returned 0 for every row, so a cumulative chart rendered as a
// flat line with no error anywhere. `evals/nl2sql/engine-gap.ts` measures it.
//
// EVERY QUERY FUNCTION HERE IS ASYNC as a result. WebAssembly instantiation
// and the worker boundary cannot be made synchronous, and pretending otherwise
// (a busy-wait, a cached snapshot) would trade a correctness bug for a
// concurrency one.

import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
// Type inference and coercion are shared with the streaming server upload —
// two implementations would eventually disagree about what a date is.
import {
  coerceRow,
  inferColumns,
  safeTableName,
  STAGING_PREFIX,
  type ColumnDef,
} from "@/lib/datasetParse";
import { isLocalReadOnlySql } from "@/lib/sqlSafety";
import {
  dropBrowserTable,
  isBrowserTableRegistered,
  prewarmBrowserEngine,
  registerBrowserTables,
  runBrowserSql,
} from "@/lib/browserDuckdb";

export const PLAYGROUND_ROW_CAP = 50;

export type { ColumnDef };

export type DatasetMeta = {
  id: string; // user_data_tables.id
  name: string; // SQL table name
  source_filename: string | null;
  is_sample: boolean;
  // Owner id — null on samples; differs from the viewer's id on tables an
  // administrator shared with them (read-only via IAM grants).
  user_id: string | null;
  columns: ColumnDef[];
  row_count: number;
};

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  total_matched: number; // before cap
  capped: boolean;
  duration_ms: number;
};

// THE ~120 LINES THAT USED TO LIVE HERE ARE GONE ON PURPOSE.
//
// They hand-implemented strftime, date, date_trunc, year, month, day and
// split_part in JavaScript, because AlaSQL has none of them and a model
// writing SQL reaches for them constantly. DuckDB ships all of them natively,
// so the shims are not merely unnecessary — keeping them would be a second
// definition competing with the engine's own.
//
// One of them was actively wrong in a way nobody could have noticed: the shim
// took strftime(format, value) while DuckDB (and Postgres, and SQLite) take
// strftime(value, format). SQL written against the shim ran here and failed on
// the server. That argument order now comes from the engine, once.

export { safeTableName };

export type ParsedCsv = {
  rows: Record<string, unknown>[];
  columns: ColumnDef[];
};

// Parse a CSV string OR File using PapaParse with header inference.
export function parseCsv(input: string | File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, unknown>>(input as string, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false, // we coerce ourselves so date strings stay strings
      complete: (res) => {
        const rows = res.data.filter(
          (r) => r && typeof r === "object" && Object.keys(r).length > 0,
        );
        const columns = inferColumns(rows);
        const coerced = rows.map((r) => coerceRow(r, columns));
        resolve({ rows: coerced, columns });
      },
      error: (err: Error) => reject(err),
    });
  });
}

/**
 * Materialise (or replace) a table in the browser database.
 *
 * DuckDB is typed, so this needs the COLUMNS as well as the rows — AlaSQL
 * accepted a bare array of objects and inferred nothing. Every caller already
 * had the inferred schema to hand.
 */
async function registerTable(
  name: string,
  rows: Record<string, unknown>[],
  columns: ColumnDef[],
): Promise<void> {
  // A shared dataset arrives column-masked, so the schema is narrowed to what
  // actually came back rather than what the catalog claims. Creating a column
  // the rows do not have would resurrect a masked column as all-NULL, which
  // reads as "no data" rather than "not permitted".
  const present = rows.length > 0 ? columns.filter((c) => Object.hasOwn(rows[0], c.name)) : columns;
  await registerBrowserTables([{ name, columns: present, rows }]);
}

export function isTableRegistered(name: string): boolean {
  return isBrowserTableRegistered(name);
}

/**
 * The hydration currently in flight, shared by every concurrent caller.
 *
 * DuckDB-Wasm's database lives for the whole TAB, and several surfaces
 * hydrate independently — the catalog, the workbench, Visual BI in chat — so
 * two of them mounting together ran two hydrations over one database. Each
 * materialise() is `DROP TABLE IF EXISTS` then `CREATE TABLE`, which is
 * idempotent alone but not against a second copy of itself: A's CREATE lands
 * between B's DROP and CREATE and DuckDB answers
 *   Catalog Error: Table with name "f1_world_champions" already exists!
 * That aborts the losing hydration midway, so tables after the collision are
 * never created — the catalog's own error was `saas_sales does not exist`
 * moments later. The Workbench looked fine because it had hydrated first and
 * won; the agent looked fine because it queries server-side.
 *
 * AlaSQL had no persistent per-tab database, so this could not happen before
 * 92686b1. Sharing the promise makes a concurrent call wait for the first
 * rather than fight it.
 */
let hydrationInFlight: Promise<DatasetMeta[]> | null = null;

// Fetch the user's persisted datasets and materialise every row in the browser
// DuckDB. Safe to call from several surfaces at once — concurrent callers
// share one hydration.
export async function hydrateFromSupabase(): Promise<DatasetMeta[]> {
  if (hydrationInFlight) return hydrationInFlight;
  hydrationInFlight = hydrateFromSupabaseUncoordinated().finally(() => {
    hydrationInFlight = null;
  });
  return hydrationInFlight;
}

async function hydrateFromSupabaseUncoordinated(): Promise<DatasetMeta[]> {
  // Start fetching the WebAssembly engine BEFORE the rows, so the ~8 MB
  // download overlaps the Supabase round trips instead of following them.
  // Hydration needs the engine regardless — this only moves it earlier — and
  // doing it here covers every surface (workbench, BI, catalog, prep flows)
  // rather than relying on each to remember.
  prewarmBrowserEngine();

  const { data: tables, error } = await supabase
    .from("user_data_tables")
    .select("id, name, source_filename, columns, is_sample, user_id")
    // An upload in flight owns a staging dataset until it is promoted; showing
    // it would put a half-written table in the picker.
    .not("name", "like", `${STAGING_PREFIX}%`)
    .order("created_at", { ascending: false });
  if (error || !tables) return [];

  // Who we are decides HOW rows are read: own/sample tables come straight
  // from user_data_rows, while a dataset SHARED with us goes through the
  // shared_dataset_rows() function so the grant's row filter and column mask
  // are applied inside Postgres. RLS no longer serves those rows directly —
  // a mask enforced only in the browser would be no mask at all.
  const { data: auth } = await supabase.auth.getUser();
  const myId = auth.user?.id ?? null;

  // Hydrate every table in parallel — and within each table, fetch row pages
  // in parallel batches as well. Big speedup vs. the old serial loop.
  const PAGE = 1000;
  const PARALLEL_PAGES = 5;

  async function loadShared(tableId: string): Promise<Record<string, unknown>[]> {
    const { data, error: rpcErr } = await supabase.rpc("shared_dataset_rows", {
      _table_id: tableId,
    });
    if (rpcErr || !Array.isArray(data)) return [];
    return data as Record<string, unknown>[];
  }

  async function loadOne(t: {
    id: string;
    name: string;
    source_filename: string | null;
    columns: unknown;
    is_sample: boolean;
    user_id: string | null;
  }): Promise<DatasetMeta> {
    const cols = (Array.isArray(t.columns) ? t.columns : []) as ColumnDef[];
    const shared = !t.is_sample && !!myId && t.user_id !== myId;
    if (shared) {
      const rows = await loadShared(t.id);
      await registerTable(t.name, rows, cols);
      // Report the columns actually present after masking, so pickers and
      // the AI never offer a column the viewer cannot see.
      const visible = rows.length > 0 ? cols.filter((c) => Object.hasOwn(rows[0], c.name)) : cols;
      return {
        id: t.id,
        name: t.name,
        source_filename: t.source_filename,
        is_sample: t.is_sample,
        user_id: t.user_id,
        columns: visible,
        row_count: rows.length,
      };
    }
    const allRows: Record<string, unknown>[] = [];
    let pageIndex = 0;
    for (;;) {
      const ranges = Array.from({ length: PARALLEL_PAGES }, (_, i) => {
        const start = (pageIndex + i) * PAGE;
        return { start, end: start + PAGE - 1 };
      });
      const results = await Promise.all(
        ranges.map((r) =>
          supabase.from("user_data_rows").select("row").eq("table_id", t.id).range(r.start, r.end),
        ),
      );
      let stop = false;
      for (const { data: chunk, error: rowErr } of results) {
        if (rowErr || !chunk || chunk.length === 0) {
          stop = true;
          break;
        }
        allRows.push(...chunk.map((c) => c.row as Record<string, unknown>));
        if (chunk.length < PAGE) {
          stop = true;
          break;
        }
      }
      if (stop) break;
      pageIndex += PARALLEL_PAGES;
    }
    await registerTable(t.name, allRows, cols);
    return {
      id: t.id,
      name: t.name,
      source_filename: t.source_filename,
      is_sample: t.is_sample,
      user_id: t.user_id,
      columns: cols,
      row_count: allRows.length,
    };
  }

  return Promise.all(tables.map(loadOne));
}

// Persist a parsed dataset to Supabase AND register it in the engine.
// Always inserts as a PRIVATE user-owned table (is_sample = false). Public
// sample datasets are seeded separately via the upsert_sample_dataset RPC
// (see src/lib/sampleData.ts) and are read-only from the client.
/**
 * Ask the server to record the dataset's current contents as a restorable
 * version. Never throws — the caller is mid-save and a missing version is a
 * smaller problem than a failed upload.
 */
async function snapshotBeforeOverwrite(
  tableId: string,
  reason: "upload" | "prep_run" | "overwrite",
  sourceFilename: string | null,
): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const { snapshotDatasetFn } = await import("@/utils/dataQuality.functions");
    await snapshotDatasetFn({
      data: {
        accessToken: session.access_token,
        tableId,
        reason,
        note: sourceFilename ? `Replaced by ${sourceFilename}` : undefined,
      },
    });
  } catch (e) {
    console.warn("[versions] pre-overwrite snapshot failed:", (e as Error).message);
  }
}

export async function saveDataset(args: {
  userId: string;
  tableName: string;
  sourceFilename: string | null;
  rows: Record<string, unknown>[];
  columns: ColumnDef[];
  /** What is doing the overwrite, recorded on the version. */
  versionReason?: "upload" | "prep_run" | "overwrite";
}): Promise<DatasetMeta> {
  const safeName = safeTableName(args.tableName);

  // Upsert by (user_id, name) for THIS user only — never touches shared samples.
  const { data: existing } = await supabase
    .from("user_data_tables")
    .select("id")
    .eq("name", safeName)
    .eq("user_id", args.userId)
    .maybeSingle();

  let tableId: string;
  if (existing) {
    tableId = existing.id;
    // Overwriting an existing dataset destroys its previous contents, so ask
    // the server to snapshot them first — a re-upload of the wrong file is
    // otherwise unrecoverable. Best-effort by design: a versioning problem
    // must not block the save the user asked for.
    await snapshotBeforeOverwrite(tableId, args.versionReason ?? "overwrite", args.sourceFilename);
    await supabase.from("user_data_rows").delete().eq("table_id", tableId);
    await supabase
      .from("user_data_tables")
      .update({
        source_filename: args.sourceFilename,
        columns: args.columns as any,
        // Explicit: `updated_at` is trigger-stamped on any metadata edit, so
        // freshness checks need a timestamp that only moves when rows do.
        data_loaded_at: new Date().toISOString(),
      })
      .eq("id", tableId);
  } else {
    const { data: created, error } = await supabase
      .from("user_data_tables")
      .insert({
        user_id: args.userId,
        name: safeName,
        source_filename: args.sourceFilename,
        columns: args.columns as any,
        is_sample: false,
      })
      .select("id")
      .single();
    if (error || !created) throw new Error(error?.message || "Failed to create dataset");
    tableId = created.id;
  }

  // Insert rows in batches of 500 to stay under request size limits.
  const BATCH = 500;
  for (let i = 0; i < args.rows.length; i += BATCH) {
    const slice = args.rows.slice(i, i + BATCH).map((row) => ({
      table_id: tableId,
      row: row as any,
    }));
    const { error } = await supabase.from("user_data_rows").insert(slice);
    if (error) throw new Error(error.message);
  }

  await registerTable(safeName, args.rows, args.columns);

  return {
    id: tableId,
    name: safeName,
    source_filename: args.sourceFilename,
    is_sample: false,
    user_id: args.userId,
    columns: args.columns,
    row_count: args.rows.length,
  };
}

export async function deleteDataset(tableId: string, tableName: string): Promise<void> {
  await supabase.from("user_data_tables").delete().eq("id", tableId);
  await dropBrowserTable(tableName);
}

/**
 * Run a statement for the workbench, capped at PLAYGROUND_ROW_CAP.
 *
 * ASYNC because DuckDB-Wasm lives behind a worker. The read-only check is kept
 * here as well as inside the engine so the workbench's own wording ("in the
 * playground") survives — the engine's guard is the one that actually protects
 * anything, and both call the same predicate.
 */
export async function runQuery(sql: string): Promise<QueryResult> {
  if (!isLocalReadOnlySql(sql)) {
    throw new Error(
      "Only read-only SELECT (or WITH … SELECT) queries are allowed in the playground.",
    );
  }
  const t0 = performance.now();
  const result = await runBrowserSql(sql);
  const t1 = performance.now();
  const total = result.rows.length;
  const capped = total > PLAYGROUND_ROW_CAP;
  const limited = capped ? result.rows.slice(0, PLAYGROUND_ROW_CAP) : result.rows;
  return {
    // Taken from the RESULT SCHEMA rather than from the first row's keys.
    // DuckDB reports columns even when no rows come back, so an empty result
    // now keeps its headers instead of rendering as a blank table.
    columns: result.columns,
    rows: limited,
    row_count: limited.length,
    total_matched: total,
    capped,
    duration_ms: Math.round(t1 - t0),
  };
}

// Read-only execution WITHOUT the playground row cap — used by the data-prep
// builder to materialise a full result before saving it as a dataset. The
// caller supplies its own cap to guard against runaway joins.
export async function runQueryUnlimited(
  sql: string,
  maxRows: number,
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  capped: boolean;
}> {
  if (!isLocalReadOnlySql(sql)) {
    throw new Error("Only read-only SELECT (or WITH … SELECT) queries are allowed.");
  }
  const result = await runBrowserSql(sql);
  const capped = result.rows.length > maxRows;
  const rows = capped ? result.rows.slice(0, maxRows) : result.rows;
  return { columns: result.columns, rows, total: result.rows.length, capped };
}

// resultToCsv used to live here — "convert a query result to CSV text for the
// Export button". The Export button uses downloadCsv in lib/exportData; this
// had no callers left anywhere in src/ or tests/, and it carried the same
// three faults as the other orphaned copy: it did not escape the HEADER row,
// its test was /[",\n]/ so a bare carriage return broke the row structure, and
// it had no guard against spreadsheet formula injection.
//
// Deleted rather than fixed. A dead helper that looks like a ready-made
// utility is worse than no helper: the next person needing a CSV export finds
// it and inherits every fault, which is precisely how the dashboard route
// ended up with its own broken copy. Use downloadCsv.
