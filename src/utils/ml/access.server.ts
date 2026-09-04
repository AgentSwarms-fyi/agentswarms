// Who may see and use an ML model.
//
// Ownership plus IAM grants ('ml_model'), computed explicitly with the
// service-role client because every caller here is a server function or a
// headless tool path where RLS does not apply. A share conveys the right to
// PREDICT with a model and read its metrics; training, promotion, renaming and
// deletion stay with the owner, and the `write` flag below is how a caller
// says which of the two it needs.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { resolveGrantedResourceIds } from "@/utils/iam.server";

export type MlModelRow = Database["public"]["Tables"]["ml_models"]["Row"];
export type MlVersionRow = Database["public"]["Tables"]["ml_model_versions"]["Row"];
export type MlJobRow = Database["public"]["Tables"]["ml_training_jobs"]["Row"];

/** Ids of the models this user may use: their own, and those shared with them. */
export async function accessibleModelIds(
  userId: string,
): Promise<{ own: Set<string>; shared: Set<string> }> {
  const [{ data: mine }, shared] = await Promise.all([
    supabaseAdmin.from("ml_models").select("id").eq("user_id", userId),
    resolveGrantedResourceIds(supabaseAdmin, userId, "ml_model"),
  ]);
  const own = new Set((mine ?? []).map((m) => m.id));
  for (const id of own) shared.delete(id);
  return { own, shared };
}

/**
 * Load one model the user may see. `write` demands ownership: a grantee who
 * tries to retrain or delete gets the same "not found" as a stranger, so the
 * error never confirms that a model exists.
 */
export async function loadModelForUser(
  modelId: string,
  userId: string,
  opts: { write?: boolean } = {},
): Promise<{ model: MlModelRow; shared: boolean }> {
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", modelId)
    .maybeSingle();
  if (!model) throw new Error("Model not found");
  if (model.user_id === userId) return { model, shared: false };
  if (opts.write) throw new Error("Model not found");
  const granted = await resolveGrantedResourceIds(supabaseAdmin, userId, "ml_model");
  if (!granted.has(model.id)) throw new Error("Model not found");
  return { model, shared: true };
}

/** Every model the user may see, newest first, flagged by how they got it. */
export async function listModelsForUser(
  userId: string,
): Promise<Array<MlModelRow & { shared: boolean }>> {
  const { own, shared } = await accessibleModelIds(userId);
  const ids = [...own, ...shared];
  if (!ids.length) return [];
  const { data } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .in("id", ids)
    .order("updated_at", { ascending: false });
  return (data ?? []).map((m) => ({ ...m, shared: !own.has(m.id) }));
}
