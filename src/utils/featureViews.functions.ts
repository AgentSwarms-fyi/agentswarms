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
import { validateView, type FeatureView } from "@/lib/featureViews";
import { loadModelForUser } from "@/utils/ml/access.server";
import {
  describeViewTable,
  listFeatureViews,
  loadFeatureView,
  lookupFeatures,
  type FeatureViewRow,
} from "@/utils/featureViews/lookup.server";

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
      return { ok: true, views, tables, usedBy };
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

    const patch = {
      ...candidate,
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
