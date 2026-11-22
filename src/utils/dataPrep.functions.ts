// Server functions for data preparation: full-data flow execution and the
// dependency lookup that makes deleting a dataset safe.
//
// IMPORTANT: this module is imported by client routes — only createServerFn
// handlers live here; the engine (AlaSQL, service-role writes) is imported
// inside handlers so it never reaches the browser bundle.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { callerFailure } from "@/utils/callerLookup.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(
    url,
    key,
    withNulSafeFetch({
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Unauthorized"));
  return { sb, userId: data.user.id };
}

// ── Full-data flow execution ──────────────────────────────────────────────

export type PrepRunOutcome = {
  ok: true;
  tableId: string;
  tableName: string;
  rowCount: number;
  /** Source tables whose input was truncated by the per-table cap. */
  truncatedSources: string[];
  /** True when the RESULT exceeded the output cap (rows are incomplete). */
  outputCapped: boolean;
  producedRows: number;
  failures: Record<string, number>;
  /** Where the pipeline actually ran. */
  engine: "local" | "warehouse" | "lakehouse";
  /** Why it didn't fold into the warehouse (only when it could have). */
  foldSkipReason?: string;
};

const RunSchema = z.object({
  accessToken: z.string().min(1),
  flowId: z.string().uuid().nullable().optional(),
  flowName: z.string().min(1).max(120),
  outputName: z.string().min(1).max(120),
  /** PrepFlowConfig — validated by the prep compiler, not by zod. */
  config: z.record(z.string(), z.unknown()),
});

/**
 * Run a prep flow on the SERVER against the owner's full stored data and
 * materialise the result.
 *
 * The browser path could only ever see what fitted in browser memory and
 * capped the output at 5,000 rows — so a large source silently produced a
 * truncated dataset. This runs the same compiled SQL the scheduled refresh
 * runs, so both produce identical results.
 */
export const prepRunAndSave = createServerFn({ method: "POST" })
  .validator((input: unknown) => RunSchema.parse(input))
  .handler(async ({ data }): Promise<PrepRunOutcome | { ok: false; error: string }> => {
    try {
      const { userId } = await requireUser(data.accessToken);
      const { parsePrepConfig, safePrepTableName } = await import("@/lib/dataPrepCore");
      const { executePrepFlow, materialisePrepOutput, savePrepSemantics } =
        await import("@/utils/bi/prep.server");

      const cfg = parsePrepConfig(data.config as never);
      const result = await executePrepFlow(userId, cfg);
      if (result.rows.length === 0) {
        return { ok: false, error: "The flow produced no rows — nothing to save." };
      }

      const tableName = safePrepTableName(data.outputName);
      const saved = await materialisePrepOutput({
        userId,
        tableName,
        flowName: data.flowName,
        columns: result.columns,
        rows: result.rows,
      });
      await savePrepSemantics({
        userId,
        tableId: saved.tableId,
        flowName: data.flowName,
        cfg,
      });

      return {
        ok: true,
        tableId: saved.tableId,
        tableName: saved.name,
        rowCount: saved.rowCount,
        truncatedSources: result.truncatedSources,
        outputCapped: result.outputCapped,
        producedRows: result.producedRows,
        failures: result.failures,
        engine: result.engine,
        foldSkipReason: result.foldSkipReason,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Prep run failed" };
    }
  });

type PreviewCell = string | number | boolean | null;

/**
 * Preview a flow that reads LIVE warehouse tables.
 *
 * Local flows preview instantly in the browser engine; a linked flow has no
 * local rows, so its preview runs the same folded query the real run would —
 * just with a small row cap. Previewing through the identical path is the
 * point: what you see is what will be materialised.
 */
export const prepPreview = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        config: z.record(z.string(), z.unknown()),
        limit: z.number().int().min(1).max(5000).default(200),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          columns: string[];
          rows: Record<string, PreviewCell>[];
          engine: "local" | "warehouse" | "lakehouse";
          foldSkipReason?: string;
          sql: string;
        }
      | { ok: false; error: string }
    > => {
      try {
        const { userId } = await requireUser(data.accessToken);
        const { parsePrepConfig } = await import("@/lib/dataPrepCore");
        const { executePrepFlow } = await import("@/utils/bi/prep.server");
        const cfg = parsePrepConfig(data.config as never);
        const res = await executePrepFlow(userId, cfg, { rowLimit: data.limit });
        return {
          ok: true,
          columns: res.columns.map((c) => c.name),
          // Coerce to primitives — the server-fn serializer rejects `unknown`
          // (Dates and driver-specific objects arrive here).
          rows: res.rows.slice(0, data.limit).map((r) => {
            const out: Record<string, PreviewCell> = {};
            for (const [k, v] of Object.entries(r)) {
              out[k] =
                v === null ||
                typeof v === "string" ||
                typeof v === "number" ||
                typeof v === "boolean"
                  ? v
                  : v === undefined
                    ? null
                    : String(v);
            }
            return out;
          }),
          engine: res.engine,
          foldSkipReason: res.foldSkipReason,
          sql: res.sql,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Preview failed" };
      }
    },
  );

// ── Dependency lookup (safe deletion) ─────────────────────────────────────

export type { DatasetDependents } from "@/lib/datasetDependents";
import type { DatasetDependents } from "@/lib/datasetDependents";

/**
 * Everything that would break if this dataset were deleted.
 *
 * Deleting a dataset used to be a bare confirm() — flows silently reset to
 * empty on next open, models and widgets started erroring with no explanation.
 * Enterprise tools show impact before a destructive change; this is that.
 * Runs under the caller's JWT, so RLS already limits it to their own objects.
 */
export const datasetDependents = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), tableId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<DatasetDependents & { tableName: string }> => {
    const { sb } = await requireUser(data.accessToken);
    const { data: table } = await sb
      .from("user_data_tables")
      .select("id, name")
      .eq("id", data.tableId)
      .maybeSingle();
    if (!table) throw new Error("Dataset not found");
    // The same lookup the dataset's page reads (R519), so what deleting it
    // breaks and what its page says uses it cannot disagree.
    const { computeDatasetDependents } = await import("@/utils/data/datasetDependents.server");
    return {
      tableName: table.name,
      ...(await computeDatasetDependents(sb, data.tableId, table.name)),
    };
  });

// ── Lakehouse sources and outputs ────────────────────────────────────────────

/** The lakehouse tables the caller may link, and the schemas they may write into. */
export const prepLakehouseTables = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { userId } = await requireUser(data.accessToken);
    const { listLakehouseTablesForUser } = await import("@/utils/lakehouse/tables.server");
    return listLakehouseTablesForUser(userId);
  });

const LakeRunSchema = z.object({
  accessToken: z.string().min(1),
  flowName: z.string().min(1).max(120),
  /** PrepFlowConfig — validated by the prep compiler, not by zod. */
  config: z.record(z.string(), z.unknown()),
  schema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  table: z.string().regex(/^[a-z_][a-z0-9_]{0,127}$/),
});

export type PrepLakehouseRunOutcome = {
  ok: true;
  matviewId: string;
  tableName: string;
  rowCount: number | null;
  sql: string;
};

/**
 * Materialise a flow whose every source is a lakehouse table AS a lakehouse
 * table: the compiled recipe becomes a materialized view (one atomic
 * CREATE OR REPLACE TABLE AS, refreshable on the flow's schedule) in a schema
 * the caller owns. No row travels through the app, so the dataset row caps do
 * not apply; the ML wizard, agents and dashboards see the table at once.
 */
export const prepRunToLakehouse = createServerFn({ method: "POST" })
  .validator((input: unknown) => LakeRunSchema.parse(input))
  .handler(async ({ data }): Promise<PrepLakehouseRunOutcome | { ok: false; error: string }> => {
    try {
      const { userId } = await requireUser(data.accessToken);
      const { parsePrepConfig, prepLakehouseBinding, validatePrepConfig } =
        await import("@/lib/dataPrepCore");
      const { lakehousePrepSql } = await import("@/utils/bi/prep.server");
      const { saveMatviewForUser } = await import("@/utils/lakehouse/matviews.server");
      const cfg = parsePrepConfig(data.config as never);
      const valid = validatePrepConfig(cfg);
      if (!valid.ok) return { ok: false, error: valid.error };
      const lake = prepLakehouseBinding(cfg);
      if (!lake) {
        return {
          ok: false,
          error:
            "Saving to the lakehouse needs every source table to be a linked lakehouse table; local datasets and warehouse tables are saved as datasets.",
        };
      }
      const sql = lakehousePrepSql(cfg, lake);
      const saved = await saveMatviewForUser(
        userId,
        { schema: data.schema, table: data.table, sql, schedule: "manual" },
        "prep",
      );
      if (saved.error) return { ok: false, error: saved.error };
      return {
        ok: true,
        matviewId: saved.id,
        tableName: `${data.schema}.${data.table}`,
        rowCount: saved.rows,
        sql,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Lakehouse run failed" };
    }
  });
