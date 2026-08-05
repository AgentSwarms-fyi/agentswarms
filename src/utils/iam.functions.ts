// Server functions backing the /admin/iam page.
// Every mutation/list here is superadmin-gated via requireSuperadmin();
// all reads/writes use the service-role client, so guards are mandatory.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { isBootstrapAdmin, requireSuperadmin } from "@/utils/iam.server";

// --- Shared types --------------------------------------------------------

export type IamError = { ok: false; error: string };

export type IamUserRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  banned: boolean;
  invite_pending: boolean;
  is_superadmin: boolean;
  group_ids: string[];
};

export type IamGroupRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  member_user_ids: string[];
};

export type IamModelRuleRow = {
  id: string;
  principal_type: "user" | "group";
  principal_id: string;
  provider: string;
  model_pattern: string;
};

export type IamGrantRow = {
  id: string;
  resource_type:
    | "knowledge_base"
    | "data_table"
    | "secret"
    | "bi_dashboard"
    | "semantic_model"
    | "catalog_source"
    | "integration"
    | "provider_credential"
    | "warehouse_connection"
    | "saas_connection";
  resource_id: string;
  resource_name: string | null; // null = resource was deleted
  resource_owner_id: string | null;
  principal_type: "user" | "group";
  principal_id: string;
  /** BI dashboards only: restrict the grantee to rows matching column ∈ values. */
  row_filter: { column: string; values: string[] } | null;
  /** BI dashboards only: columns hidden from the grantee. */
  column_mask: string[];
};

export type IamResourceOption = {
  resource_type:
    | "knowledge_base"
    | "data_table"
    | "secret"
    | "bi_dashboard"
    | "semantic_model"
    | "catalog_source"
    | "integration"
    | "provider_credential"
    | "warehouse_connection"
    | "saas_connection";
  id: string;
  name: string;
  owner_user_id: string | null;
};

const BAN_DURATION = "87600h"; // ~10 years; "none" lifts the ban.

// Supabase's admin user shape (subset we rely on; banned_until is present
// in the API response but missing from the published User type).
type AdminUser = {
  id: string;
  email?: string;
  created_at?: string;
  last_sign_in_at?: string;
  invited_at?: string;
  email_confirmed_at?: string;
  banned_until?: string;
};

async function listAllAuthUsers(): Promise<AdminUser[]> {
  const users: AdminUser[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 500 });
    if (error) throw new Error(error.message);
    users.push(...(data.users as unknown as AdminUser[]));
    if (data.users.length < 500) break;
  }
  return users;
}

function isBanned(u: AdminUser): boolean {
  return Boolean(u.banned_until && new Date(u.banned_until).getTime() > Date.now());
}

// --- Users ---------------------------------------------------------------

export const iamListUsers = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | { ok: true; users: IamUserRow[] }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const [authUsers, { data: profiles }, { data: roles }, { data: memberships }] =
      await Promise.all([
        listAllAuthUsers(),
        supabaseAdmin.from("profiles").select("user_id, display_name"),
        supabaseAdmin.from("user_roles").select("user_id, role"),
        supabaseAdmin.from("iam_group_members").select("user_id, group_id"),
      ]);

    const nameByUser = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));
    const superadmins = new Set(
      (roles ?? []).filter((r) => r.role === "superadmin").map((r) => r.user_id),
    );
    const groupsByUser = new Map<string, string[]>();
    for (const m of memberships ?? []) {
      const list = groupsByUser.get(m.user_id) ?? [];
      list.push(m.group_id);
      groupsByUser.set(m.user_id, list);
    }

    const users: IamUserRow[] = authUsers
      .map((u) => ({
        user_id: u.id,
        email: u.email ?? null,
        display_name: nameByUser.get(u.id) ?? null,
        created_at: u.created_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
        banned: isBanned(u),
        invite_pending: Boolean(u.invited_at && !u.last_sign_in_at),
        is_superadmin: superadmins.has(u.id),
        group_ids: groupsByUser.get(u.id) ?? [],
      }))
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

    return { ok: true, users };
  });

export const iamCreateUser = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        email: z.string().email(),
        // With a password the account is created directly (email pre-confirmed);
        // without one an invitation email is sent instead.
        password: z.string().min(8).optional(),
        display_name: z.string().max(120).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<IamError | { ok: true; user_id: string; invited: boolean }> => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return guard;

      if (data.password) {
        const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
          email: data.email,
          password: data.password,
          email_confirm: true,
          app_metadata: { provisioned_by: "admin" },
          user_metadata: data.display_name ? { full_name: data.display_name } : undefined,
        });
        if (error || !created.user) return { ok: false, error: error?.message ?? "Create failed" };
        auditEvent({
          userId: guard.userId,
          action: "iam.user.create",
          resourceType: "user",
          resourceId: created.user.id,
          resourceName: data.email,
          detail: { invited: false },
        });
        return { ok: true, user_id: created.user.id, invited: false };
      }

      const { data: invited, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        data.email,
        {
          data: data.display_name ? { full_name: data.display_name } : undefined,
        },
      );
      if (error || !invited.user) return { ok: false, error: error?.message ?? "Invite failed" };
      auditEvent({
        userId: guard.userId,
        action: "iam.user.create",
        resourceType: "user",
        resourceId: invited.user.id,
        resourceName: data.email,
        detail: { invited: true },
      });
      return { ok: true, user_id: invited.user.id, invited: true };
    },
  );

export const iamSetUserBan = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ access_token: z.string().min(1), user_id: z.string().uuid(), banned: z.boolean() })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    if (data.user_id === guard.userId) return { ok: false, error: "You cannot ban yourself" };

    if (data.banned) {
      const { data: role } = await supabaseAdmin
        .from("user_roles")
        .select("id")
        .eq("user_id", data.user_id)
        .eq("role", "superadmin")
        .maybeSingle();
      if (role) return { ok: false, error: "Demote this superadmin before banning them" };
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      ban_duration: data.banned ? BAN_DURATION : "none",
    });
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: data.banned ? "iam.user.ban" : "iam.user.unban",
      resourceType: "user",
      resourceId: data.user_id,
    });
    return { ok: true };
  });

export const iamDeleteUser = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), user_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    if (data.user_id === guard.userId) return { ok: false, error: "You cannot delete yourself" };

    const { data: role } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("user_id", data.user_id)
      .eq("role", "superadmin")
      .maybeSingle();
    if (role) return { ok: false, error: "Demote this superadmin before deleting them" };

    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.user.delete",
      resourceType: "user",
      resourceId: data.user_id,
    });
    return { ok: true };
  });

// --- Superadmin role -----------------------------------------------------

export const iamGrantSuperadmin = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), user_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("user_roles")
      .upsert(
        { user_id: data.user_id, role: "superadmin", created_by: guard.userId },
        { onConflict: "user_id,role", ignoreDuplicates: true },
      );
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.role.grant_superadmin",
      resourceType: "user",
      resourceId: data.user_id,
    });
    return { ok: true };
  });

export const iamRevokeSuperadmin = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), user_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    if (await isBootstrapAdmin(data.user_id)) {
      return {
        ok: false,
        error: "This account is the ADMIN_EMAIL bootstrap superadmin and cannot be demoted",
      };
    }

    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("id", { count: "exact", head: true })
      .eq("role", "superadmin");
    if ((count ?? 0) <= 1) {
      return { ok: false, error: "Cannot demote the last superadmin" };
    }

    const { error } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.user_id)
      .eq("role", "superadmin");
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.role.revoke_superadmin",
      resourceType: "user",
      resourceId: data.user_id,
    });
    return { ok: true };
  });

// --- Groups --------------------------------------------------------------

export const iamListGroups = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | { ok: true; groups: IamGroupRow[] }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const [{ data: groups, error }, { data: memberships }] = await Promise.all([
      supabaseAdmin
        .from("iam_groups")
        .select("id, name, description, created_at")
        .order("name", { ascending: true }),
      supabaseAdmin.from("iam_group_members").select("group_id, user_id"),
    ]);
    if (error) return { ok: false, error: error.message };

    const membersByGroup = new Map<string, string[]>();
    for (const m of memberships ?? []) {
      const list = membersByGroup.get(m.group_id) ?? [];
      list.push(m.user_id);
      membersByGroup.set(m.group_id, list);
    }

    return {
      ok: true,
      groups: (groups ?? []).map((g) => ({
        ...g,
        member_user_ids: membersByGroup.get(g.id) ?? [],
      })),
    };
  });

export const iamCreateGroup = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: z.string().min(1).max(80),
        description: z.string().max(400).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true; group_id: string }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { data: row, error } = await supabaseAdmin
      .from("iam_groups")
      .insert({
        name: data.name.trim(),
        description: data.description?.trim() || null,
        created_by: guard.userId,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.group.create",
      resourceType: "iam_group",
      resourceId: row.id,
      resourceName: data.name,
    });
    return { ok: true, group_id: row.id };
  });

export const iamUpdateGroup = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        group_id: z.string().uuid(),
        name: z.string().min(1).max(80),
        description: z.string().max(400).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("iam_groups")
      .update({ name: data.name.trim(), description: data.description?.trim() || null })
      .eq("id", data.group_id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.group.update",
      resourceType: "iam_group",
      resourceId: data.group_id,
    });
    return { ok: true };
  });

export const iamDeleteGroup = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), group_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    // Memberships cascade via FK; clean up rules/grants pointing at the group.
    const [{ error }] = await Promise.all([
      supabaseAdmin.from("iam_groups").delete().eq("id", data.group_id),
      supabaseAdmin
        .from("iam_model_rules")
        .delete()
        .eq("principal_type", "group")
        .eq("principal_id", data.group_id),
      supabaseAdmin
        .from("iam_resource_grants")
        .delete()
        .eq("principal_type", "group")
        .eq("principal_id", data.group_id),
    ]);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.group.delete",
      resourceType: "iam_group",
      resourceId: data.group_id,
    });
    return { ok: true };
  });

export const iamAddGroupMember = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        group_id: z.string().uuid(),
        user_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("iam_group_members")
      .upsert(
        { group_id: data.group_id, user_id: data.user_id, added_by: guard.userId },
        { onConflict: "group_id,user_id", ignoreDuplicates: true },
      );
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.group.add_member",
      resourceType: "iam_group",
      resourceId: data.group_id,
      detail: { member_user_id: data.user_id },
    });
    return { ok: true };
  });

export const iamRemoveGroupMember = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        group_id: z.string().uuid(),
        user_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("iam_group_members")
      .delete()
      .eq("group_id", data.group_id)
      .eq("user_id", data.user_id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.group.remove_member",
      resourceType: "iam_group",
      resourceId: data.group_id,
      detail: { member_user_id: data.user_id },
    });
    return { ok: true };
  });

// --- Model rules ---------------------------------------------------------

export const iamListModelRules = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | { ok: true; rules: IamModelRuleRow[] }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { data: rules, error } = await supabaseAdmin
      .from("iam_model_rules")
      .select("id, principal_type, principal_id, provider, model_pattern")
      .order("created_at", { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, rules: (rules ?? []) as IamModelRuleRow[] };
  });

export const iamSetModelRules = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        principal_type: z.enum(["user", "group"]),
        principal_id: z.string().uuid(),
        rules: z
          .array(
            z.object({
              provider: z.string().min(1).max(40),
              model_pattern: z.string().min(1).max(200),
            }),
          )
          .max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const { error: delError } = await supabaseAdmin
      .from("iam_model_rules")
      .delete()
      .eq("principal_type", data.principal_type)
      .eq("principal_id", data.principal_id);
    if (delError) return { ok: false, error: delError.message };

    if (data.rules.length > 0) {
      const { error } = await supabaseAdmin.from("iam_model_rules").insert(
        data.rules.map((r) => ({
          principal_type: data.principal_type,
          principal_id: data.principal_id,
          provider: r.provider,
          model_pattern: r.model_pattern,
          created_by: guard.userId,
        })),
      );
      if (error) return { ok: false, error: error.message };
    }
    auditEvent({
      userId: guard.userId,
      action: "iam.model_rules.set",
      resourceType: data.principal_type,
      resourceId: data.principal_id,
    });
    return { ok: true };
  });

// --- Resource grants -----------------------------------------------------

export const iamListGrantableResources = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | { ok: true; resources: IamResourceOption[] }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const [
      { data: kbs },
      { data: tables },
      { data: secrets },
      { data: dashboards },
      { data: models },
      { data: catalogSources },
      { data: llmIntegrations },
      { data: providerCreds },
      { data: warehouses },
      { data: saasSources },
    ] = await Promise.all([
      supabaseAdmin.from("knowledge_bases").select("id, name, user_id").order("name"),
      supabaseAdmin
        .from("user_data_tables")
        .select("id, name, user_id, is_sample")
        .eq("is_sample", false)
        .order("name"),
      supabaseAdmin.from("user_secrets").select("id, name, user_id").order("name"),
      supabaseAdmin.from("bi_dashboards").select("id, name, user_id").order("name"),
      supabaseAdmin.from("semantic_models").select("id, name, label, user_id").order("name"),
      supabaseAdmin.from("catalog_sources").select("id, name, user_id").order("name"),
      // Shareable LLM credentials. Only the two provider stores — sharing a
      // gateway/n8n/firecrawl connection is not supported (their semantics are
      // account-wide, not per-call).
      supabaseAdmin
        .from("integrations")
        .select("id, name, provider, user_id")
        .eq("type", "llm_provider")
        .eq("is_active", true)
        .order("provider"),
      supabaseAdmin.from("provider_credentials").select("id, provider, label, user_id"),
      supabaseAdmin
        .from("data_warehouse_connections")
        .select("id, name, provider, user_id")
        .order("name"),
      supabaseAdmin.from("saas_connections").select("id, name, provider, user_id").order("name"),
    ]);
    const resources: IamResourceOption[] = [
      ...(kbs ?? []).map((k) => ({
        resource_type: "knowledge_base" as const,
        id: k.id,
        name: k.name,
        owner_user_id: k.user_id,
      })),
      ...(tables ?? []).map((t) => ({
        resource_type: "data_table" as const,
        id: t.id,
        name: t.name,
        owner_user_id: t.user_id,
      })),
      ...(secrets ?? []).map((s) => ({
        resource_type: "secret" as const,
        id: s.id,
        name: s.name,
        owner_user_id: s.user_id,
      })),
      ...(dashboards ?? []).map((d) => ({
        resource_type: "bi_dashboard" as const,
        id: d.id,
        name: d.name,
        owner_user_id: d.user_id,
      })),
      ...(models ?? []).map((m) => ({
        resource_type: "semantic_model" as const,
        id: m.id,
        name: m.label || m.name,
        owner_user_id: m.user_id,
      })),
      ...(catalogSources ?? []).map((c) => ({
        resource_type: "catalog_source" as const,
        id: c.id,
        name: c.name,
        owner_user_id: c.user_id,
      })),
      ...(llmIntegrations ?? []).map((i) => ({
        resource_type: "integration" as const,
        id: i.id,
        name: `${i.provider || i.name} key`,
        owner_user_id: i.user_id,
      })),
      ...(providerCreds ?? []).map((c) => ({
        resource_type: "provider_credential" as const,
        id: c.id,
        name: `${c.provider}${c.label ? ` (${c.label})` : ""} credential`,
        owner_user_id: c.user_id,
      })),
      // Sharing a connection shares its USE, never its credential: the
      // grantee's queries run against the owner's warehouse with the owner's
      // credential, decrypted server-side and never sent anywhere.
      ...(warehouses ?? []).map((c) => ({
        resource_type: "warehouse_connection" as const,
        id: c.id,
        name: `${c.name} (${c.provider})`,
        owner_user_id: c.user_id,
      })),
      ...(saasSources ?? []).map((c) => ({
        resource_type: "saas_connection" as const,
        id: c.id,
        name: `${c.name} (${c.provider})`,
        owner_user_id: c.user_id,
      })),
    ];
    return { ok: true, resources };
  });

export const iamListGrants = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | { ok: true; grants: IamGrantRow[] }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const { data: grants, error } = await supabaseAdmin
      .from("iam_resource_grants")
      .select(
        "id, resource_type, resource_id, principal_type, principal_id, row_filter, column_mask",
      )
      .order("created_at", { ascending: false });
    if (error) return { ok: false, error: error.message };

    const kbIds = (grants ?? [])
      .filter((g) => g.resource_type === "knowledge_base")
      .map((g) => g.resource_id);
    const tableIds = (grants ?? [])
      .filter((g) => g.resource_type === "data_table")
      .map((g) => g.resource_id);
    const secretIds = (grants ?? [])
      .filter((g) => g.resource_type === "secret")
      .map((g) => g.resource_id);
    const dashboardIds = (grants ?? [])
      .filter((g) => g.resource_type === "bi_dashboard")
      .map((g) => g.resource_id);
    const modelIds = (grants ?? [])
      .filter((g) => g.resource_type === "semantic_model")
      .map((g) => g.resource_id);
    const catalogIds = (grants ?? [])
      .filter((g) => g.resource_type === "catalog_source")
      .map((g) => g.resource_id);
    const integrationIds = (grants ?? [])
      .filter((g) => g.resource_type === "integration")
      .map((g) => g.resource_id);
    const credIds = (grants ?? [])
      .filter((g) => g.resource_type === "provider_credential")
      .map((g) => g.resource_id);

    const [
      { data: kbs },
      { data: tables },
      { data: secrets },
      { data: dashboards },
      { data: models },
      { data: catalogs },
      { data: integrationRows },
      { data: credRows },
    ] = await Promise.all([
      kbIds.length
        ? supabaseAdmin.from("knowledge_bases").select("id, name, user_id").in("id", kbIds)
        : Promise.resolve({ data: [] as { id: string; name: string; user_id: string }[] }),
      tableIds.length
        ? supabaseAdmin.from("user_data_tables").select("id, name, user_id").in("id", tableIds)
        : Promise.resolve({ data: [] as { id: string; name: string; user_id: string | null }[] }),
      secretIds.length
        ? supabaseAdmin.from("user_secrets").select("id, name, user_id").in("id", secretIds)
        : Promise.resolve({ data: [] as { id: string; name: string; user_id: string }[] }),
      dashboardIds.length
        ? supabaseAdmin.from("bi_dashboards").select("id, name, user_id").in("id", dashboardIds)
        : Promise.resolve({ data: [] as { id: string; name: string; user_id: string }[] }),
      modelIds.length
        ? supabaseAdmin
            .from("semantic_models")
            .select("id, name, label, user_id")
            .in("id", modelIds)
        : Promise.resolve({
            data: [] as { id: string; name: string; label: string | null; user_id: string }[],
          }),
      catalogIds.length
        ? supabaseAdmin.from("catalog_sources").select("id, name, user_id").in("id", catalogIds)
        : Promise.resolve({ data: [] as { id: string; name: string; user_id: string }[] }),
      integrationIds.length
        ? supabaseAdmin
            .from("integrations")
            .select("id, name, provider, user_id")
            .in("id", integrationIds)
        : Promise.resolve({
            data: [] as { id: string; name: string; provider: string | null; user_id: string }[],
          }),
      credIds.length
        ? supabaseAdmin
            .from("provider_credentials")
            .select("id, provider, label, user_id")
            .in("id", credIds)
        : Promise.resolve({
            data: [] as { id: string; provider: string; label: string | null; user_id: string }[],
          }),
    ]);

    const kbById = new Map((kbs ?? []).map((k) => [k.id, k]));
    const catalogById = new Map((catalogs ?? []).map((c) => [c.id, c]));
    const tableById = new Map((tables ?? []).map((t) => [t.id, t]));
    const secretById = new Map((secrets ?? []).map((s) => [s.id, s]));
    const dashboardById = new Map((dashboards ?? []).map((d) => [d.id, d]));
    const modelById = new Map(
      (models ?? []).map((m) => [m.id, { name: m.label || m.name, user_id: m.user_id }]),
    );
    const integrationById = new Map(
      (integrationRows ?? []).map((i) => [
        i.id,
        { name: `${i.provider || i.name} key`, user_id: i.user_id },
      ]),
    );
    const credById = new Map(
      (credRows ?? []).map((c) => [
        c.id,
        { name: `${c.provider}${c.label ? ` (${c.label})` : ""} credential`, user_id: c.user_id },
      ]),
    );

    return {
      ok: true,
      grants: (grants ?? []).map((g) => {
        const res =
          g.resource_type === "knowledge_base"
            ? kbById.get(g.resource_id)
            : g.resource_type === "secret"
              ? secretById.get(g.resource_id)
              : g.resource_type === "bi_dashboard"
                ? dashboardById.get(g.resource_id)
                : g.resource_type === "semantic_model"
                  ? modelById.get(g.resource_id)
                  : g.resource_type === "catalog_source"
                    ? catalogById.get(g.resource_id)
                    : g.resource_type === "integration"
                      ? integrationById.get(g.resource_id)
                      : g.resource_type === "provider_credential"
                        ? credById.get(g.resource_id)
                        : tableById.get(g.resource_id);
        const rf = g.row_filter as { column?: unknown; values?: unknown } | null;
        return {
          id: g.id,
          resource_type: g.resource_type as IamGrantRow["resource_type"],
          resource_id: g.resource_id,
          resource_name: res?.name ?? null,
          resource_owner_id: res?.user_id ?? null,
          principal_type: g.principal_type as IamGrantRow["principal_type"],
          principal_id: g.principal_id,
          row_filter:
            rf && typeof rf.column === "string" && Array.isArray(rf.values)
              ? { column: rf.column, values: rf.values.map(String) }
              : null,
          column_mask: Array.isArray(g.column_mask) ? g.column_mask.map(String) : [],
        };
      }),
    };
  });

export const iamCreateGrant = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        resource_type: z.enum([
          "knowledge_base",
          "data_table",
          "secret",
          "bi_dashboard",
          "semantic_model",
          "catalog_source",
          "integration",
          "provider_credential",
          "warehouse_connection",
          "saas_connection",
        ]),
        resource_id: z.string().uuid(),
        principal_type: z.enum(["user", "group"]),
        principal_id: z.string().uuid(),
        row_filter: z
          .object({
            column: z.string().trim().min(1),
            values: z.array(z.string().trim().min(1)).min(1).max(100),
          })
          .nullish(),
        column_mask: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    // Row filters and column masks apply to the two resource types that
    // actually serve rows: dashboards and datasets. Granting a masked
    // dashboard while the underlying dataset stayed all-or-nothing was a hole
    // — the same person could read past the mask through SQL.
    const RESTRICTABLE = new Set(["bi_dashboard", "data_table"]);
    if (data.row_filter && !RESTRICTABLE.has(data.resource_type)) {
      return { ok: false, error: "Row filters only apply to BI dashboard and dataset grants" };
    }
    if (data.column_mask?.length && !RESTRICTABLE.has(data.resource_type)) {
      return { ok: false, error: "Column masks only apply to BI dashboard and dataset grants" };
    }
    // Merge on conflict so re-granting updates the row filter in place.
    const { error } = await supabaseAdmin.from("iam_resource_grants").upsert(
      {
        resource_type: data.resource_type,
        resource_id: data.resource_id,
        principal_type: data.principal_type,
        principal_id: data.principal_id,
        created_by: guard.userId,
        row_filter: data.row_filter ?? null,
        column_mask: data.column_mask ?? [],
      },
      { onConflict: "resource_type,resource_id,principal_type,principal_id" },
    );
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.access.grant",
      resourceType: data.resource_type,
      resourceId: data.resource_id,
      detail: { principal_type: data.principal_type, principal_id: data.principal_id },
    });
    return { ok: true };
  });

export const iamDeleteGrant = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), grant_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("iam_resource_grants")
      .delete()
      .eq("id", data.grant_id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.access.revoke",
      resourceType: "iam_grant",
      resourceId: data.grant_id,
    });
    return { ok: true };
  });

// --- Settings ------------------------------------------------------------

export type IamSettings = {
  allow_public_signup: boolean;
  sso_enabled: boolean;
  sso_enforced: boolean;
  /**
   * Days to keep execution traces and swarm runs. 0 means keep for ever.
   *
   * The purge itself has existed and run on the scheduler since 20260736000000;
   * it was simply unreachable, because nothing but a direct database write
   * could change this number. A retention control nobody can find is a
   * retention policy nobody has.
   */
  trace_retention_days: number;
  /**
   * What "no applicable model rules" means for a user: 'allow' (historical —
   * unrestricted) or 'deny' (nothing callable until an admin allow-lists it;
   * superadmins bypass). Resource access is unaffected — it is already
   * deny-by-default via owner-only RLS plus additive grants.
   */
  model_access_default: "allow" | "deny";
};

/** Refuse a value that would silently delete more than intended. */
const MAX_RETENTION_DAYS = 3650;

export const iamGetSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | ({ ok: true } & IamSettings)> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { data: row, error } = await supabaseAdmin
      .from("iam_settings")
      .select(
        "allow_public_signup, sso_enabled, sso_enforced, trace_retention_days, model_access_default",
      )
      .eq("id", true)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      allow_public_signup: row?.allow_public_signup ?? true,
      sso_enabled: row?.sso_enabled ?? false,
      sso_enforced: row?.sso_enforced ?? false,
      trace_retention_days: Number(row?.trace_retention_days ?? 0),
      model_access_default: row?.model_access_default === "deny" ? "deny" : "allow",
    };
  });

export const iamUpdateSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        allow_public_signup: z.boolean().optional(),
        sso_enabled: z.boolean().optional(),
        sso_enforced: z.boolean().optional(),
        // Validated here rather than trusted from the form: this number
        // decides what gets permanently deleted on the next scheduler pass.
        trace_retention_days: z.number().int().min(0).max(MAX_RETENTION_DAYS).optional(),
        model_access_default: z.enum(["allow", "deny"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const patch: {
      updated_at: string;
      allow_public_signup?: boolean;
      sso_enabled?: boolean;
      sso_enforced?: boolean;
      trace_retention_days?: number;
      model_access_default?: "allow" | "deny";
    } = { updated_at: new Date().toISOString() };
    if (typeof data.allow_public_signup === "boolean")
      patch.allow_public_signup = data.allow_public_signup;
    if (typeof data.sso_enabled === "boolean") patch.sso_enabled = data.sso_enabled;
    if (typeof data.sso_enforced === "boolean") patch.sso_enforced = data.sso_enforced;
    if (typeof data.trace_retention_days === "number")
      patch.trace_retention_days = data.trace_retention_days;
    if (data.model_access_default) patch.model_access_default = data.model_access_default;
    const { error } = await supabaseAdmin.from("iam_settings").update(patch).eq("id", true);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: guard.userId,
      action: "iam.settings.update",
      resourceType: "iam_settings",
      detail: {
        allow_public_signup: data.allow_public_signup,
        sso_enabled: data.sso_enabled,
        sso_enforced: data.sso_enforced,
        trace_retention_days: data.trace_retention_days,
        model_access_default: data.model_access_default,
      },
    });
    return { ok: true };
  });

// --- Single sign-on (SAML identity providers) -----------------------------
// Providers live in GoTrue, managed through its admin API. On hosted
// Supabase, SAML SSO must be enabled on the project (Pro plan feature) or
// these endpoints return 404 — surfaced to the UI as `saml_disabled`.

export type IamSsoProvider = {
  id: string;
  entity_id: string | null;
  metadata_url: string | null;
  domains: string[];
  created_at: string | null;
};

type GotrueSsoProvider = {
  id: string;
  created_at?: string;
  saml?: { entity_id?: string; metadata_url?: string };
  domains?: { domain: string }[];
};

async function gotrueAdminSso(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string; saml_disabled?: boolean }> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { ok: false, error: "Server is missing Supabase configuration" };
  const res = await fetch(`${base}/auth/v1/admin/sso/providers${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      return {
        ok: false,
        saml_disabled: true,
        error:
          "SAML SSO is not enabled on this Supabase project. Enable it in the Supabase dashboard " +
          "(Authentication → Sign In / Up → SSO with SAML — requires the Pro plan on hosted " +
          "Supabase), then retry.",
      };
    }
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { msg?: string; message?: string; error?: string };
      message = parsed.msg || parsed.message || parsed.error || message;
    } catch {
      /* keep raw */
    }
    return { ok: false, error: `SSO admin API error (${res.status}): ${message}` };
  }
  try {
    return { ok: true, body: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: true, body: {} };
  }
}

function mapSsoProvider(p: GotrueSsoProvider): IamSsoProvider {
  return {
    id: p.id,
    entity_id: p.saml?.entity_id ?? null,
    metadata_url: p.saml?.metadata_url ?? null,
    domains: (p.domains ?? []).map((d) => d.domain),
    created_at: p.created_at ?? null,
  };
}

export const iamListSsoProviders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      (IamError & { saml_disabled?: boolean }) | { ok: true; providers: IamSsoProvider[] }
    > => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return guard;
      const res = await gotrueAdminSso("");
      if (!res.ok) return res;
      const items = ((res.body as { items?: GotrueSsoProvider[] }).items ?? []).map(mapSsoProvider);
      return { ok: true, providers: items };
    },
  );

export const iamCreateSsoProvider = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        metadata_url: z.string().url().optional(),
        metadata_xml: z.string().min(1).optional(),
        domains: z.array(z.string().min(3).max(255)).min(1).max(50),
      })
      .refine((v) => v.metadata_url || v.metadata_xml, {
        message: "Provide a metadata URL or paste the metadata XML",
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      (IamError & { saml_disabled?: boolean }) | { ok: true; provider: IamSsoProvider }
    > => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return guard;
      const res = await gotrueAdminSso("", {
        method: "POST",
        body: JSON.stringify({
          type: "saml",
          ...(data.metadata_url ? { metadata_url: data.metadata_url } : {}),
          ...(data.metadata_xml ? { metadata_xml: data.metadata_xml } : {}),
          domains: data.domains,
        }),
      });
      if (!res.ok) return res;
      auditEvent({
        userId: guard.userId,
        action: "iam.sso.create",
        resourceType: "sso_provider",
        detail: { domains: data.domains },
      });
      return { ok: true, provider: mapSsoProvider(res.body as GotrueSsoProvider) };
    },
  );

export const iamUpdateSsoProvider = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        provider_id: z.string().uuid(),
        metadata_url: z.string().url().optional(),
        metadata_xml: z.string().min(1).optional(),
        domains: z.array(z.string().min(3).max(255)).min(1).max(50),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<(IamError & { saml_disabled?: boolean }) | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const res = await gotrueAdminSso(`/${data.provider_id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...(data.metadata_url ? { metadata_url: data.metadata_url } : {}),
        ...(data.metadata_xml ? { metadata_xml: data.metadata_xml } : {}),
        domains: data.domains,
      }),
    });
    if (!res.ok) return res;
    auditEvent({
      userId: guard.userId,
      action: "iam.sso.update",
      resourceType: "sso_provider",
      resourceId: data.provider_id,
      detail: { domains: data.domains },
    });
    return { ok: true };
  });

export const iamDeleteSsoProvider = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), provider_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<(IamError & { saml_disabled?: boolean }) | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const res = await gotrueAdminSso(`/${data.provider_id}`, { method: "DELETE" });
    if (!res.ok) return res;
    auditEvent({
      userId: guard.userId,
      action: "iam.sso.delete",
      resourceType: "sso_provider",
      resourceId: data.provider_id,
    });
    return { ok: true };
  });
