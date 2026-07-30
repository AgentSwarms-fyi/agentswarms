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
import {
  applyColumnMask,
  applyRowFilters,
  intersectColumnMasks,
  mergeGrantRowFilters,
  sanitizePublicPages,
  sanitizePublicWidgets,
  type WidgetResultRow,
} from "@/lib/biDashboards";
import { isModelAllowed } from "@/utils/iam.server";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import type { Json } from "@/integrations/supabase/types";

async function requireUserId(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

async function requireDashboardOwner(
  accessToken: string,
  dashboardId: string,
): Promise<{ userId: string; aiModel: string | null }> {
  const userId = await requireUserId(accessToken);
  const { data, error } = await supabaseAdmin
    .from("bi_dashboards")
    .select("id, user_id, ai_model")
    .eq("id", dashboardId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Dashboard not found");
  if (data.user_id !== userId) throw new Error("Only the owner can manage sharing");
  return { userId, aiModel: data.ai_model };
}

/**
 * Names of the given groups whose IAM model rules EXCLUDE the reader model
 * (an encoded "provider::model" choice; legacy plain ids mean OpenRouter).
 * A group with no rules of its own is unrestricted at group level (IAM is
 * default-allow), so it never blocks.
 */
async function groupsBlockedFromModel(groupIds: string[], model: string): Promise<string[]> {
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
  const nameById = new Map((groups ?? []).map((g) => [g.id, g.name]));
  const blocked: string[] = [];
  for (const gid of groupIds) {
    const groupRules = byGroup.get(gid);
    if (
      groupRules &&
      groupRules.length > 0 &&
      !isModelAllowed(groupRules, choice.provider, choice.model)
    ) {
      blocked.push(nameById.get(gid) ?? gid);
    }
  }
  return blocked;
}

export type PublicDashboard = {
  name: string;
  description: string | null;
  widgets: Json;
  layout: Json;
  pages: Json;
  filters: Json;
  theme: Json;
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
          .select(
            "id, name, description, widgets, layout, pages, filters, theme, updated_at, published",
          )
          .eq("public_slug", data.slug)
          .maybeSingle();
        if (error) return { ok: false, error: error.message };
        if (!row || !row.published) {
          return { ok: false, error: "This dashboard does not exist or is no longer published." };
        }
        // Usage analytics: anonymous public views are stamped with the
        // service role (bi_touch_view trusts service-role callers).
        void supabaseAdmin
          .rpc("bi_touch_view", { _dashboard_id: row.id })
          .then(() => {})
          .then(undefined, () => {});
        // Row snapshots live in bi_widget_results; anonymous viewers have no
        // session for its RLS, so hydrate with the service role BEFORE the
        // sanitiser strips everything a public payload must not carry.
        const { hydrateDashboardAdmin } = await import("@/utils/bi/results.server");
        const hydrated = await hydrateDashboardAdmin(row.id, row);
        const { id: _id, published: _published, ...rest } = hydrated;
        // Anyone with the slug can read this, so strip the query behind each
        // widget (raw SQL, warehouse connection ids) — see sanitizePublicWidgets.
        const dashboard = {
          ...rest,
          widgets: sanitizePublicWidgets(rest.widgets) as unknown as Json,
          pages: sanitizePublicPages(rest.pages) as Json,
        };
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
      const { userId, aiModel } = await requireDashboardOwner(data.access_token, data.dashboard_id);
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

      // The dashboard's reader model must be usable by every group it's
      // shared with — IAM model rules are checked before granting.
      if (aiModel && toInsert.length > 0) {
        const blocked = await groupsBlockedFromModel(toInsert, aiModel);
        if (blocked.length > 0) {
          return {
            ok: false,
            error:
              `IAM model rules do not allow the reader model (${aiModel}) for: ` +
              `${blocked.join(", ")}. Allow the model for those groups in Admin → IAM, ` +
              "or pick a different reader model.",
          };
        }
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

/**
 * Set the dashboard's reader AI model (owner only). Validated against the
 * IAM model rules of every group the dashboard is currently shared with.
 */
export const biSetReaderModel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        dashboard_id: z.string().uuid(),
        model: z.string().min(1).max(200).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      await requireDashboardOwner(data.access_token, data.dashboard_id);
      if (data.model) {
        const { data: grants, error } = await supabaseAdmin
          .from("iam_resource_grants")
          .select("principal_id")
          .eq("resource_type", "bi_dashboard")
          .eq("resource_id", data.dashboard_id)
          .eq("principal_type", "group");
        if (error) return { ok: false, error: error.message };
        const blocked = await groupsBlockedFromModel(
          (grants ?? []).map((g) => g.principal_id),
          data.model,
        );
        if (blocked.length > 0) {
          return {
            ok: false,
            error:
              `This dashboard is shared with group(s) not allowed to use ${data.model} ` +
              `under IAM: ${blocked.join(", ")}. Allow the model for them in Admin → IAM first.`,
          };
        }
      }
      const { error: updErr } = await supabaseAdmin
        .from("bi_dashboards")
        .update({ ai_model: data.model })
        .eq("id", data.dashboard_id);
      if (updErr) return { ok: false, error: updErr.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Failed" };
    }
  });

/**
 * Widget results for a RESTRICTED grantee, masked and filtered server-side.
 *
 * Grantees whose every applicable grant carries a row filter or a column mask
 * cannot read bi_widget_results directly (the RLS policy admits only
 * unrestricted grants) — RLS can gate rows but cannot drop columns, so a
 * direct read would defeat the mask. This is their read path: the row filter
 * and the intersection of masks are applied here, with the service role,
 * before anything leaves the server. Owners and unrestricted grantees never
 * need it, but calling it anyway returns their data unrestricted — so a
 * mistimed client call degrades to correct behaviour, not an error.
 */
export const biGetSharedWidgetResults = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), dashboard_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; results: WidgetResultRow[]; masked_columns: string[] }
      | { ok: false; error: string }
    > => {
      try {
        const userId = await requireUserId(data.access_token);

        const { data: dash, error: dashErr } = await supabaseAdmin
          .from("bi_dashboards")
          .select("id, user_id")
          .eq("id", data.dashboard_id)
          .maybeSingle();
        if (dashErr || !dash) return { ok: false, error: "Dashboard not found" };

        let rowFilters: ReturnType<typeof mergeGrantRowFilters> = null;
        let mask: string[] = [];
        if (dash.user_id !== userId) {
          // Grants that apply to this caller: their own, plus their groups'.
          const { data: memberships } = await supabaseAdmin
            .from("iam_group_members")
            .select("group_id")
            .eq("user_id", userId);
          const groupIds = (memberships ?? []).map((m) => m.group_id);
          const { data: grants, error: gErr } = await supabaseAdmin
            .from("iam_resource_grants")
            .select("principal_type, principal_id, row_filter, column_mask")
            .eq("resource_type", "bi_dashboard")
            .eq("resource_id", data.dashboard_id);
          if (gErr) return { ok: false, error: gErr.message };
          const applicable = (grants ?? []).filter(
            (g) =>
              (g.principal_type === "user" && g.principal_id === userId) ||
              (g.principal_type === "group" && groupIds.includes(g.principal_id)),
          );
          if (applicable.length === 0) {
            return { ok: false, error: "This dashboard is not shared with you" };
          }
          rowFilters = mergeGrantRowFilters(applicable);
          mask = intersectColumnMasks(applicable.map((g) => g.column_mask));
        }

        const { data: stored, error } = await supabaseAdmin
          .from("bi_widget_results")
          .select("widget_id, columns, rows, truncated, refreshed_at")
          .eq("dashboard_id", data.dashboard_id);
        if (error) return { ok: false, error: error.message };

        const results = ((stored ?? []) as WidgetResultRow[]).map((r) => {
          const columns = Array.isArray(r.columns) ? (r.columns as string[]) : [];
          let rows = Array.isArray(r.rows) ? (r.rows as Record<string, unknown>[]) : [];
          rows = applyRowFilters(rows, rowFilters);
          const masked = applyColumnMask(columns, rows, mask);
          return {
            ...r,
            columns: masked.columns as unknown as Json,
            rows: masked.rows as unknown as Json,
          };
        });
        return { ok: true, results, masked_columns: mask };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );
