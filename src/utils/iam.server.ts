// Shared IAM primitives for server code.
//
// - requireSuperadmin: validates a Supabase access token and checks the
//   DB-backed superadmin role. The ADMIN_EMAIL account is the permanent
//   bootstrap superadmin: it always passes, and its user_roles row is
//   self-healed on first use so it shows up in the IAM UI.
// - getEffectiveModelRules / isModelAllowed: model-governance semantics.
//   A user with zero applicable rules is unrestricted; otherwise their
//   allowed set is the union of their own rules and their groups' rules.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

export type SuperadminGuard =
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string };

function bootstrapAdminEmail(): string {
  return (process.env.ADMIN_EMAIL || import.meta.env.ADMIN_EMAIL || "").toLowerCase();
}

export async function requireSuperadmin(accessToken: string | undefined): Promise<SuperadminGuard> {
  if (!accessToken) return { ok: false, error: "Missing access token" };
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    const user = data.user;
    if (error || !user) {
      return { ok: false, error: error?.message ?? "Invalid session" };
    }
    const email = (user.email ?? "").toLowerCase();

    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "superadmin")
      .maybeSingle();
    if (roleRow) return { ok: true, userId: user.id, email };

    const bootstrap = bootstrapAdminEmail();
    if (bootstrap && email === bootstrap) {
      await supabaseAdmin
        .from("user_roles")
        .upsert(
          { user_id: user.id, role: "superadmin" },
          { onConflict: "user_id,role", ignoreDuplicates: true },
        );
      return { ok: true, userId: user.id, email };
    }

    return { ok: false, error: "Forbidden: superadmin access only" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to validate session",
    };
  }
}

/** True when the given user id is the env-bootstrapped ADMIN_EMAIL account. */
export async function isBootstrapAdmin(userId: string): Promise<boolean> {
  const bootstrap = bootstrapAdminEmail();
  if (!bootstrap) return false;
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
  return (data.user?.email ?? "").toLowerCase() === bootstrap;
}

export type ModelRule = { provider: string; model_pattern: string };

/**
 * Load the model rules that apply to a user, querying under the CALLER's
 * JWT-scoped client (RLS exposes exactly the applicable rules to regular
 * users). Returns null when the user is unrestricted.
 *
 * Note: for superadmin callers RLS returns every rule, so results are
 * re-filtered against the user's own id + group memberships here.
 */
export async function getEffectiveModelRules(
  sb: SupabaseClient<Database>,
  userId: string,
): Promise<ModelRule[] | null> {
  const [{ data: memberships }, { data: rules }] = await Promise.all([
    sb.from("iam_group_members").select("group_id").eq("user_id", userId),
    sb.from("iam_model_rules").select("principal_type, principal_id, provider, model_pattern"),
  ]);
  const groupIds = new Set((memberships ?? []).map((m) => m.group_id));
  const applicable = (rules ?? []).filter(
    (r) =>
      (r.principal_type === "user" && r.principal_id === userId) ||
      (r.principal_type === "group" && groupIds.has(r.principal_id)),
  );
  if (applicable.length === 0) return null;
  return applicable.map((r) => ({ provider: r.provider, model_pattern: r.model_pattern }));
}

export function isModelAllowed(rules: ModelRule[], provider: string, model: string): boolean {
  return rules.some((r) => {
    if (r.provider !== provider) return false;
    const p = r.model_pattern;
    if (p === "*" || p === model) return true;
    if (p.endsWith("*")) return model.startsWith(p.slice(0, -1));
    return false;
  });
}

// Resource ids of `resourceType` the user may read via an IAM grant — directly
// or through any group they belong to. Mirrors the `has_resource_access` RLS
// helper, computed explicitly for headless paths where RLS is bypassed (the
// caller passes a service-role client as `sb`). Grant tables are small, so we
// fetch and filter in JS (same approach as getEffectiveModelRules).
export async function resolveGrantedResourceIds(
  sb: SupabaseClient<Database>,
  userId: string,
  resourceType: "data_table" | "knowledge_base",
): Promise<Set<string>> {
  const [{ data: memberships }, { data: grants }] = await Promise.all([
    sb.from("iam_group_members").select("group_id").eq("user_id", userId),
    sb
      .from("iam_resource_grants")
      .select("principal_type, principal_id, resource_id")
      .eq("resource_type", resourceType),
  ]);
  const groupIds = new Set((memberships ?? []).map((m) => m.group_id));
  const ids = new Set<string>();
  for (const g of grants ?? []) {
    if (
      (g.principal_type === "user" && g.principal_id === userId) ||
      (g.principal_type === "group" && groupIds.has(g.principal_id))
    ) {
      ids.add(g.resource_id);
    }
  }
  return ids;
}
