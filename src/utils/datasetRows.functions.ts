// A dataset's rows, through the server, for the browser (R452). Rows of a user
// under a customer key cannot be read or written by the browser directly, which
// holds no key; everyone else's still are, by the same page that always did.
//
// These run as the service role, so they make the checks row-level security
// made: an owner reads and writes their own, anyone reads a sample, and a grantee
// reads through restrictSharedDataset, which applies the grant's row filter and
// column mask and answers nothing when there is no grant.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { callerFailure } from "@/utils/callerLookup.server";

type Row = Record<string, Json>;

/** The most a read of a shared dataset hands back, as the SQL tool's ceiling. */
const SHARED_READ_MAX = 200_000;

async function callerId(accessToken: string): Promise<string | { error: string }> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { error: callerFailure(error, "Unauthorized") };
  return data.user.id;
}

async function datasetFor(tableId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, user_id, is_sample, columns")
    .eq("id", tableId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

const token = z.string().min(1);
const uuid = z.string().uuid();

/** Whether what the caller saves goes through the server: they are under a customer key. */
export const datasetRowsGoThroughServer = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token }).parse(v))
  .handler(
    async ({ data }): Promise<{ ok: true; through: boolean } | { ok: false; error: string }> => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      const { sealsDatasetRows } = await import("@/utils/data/datasetRows.server");
      return { ok: true, through: await sealsDatasetRows(user) };
    },
  );

/** One window of a dataset the caller owns, or of a sample. */
export const readDatasetWindow = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({
        access_token: token,
        table_id: uuid,
        from: z.number().int().min(0),
        size: z.number().int().min(1).max(1000),
      })
      .parse(v),
  )
  .handler(async ({ data }): Promise<{ ok: true; rows: Row[] } | { ok: false; error: string }> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return { ok: false, error: user.error };
    try {
      const table = await datasetFor(data.table_id);
      if (!table || (table.user_id !== user && !table.is_sample)) {
        return { ok: false, error: "Dataset not found" };
      }
      const { windowDatasetRows } = await import("@/utils/data/datasetRows.server");
      const { rows, error } = await windowDatasetRows(data.table_id, data.from, data.size);
      if (error) return { ok: false, error: error.message };
      return { ok: true, rows: rows as Row[] };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** A dataset shared with the caller, as its grant lets them see it. */
export const readSharedDataset = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, table_id: uuid }).parse(v))
  .handler(async ({ data }): Promise<{ ok: true; rows: Row[] } | { ok: false; error: string }> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return { ok: false, error: user.error };
    try {
      const table = await datasetFor(data.table_id);
      if (!table) return { ok: false, error: "Dataset not found" };
      const own = table.user_id === user || table.is_sample;
      if (!own) {
        // Before the read, not after it: with no grant the answer is nothing,
        // and nobody should be able to make the server page through a table
        // they cannot see in order to hear that.
        const { readApplicableGrants } = await import("@/utils/iam.server");
        const grants = await readApplicableGrants(supabaseAdmin, user, "data_table", [
          data.table_id,
        ]);
        if (grants.length === 0) return { ok: true, rows: [] };
      }
      const { scanDatasetRows } = await import("@/utils/data/datasetRows.server");
      const scan = await scanDatasetRows(data.table_id, SHARED_READ_MAX);
      // A prefix would look like the whole table to everything downstream.
      if (scan.truncated) return { ok: false, error: "This shared dataset is too large to read" };
      if (own) return { ok: true, rows: scan.rows as Row[] };
      const { restrictSharedDataset } = await import("@/utils/data/sharedDatasets.server");
      const columns = (Array.isArray(table.columns) ? table.columns : []) as never[];
      const seen = await restrictSharedDataset(
        supabaseAdmin,
        data.table_id,
        user,
        columns,
        scan.rows,
      );
      return { ok: true, rows: seen.rows as Row[] };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** Add a batch of rows to a dataset the caller owns. */
export const writeDatasetBatch = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({
        access_token: token,
        table_id: uuid,
        rows: z.array(z.record(z.string(), z.unknown())).max(500),
      })
      .parse(v),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return { ok: false, error: user.error };
    try {
      const table = await datasetFor(data.table_id);
      if (!table || table.user_id !== user) return { ok: false, error: "Dataset not found" };
      const { insertDatasetRows } = await import("@/utils/data/datasetRows.server");
      const { error } = await insertDatasetRows(data.table_id, user, data.rows);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
