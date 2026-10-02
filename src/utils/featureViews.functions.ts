// Server functions behind ML Models → Feature views: define a view over a
// table, check it against that table, and attach it to a model.
//
// A view is owner-only in every direction. It names a table the owner can
// read, and every lookup re-checks that as the owner, so a view cannot become
// a way to read something its author lost access to.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { effectiveFeatureColumns, validateView, type FeatureView } from "@/lib/featureViews";
import {
  dropView,
  onlineSummary,
  recordRefresh,
  refreshView,
} from "@/utils/featureStore/online.server";
import { loadModelForUser } from "@/utils/ml/access.server";
import {
  describeViewTable,
  listFeatureViews,
  loadFeatureView,
  lookupFeatures,
  type FeatureViewRow,
} from "@/utils/featureViews/lookup.server";
import type { TrainingSetResult } from "@/utils/featureViews/trainingSet.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

const COLUMN = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

export const featureViewsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          views: FeatureViewRow[];
          /** Lakehouse tables the caller can read, to pick a source from. */
          tables: { schema: string; table: string; columns: { name: string; type: string }[] }[];
          /** Which models already serve from which view. */
          usedBy: Record<string, string[]>;
          /** What the online store holds for each view, by view id. */
          online: Record<string, Awaited<ReturnType<typeof onlineSummary>>>;
        }
    > => {
      const userId = await resolveCaller(data.accessToken);
      const views = await listFeatureViews(userId);

      const { listLakehouseTablesForUser } = await import("@/utils/lakehouse/tables.server");
      const src = await listLakehouseTablesForUser(userId);
      const tables = (src.tables ?? []).map((t) => ({
        schema: t.schema,
        table: t.table,
        columns: t.columns,
      }));

      const { data: models } = await supabaseAdmin
        .from("ml_models")
        .select("name, feature_view_id")
        .eq("user_id", userId)
        .not("feature_view_id", "is", null);
      const usedBy: Record<string, string[]> = {};
      for (const m of models ?? []) {
        const id = m.feature_view_id as string;
        usedBy[id] = [...(usedBy[id] ?? []), m.name];
      }
      const online: Record<string, Awaited<ReturnType<typeof onlineSummary>>> = {};
      for (const v of views) online[v.id] = await onlineSummary(v);
      return { ok: true, views, tables, usedBy, online };
    },
  );

/**
 * Create or update a view, after checking it against the table it names.
 *
 * The check is the point. A view whose key column does not exist produces a
 * lookup that fails behind a live prediction, which is the worst place to find
 * out; it costs one `LIMIT 0` here to find out at save time instead.
 */
export const featureViewSave = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid().nullable().optional(),
        name: z.string().trim().min(1).max(63),
        description: z.string().trim().max(2000).nullable().optional(),
        schema_name: z.string().trim().min(1).max(200),
        table_name: z.string().trim().min(1).max(200),
        key_columns: z.array(COLUMN).min(1).max(8),
        feature_columns: z.array(COLUMN).max(500),
        timestamp_column: COLUMN.nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; id: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const candidate = {
      name: data.name,
      schema_name: data.schema_name,
      table_name: data.table_name,
      key_columns: data.key_columns,
      feature_columns: data.feature_columns,
      timestamp_column: data.timestamp_column ?? null,
    };
    const invalid = validateView(candidate);
    if (invalid) return { ok: false, error: invalid };

    const described = await describeViewTable(userId, data.schema_name, data.table_name);
    if (!described.ok) return { ok: false, error: described.error };
    const present = new Set(described.columns.map((c) => c.name));
    const missing = [
      ...data.key_columns,
      ...data.feature_columns,
      ...(data.timestamp_column ? [data.timestamp_column] : []),
    ].filter((c) => !present.has(c));
    if (missing.length) {
      return {
        ok: false,
        error: `${data.schema_name}.${data.table_name} has no column ${missing.slice(0, 4).join(", ")}`,
      };
    }

    // "ALL COLUMNS" BECOMES A LIST, HERE, ONCE.
    //
    // An empty feature_columns is documented on the table as "every column
    // that is not a key" and was implemented by nobody: lookupSql selects the
    // keys plus the features, so an empty list served a model the one column
    // it was looked up BY and nothing else. Resolving at save keeps the
    // promise that a column added to the table later cannot silently become a
    // feature nobody trained on, and keeps the serving path free of the round
    // trip that asking the table would cost.
    const resolved = effectiveFeatureColumns(
      candidate,
      described.columns.map((c) => c.name),
    );
    if (resolved.length === 0) {
      return {
        ok: false,
        error: `${data.schema_name}.${data.table_name} has no columns left to serve as features once ${data.key_columns.join(", ")} is the key`,
      };
    }

    const patch = {
      ...candidate,
      feature_columns: resolved,
      user_id: userId,
      description: data.description ?? null,
      updated_at: new Date().toISOString(),
    };
    const q = data.id
      ? supabaseAdmin.from("feature_views").update(patch).eq("id", data.id).eq("user_id", userId)
      : supabaseAdmin.from("feature_views").insert(patch);
    const { data: row, error } = await q.select("id").maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: "Feature view not found" };
    return { ok: true, id: row.id as string };
  });

export const featureViewDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; detachedFrom: string[] }> => {
    const userId = await resolveCaller(data.accessToken);
    // The stored copy goes with it. A view id is a uuid and will not be
    // reused, so leftover keys would simply occupy the store until their TTL
    // — but a store that holds rows for a view nobody can name is exactly the
    // sort of thing an operator finds at the worst moment.
    await dropView(data.id);
    // Say what stops working. The FK nulls the column either way; a model that
    // silently went back to needing whole rows is a surprise at the next call.
    const { data: models } = await supabaseAdmin
      .from("ml_models")
      .select("name")
      .eq("user_id", userId)
      .eq("feature_view_id", data.id);
    const { error } = await supabaseAdmin
      .from("feature_views")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true, detachedFrom: (models ?? []).map((m) => m.name) };
  });

/** Point a model at a view, or detach it. */
export const mlModelSetFeatureView = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        modelId: z.string().uuid(),
        featureViewId: z.string().uuid().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { model } = await loadModelForUser(data.modelId, userId, { write: true });
    if (!model) return { ok: false, error: "Model not found" };
    if (data.featureViewId) {
      const view = await loadFeatureView(data.featureViewId, userId);
      if (!view) return { ok: false, error: "Feature view not found" };
    }
    const { error } = await supabaseAdmin
      .from("ml_models")
      .update({ feature_view_id: data.featureViewId, updated_at: new Date().toISOString() })
      .eq("id", model.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

/** Read the features for one key, so an author can see what serving will see. */
export const featureViewPreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        key: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; row: Record<string, Json> | null }> => {
    const userId = await resolveCaller(data.accessToken);
    const view = await loadFeatureView(data.id, userId);
    if (!view) return { ok: false, error: "Feature view not found" };
    const res = await lookupFeatures({
      view: view as FeatureView,
      keys: [data.key],
      userId,
      via: "feature-view-preview",
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, row: (res.resolution.rows[0] ?? null) as Record<string, Json> | null };
  });

const NAME = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

/**
 * Build a point-in-time training set from a view and a table of labels.
 *
 * The one thing this must never do is join the latest feature row: that is
 * the answer people write by hand, and it teaches a model facts from after
 * the label it is predicting.
 */
export const featureViewBuildTrainingSet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        spine: z.object({
          schema_name: NAME,
          table_name: NAME,
          timestamp_column: COLUMN,
          key_columns: z.array(COLUMN).min(1).max(8),
          where: z.string().max(2000).optional().nullable(),
        }),
        output: z.object({ schema: NAME, table: NAME }),
        // Uncapped on purpose: how stale a feature may be is a property of the
        // data, not something the platform can guess.
        max_age_days: z.number().int().positive().optional().nullable(),
        keep_unmatched: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; result: TrainingSetResult }> => {
    const userId = await resolveCaller(data.accessToken);
    const view = await loadFeatureView(data.id, userId);
    if (!view) return { ok: false, error: "Feature view not found" };
    const { buildTrainingSet } = await import("@/utils/featureViews/trainingSet.server");
    const built = await buildTrainingSet({
      userId,
      view: view as FeatureView,
      spine: {
        schema_name: data.spine.schema_name,
        table_name: data.spine.table_name,
        timestamp_column: data.spine.timestamp_column,
        key_columns: data.spine.key_columns,
        where: data.spine.where ?? null,
      },
      output: data.output,
      plan: { maxAgeDays: data.max_age_days ?? null, keepUnmatched: data.keep_unmatched },
    });
    if (!built.ok) return { ok: false, error: built.error };
    return { ok: true, result: built.result };
  });

/**
 * Turn online serving on or off for a view, and set how stale it may be.
 *
 * Switching it OFF also drops what was stored. Leaving the rows behind would
 * mean a view turned back on later starts answering from whatever the table
 * looked like at some forgotten moment — and the meta would say it was fresh,
 * because the meta records when it was written, not when anybody last meant it.
 */
export const featureViewSetOnline = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        enabled: z.boolean(),
        staleMinutes: z.number().int().min(1).max(43200).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const view = await loadFeatureView(data.id, userId);
    if (!view) return { ok: false, error: "Feature view not found" };

    const { error } = await supabaseAdmin
      .from("feature_views")
      .update({
        online_enabled: data.enabled,
        online_max_staleness_minutes: data.staleMinutes ?? null,
        ...(data.enabled
          ? {}
          : { online_refreshed_at: null, online_rows: null, online_source_rows: null }),
      })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    if (!data.enabled) await dropView(data.id);
    return { ok: true };
  });

/**
 * Copy the view's current rows into the store.
 *
 * Synchronous on purpose. A refresh is the owner asking "make serving match
 * the table NOW", and an answer that says how many keys it wrote and how long
 * it took is worth more than a job id — the numbers are how they find out the
 * store holds only part of the view.
 */
export const featureViewRefreshOnline = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | { ok: true; rows: number; sourceRows: number | null; note: string | null; seconds: number }
    > => {
      const userId = await resolveCaller(data.accessToken);
      const view = await loadFeatureView(data.id, userId);
      if (!view) return { ok: false, error: "Feature view not found" };

      const result = await refreshView(view, userId);
      await recordRefresh(data.id, userId, result);
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        rows: result.rows,
        sourceRows: result.sourceRows,
        note: result.note,
        seconds: result.seconds,
      };
    },
  );
