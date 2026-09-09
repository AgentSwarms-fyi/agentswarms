// Layout of lakehouse tables: what the catalog says about a table's files,
// what the query history says about how it is read, and the clustered
// rewrite that puts files in key order. Everything here takes an open
// lakehouse connection; access checks and audit belong to the callers.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  adviseLayout,
  bucketCount,
  columnLayout,
  cutsStatement,
  filteredColumns,
  rewriteStatements,
  type ColumnLayout,
  type FileRange,
  type LayoutAdvice,
} from "@/utils/lakehouse/layout";

/** The slice of a DuckDB connection this module needs — keeps core.server importable from here. */
export type LakeConnection = {
  run(sql: string): Promise<{ getRows(): Promise<unknown[][]> }>;
};

export type LayoutRow = {
  id: string;
  schema_name: string;
  table_name: string;
  cluster_columns: string[];
  target_file_bytes: number | null;
  keep_clustered: boolean;
  last_rewrite_at: string | null;
  last_rewrite_ms: number | null;
  last_rewrite_rows: number | null;
  last_rewrite_files_before: number | null;
  last_rewrite_files_after: number | null;
  last_rewrite_snapshot: number | null;
  last_error: string | null;
};

export type TableLayout = {
  files: number;
  bytes: number;
  rows: number;
  target_file_bytes: number;
  columns: ColumnLayout[];
  /** Columns queries filtered on this week, with how many queries. */
  filtered: Record<string, number>;
  layout: LayoutRow | null;
  files_since_rewrite: number;
  advice: LayoutAdvice[];
};

const DEFAULT_TARGET_FILE_BYTES = 128 * 1024 * 1024;

/**
 * The size a clustered file aims for: the table's own setting, else the
 * platform's, else 128 MiB — a size one worker scans comfortably and the
 * merge step leaves alone. Never capped: a 2 GB file is allowed if wanted.
 */
export function defaultTargetFileBytes(): number {
  const raw = process.env.LAKEHOUSE_CLUSTER_FILE_BYTES;
  const n = raw ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_TARGET_FILE_BYTES;
}

const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function rows(c: LakeConnection, sql: string): Promise<unknown[][]> {
  return (await c.run(sql)).getRows();
}

/** DuckLake's id for a live table, or null when the name is not a DuckLake table (a mount, a view). */
export async function tableId(
  c: LakeConnection,
  schema: string,
  table: string,
): Promise<number | null> {
  try {
    const r = await rows(
      c,
      `SELECT t.table_id FROM __ducklake_metadata_lake.ducklake_table t
       JOIN __ducklake_metadata_lake.ducklake_schema s
         ON s.schema_id = t.schema_id AND s.end_snapshot IS NULL
       WHERE t.end_snapshot IS NULL AND s.schema_name = ${sq(schema)} AND t.table_name = ${sq(table)}`,
    );
    return r.length ? Number(r[0][0]) : null;
  } catch {
    return null;
  }
}

export type FileStats = {
  files: number;
  bytes: number;
  rows: number;
  /** Files whose first snapshot is after `sinceSnapshot` (all of them when null). */
  since: number;
  columns: { name: string; type: string; ranges: FileRange[] }[];
};

/** The live files of a table and every column's range in each, from the catalog. */
export async function readFileStats(
  c: LakeConnection,
  id: number,
  sinceSnapshot: number | null,
): Promise<FileStats> {
  const files = await rows(
    c,
    `SELECT f.data_file_id, f.record_count, f.file_size_bytes, f.begin_snapshot
     FROM __ducklake_metadata_lake.ducklake_data_file f
     WHERE f.table_id = ${id} AND f.end_snapshot IS NULL`,
  );
  const byFile = new Map<number, { rows: number; bytes: number; begin: number }>();
  for (const f of files) {
    byFile.set(Number(f[0]), {
      rows: Number(f[1] ?? 0),
      bytes: Number(f[2] ?? 0),
      begin: Number(f[3] ?? 0),
    });
  }
  const stats = await rows(
    c,
    `SELECT col.column_name, col.column_type, col.column_order, s.data_file_id, s.min_value, s.max_value, s.null_count
     FROM __ducklake_metadata_lake.ducklake_file_column_stats s
     JOIN __ducklake_metadata_lake.ducklake_column col
       ON col.column_id = s.column_id AND col.table_id = s.table_id AND col.end_snapshot IS NULL
     JOIN __ducklake_metadata_lake.ducklake_data_file f
       ON f.data_file_id = s.data_file_id AND f.end_snapshot IS NULL
     WHERE s.table_id = ${id} AND col.parent_column IS NULL
     ORDER BY col.column_order, s.data_file_id`,
  );
  const columns = new Map<string, { name: string; type: string; ranges: FileRange[] }>();
  for (const r of stats) {
    const name = String(r[0]);
    const entry = columns.get(name) ?? { name, type: String(r[1]), ranges: [] };
    const fid = Number(r[3]);
    const f = byFile.get(fid);
    entry.ranges.push({
      file_id: fid,
      rows: f?.rows ?? 0,
      bytes: f?.bytes ?? 0,
      min: r[4] === null || r[4] === undefined ? null : String(r[4]),
      max: r[5] === null || r[5] === undefined ? null : String(r[5]),
      nulls: Number(r[6] ?? 0),
    });
    columns.set(name, entry);
  }
  let bytes = 0;
  let count = 0;
  let since = 0;
  for (const f of byFile.values()) {
    bytes += f.bytes;
    count += f.rows;
    if (sinceSnapshot === null || f.begin > sinceSnapshot) since += 1;
  }
  return { files: byFile.size, bytes, rows: count, since, columns: [...columns.values()] };
}

export async function readLayoutRow(schema: string, table: string): Promise<LayoutRow | null> {
  const { data } = await supabaseAdmin
    .from("lakehouse_table_layouts")
    .select("*")
    .eq("schema_name", schema)
    .eq("table_name", table)
    .maybeSingle();
  return (data as LayoutRow | null) ?? null;
}

/** Which of the table's columns this week's SELECTs filtered on, and how often. */
export async function filteredThisWeek(
  table: string,
  columns: string[],
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await supabaseAdmin
    .from("lakehouse_query_history")
    .select("sql")
    .eq("kind", "select")
    .gte("created_at", since)
    .ilike("sql", `%${table}%`)
    .order("id", { ascending: false })
    .limit(500);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    for (const col of filteredColumns(String(row.sql ?? ""), table, columns)) {
      counts[col] = (counts[col] ?? 0) + 1;
    }
  }
  return counts;
}

/** Everything the Layout dialog shows for one table. */
export async function readTableLayout(
  c: LakeConnection,
  schema: string,
  table: string,
): Promise<TableLayout> {
  const layout = await readLayoutRow(schema, table);
  const id = await tableId(c, schema, table);
  const target = layout?.target_file_bytes ?? defaultTargetFileBytes();
  const stats =
    id === null
      ? { files: 0, bytes: 0, rows: 0, since: 0, columns: [] }
      : await readFileStats(c, id, layout?.last_rewrite_snapshot ?? null);
  const columns = stats.columns.map((col) => columnLayout(col.name, col.type, col.ranges));
  const filtered = await filteredThisWeek(
    table,
    columns.map((col) => col.name),
  );
  const cluster = layout?.cluster_columns ?? [];
  return {
    files: stats.files,
    bytes: stats.bytes,
    rows: stats.rows,
    target_file_bytes: target,
    columns,
    filtered,
    layout,
    files_since_rewrite: layout ? stats.since : 0,
    advice: adviseLayout({
      files: stats.files,
      bytes: stats.bytes,
      targetBytes: target,
      columns,
      filtered,
      cluster,
      filesSinceRewrite: layout ? stats.since : 0,
      keepClustered: layout?.keep_clustered ?? false,
    }),
  };
}

export type RewriteResult = {
  files_before: number;
  files_after: number;
  rows: number;
  buckets: number;
  ms: number;
  snapshot: number | null;
  /** Files a lookup on the first key opened before and after, on average. */
  touched_before: number;
  touched_after: number;
};

/**
 * Rewrite a table in key order, one transaction. Ranges on the first key at
 * row-count quantiles, one range per target-sized file; every range is
 * copied aside sorted, deleted, and inserted back. A failure anywhere rolls
 * the whole thing back and the table is exactly as it was.
 */
export async function rewriteClustered(
  c: LakeConnection,
  args: { schema: string; table: string; keys: string[]; targetBytes: number },
): Promise<RewriteResult> {
  const id = await tableId(c, args.schema, args.table);
  if (id === null) throw new Error("Not a lakehouse table (a mount or a view cannot be rewritten)");
  const cols = await rows(
    c,
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_catalog = 'lake' AND table_schema = ${sq(args.schema)} AND table_name = ${sq(args.table)}`,
  );
  const types = new Map(cols.map((r) => [String(r[0]), String(r[1])]));
  for (const k of args.keys) {
    if (!types.has(k)) throw new Error(`No column "${k}" on ${args.schema}.${args.table}`);
  }
  // Rows still inlined in the catalog have no file statistics; give them
  // files first so the rewrite sees the whole table the same way.
  try {
    await c.run(
      `CALL ducklake_flush_inlined_data('lake', table_name => ${sq(args.table)}, schema_name => ${sq(args.schema)})`,
    );
  } catch {
    /* nothing inlined, or an older extension — the rewrite copes either way */
  }
  const before = await readFileStats(c, id, null);
  const firstKey = args.keys[0];
  const keyType = types.get(firstKey) ?? "VARCHAR";
  const buckets = bucketCount(before.bytes, args.targetBytes);
  let cuts: string[] = [];
  if (buckets > 1) {
    cuts = (await rows(c, cutsStatement(args.schema, args.table, firstKey, buckets))).map((r) =>
      String(r[0]),
    );
  }
  const statements = rewriteStatements({
    schema: args.schema,
    table: args.table,
    keys: args.keys,
    keyType,
    cuts,
  });
  const started = Date.now();
  try {
    for (const sql of statements) await c.run(sql);
  } catch (e) {
    try {
      await c.run("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw new Error(`Rewrite rolled back: ${(e as Error).message}`);
  }
  const ms = Date.now() - started;
  const after = await readFileStats(c, id, null);
  let snapshot: number | null = null;
  try {
    const r = await rows(c, "SELECT max(snapshot_id)::BIGINT FROM lake.snapshots()");
    snapshot = r.length && r[0][0] !== null ? Number(r[0][0]) : null;
  } catch {
    /* the row still records the rewrite; only the "since" count is lost */
  }
  const touched = (s: FileStats) => {
    const col = s.columns.find((x) => x.name === firstKey);
    return col ? columnLayout(col.name, col.type, col.ranges).touched : 0;
  };
  return {
    files_before: before.files,
    files_after: after.files,
    rows: after.rows,
    buckets: cuts.length + 1,
    ms,
    snapshot,
    touched_before: touched(before),
    touched_after: touched(after),
  };
}

/** Record a rewrite (or its failure) on the table's layout row. */
export async function saveLayoutRow(args: {
  schema: string;
  table: string;
  keys: string[];
  targetBytes: number | null;
  keepClustered: boolean;
  userId: string | null;
  result: RewriteResult | null;
  error: string | null;
}): Promise<void> {
  const r = args.result;
  await supabaseAdmin.from("lakehouse_table_layouts").upsert(
    {
      schema_name: args.schema,
      table_name: args.table,
      cluster_columns: args.keys,
      target_file_bytes: args.targetBytes,
      keep_clustered: args.keepClustered,
      ...(r
        ? {
            last_rewrite_at: new Date().toISOString(),
            last_rewrite_ms: r.ms,
            last_rewrite_rows: r.rows,
            last_rewrite_files_before: r.files_before,
            last_rewrite_files_after: r.files_after,
            last_rewrite_snapshot: r.snapshot,
          }
        : {}),
      last_error: args.error,
      updated_by: args.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "schema_name,table_name" },
  );
}

export type MaintenanceStep = { step: string; ok: boolean; ms: number; error?: string };

/**
 * The merge step of maintenance, table by table, skipping tables that are
 * clustered: DuckLake's merge concatenates adjacent files up to a size and
 * would fold a ranged layout back into overlapping files. Clustered tables
 * are compacted by their own rewrite instead.
 */
export async function mergeUnclusteredTables(c: LakeConnection): Promise<MaintenanceStep[]> {
  const { data } = await supabaseAdmin
    .from("lakehouse_table_layouts")
    .select("schema_name, table_name, cluster_columns");
  const clustered = new Set(
    (data ?? [])
      .filter((r) => (r.cluster_columns as string[] | null)?.length)
      .map((r) => `${r.schema_name}.${r.table_name}`),
  );
  const tables = await rows(
    c,
    `SELECT sc.schema_name, ti.table_name FROM ducklake_table_info('lake') ti
     JOIN __ducklake_metadata_lake.ducklake_schema sc ON sc.schema_id = ti.schema_id AND sc.end_snapshot IS NULL`,
  );
  const steps: MaintenanceStep[] = [];
  for (const t of tables) {
    const schema = String(t[0]);
    const table = String(t[1]);
    if (clustered.has(`${schema}.${table}`)) continue;
    const started = Date.now();
    try {
      await c.run(
        `CALL ducklake_merge_adjacent_files('lake', ${sq(table)}, schema => ${sq(schema)})`,
      );
      steps.push({ step: `merge_files:${schema}.${table}`, ok: true, ms: Date.now() - started });
    } catch (e) {
      steps.push({
        step: `merge_files:${schema}.${table}`,
        ok: false,
        ms: Date.now() - started,
        error: (e as Error).message,
      });
    }
  }
  return steps;
}

/**
 * Tables kept clustered whose files grew since the last rewrite are
 * rewritten again — the maintenance pass's version of OPTIMIZE on a
 * schedule. One table failing is recorded on its row and never stops the
 * others.
 */
export async function reclusterDueTables(c: LakeConnection): Promise<MaintenanceStep[]> {
  const { data } = await supabaseAdmin
    .from("lakehouse_table_layouts")
    .select("*")
    .eq("keep_clustered", true);
  const steps: MaintenanceStep[] = [];
  for (const row of (data ?? []) as LayoutRow[]) {
    if (!row.cluster_columns.length) continue;
    const id = await tableId(c, row.schema_name, row.table_name);
    if (id === null) continue;
    const stats = await readFileStats(c, id, row.last_rewrite_snapshot);
    if (stats.since === 0) continue;
    const name = `recluster:${row.schema_name}.${row.table_name}`;
    const started = Date.now();
    try {
      const result = await rewriteClustered(c, {
        schema: row.schema_name,
        table: row.table_name,
        keys: row.cluster_columns,
        targetBytes: row.target_file_bytes ?? defaultTargetFileBytes(),
      });
      await saveLayoutRow({
        schema: row.schema_name,
        table: row.table_name,
        keys: row.cluster_columns,
        targetBytes: row.target_file_bytes,
        keepClustered: true,
        userId: null,
        result,
        error: null,
      });
      steps.push({ step: name, ok: true, ms: Date.now() - started });
    } catch (e) {
      const message = (e as Error).message;
      await saveLayoutRow({
        schema: row.schema_name,
        table: row.table_name,
        keys: row.cluster_columns,
        targetBytes: row.target_file_bytes,
        keepClustered: true,
        userId: null,
        result: null,
        error: message,
      });
      steps.push({ step: name, ok: false, ms: Date.now() - started, error: message });
    }
  }
  return steps;
}

/** The cluster keys of the tables in a schema list, for badges. */
export async function clusteredBy(schema: string, table: string): Promise<string[]> {
  const row = await readLayoutRow(schema, table);
  return row?.cluster_columns ?? [];
}
