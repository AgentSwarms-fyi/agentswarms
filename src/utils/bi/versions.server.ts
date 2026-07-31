// Dataset version history: snapshot before overwrite, restore on demand.
//
// Every path that replaces a dataset's contents — a re-upload, "Run & save" on
// a prep flow, a scheduled prep refresh — used to be a one-way door. A prep
// flow that silently started producing garbage overwrote good data at full
// volume, on a timer, with no undo. This is the undo.
//
// Bounded on purpose. `DATASET_VERSION_ROW_CAP` decides how large a dataset
// may be before its snapshots become METADATA-ONLY: above the cap we still
// record what changed and when, but not the rows. Copying a 250k-row table on
// every hourly refresh would cost more than the protection is worth, and
// pretending otherwise would be the kind of silent scaling cliff that only
// shows up in production.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

export type VersionReason = "upload" | "prep_run" | "prep_refresh" | "restore" | "overwrite";

export function versionRowCap(): number {
  const n = Number(process.env.DATASET_VERSION_ROW_CAP);
  return Number.isFinite(n) && n >= 0 ? n : 20_000;
}

export function versionsKept(): number {
  const n = Number(process.env.DATASET_VERSION_KEEP);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

const PAGE = 1000;

export type DatasetVersion = {
  id: string;
  table_id: string;
  created_at: string;
  reason: string;
  row_count: number;
  columns: { name: string; type?: string }[];
  rows_omitted: boolean;
  note: string | null;
};

/**
 * Capture the CURRENT contents of a dataset as a restorable version.
 *
 * Returns null when the dataset does not exist or is not the caller's — never
 * throws for the "nothing to snapshot" case, because callers invoke this on
 * the way to a write they still want to happen.
 */
export async function snapshotDataset(args: {
  userId: string;
  tableId: string;
  reason: VersionReason;
  note?: string;
}): Promise<{ versionId: string; rowCount: number; rowsOmitted: boolean } | null> {
  const { data: table } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, user_id, columns, is_sample")
    .eq("id", args.tableId)
    .maybeSingle();
  if (!table || table.user_id !== args.userId || table.is_sample) return null;

  const { count } = await supabaseAdmin
    .from("user_data_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", args.tableId);
  const rowCount = count ?? 0;
  // Nothing to protect: an empty table's "previous state" is the empty state,
  // and recording it would just push a real version out of the retention window.
  if (rowCount === 0) return null;

  const cap = versionRowCap();
  let rows: Record<string, unknown>[] | null = null;
  if (rowCount <= cap && cap > 0) {
    rows = [];
    for (let start = 0; start < rowCount; start += PAGE) {
      const { data: chunk, error } = await supabaseAdmin
        .from("user_data_rows")
        .select("row")
        .eq("table_id", args.tableId)
        .range(start, start + PAGE - 1);
      if (error) {
        // A partial copy is worse than an honest metadata-only version: it
        // would present itself as restorable and then silently lose rows.
        console.warn(`[versions] row copy failed, storing metadata only: ${error.message}`);
        rows = null;
        break;
      }
      if (!chunk || chunk.length === 0) break;
      rows.push(...chunk.map((c) => c.row as Record<string, unknown>));
      if (chunk.length < PAGE) break;
    }
  }

  const { data: created, error: insErr } = await supabaseAdmin
    .from("user_data_table_versions")
    .insert({
      table_id: args.tableId,
      user_id: args.userId,
      reason: args.reason,
      row_count: rowCount,
      columns: (table.columns ?? []) as Json,
      rows: rows as unknown as Json,
      rows_omitted: rows === null,
      note: args.note?.slice(0, 300) ?? null,
    })
    .select("id")
    .single();
  if (insErr || !created) throw new Error(insErr?.message ?? "Failed to record the version");

  await pruneVersions(args.tableId);
  return { versionId: created.id, rowCount, rowsOmitted: rows === null };
}

/** Best-effort snapshot: logs and returns null instead of failing the write
 *  that prompted it. Used on hot paths where blocking the save would be worse
 *  than losing one version. */
export async function snapshotDatasetQuiet(args: {
  userId: string;
  tableId: string;
  reason: VersionReason;
  note?: string;
}): Promise<{ versionId: string; rowCount: number; rowsOmitted: boolean } | null> {
  try {
    return await snapshotDataset(args);
  } catch (e) {
    console.warn("[versions] snapshot failed:", (e as Error).message);
    return null;
  }
}

async function pruneVersions(tableId: string): Promise<void> {
  try {
    const keep = versionsKept();
    const { data: old } = await supabaseAdmin
      .from("user_data_table_versions")
      .select("id")
      .eq("table_id", tableId)
      .order("created_at", { ascending: false })
      .range(keep, keep + 99);
    if (old && old.length > 0) {
      await supabaseAdmin
        .from("user_data_table_versions")
        .delete()
        .in(
          "id",
          old.map((v) => v.id),
        );
    }
  } catch (e) {
    console.warn("[versions] prune failed:", (e as Error).message);
  }
}

export async function listDatasetVersions(
  userId: string,
  tableId: string,
): Promise<DatasetVersion[]> {
  const { data, error } = await supabaseAdmin
    .from("user_data_table_versions")
    .select("id, table_id, created_at, reason, row_count, columns, rows_omitted, note")
    .eq("user_id", userId)
    .eq("table_id", tableId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((v) => ({
    id: v.id,
    table_id: v.table_id,
    created_at: v.created_at,
    reason: v.reason,
    row_count: v.row_count,
    columns: Array.isArray(v.columns) ? (v.columns as { name: string; type?: string }[]) : [],
    rows_omitted: v.rows_omitted,
    note: v.note,
  }));
}

const INSERT_BATCH = 500;

/**
 * Replace a dataset's contents with a stored version.
 *
 * The state being replaced is snapshotted FIRST, so restoring the wrong
 * version is itself undoable — a restore that could not be undone would just
 * move the one-way door rather than remove it.
 */
export async function restoreDatasetVersion(args: {
  userId: string;
  versionId: string;
}): Promise<{ tableId: string; rowCount: number; tableName: string }> {
  const { data: version, error } = await supabaseAdmin
    .from("user_data_table_versions")
    .select("id, table_id, user_id, rows, columns, rows_omitted, row_count, created_at")
    .eq("id", args.versionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!version || version.user_id !== args.userId) throw new Error("Version not found");
  if (version.rows_omitted || !Array.isArray(version.rows)) {
    throw new Error(
      "This version recorded only metadata because the dataset was larger than the snapshot cap, so it cannot be restored.",
    );
  }

  const { data: table } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, user_id")
    .eq("id", version.table_id)
    .maybeSingle();
  if (!table || table.user_id !== args.userId) throw new Error("Dataset not found");

  await snapshotDatasetQuiet({
    userId: args.userId,
    tableId: version.table_id,
    reason: "restore",
    note: `Replaced by a restore of the ${new Date(version.created_at).toISOString()} version`,
  });

  const rows = version.rows as unknown as Record<string, unknown>[];
  const { error: delErr } = await supabaseAdmin
    .from("user_data_rows")
    .delete()
    .eq("table_id", version.table_id);
  if (delErr) throw new Error(delErr.message);

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows.slice(i, i + INSERT_BATCH).map((row) => ({
      table_id: version.table_id,
      row: row as unknown as Json,
    }));
    const { error: insErr } = await supabaseAdmin.from("user_data_rows").insert(slice);
    if (insErr) throw new Error(insErr.message);
  }

  // The schema travels with the rows — restoring 2020's rows under 2026's
  // column list would leave the dataset describing columns it no longer has.
  await supabaseAdmin
    .from("user_data_tables")
    .update({ columns: (version.columns ?? []) as Json, data_loaded_at: new Date().toISOString() })
    .eq("id", version.table_id);

  await import("@/utils/data/parquet.server")
    .then((m) => m.refreshDatasetMirror({ userId: args.userId, tableId: version.table_id }))
    .catch(() => null);

  return { tableId: version.table_id, rowCount: rows.length, tableName: table.name };
}

export async function deleteDatasetVersion(userId: string, versionId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("user_data_table_versions")
    .delete()
    .eq("id", versionId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}
