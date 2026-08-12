// Loads the access policy a user holds on shared semantic models.
//
// Grants live in iam_resource_grants, which client JWTs cannot read (that
// table is admin-managed), so the lookup runs on the service role and scopes
// EXPLICITLY to the user + their groups — the same pattern the BI dashboard
// direct-query route uses. The pure merge/enforce logic lives in
// lib/semanticPolicy; this file only fetches.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  applicableGrants,
  policyFromGrants,
  type SemanticAccessPolicy,
} from "@/lib/semanticPolicy";

/**
 * Policies for `userId` on each of `modelIds`, batched (one groups query, one
 * grants query — the agent catalog calls this once per prompt).
 *
 * A model id maps to a policy ONLY when at least one grant applies to the
 * user. No applicable grant means the user reached the model another way
 * (owner, or an admin surface) and no share-level restriction exists.
 */
export async function semanticPoliciesFor(
  userId: string,
  modelIds: string[],
): Promise<Map<string, SemanticAccessPolicy>> {
  const out = new Map<string, SemanticAccessPolicy>();
  if (modelIds.length === 0) return out;

  const { data: gm } = await supabaseAdmin
    .from("iam_group_members")
    .select("group_id")
    .eq("user_id", userId);
  const groupIds = (gm ?? []).map((g) => g.group_id as string);

  const { data: grants, error } = await supabaseAdmin
    .from("iam_resource_grants")
    .select("resource_id, principal_type, principal_id, row_filter, column_mask")
    .eq("resource_type", "semantic_model")
    .in("resource_id", modelIds);
  if (error) {
    // FAIL CLOSED: if the grants cannot be read, a shared model must not run
    // unrestricted. Callers treat a thrown error as "refuse the query".
    throw new Error(`Could not load access grants: ${error.message}`);
  }

  for (const id of new Set(modelIds)) {
    const forModel = (grants ?? []).filter((g) => g.resource_id === id);
    const mine = applicableGrants(forModel, userId, groupIds);
    if (mine.length > 0) out.set(id, policyFromGrants(mine));
  }
  return out;
}

/** Single-model convenience for the query path. */
export async function semanticPolicyFor(
  userId: string,
  modelId: string,
): Promise<SemanticAccessPolicy | null> {
  const map = await semanticPoliciesFor(userId, [modelId]);
  return map.get(modelId) ?? null;
}
