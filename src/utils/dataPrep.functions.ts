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
  engine: "local" | "warehouse";
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
  .inputValidator((input: unknown) => RunSchema.parse(input))
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
  .inputValidator((input: unknown) =>
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
          engine: "local" | "warehouse";
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

export type DatasetDependents = {
  /** Flows that READ this dataset (base, join, or append source). */
  flowsUsing: { id: string; name: string }[];
  /** Flows whose OUTPUT is this dataset — deleting it breaks their refresh. */
  flowsProducing: { id: string; name: string }[];
  semanticModels: { id: string; name: string }[];
  /** Dashboards whose widget SQL mentions the table name. */
  dashboards: { id: string; name: string }[];
  savedMetrics: number;
};

/** Word-boundary match so "orders" doesn't match "orders_archive". */
function mentionsTable(sql: string, table: string): boolean {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`, "i").test(sql);
}

/**
 * Everything that would break if this dataset were deleted.
 *
 * Deleting a dataset used to be a bare confirm() — flows silently reset to
 * empty on next open, models and widgets started erroring with no explanation.
 * Enterprise tools show impact before a destructive change; this is that.
 * Runs under the caller's JWT, so RLS already limits it to their own objects.
 */
export const datasetDependents = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
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
    const name = table.name;

    const [{ data: flows }, { data: models }, { data: dashboards }, { count: metricCount }] =
      await Promise.all([
        sb.from("user_prep_flows").select("id, name, config, output_table_id"),
        sb.from("semantic_models").select("id, name, source_table, source_kind"),
        sb.from("bi_dashboards").select("id, name, widgets"),
        sb
          .from("user_saved_metrics")
          .select("id", { head: true, count: "exact" })
          .eq("table_id", data.tableId),
      ]);

    const flowsUsing: { id: string; name: string }[] = [];
    const flowsProducing: { id: string; name: string }[] = [];
    for (const f of flows ?? []) {
      if (f.output_table_id === data.tableId) {
        flowsProducing.push({ id: f.id, name: f.name });
        continue;
      }
      // The config holds base/joins/append-step table names.
      const cfg = f.config as { base?: string; joins?: { table?: string }[]; steps?: unknown[] };
      const names = new Set<string>();
      if (typeof cfg?.base === "string") names.add(cfg.base);
      for (const j of cfg?.joins ?? []) if (j?.table) names.add(j.table);
      for (const s of (cfg?.steps ?? []) as { kind?: string; table?: string }[]) {
        if (s?.kind === "append" && s.table) names.add(s.table);
      }
      if (names.has(name)) flowsUsing.push({ id: f.id, name: f.name });
    }

    const semanticModels = (models ?? [])
      .filter((m) => m.source_kind === "data_table" && m.source_table === name)
      .map((m) => ({ id: m.id, name: m.name }));

    const dashboardsUsing: { id: string; name: string }[] = [];
    for (const d of dashboards ?? []) {
      const widgets = Array.isArray(d.widgets) ? d.widgets : [];
      const hit = (widgets as { sql?: string; source?: { kind?: string } }[]).some(
        (w) => typeof w?.sql === "string" && mentionsTable(w.sql, name),
      );
      if (hit) dashboardsUsing.push({ id: d.id, name: d.name });
    }

    return {
      tableName: name,
      flowsUsing,
      flowsProducing,
      semanticModels,
      dashboards: dashboardsUsing,
      savedMetrics: metricCount ?? 0,
    };
  });
