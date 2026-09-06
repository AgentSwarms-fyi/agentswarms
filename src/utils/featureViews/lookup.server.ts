/**
 * Reading features for a set of keys.
 *
 * Everything goes through `runLakehouseStatement`, which is not a detail: that
 * chokepoint is what applies the owner's schema access, rewrites row-level
 * policies into the query, caps the rows and writes the audit row. A feature
 * lookup that opened its own connection would be a way to read a table the
 * caller cannot read, which is exactly the sort of side door a serving path
 * accumulates if nobody says no once.
 *
 * It runs as the model's OWNER, like training and prediction do, because a
 * gateway key is not a person and the owner's grants are the only correct
 * authority behind an API call.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runLakehouseStatement } from "@/utils/lakehouse/core.server";
import {
  lookupSql,
  resolveRows,
  resolutionError,
  validateKeys,
  type FeatureKey,
  type FeatureView,
  type Resolution,
} from "@/lib/featureViews";

export type FeatureViewRow = FeatureView & {
  user_id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export async function loadFeatureView(id: string, userId: string): Promise<FeatureViewRow | null> {
  const { data } = await supabaseAdmin
    .from("feature_views")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as FeatureViewRow | null) ?? null;
}

export async function listFeatureViews(userId: string): Promise<FeatureViewRow[]> {
  const { data } = await supabaseAdmin
    .from("feature_views")
    .select("*")
    .eq("user_id", userId)
    .order("name");
  return (data ?? []) as FeatureViewRow[];
}

/**
 * Turn keys into feature rows.
 *
 * Returns the rows in the order the keys were given, so a caller scoring three
 * keys gets three predictions it can line up without guessing. A key that
 * matched nothing is left out and named in `missing` rather than filled with
 * nulls — a row of nulls scores perfectly happily and means nothing.
 */
export async function lookupFeatures(args: {
  view: FeatureView;
  keys: FeatureKey[];
  userId: string;
  via?: string;
}): Promise<{ ok: true; resolution: Resolution } | { ok: false; error: string }> {
  const invalid = validateKeys(args.view, args.keys);
  if (invalid) return { ok: false, error: invalid };

  let result;
  try {
    result = await runLakehouseStatement(args.userId, lookupSql(args.view, args.keys), {
      // One row per key, plus the one extra the SQL asks for so a duplicate
      // key is visible rather than silently resolved.
      rowCap: args.keys.length + 1,
      auditVia: args.via ?? "feature-lookup",
      // Features change; a cached answer is the one thing a feature store
      // must not serve.
      useCache: false,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // The chokepoint returns positional rows; name them before anything else
  // touches them.
  const names = result.columns.map((c) => c.name);
  const rows = (result.rows as unknown[][]).map((r) => {
    const row: Record<string, unknown> = {};
    names.forEach((n, i) => (row[n] = r[i]));
    return row;
  });

  const resolution = resolveRows(args.view, args.keys, rows);
  const error = resolutionError(args.view, resolution);
  if (error) return { ok: false, error };
  return { ok: true, resolution };
}

/**
 * Check a view against the table it names, before it is saved.
 *
 * A view whose key column does not exist produces a lookup that fails at the
 * worst moment — behind a live prediction — so it is checked once, here, with
 * the columns reported by the table itself.
 */
export async function describeViewTable(
  userId: string,
  schema: string,
  table: string,
): Promise<{ ok: true; columns: { name: string; type: string }[] } | { ok: false; error: string }> {
  try {
    const { qi } = await import("@/lib/featureViews");
    const res = await runLakehouseStatement(
      userId,
      `SELECT * FROM ${qi(schema)}.${qi(table)} LIMIT 0`,
      {
        rowCap: 1,
        auditVia: "feature-view-check",
        useCache: false,
      },
    );
    return { ok: true, columns: res.columns };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
