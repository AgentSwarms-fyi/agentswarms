// Server functions backing the /admin/iam page.
// Every mutation/list here is superadmin-gated via requireSuperadmin();
// all reads/writes use the service-role client, so guards are mandatory.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
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
  resource_type: "knowledge_base" | "data_table";
  resource_id: string;
  resource_name: string | null; // null = resource was deleted
  resource_owner_id: string | null;
  principal_type: "user" | "group";
  principal_id: string;
};

export type IamResourceOption = {
  resource_type: "knowledge_base" | "data_table";
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
        return { ok: true, user_id: created.user.id, invited: false };
      }

      const { data: invited, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        data.email,
        {
          data: data.display_name ? { full_name: data.display_name } : undefined,
        },
      );
      if (error || !invited.user) return { ok: false, error: error?.message ?? "Invite failed" };
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
    return { ok: true };
  });

// --- Resource grants -----------------------------------------------------

export const iamListGrantableResources = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | { ok: true; resources: IamResourceOption[] }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const [{ data: kbs }, { data: tables }] = await Promise.all([
      supabaseAdmin.from("knowledge_bases").select("id, name, user_id").order("name"),
      supabaseAdmin
        .from("user_data_tables")
        .select("id, name, user_id, is_sample")
        .eq("is_sample", false)
        .order("name"),
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
      .select("id, resource_type, resource_id, principal_type, principal_id")
      .order("created_at", { ascending: false });
    if (error) return { ok: false, error: error.message };

    const kbIds = (grants ?? [])
      .filter((g) => g.resource_type === "knowledge_base")
      .map((g) => g.resource_id);
    const tableIds = (grants ?? [])
      .filter((g) => g.resource_type === "data_table")
      .map((g) => g.resource_id);

    const [{ data: kbs }, { data: tables }] = await Promise.all([
      kbIds.length
        ? supabaseAdmin.from("knowledge_bases").select("id, name, user_id").in("id", kbIds)
        : Promise.resolve({ data: [] as { id: string; name: string; user_id: string }[] }),
      tableIds.length
        ? supabaseAdmin.from("user_data_tables").select("id, name, user_id").in("id", tableIds)
        : Promise.resolve({ data: [] as { id: string; name: string; user_id: string | null }[] }),
    ]);

    const kbById = new Map((kbs ?? []).map((k) => [k.id, k]));
    const tableById = new Map((tables ?? []).map((t) => [t.id, t]));

    return {
      ok: true,
      grants: (grants ?? []).map((g) => {
        const res =
          g.resource_type === "knowledge_base"
            ? kbById.get(g.resource_id)
            : tableById.get(g.resource_id);
        return {
          id: g.id,
          resource_type: g.resource_type as IamGrantRow["resource_type"],
          resource_id: g.resource_id,
          resource_name: res?.name ?? null,
          resource_owner_id: res?.user_id ?? null,
          principal_type: g.principal_type as IamGrantRow["principal_type"],
          principal_id: g.principal_id,
        };
      }),
    };
  });

export const iamCreateGrant = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        resource_type: z.enum(["knowledge_base", "data_table"]),
        resource_id: z.string().uuid(),
        principal_type: z.enum(["user", "group"]),
        principal_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin.from("iam_resource_grants").upsert(
      {
        resource_type: data.resource_type,
        resource_id: data.resource_id,
        principal_type: data.principal_type,
        principal_id: data.principal_id,
        created_by: guard.userId,
      },
      {
        onConflict: "resource_type,resource_id,principal_type,principal_id",
        ignoreDuplicates: true,
      },
    );
    if (error) return { ok: false, error: error.message };
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
    return { ok: true };
  });

// --- Settings ------------------------------------------------------------

export const iamGetSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<IamError | { ok: true; allow_public_signup: boolean }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { data: row, error } = await supabaseAdmin
      .from("iam_settings")
      .select("allow_public_signup")
      .eq("id", true)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, allow_public_signup: row?.allow_public_signup ?? true };
  });

export const iamUpdateSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), allow_public_signup: z.boolean() }).parse(input),
  )
  .handler(async ({ data }): Promise<IamError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("iam_settings")
      .update({
        allow_public_signup: data.allow_public_signup,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
