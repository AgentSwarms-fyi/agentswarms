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
import { KeyStoreMissingError } from "@/utils/kms/keyHierarchy.server";
import { keyHierarchy } from "@/utils/providers/crypto.server";

export type DatasetRow = Record<string, unknown>;
type DbError = { message: string } | null;

const INSERT_BATCH = 500;

/**
 * Whether a dataset of this owner's has its rows go through the server: they
 * are under a customer key (R452). Everyone else's stay exactly as they were, and
 * never touch the `rows_sealed` column, so nothing here needs the migration for
 * them. A lookup that fails counts as yes: the server path works for anyone, and
 * the other answer would leave a customer's rows where the browser can write
 * them. Only tables that do not exist yet mean no.
 */
export async function sealsDatasetRows(owner: string): Promise<boolean> {
  try {
    return (await keyHierarchy().customerKeyOver(owner)) !== null;
  } catch (e) {
    return !(e instanceof KeyStoreMissingError);
  }
}

/** Mark a dataset as one whose rows go through the server, when its owner's do. */
async function markIfSealed(tableId: string, owner: string): Promise<void> {
  if (!(await sealsDatasetRows(owner))) return;
  const { error } = await supabaseAdmin
    .from("user_data_tables")
    .update({ rows_sealed: true } as never)
    .eq("id", tableId);
  if (error) console.warn(`[dataset-rows] ${tableId} was not marked: ${error.message}`);
}

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

/** One window of a dataset, in a stable order: what the browser pages through. */
export async function windowDatasetRows(
  tableId: string,
  from: number,
  size: number,
): Promise<{ rows: DatasetRow[]; error: DbError }> {
  const { data, error } = await supabaseAdmin
    .from("user_data_rows")
    .select("row")
    .eq("table_id", tableId)
    .order("id", { ascending: true })
    .range(from, from + size - 1);
  return { rows: (data ?? []).map((c) => c.row as DatasetRow), error };
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

export type DatasetWriter = {
  /** Add rows, in batches. Stops at the first failure and returns it. */
  insert(rows: DatasetRow[]): Promise<{ error: DbError }>;
};

/**
 * A writer for one dataset. It asks once whether the owner's rows go through the
 * server, not once a batch: an upload flushes hundreds of times, and everyone who
 * is not under a customer key should pay nothing for this.
 */
export async function datasetWriter(tableId: string, owner: string): Promise<DatasetWriter> {
  await markIfSealed(tableId, owner);
  return {
    async insert(rows) {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const slice = rows
          .slice(i, i + INSERT_BATCH)
          .map((row) => ({ table_id: tableId, row: row as unknown as Json }));
        const { error } = await supabaseAdmin.from("user_data_rows").insert(slice);
        if (error) return { error };
      }
      return { error: null };
    },
  };
}

/** Add rows to a dataset, in one go. */
export async function insertDatasetRows(
  tableId: string,
  owner: string,
  rows: DatasetRow[],
): Promise<{ error: DbError }> {
  if (rows.length === 0) return { error: null };
  return (await datasetWriter(tableId, owner)).insert(rows);
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
export async function moveDatasetRows(
  fromId: string,
  toId: string,
  owner: string,
): Promise<{ error: DbError }> {
  const { error } = await supabaseAdmin
    .from("user_data_rows")
    .update({ table_id: toId })
    .eq("table_id", fromId);
  if (!error) await markIfSealed(toId, owner);
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
  owner: string;
}): Promise<{ updated: number; inserted: number; error: DbError }> {
  const { data, error } = await supabaseAdmin.rpc("merge_dataset_rows", {
    p_target: args.targetId,
    p_staging: args.stagingId,
    p_key: args.key,
  });
  if (!error) await markIfSealed(args.targetId, args.owner);
  const row = (Array.isArray(data) ? data[0] : data) as {
    updated?: number;
    inserted?: number;
  } | null;
  return { updated: Number(row?.updated ?? 0), inserted: Number(row?.inserted ?? 0), error };
}
