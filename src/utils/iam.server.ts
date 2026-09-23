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

    const { data: roleRow, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "superadmin")
      .maybeSingle();
    // A failed read is not "no role": answered that way it fell through to the
    // bootstrap claim below, which writes.
    if (roleErr) return { ok: false, error: `could not read roles: ${roleErr.message}` };
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
  const [membershipsRes, rulesRes, rolesRes, settingsRes] = await Promise.all([
    sb.from("iam_group_members").select("group_id").eq("user_id", userId),
    sb.from("iam_model_rules").select("principal_type, principal_id, provider, model_pattern"),
    sb.from("user_roles").select("role").eq("user_id", userId),
    sb.from("iam_settings").select("model_access_default").eq("id", true).maybeSingle(),
  ]);
  // A failed read of the policy is not "no policy". Each of these used to drop
  // its error: settings unreadable became allow mode, memberships unreadable
  // dropped every group rule, and under allow mode both collapse to null —
  // unrestricted. A policy that cannot be read fails CLOSED: every caller
  // answers the model call with an error rather than making it.
  const failed = [membershipsRes.error, rulesRes.error, rolesRes.error, settingsRes.error].find(
    (e) => e !== null && e !== undefined,
  );
  if (failed) throw new Error(`could not read model access policy: ${failed.message}`);
  const memberships = membershipsRes.data;
  const rules = rulesRes.data;
  const roles = rolesRes.data;
  const settings = settingsRes.data;
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

/**
 * The sentence a model call is refused with, or null when the user's model
 * rules allow it. Throws when the policy cannot be read, as
 * getEffectiveModelRules does: a caller that cannot tell must not call.
 *
 * FOUND FROM THE SURVEY (R97). The rules are enforced at /api/chat, and the
 * features that go through it are covered. Five did not go through it: the
 * ETL, lakehouse and skill code generators, the knowledge-graph builder and
 * embedded BI's analyst each called a provider directly and asked nothing.
 * The generators' own header said governance "applies through the same
 * picker" — the dropdown — and the dropdown starts unset, so a plain
 * Generate click fell back to openai/gpt-4o-mini whatever the rules said.
 * Read with the service role and filtered to this user and their groups,
 * exactly as /api/chat's internal channel reads them.
 */
export async function modelAccessRefusal(
  userId: string,
  provider: string,
  model: string,
): Promise<string | null> {
  const rules = await getEffectiveModelRules(supabaseAdmin, userId);
  if (rules && !isModelAllowedShared(rules, provider, model)) {
    return `Your administrator has not allowed ${provider}/${model} for your account. Ask a superadmin to adjust your model access.`;
  }
  return null;
}
import { collapseModelPolicy, isModelAllowed as isModelAllowedShared } from "@/lib/iamRules";

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
    | "saas_connection"
    | "ml_model",
): Promise<Set<string>> {
  const [membershipsRes, grantsRes] = await Promise.all([
    sb.from("iam_group_members").select("group_id").eq("user_id", userId),
    sb
      .from("iam_resource_grants")
      .select("principal_type, principal_id, resource_id")
      .eq("resource_type", resourceType),
  ]);
  // A failed read is not an empty grant list: answered that way, everything
  // shared with this user vanished from every listing that asks, silently.
  const failed = membershipsRes.error ?? grantsRes.error;
  if (failed) throw new Error(`could not read resource grants: ${failed.message}`);
  const memberships = membershipsRes.data;
  const grants = grantsRes.data;
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
