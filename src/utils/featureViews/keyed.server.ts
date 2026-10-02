// Which of a set of models can be scored by KEY, and by which columns.
//
// A model bound to a feature view is scored by naming a row (`keys`) rather
// than sending its feature values (`rows`): the platform reads the features
// from the table training read, so the caller has nothing to compute and
// nothing to get subtly wrong. The agent tools need to know this per model —
// to tell the agent which models take keys, and what a key looks like.
//
// Read as the platform, not as the caller, on purpose. A model shared through
// IAM is scored by its grantee, but the view (and the table it reads) belong
// to the model's OWNER; the REST route loads the view by the owner's id for
// the same reason. Only the view's name and key columns leave this function —
// nothing a grantee could not learn by scoring the model once.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type KeyedView = { id: string; name: string; key_columns: string[] };

/** Model id → its feature view, for every model that has one. */
export async function keyedModelViews(
  models: Array<{ id: string; feature_view_id: string | null }>,
): Promise<Map<string, KeyedView>> {
  const out = new Map<string, KeyedView>();
  const bound = models.filter((m) => m.feature_view_id);
  if (!bound.length) return out;
  const { data } = await supabaseAdmin
    .from("feature_views")
    .select("id, name, key_columns")
    .in("id", [...new Set(bound.map((m) => m.feature_view_id as string))]);
  const byId = new Map((data ?? []).map((v) => [v.id, v as KeyedView]));
  for (const m of bound) {
    const view = byId.get(m.feature_view_id as string);
    if (view) out.set(m.id, view);
  }
  return out;
}
