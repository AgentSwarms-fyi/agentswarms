// Server functions for the audit trail and admin spend analytics.
//
// The audit timeline merges two streams at read time: audit_events (user
// activities — dashboard views, dataset/warehouse queries, catalog crawls)
// and execution_traces (every LLM call, mapped to "model.call" events).
// Regular users see their own trail; superadmins see everyone's with
// emails resolved. Retention is a superadmin-configurable window; the
// purge itself runs on the shared scheduler (see audit.server.ts).
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperadmin } from "@/utils/iam.server";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return { sb, userId: data.user.id };
}

/** Emails for a set of user ids (service role; self-hosted scale). */
async function emailMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data.users.length) break;
    for (const u of data.users) if (u.email) map.set(u.id, u.email);
    if (data.users.length < 1000) break;
  }
  return map;
}

export type AuditRow = {
  id: string;
  /**
   * Null once the account is deleted. The audit trail deliberately outlives the
   * account (FK is ON DELETE SET NULL), so this is a normal state, not an
   * anomaly — `user_email` falls back to the actor_email captured at write time.
   */
  user_id: string | null;
  user_email: string | null;
  action: string;
  resource_type: string | null;
  resource_name: string | null;
  detail: Json;
  created_at: string;
};

const FETCH_CAP = 300;

export const auditListEvents = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        days: z.number().int().min(1).max(365).optional(),
        action: z.string().max(40).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: false; error: string }
      | { ok: true; rows: AuditRow[]; is_admin: boolean; retention_days: number }
    > => {
      try {
        const { sb } = await requireUser(data.access_token);
        const admin = (await requireSuperadmin(data.access_token)).ok;

        const { data: settings } = await supabaseAdmin
          .from("iam_settings")
          .select("audit_retention_days")
          .limit(1)
          .maybeSingle();
        const retention = settings?.audit_retention_days ?? 14;
        const windowDays = Math.min(data.days ?? retention, retention);
        const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

        // RLS does the scoping for non-admins; the service client sees all.
        const client = admin ? supabaseAdmin : sb;

        // Three sources: audit_events (activities incl. agent.chat),
        // execution_traces (model calls) and swarm_runs (swarm executions).
        const derived = ["model.call", "swarm.run"];
        const wantEvents = !data.action || !derived.includes(data.action);
        const wantModels = !data.action || data.action === "model.call";
        const wantSwarms = !data.action || data.action === "swarm.run";

        const [eventsRes, tracesRes, swarmsRes] = await Promise.all([
          wantEvents
            ? client
                .from("audit_events")
                .select(
                  "id, user_id, actor_email, action, resource_type, resource_name, detail, created_at",
                )
                .gte("created_at", since)
                .order("created_at", { ascending: false })
                .limit(FETCH_CAP)
            : Promise.resolve({ data: [], error: null }),
          wantModels
            ? client
                .from("execution_traces")
                .select(
                  "id, user_id, agent_name, llm_provider, llm_model, tokens_in, tokens_out, cost_usd, status, created_at",
                )
                .gte("created_at", since)
                .order("created_at", { ascending: false })
                .limit(FETCH_CAP)
            : Promise.resolve({ data: [], error: null }),
          wantSwarms
            ? client
                .from("swarm_runs")
                .select("id, user_id, swarm_name, status, step_count, total_cost_usd, started_at")
                .gte("started_at", since)
                .order("started_at", { ascending: false })
                .limit(FETCH_CAP)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (eventsRes.error) return { ok: false, error: eventsRes.error.message };
        if (tracesRes.error) return { ok: false, error: tracesRes.error.message };
        if (swarmsRes.error) return { ok: false, error: swarmsRes.error.message };

        const emails = admin ? await emailMap() : null;
        const emailFor = (uid: string | null) => (uid ? (emails?.get(uid) ?? null) : null);

        const rows: AuditRow[] = [
          ...(eventsRes.data ?? []).map((e) => ({
            id: e.id,
            user_id: e.user_id,
            // actor_email is the whole point of that column: it is captured at
            // write time so a deleted account still has a name against its
            // actions. Rows written before the column existed have neither, and
            // the UI says "deleted account" rather than inventing an identity.
            user_email: emailFor(e.user_id) ?? e.actor_email ?? null,
            action: e.action,
            resource_type: e.resource_type,
            resource_name: e.resource_name,
            detail: (e.detail ?? {}) as Json,
            created_at: e.created_at,
          })),
          ...(tracesRes.data ?? []).map((t) => ({
            id: `trace:${t.id}`,
            user_id: t.user_id,
            user_email: emailFor(t.user_id),
            action: "model.call",
            resource_type: "model",
            resource_name: `${t.llm_provider}/${t.llm_model}`,
            detail: {
              surface: t.agent_name,
              tokens: (t.tokens_in ?? 0) + (t.tokens_out ?? 0),
              cost_usd: Number(t.cost_usd ?? 0),
              status: t.status,
            } as Json,
            created_at: t.created_at,
          })),
          ...(swarmsRes.data ?? []).map((s) => ({
            id: `swarm:${s.id}`,
            user_id: s.user_id,
            user_email: emailFor(s.user_id),
            action: "swarm.run",
            resource_type: "swarm",
            resource_name: s.swarm_name ?? "Untitled swarm",
            detail: {
              status: s.status,
              steps: s.step_count,
              cost_usd: Number(s.total_cost_usd ?? 0),
            } as Json,
            created_at: s.started_at,
          })),
        ]
          .filter((r) => (data.action ? r.action === data.action : true))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .slice(0, 400);

        return { ok: true, rows, is_admin: admin, retention_days: retention };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

export const auditSetRetention = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ access_token: z.string().min(1), days: z.number().int().min(1).max(365) })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: false; error: string } | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("iam_settings")
      .update({ audit_retention_days: data.days, updated_at: new Date().toISOString() })
      .eq("id", true);
    if (error) return { ok: false, error: error.message };
    // Apply the new window immediately rather than at the next hourly tick.
    const { purgeAuditEvents } = await import("@/utils/audit.server");
    await purgeAuditEvents(true);
    return { ok: true };
  });

// ── Admin spend analytics ────────────────────────────────────────────────

export type UserSpendRow = {
  user_id: string;
  email: string | null;
  calls: number;
  tokens: number;
  cost: number;
};

export type GroupSpendRow = {
  group_id: string;
  name: string;
  members: number;
  calls: number;
  tokens: number;
  cost: number;
};

export const adminSpendBreakdown = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ access_token: z.string().min(1), days: z.number().int().min(1).max(365) })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: false; error: string } | { ok: true; users: UserSpendRow[]; groups: GroupSpendRow[] }
    > => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return guard;
      try {
        const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
        const [{ data: spend, error }, emails, groupsRes, membersRes] = await Promise.all([
          supabaseAdmin.rpc("admin_spend_by_user", { _since: since }),
          emailMap(),
          supabaseAdmin.from("iam_groups").select("id, name"),
          supabaseAdmin.from("iam_group_members").select("group_id, user_id"),
        ]);
        if (error) return { ok: false, error: error.message };

        const users: UserSpendRow[] = (spend ?? [])
          .map((s) => ({
            user_id: s.user_id,
            email: emails.get(s.user_id) ?? null,
            calls: Number(s.calls),
            tokens: Number(s.tokens),
            cost: Number(s.cost),
          }))
          .sort((a, b) => b.cost - a.cost);

        const byUser = new Map(users.map((u) => [u.user_id, u]));
        const memberOf = new Map<string, string[]>();
        for (const m of membersRes.data ?? []) {
          memberOf.set(m.group_id, [...(memberOf.get(m.group_id) ?? []), m.user_id]);
        }
        const groups: GroupSpendRow[] = (groupsRes.data ?? [])
          .map((g) => {
            const members = memberOf.get(g.id) ?? [];
            const agg = members.reduce(
              (acc, uid) => {
                const u = byUser.get(uid);
                if (u) {
                  acc.calls += u.calls;
                  acc.tokens += u.tokens;
                  acc.cost += u.cost;
                }
                return acc;
              },
              { calls: 0, tokens: 0, cost: 0 },
            );
            return { group_id: g.id, name: g.name, members: members.length, ...agg };
          })
          .sort((a, b) => b.cost - a.cost);

        return { ok: true, users, groups };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

/**
 * Walk the audit hash chain and recompute every link (superadmin only — the
 * DB function enforces it too). NULL first_broken_seq = every link from the
 * oldest remaining row holds; a number = the first sequence where the chain
 * no longer matches its content, i.e. a row was edited or deleted in place.
 */
export const auditChainVerify = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; checked: number; firstBrokenSeq: number | null } | { ok: false; error: string }
    > => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return { ok: false, error: "Superadmin only" };
      const { sb } = await requireUser(data.access_token);
      // Run under the CALLER's JWT so the function's own is_superadmin(auth.uid())
      // check is exercised — defense in depth, not service-role bypass.
      const { data: rows, error } = await (
        sb as unknown as {
          rpc: (fn: string) => Promise<{
            data: { checked: number; first_broken_seq: number | null }[] | null;
            error: { message: string } | null;
          }>;
        }
      ).rpc("audit_chain_verify");
      if (error) return { ok: false, error: error.message };
      const row = rows?.[0];
      if (!row) return { ok: false, error: "No result from verification" };
      return { ok: true, checked: Number(row.checked), firstBrokenSeq: row.first_broken_seq };
    },
  );
