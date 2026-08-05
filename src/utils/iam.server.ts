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

/**
 * May this account claim the ADMIN_EMAIL bootstrap superadmin role?
 *
 * The bootstrap grant is permanent and irrevocable — iamRevokeSuperadmin
 * refuses to demote it — so it is worth being exact about who gets it.
 *
 * THE ADDRESS IS A CLAIM, NOT A CREDENTIAL. A fresh deploy has
 * `allow_public_signup` defaulting to true (20260720000000_iam.sql), and
 * DEPLOYMENT.md tells the operator to sign up with ADMIN_EMAIL *after*
 * deploying and enable invite-only *after* that. Until they do, the address is
 * unclaimed, and whoever registers it first is handed permanent superadmin over
 * the instance. Guessing "admin@<their-domain>" is not a high bar.
 *
 * Requiring a CONFIRMED email closes that when the Supabase project verifies
 * addresses: an attacker who does not control the mailbox never confirms, so
 * never claims it.
 *
 * IT DOES NOT CLOSE IT UNDER AUTOCONFIRM. With email confirmations disabled
 * (the Supabase local-dev default) Supabase stamps email_confirmed_at at signup
 * for everyone, so this check passes for an attacker too — and there is no
 * server-side way to tell them from the operator, because the two present
 * exactly the same evidence: possession of a string. That configuration needs
 * confirmations turned on, which is why the docs now say so rather than this
 * function pretending to have solved it.
 */
export function bootstrapClaimAllowed(opts: {
  email: string;
  bootstrapEmail: string;
  emailConfirmedAt: string | null | undefined;
}): boolean {
  const bootstrap = opts.bootstrapEmail.trim().toLowerCase();
  // No ADMIN_EMAIL configured means there is no bootstrap account, not that
  // every account is one.
  if (!bootstrap) return false;
  if (opts.email.trim().toLowerCase() !== bootstrap) return false;
  return Boolean(opts.emailConfirmedAt);
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
    if (
      bootstrapClaimAllowed({
        email,
        bootstrapEmail: bootstrap,
        emailConfirmedAt: (user as { email_confirmed_at?: string | null }).email_confirmed_at,
      })
    ) {
      await supabaseAdmin
        .from("user_roles")
        .upsert(
          { user_id: user.id, role: "superadmin" },
          { onConflict: "user_id,role", ignoreDuplicates: true },
        );
      return { ok: true, userId: user.id, email };
    }

    // Distinct message for the near-miss, so an operator whose ADMIN_EMAIL
    // account is unconfirmed is told what to do instead of staring at a
    // generic 403.
    if (bootstrap && email === bootstrap) {
      return {
        ok: false,
        error:
          "This is the ADMIN_EMAIL account, but its email address is not confirmed. " +
          "Confirm it and sign in again.",
      };
    }

    return { ok: false, error: "Forbidden: superadmin access only" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to validate session",
    };
  }
}

/**
 * True when the given user id is the env-bootstrapped ADMIN_EMAIL account.
 *
 * This is what makes the bootstrap account undemotable, so it uses the SAME
 * rule as the claim itself. Matching on the address alone would hand
 * demotion-immunity to an account that cannot actually use the bootstrap —
 * an unconfirmed squatter on the address would be both locked out and
 * unremovable, which is the worst of both.
 */
export async function isBootstrapAdmin(userId: string): Promise<boolean> {
  const bootstrap = bootstrapAdminEmail();
  if (!bootstrap) return false;
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
  return bootstrapClaimAllowed({
    email: data.user?.email ?? "",
    bootstrapEmail: bootstrap,
    emailConfirmedAt: (data.user as { email_confirmed_at?: string | null } | null)
      ?.email_confirmed_at,
  });
}

export type ModelRule = { provider: string; model_pattern: string };

/**
 * Load the model rules that apply to a user, querying under the CALLER's
 * JWT-scoped client (RLS exposes exactly the applicable rules to regular
 * users). Returns null when the user is unrestricted, and `[]` when the
 * instance policy denies by default and nothing grants this user access —
 * isModelAllowed fails closed on the empty list.
 *
 * The instance's model_access_default decides what "no applicable rules"
 * means (allow = historical unrestricted; deny = nothing until granted), and
 * superadmins bypass deny mode — collapseModelPolicy is the single shared
 * rule for this, used identically by the browser hook.
 *
 * Note: for superadmin callers RLS returns every rule, so results are
 * re-filtered against the user's own id + group memberships here.
 */
export async function getEffectiveModelRules(
  sb: SupabaseClient<Database>,
  userId: string,
): Promise<ModelRule[] | null> {
  const [{ data: memberships }, { data: rules }, { data: roles }, { data: settings }] =
    await Promise.all([
      sb.from("iam_group_members").select("group_id").eq("user_id", userId),
      sb.from("iam_model_rules").select("principal_type, principal_id, provider, model_pattern"),
      sb.from("user_roles").select("role").eq("user_id", userId),
      sb.from("iam_settings").select("model_access_default").eq("id", true).maybeSingle(),
    ]);
  const groupIds = new Set((memberships ?? []).map((m) => m.group_id));
  const applicable = (rules ?? []).filter(
    (r) =>
      (r.principal_type === "user" && r.principal_id === userId) ||
      (r.principal_type === "group" && groupIds.has(r.principal_id)),
  );
  // A missing settings row (pre-migration schema) reads as 'allow' — the
  // historical behaviour, which is also what the column defaults to.
  const mode = settings?.model_access_default === "deny" ? ("deny" as const) : ("allow" as const);
  return collapseModelPolicy({
    mode,
    isSuperadmin: (roles ?? []).some((r) => r.role === "superadmin"),
    applicable: applicable.map((r) => ({ provider: r.provider, model_pattern: r.model_pattern })),
  });
}

// Re-exported from the shared matcher so the server and the browser cannot
// disagree about who may call which model. See src/lib/iamRules.ts.
export { isModelAllowed } from "@/lib/iamRules";
import { collapseModelPolicy } from "@/lib/iamRules";

// Resource ids of `resourceType` the user may read via an IAM grant — directly
// or through any group they belong to. Mirrors the `has_resource_access` RLS
// helper, computed explicitly for headless paths where RLS is bypassed (the
// caller passes a service-role client as `sb`). Grant tables are small, so we
// fetch and filter in JS (same approach as getEffectiveModelRules).
export async function resolveGrantedResourceIds(
  sb: SupabaseClient<Database>,
  userId: string,
  resourceType:
    | "data_table"
    | "knowledge_base"
    | "semantic_model"
    | "integration"
    | "provider_credential"
    | "warehouse_connection"
    | "saas_connection",
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
