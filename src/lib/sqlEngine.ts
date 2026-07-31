// In-browser SQL engine wrapping AlaSQL.
//
// Responsibilities:
//   - Parse uploaded CSV → JSON rows + inferred schema (PapaParse)
//   - Register tables in an isolated AlaSQL database
//   - Run only SELECT/WITH queries (read-only enforcement)
//   - Cap result row count at 50 for the playground
//   - Hydrate the engine from the user's persisted Supabase rows
//
// Used in two places:
//   1. The /data-sql IDE (browser) — runs queries the user types
//   2. The sql_query agent tool (server-side via the same logic re-instantiated
//      in sql.server.ts; the browser engine is independent of that path)

import alasql from "alasql";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";

export const PLAYGROUND_ROW_CAP = 50;

export type ColumnDef = { name: string; type: "number" | "string" | "date" };

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

// One engine instance per browser session, lazily initialized.
let engine: typeof alasql | null = null;
const registered = new Set<string>();

function getEngine(): typeof alasql {
  if (!engine) {
    engine = alasql;
  }
  registerCustomFunctions(engine);
  const globalEngine = (globalThis as typeof globalThis & { alasql?: typeof alasql }).alasql;
  if (globalEngine && globalEngine !== engine) registerCustomFunctions(globalEngine);
  return engine;
}

// Register SQLite/Postgres-style helpers the LLM may use that alasql lacks.
function registerCustomFunctions(a: typeof alasql) {
  const toDate = (v: unknown): Date | null => {
    if (v == null) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");

  const fn = a.fn as Record<string, (...args: unknown[]) => unknown>;

  const strftime = function (format: unknown, value: unknown) {
    const d = toDate(value);
    if (!d || typeof format !== "string") return null;
    return format.replace(/%[YmdHMSjw%]/g, (token) => {
      switch (token) {
        case "%Y":
          return String(d.getFullYear());
        case "%m":
          return pad(d.getMonth() + 1);
        case "%d":
          return pad(d.getDate());
        case "%H":
          return pad(d.getHours());
        case "%M":
          return pad(d.getMinutes());
        case "%S":
          return pad(d.getSeconds());
        case "%j": {
          const start = Date.UTC(d.getFullYear(), 0, 0);
          const diff = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - start;
          return pad(Math.floor(diff / 86400000), 3);
        }
        case "%w":
          return String(d.getDay());
        case "%%":
          return "%";
        default:
          return token;
      }
    });
  };
  fn.strftime = strftime;
  fn.STRFTIME = strftime;

  const date = function (value: unknown) {
    const d = toDate(value);
    if (!d) return null;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  fn.date = date;
  fn.DATE = date;

  const dateTrunc = function (unit: unknown, value: unknown) {
    const d = toDate(value);
    if (!d || typeof unit !== "string") return null;
    const y = d.getFullYear();
    const m = d.getMonth();
    switch (unit.toLowerCase()) {
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
  fn.date_trunc = dateTrunc;
  fn.DATE_TRUNC = dateTrunc;

  const year = function (v: unknown) {
    const d = toDate(v);
    return d ? d.getFullYear() : null;
  };
  const month = function (v: unknown) {
    const d = toDate(v);
    return d ? d.getMonth() + 1 : null;
  };
  const day = function (v: unknown) {
    const d = toDate(v);
    return d ? d.getDate() : null;
  };
  fn.year = year;
  fn.YEAR = year;
  fn.month = month;
  fn.MONTH = month;
  fn.day = day;
  fn.DAY = day;

  // SPLIT_PART(text, delimiter, n) — 1-based, like Postgres. Used by the
  // data-prep "split column" step. Returns null when the part is absent.
  const splitPart = function (value: unknown, delimiter: unknown, index: unknown) {
    if (value == null) return null;
    const parts = String(value).split(String(delimiter ?? ""));
    const i = Number(index);
    return Number.isInteger(i) && i >= 1 && i <= parts.length ? parts[i - 1] : null;
  };
  fn.split_part = splitPart;
  fn.SPLIT_PART = splitPart;
}

// Sanitize a string into a safe SQL identifier — letters, digits, underscores
// only, must start with a letter, lowercased.
export function safeTableName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  if (!cleaned || !/^[a-z]/.test(cleaned)) return `t_${cleaned || "table"}`;
  return cleaned.slice(0, 48);
}

function inferType(value: unknown): "number" | "string" | "date" {
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    if (value === "") return "string";
    // ISO date / common date formats
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) return "date";
    const n = Number(value.replace(/,/g, ""));
    if (!Number.isNaN(n) && value.trim() !== "") return "number";
  }
  return "string";
}

function inferColumns(rows: Record<string, unknown>[]): ColumnDef[] {
  if (rows.length === 0) return [];
  const headers = Object.keys(rows[0]);
  return headers.map((name) => {
    // Sample first 50 non-empty values to guess the type
    const counts = { number: 0, string: 0, date: 0 };
    let seen = 0;
    for (const r of rows) {
      const v = r[name];
      if (v === null || v === undefined || v === "") continue;
      counts[inferType(v)]++;
      seen++;
      if (seen >= 50) break;
    }
    const winner =
      counts.number > counts.string && counts.number >= counts.date
        ? "number"
        : counts.date > counts.string
          ? "date"
          : "string";
    return { name, type: winner };
  });
}

// Coerce values to their inferred type so AlaSQL can SUM, AVG, ORDER BY etc.
function coerceRow(row: Record<string, unknown>, cols: ColumnDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    const v = row[c.name];
    if (v === null || v === undefined || v === "") {
      out[c.name] = null;
      continue;
    }
    if (c.type === "number" && typeof v === "string") {
      const n = Number(v.replace(/,/g, ""));
      out[c.name] = Number.isNaN(n) ? v : n;
    } else {
      out[c.name] = v;
    }
  }
  return out;
}

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

// Register (or replace) a table inside the in-memory AlaSQL engine.
function registerTable(name: string, rows: Record<string, unknown>[]) {
  const e = getEngine();
  // Drop any existing table with this name so re-uploading replaces it.
  try {
    e(`DROP TABLE IF EXISTS \`${name}\``);
  } catch {
    /* noop */
  }
  e(`CREATE TABLE \`${name}\``);
  if (rows.length > 0) {
    (e.tables as any)[name].data = rows;
  }
  registered.add(name);
}

export function isTableRegistered(name: string): boolean {
  return registered.has(name);
}

// Fetch the user's persisted datasets and load every row into the AlaSQL engine.
// This is called once when the IDE mounts so all queries work immediately.
export async function hydrateFromSupabase(): Promise<DatasetMeta[]> {
  const { data: tables, error } = await supabase
    .from("user_data_tables")
    .select("id, name, source_filename, columns, is_sample, user_id")
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
      registerTable(t.name, rows);
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
    registerTable(t.name, allRows);
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

  registerTable(safeName, args.rows);

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
  registered.delete(tableName);
  try {
    getEngine()(`DROP TABLE IF EXISTS \`${tableName}\``);
  } catch {
    /* noop */
  }
}

// Reject anything that isn't a SELECT or CTE (WITH ... SELECT). No DDL/DML.
function isReadOnly(sql: string): boolean {
  const trimmed = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .trim();
  if (!trimmed) return false;
  const head = trimmed.toUpperCase();
  if (!(head.startsWith("SELECT") || head.startsWith("WITH"))) return false;
  // Crude denylist for stacked statements.
  const denylist =
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|TRUNCATE|REPLACE)\b/i;
  return !denylist.test(trimmed);
}

export function runQuery(sql: string): QueryResult {
  if (!isReadOnly(sql)) {
    throw new Error(
      "Only read-only SELECT (or WITH … SELECT) queries are allowed in the playground.",
    );
  }
  const e = getEngine();
  const t0 = performance.now();
  const result = e(sql) as Record<string, unknown>[];
  const t1 = performance.now();
  const total = result.length;
  const capped = total > PLAYGROUND_ROW_CAP;
  const limited = capped ? result.slice(0, PLAYGROUND_ROW_CAP) : result;
  const columns = limited.length > 0 ? Object.keys(limited[0]) : [];
  return {
    columns,
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
export function runQueryUnlimited(
  sql: string,
  maxRows: number,
): { columns: string[]; rows: Record<string, unknown>[]; total: number; capped: boolean } {
  if (!isReadOnly(sql)) {
    throw new Error("Only read-only SELECT (or WITH … SELECT) queries are allowed.");
  }
  const result = getEngine()(sql) as Record<string, unknown>[];
  const capped = result.length > maxRows;
  const rows = capped ? result.slice(0, maxRows) : result;
  return {
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rows,
    total: result.length,
    capped,
  };
}

// Convert a query result to CSV text for the Export button.
export function resultToCsv(result: QueryResult): string {
  if (result.columns.length === 0) return "";
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [result.columns.join(",")];
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => escape(row[c])).join(","));
  }
  return lines.join("\n");
}
