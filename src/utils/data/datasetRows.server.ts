// The one way the server reads and writes a dataset's rows (R451).
//
// These calls were written out at every site that needed them, in ten files.
// They are here so that what happens to a row happens in one place: the rows of
// a user under a customer key are to be sealed under that key, and a path that
// went around this module would read ciphertext as data, or write plaintext
// beside it. A test holds every server file to it.
//
// Nothing here decides who may read what. Row-level security does that for a
// caller's own client, passed as `sb`; the service role reads everything, and
// its callers apply a shared dataset's grant themselves (restrictSharedDataset).
//
// Errors come back the way Supabase gave them, as `{ error }`, because what a
// failure means differs by caller: a failed clear must stop a rebuild, and each
// says so in its own words.
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { selectAllPages } from "@/lib/pagedSelect";

export type DatasetRow = Record<string, unknown>;
type DbError = { message: string } | null;

const INSERT_BATCH = 500;

/**
 * Every row of a dataset, in a stable order, up to `cap`. Through selectAllPages,
 * which advances by the rows it received and keeps a page's error, and ordered by
 * id: offsets over no order are not a sequence, and a read that repeats one row
 * and drops another changes an answer in either direction. `truncated` says the
 * cap stopped it, and each caller decides what a prefix is worth.
 */
export async function scanDatasetRows(
  tableId: string,
  cap: number,
  sb: SupabaseClient<Database> = supabaseAdmin,
): Promise<{ rows: DatasetRow[]; truncated: boolean }> {
  const scan = await selectAllPages<{ row: unknown }>(
    () =>
      sb
        .from("user_data_rows")
        .select("row")
        .eq("table_id", tableId)
        .order("id", { ascending: true }),
    cap,
  );
  return { rows: scan.rows.map((c) => c.row as DatasetRow), truncated: scan.truncated };
}

/** A few of a dataset's rows, for a preview. In no particular order. */
export async function sampleDatasetRows(
  tableId: string,
  limit: number,
  sb: SupabaseClient<Database> = supabaseAdmin,
): Promise<DatasetRow[]> {
  const { data } = await sb
    .from("user_data_rows")
    .select("row")
    .eq("table_id", tableId)
    .limit(limit);
  return (data ?? []).map((c) => c.row as DatasetRow);
}

/** How many rows a dataset has; null, with the error, when that could not be read. */
export async function countDatasetRows(
  tableId: string,
): Promise<{ count: number | null; error: DbError }> {
  const { count, error } = await supabaseAdmin
    .from("user_data_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", tableId);
  return { count, error };
}

/** Delete all of a dataset's rows. */
export async function clearDatasetRows(tableId: string): Promise<{ error: DbError }> {
  const { error } = await supabaseAdmin.from("user_data_rows").delete().eq("table_id", tableId);
  return { error };
}

/** Add rows to a dataset, in batches. Stops at the first failure and returns it. */
export async function insertDatasetRows(
  tableId: string,
  rows: DatasetRow[],
): Promise<{ error: DbError }> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows
      .slice(i, i + INSERT_BATCH)
      .map((row) => ({ table_id: tableId, row: row as unknown as Json }));
    const { error } = await supabaseAdmin.from("user_data_rows").insert(slice);
    if (error) return { error };
  }
  return { error: null };
}

/**
 * The row with the greatest value in a column, read as text: a prep flow's
 * watermark. Null when the dataset is empty or that could not be read, which
 * sends the flow to a full build.
 */
export async function newestDatasetRow(
  tableId: string,
  column: string,
): Promise<DatasetRow | null> {
  const { data } = await supabaseAdmin
    .from("user_data_rows")
    .select("row")
    .eq("table_id", tableId)
    .order(`row->>${column}`, { ascending: false })
    .limit(1);
  return (data?.[0]?.row as DatasetRow | undefined) ?? null;
}

/** Delete the rows at or after a value in a column: the range a refresh rebuilds. */
export async function deleteDatasetRowsSince(
  tableId: string,
  column: string,
  since: string,
): Promise<{ error: DbError }> {
  const { error } = await supabaseAdmin
    .from("user_data_rows")
    .delete()
    .eq("table_id", tableId)
    .gte(`row->>${column}`, since);
  return { error };
}

/** Move every row from one dataset to another: an upload's staging swap. */
export async function moveDatasetRows(fromId: string, toId: string): Promise<{ error: DbError }> {
  const { error } = await supabaseAdmin
    .from("user_data_rows")
    .update({ table_id: toId })
    .eq("table_id", fromId);
  return { error };
}

/**
 * Merge a staging dataset into its target by a key column, in one statement in
 * the database: the key set can be tens of thousands of ids, and shipping them
 * here to build an `in (...)` would be slower and would race a concurrent sync.
 */
export async function mergeDatasetRows(args: {
  targetId: string;
  stagingId: string;
  key: string;
}): Promise<{ updated: number; inserted: number; error: DbError }> {
  const { data, error } = await supabaseAdmin.rpc("merge_dataset_rows", {
    p_target: args.targetId,
    p_staging: args.stagingId,
    p_key: args.key,
  });
  const row = (Array.isArray(data) ? data[0] : data) as {
    updated?: number;
    inserted?: number;
  } | null;
  return { updated: Number(row?.updated ?? 0), inserted: Number(row?.inserted ?? 0), error };
}
