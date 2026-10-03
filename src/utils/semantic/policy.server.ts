// Loads the access policy a user holds on shared semantic models.
//
// Grants live in iam_resource_grants, which client JWTs cannot read (that
// table is admin-managed), so the lookup runs on the service role and scopes
// EXPLICITLY to the user + their groups — the same pattern the BI dashboard
// direct-query route uses. The pure merge/enforce logic lives in
// lib/semanticPolicy; this file only fetches.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readApplicableGrants } from "@/utils/iam.server";
import {
  AttributeRefusalError,
  attributeKeysInGrants,
  policyFromGrants,
  resolveAttributeGrants,
  type SemanticAccessPolicy,
} from "@/lib/semanticPolicy";

/**
 * The caller's attribute values for `keys`, fetched only when a grant
 * actually references one. Explicitly user-scoped on the service role, like
 * the groups lookup above it. Exported: the BI dashboard and shared-dataset
 * grant surfaces resolve the same tokens through the same fetch — a second
 * private copy of this lookup is how one surface drifts from the others.
 */
export async function attributesFor(
  userId: string,
  keys: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (keys.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("iam_user_attributes")
    .select("key, attr_values")
    .eq("user_id", userId)
    .in("key", keys);
  if (error) {
    // FAIL CLOSED — an unreadable attribute store must refuse the query, not
    // run it unfiltered or silently empty.
    throw new AttributeRefusalError(`Could not load user attributes: ${error.message}`);
  }
  for (const row of data ?? []) {
    const vals = Array.isArray(row.attr_values)
      ? (row.attr_values as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    out.set(row.key as string, vals);
  }
  return out;
}

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

  // FAIL CLOSED, on BOTH reads. The grants read was already guarded here; the
  // membership read beside it was not, and it carries exactly as much. A
  // restriction granted to a GROUP applies only when the membership list can
  // be read, and when it could not, this returned no applicable grant for the
  // model — which the contract above reads as "no share-level restriction
  // exists". The viewer kept the access and lost its limits. R235.
  const mine = await readApplicableGrants(supabaseAdmin, userId, "semantic_model", modelIds);

  // Attribute tokens resolve per grant BEFORE the merge — one attributes
  // fetch covers every model in the batch.
  type FetchedGrant = (typeof mine)[number];
  const allMine = new Map<string, FetchedGrant[]>();
  for (const id of new Set(modelIds)) {
    allMine.set(
      id,
      mine.filter((g) => g.resource_id === id),
    );
  }
  const keys = attributeKeysInGrants([...allMine.values()].flat());
  const attrs = await attributesFor(userId, keys);

  for (const [id, mine] of allMine) {
    if (mine.length > 0) out.set(id, policyFromGrants(resolveAttributeGrants(mine, attrs)));
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
