// Server functions for BI dashboards: public (published) dashboard fetch by
// slug, and owner-managed group sharing on top of the polymorphic
// iam_resource_grants system.
//
// Dashboard CRUD itself happens client-side under RLS (src/lib/biDashboards.ts).
// These functions use the service role for the two things RLS can't express:
//   - anonymous access to a published dashboard (slug lookup, no enumeration)
//   - a dashboard OWNER granting/revoking group access (grant writes are
//     otherwise superadmin-only; ownership is verified here server-side)
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

async function requireUserId(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

async function requireDashboardOwner(accessToken: string, dashboardId: string): Promise<string> {
  const userId = await requireUserId(accessToken);
  const { data, error } = await supabaseAdmin
    .from("bi_dashboards")
    .select("id, user_id")
    .eq("id", dashboardId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Dashboard not found");
  if (data.user_id !== userId) throw new Error("Only the owner can manage sharing");
  return userId;
}

export type PublicDashboard = {
  name: string;
  description: string | null;
  widgets: Json;
  layout: Json;
  updated_at: string;
};

/** Anonymous fetch of a published dashboard by its unguessable slug. */
export const biGetPublicDashboard = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ slug: z.string().min(8).max(64) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; dashboard: PublicDashboard } | { ok: false; error: string }> => {
      try {
        const { data: row, error } = await supabaseAdmin
          .from("bi_dashboards")
          .select("name, description, widgets, layout, updated_at, published")
          .eq("public_slug", data.slug)
          .maybeSingle();
        if (error) return { ok: false, error: error.message };
        if (!row || !row.published) {
          return { ok: false, error: "This dashboard does not exist or is no longer published." };
        }
        const { published: _published, ...dashboard } = row;
        return { ok: true, dashboard };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

/** Groups any signed-in user can share a dashboard with. */
export const biListShareTargets = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; groups: { id: string; name: string }[] } | { ok: false; error: string }
    > => {
      try {
        await requireUserId(data.access_token);
        const { data: groups, error } = await supabaseAdmin
          .from("iam_groups")
          .select("id, name")
          .order("name");
        if (error) return { ok: false, error: error.message };
        return { ok: true, groups: groups ?? [] };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

export const biGetShares = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), dashboard_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; group_ids: string[]; user_grants: number } | { ok: false; error: string }
    > => {
      try {
        await requireDashboardOwner(data.access_token, data.dashboard_id);
        const { data: grants, error } = await supabaseAdmin
          .from("iam_resource_grants")
          .select("principal_type, principal_id")
          .eq("resource_type", "bi_dashboard")
          .eq("resource_id", data.dashboard_id);
        if (error) return { ok: false, error: error.message };
        const group_ids = (grants ?? [])
          .filter((g) => g.principal_type === "group")
          .map((g) => g.principal_id);
        const user_grants = (grants ?? []).filter((g) => g.principal_type === "user").length;
        return { ok: true, group_ids, user_grants };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

/** Replace the set of groups this dashboard is shared with (owner only). */
export const biSetShares = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        dashboard_id: z.string().uuid(),
        group_ids: z.array(z.string().uuid()).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const userId = await requireDashboardOwner(data.access_token, data.dashboard_id);
      const { data: existing, error } = await supabaseAdmin
        .from("iam_resource_grants")
        .select("id, principal_id")
        .eq("resource_type", "bi_dashboard")
        .eq("resource_id", data.dashboard_id)
        .eq("principal_type", "group");
      if (error) return { ok: false, error: error.message };

      const wanted = new Set(data.group_ids);
      const current = new Map((existing ?? []).map((g) => [g.principal_id, g.id]));

      const toDelete = [...current.entries()]
        .filter(([gid]) => !wanted.has(gid))
        .map(([, id]) => id);
      const toInsert = [...wanted].filter((gid) => !current.has(gid));

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
            resource_type: "bi_dashboard",
            resource_id: data.dashboard_id,
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
