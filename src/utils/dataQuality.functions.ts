// Server functions for data quality tests and dataset version history.
//
// IMPORTANT: this module is imported by client routes — only createServerFn
// handlers live here; the evaluators and service-role writes are imported
// inside handlers so they never reach the browser bundle.
//
// Reading and editing TESTS goes through plain RLS-scoped Supabase queries in
// the browser (lib/dataQuality). Everything here needs something the browser
// must not have: full row volumes, writes to result/version tables the owner
// may only read, and notification delivery.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import type { QualityRollup, QualityStatus } from "@/lib/dataQualityCore";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return { sb, userId: data.user.id };
}

// ── Run tests ─────────────────────────────────────────────────────────────

export type QualityRunOutcome =
  | {
      ok: true;
      tableId: string;
      tableName: string;
      rollup: QualityRollup;
      results: {
        testId: string;
        status: QualityStatus;
        failingRows: number;
        totalRows: number;
        detail: string;
      }[];
    }
  | { ok: false; error: string };

export const runQualityTests = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), tableId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<QualityRunOutcome> => {
    try {
      const { userId } = await requireUser(data.accessToken);
      const { runQualityTestsForTable } = await import("@/utils/bi/quality.server");
      // quiet: the user is watching the results appear, so an alert would be
      // noise. Scheduled runs are the ones worth notifying about.
      const run = await runQualityTestsForTable({ userId, tableId: data.tableId, quiet: true });
      return {
        ok: true,
        tableId: run.tableId,
        tableName: run.tableName,
        rollup: run.rollup,
        results: run.results.map(({ test, outcome }) => ({
          testId: test.id,
          status: outcome.status,
          failingRows: outcome.failingRows,
          totalRows: outcome.totalRows,
          detail: outcome.detail,
        })),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

// ── Version history ───────────────────────────────────────────────────────

export type DatasetVersionRow = {
  id: string;
  created_at: string;
  reason: string;
  row_count: number;
  column_count: number;
  rows_omitted: boolean;
  note: string | null;
};

export const listDatasetVersionsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), tableId: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; versions: DatasetVersionRow[]; cap: number } | { ok: false; error: string }
    > => {
      try {
        const { userId } = await requireUser(data.accessToken);
        const { listDatasetVersions, versionRowCap } = await import("@/utils/bi/versions.server");
        const versions = await listDatasetVersions(userId, data.tableId);
        return {
          ok: true,
          cap: versionRowCap(),
          versions: versions.map((v) => ({
            id: v.id,
            created_at: v.created_at,
            reason: v.reason,
            row_count: v.row_count,
            column_count: v.columns.length,
            rows_omitted: v.rows_omitted,
            note: v.note,
          })),
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

export const restoreDatasetVersionFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), versionId: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; tableId: string; tableName: string; rowCount: number }
      | { ok: false; error: string }
    > => {
      try {
        const { userId } = await requireUser(data.accessToken);
        const { restoreDatasetVersion } = await import("@/utils/bi/versions.server");
        const res = await restoreDatasetVersion({ userId, versionId: data.versionId });
        return { ok: true, ...res };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/**
 * Snapshot a dataset before the BROWSER overwrites it.
 *
 * Client-side saves (CSV re-upload, warehouse import, the in-browser prep
 * save) replace rows directly through RLS, so the only way they can be
 * versioned is to ask the server to copy the current contents first. Callers
 * treat a failure here as non-fatal — see saveDataset.
 */
export const snapshotDatasetFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        tableId: z.string().uuid(),
        reason: z.enum(["upload", "prep_run", "prep_refresh", "restore", "overwrite"]),
        note: z.string().max(300).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; versionId: string | null; rowsOmitted: boolean } | { ok: false; error: string }
    > => {
      try {
        const { userId } = await requireUser(data.accessToken);
        const { snapshotDataset } = await import("@/utils/bi/versions.server");
        const res = await snapshotDataset({
          userId,
          tableId: data.tableId,
          reason: data.reason,
          note: data.note,
        });
        return {
          ok: true,
          versionId: res?.versionId ?? null,
          rowsOmitted: res?.rowsOmitted ?? false,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
