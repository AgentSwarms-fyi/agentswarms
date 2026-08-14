// Server functions for sharing an AI analyst with IAM groups.
//
// Analyst CRUD happens client-side under RLS. These use the service role for
// the one thing RLS cannot express: an analyst OWNER granting or revoking
// group access, when grant writes are otherwise superadmin-only. Ownership is
// verified here, server-side, on every call — the access token is the only
// thing trusted from the caller.
//
// What a grant conveys is deliberately narrow (see the 20260826000000
// migration): the right to OPEN and USE the analyst. Every query a recipient
// then runs is authorised as them.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { describeBlockedShare, groupAllowsModel, groupsBlocked } from "@/lib/analystSharing";
import { isModelAllowed } from "@/utils/iam.server";
import { parseModelChoice } from "@/utils/providers/modelChoice";

async function requireUserId(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

/** The analyst's owner and pinned model, or a throw. */
async function requireAnalystOwner(
  accessToken: string,
  analystId: string,
): Promise<{ userId: string; model: string }> {
  const userId = await requireUserId(accessToken);
  const { data, error } = await supabaseAdmin
    .from("ai_analysts")
    .select("id, user_id, model")
    .eq("id", analystId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Analyst not found");
  if (data.user_id !== userId) throw new Error("Only the owner can manage sharing");
  return { userId, model: data.model };
}

/**
 * Groups whose IAM model rules exclude the analyst's pinned model.
 *
 * A group with no rules of its own is unrestricted at group level (IAM is
 * default-allow at this layer), so it never blocks.
 */
async function blockedGroupNames(groupIds: string[], model: string): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const choice = parseModelChoice(model);
  if (!choice) return [];
  const [{ data: rules }, { data: groups }] = await Promise.all([
    supabaseAdmin
      .from("iam_model_rules")
      .select("principal_id, provider, model_pattern")
      .eq("principal_type", "group")
      .in("principal_id", groupIds),
    supabaseAdmin.from("iam_groups").select("id, name").in("id", groupIds),
  ]);
  const byGroup = new Map<string, { provider: string; model_pattern: string }[]>();
  for (const r of rules ?? []) {
    const list = byGroup.get(r.principal_id) ?? [];
    list.push({ provider: r.provider, model_pattern: r.model_pattern });
    byGroup.set(r.principal_id, list);
  }
  const named = groupIds.map((id) => ({
    id,
    name: (groups ?? []).find((g) => g.id === id)?.name ?? id,
  }));
  return groupsBlocked(named, (gid) =>
    groupAllowsModel(byGroup.get(gid), () =>
      isModelAllowed(byGroup.get(gid)!, choice.provider, choice.model),
    ),
  );
}

export const analystGetShares = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), analyst_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; group_ids: string[] } | { ok: false; error: string }> => {
      try {
        await requireAnalystOwner(data.access_token, data.analyst_id);
        const { data: grants, error } = await supabaseAdmin
          .from("iam_resource_grants")
          .select("principal_type, principal_id")
          .eq("resource_type", "ai_analyst")
          .eq("resource_id", data.analyst_id);
        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          group_ids: (grants ?? [])
            .filter((g) => g.principal_type === "group")
            .map((g) => g.principal_id),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

/** Replace the set of groups this analyst is shared with (owner only). */
export const analystSetShares = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        analyst_id: z.string().uuid(),
        group_ids: z.array(z.string().uuid()).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { userId, model } = await requireAnalystOwner(data.access_token, data.analyst_id);
      const { data: existing, error } = await supabaseAdmin
        .from("iam_resource_grants")
        .select("id, principal_id")
        .eq("resource_type", "ai_analyst")
        .eq("resource_id", data.analyst_id)
        .eq("principal_type", "group");
      if (error) return { ok: false, error: error.message };

      const wanted = new Set(data.group_ids);
      const current = new Map((existing ?? []).map((g) => [g.principal_id, g.id]));
      const toDelete = [...current.entries()]
        .filter(([gid]) => !wanted.has(gid))
        .map(([, id]) => id);
      const toInsert = [...wanted].filter((gid) => !current.has(gid));

      // An analyst thinks with ONE model. Granting it to a group that may not
      // use that model yields an analyst they can open and never run, which
      // reads as a broken feature rather than a policy decision.
      if (toInsert.length > 0) {
        const refusal = describeBlockedShare(model, await blockedGroupNames(toInsert, model));
        if (refusal) return { ok: false, error: refusal };
      }

      if (toDelete.length > 0) {
        const { error: delErr } = await supabaseAdmin
          .from("iam_resource_grants")
          .delete()
          .in("id", toDelete);
        if (delErr) return { ok: false, error: delErr.message };
      }
      if (toInsert.length > 0) {
        const { error: insErr } = await supabaseAdmin.from("iam_resource_grants").insert(
          toInsert.map((gid) => ({
            resource_type: "ai_analyst",
            resource_id: data.analyst_id,
            principal_type: "group",
            principal_id: gid,
            created_by: userId,
          })),
        );
        if (insErr) return { ok: false, error: insErr.message };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Failed" };
    }
  });
