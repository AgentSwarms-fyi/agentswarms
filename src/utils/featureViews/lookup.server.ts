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
  effectiveFeatureColumns,
  lookupSql,
  resolveRows,
  resolutionError,
  validateKeys,
  type FeatureKey,
  type FeatureView,
  type Resolution,
} from "@/lib/featureViews";
import { readOnline } from "@/utils/featureStore/online.server";

/** Where a lookup's rows came from, for the panel and for the logs. */
export type ServedFrom = "online" | "mixed" | "lakehouse";

/** The online columns live on the same row; the store reads them from it. */
type OnlineViewRow = FeatureView & {
  online_enabled?: boolean;
  online_max_staleness_minutes?: number | null;
};

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
  const view = (data as FeatureViewRow | null) ?? null;
  return view ? await repairFeatureColumns(view, userId) : null;
}

/**
 * Give a view saved with "all columns" the actual list, once.
 *
 * `feature_columns: []` means "every column that is not a key" on the table
 * and meant NOTHING in the code: lookupSql selects the key columns plus the
 * feature columns, so an empty list served a model the one column it was
 * looked up BY. Seen live on a view a trained model was already bound to —
 * `order_id=1000` came back as `order_id | 1000`, no features at all.
 *
 * Resolved from the table and written back rather than expanded on every read,
 * for the reason lookupSql is a column list in the first place: a column added
 * to the table later must not silently become a feature nobody trained on. It
 * also keeps the serving path free of a round trip.
 *
 * A failure here leaves the view exactly as it was. The lookup that follows is
 * then no better than it was before — and no worse, which is what matters on a
 * path a prediction is waiting behind.
 */
async function repairFeatureColumns(view: FeatureViewRow, userId: string): Promise<FeatureViewRow> {
  if (view.feature_columns.length > 0) return view;
  const described = await describeViewTable(userId, view.schema_name, view.table_name);
  if (!described.ok) {
    console.warn(`[features] ${view.name}: cannot resolve its columns — ${described.error}`);
    return view;
  }
  const resolved = effectiveFeatureColumns(
    view,
    described.columns.map((c) => c.name),
  );
  if (resolved.length === 0) return view;
  const { error } = await supabaseAdmin
    .from("feature_views")
    .update({ feature_columns: resolved })
    .eq("id", view.id)
    .eq("user_id", userId);
  if (error) {
    console.warn(`[features] ${view.name}: columns resolved but not saved — ${error.message}`);
  }
  return { ...view, feature_columns: resolved };
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
}): Promise<
  { ok: true; resolution: Resolution; servedFrom: ServedFrom } | { ok: false; error: string }
> {
  const invalid = validateKeys(args.view, args.keys);
  if (invalid) return { ok: false, error: invalid };

  // ── The online store first, when this view is served from one ────────────
  //
  // It answers in about 2 ms where the lakehouse answers in 130 at best, and
  // it is never authoritative: anything it does not hold, will not vouch for,
  // or cannot answer at all falls through to exactly the query that ran before
  // the store existed. A partly-populated store still saves the keys it has.
  const online = await readOnline(args.view as OnlineViewRow, args.keys);
  const fromStore = online?.rows ?? [];
  const wanted = online ? online.misses : args.keys;

  if (wanted.length === 0 && online) {
    const resolution = resolveRows(args.view, args.keys, fromStore);
    const error = resolutionError(args.view, resolution);
    if (error) return { ok: false, error };
    return { ok: true, resolution, servedFrom: "online" };
  }

  let result;
  try {
    result = await runLakehouseStatement(args.userId, lookupSql(args.view, wanted), {
      // One row per key, plus the one extra the SQL asks for so a duplicate
      // key is visible rather than silently resolved. Counted on the keys
      // ACTUALLY being read: with a warm store that is the handful the store
      // did not hold, not everything the caller asked for.
      rowCap: wanted.length + 1,
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

  // Both halves are matched together: resolveRows pairs rows to keys by
  // fingerprint rather than by order, so it does not care which of them came
  // from where.
  const resolution = resolveRows(args.view, args.keys, [...fromStore, ...rows]);
  const error = resolutionError(args.view, resolution);
  if (error) return { ok: false, error };
  return { ok: true, resolution, servedFrom: online ? "mixed" : "lakehouse" };
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
