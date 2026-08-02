// Dashboard metrics, scoped to a person, their teams, or the organisation.
//
// WHY THIS IS A SERVER FUNCTION AT ALL. The dashboard used to read
// execution_traces straight from the browser under the caller's JWT, which RLS
// scopes to their own rows. That is exactly right for "just me" and cannot
// answer the other two questions — a manager cannot see their team's spend,
// and nobody can charge anything back.
//
// SO THE AUTHORISATION IS THE WHOLE POINT:
//   * "mine" — always allowed, and the only scope a plain user gets by default.
//   * "team" — the union of the members of the groups THE CALLER BELONGS TO,
//     resolved server-side from iam_group_members. Never a group they name.
//   * "org"  — superadmin only.
//
// A refused scope is an ERROR, never a silent downgrade. Showing someone
// "Whole organisation · $12.40" when $12.40 is their own spend is a lie the
// number itself cannot reveal.
//
// The service role is used only AFTER the scope is authorised, and the user
// set it may read is computed here rather than taken from the request.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DASHBOARD_RANGES,
  DASHBOARD_SCOPES,
  allowedScopes,
  personLabel,
  resolveRange,
  type DashboardScope,
} from "@/utils/dashboard/scope";

type TraceRow = {
  user_id: string;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  status: string | null;
  llm_model: string | null;
  created_at: string;
};

export type SpendRow = {
  id: string;
  label: string;
  runs: number;
  cost_usd: number;
  tokens: number;
};

export type DashboardOverview = {
  scope: DashboardScope;
  range: string;
  from: string;
  to: string;
  /** Scopes THIS caller may ask for — the UI renders only these. */
  available: DashboardScope[];
  totals: {
    runs: number;
    cost_usd: number;
    tokens: number;
    /** Percentage 0-100, or null when there were no runs to judge. */
    successRate: number | null;
    avgLatencyMs: number | null;
  };
  /** Per-person breakdown. Empty for "mine" — it would be one row of itself. */
  byUser: SpendRow[];
  /** Per-team breakdown. A user in two teams contributes to both. */
  byGroup: SpendRow[];
  topModels: { model: string; runs: number; cost_usd: number }[];
};

async function requireUser(accessToken: string) {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

async function isSuperadmin(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("user_id", userId)
    .eq("role", "superadmin")
    .maybeSingle();
  return Boolean(data);
}

/** Groups the caller belongs to, with their members. */
async function myGroups(userId: string) {
  const { data: mine } = await supabaseAdmin
    .from("iam_group_members")
    .select("group_id")
    .eq("user_id", userId);
  const groupIds = [...new Set((mine ?? []).map((r) => r.group_id))];
  if (groupIds.length === 0) return { groupIds, names: new Map<string, string>(), members: [] };

  const [{ data: groups }, { data: members }] = await Promise.all([
    supabaseAdmin.from("iam_groups").select("id, name").in("id", groupIds),
    supabaseAdmin.from("iam_group_members").select("group_id, user_id").in("group_id", groupIds),
  ]);
  return {
    groupIds,
    names: new Map((groups ?? []).map((g) => [g.id, g.name])),
    members: (members ?? []) as { group_id: string; user_id: string }[],
  };
}

function sum(rows: TraceRow[], pick: (r: TraceRow) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

const cost = (r: TraceRow) => Number(r.cost_usd ?? 0);
const tokens = (r: TraceRow) => Number(r.tokens_in ?? 0) + Number(r.tokens_out ?? 0);

export const dashboardOverview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        scope: z.enum(DASHBOARD_SCOPES).default("mine"),
        range: z.enum(DASHBOARD_RANGES).default("30d"),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<DashboardOverview> => {
    const userId = await requireUser(data.access_token);
    const [superadmin, groups] = await Promise.all([isSuperadmin(userId), myGroups(userId)]);
    const available = allowedScopes({
      isSuperadmin: superadmin,
      groupCount: groups.groupIds.length,
    });

    // REFUSE rather than downgrade. See the file header.
    if (!available.includes(data.scope)) {
      throw new Error(
        data.scope === "org"
          ? "Organisation-wide figures are available to superadmins only."
          : "You are not a member of any team yet.",
      );
    }

    const { from, to } = resolveRange(data.range);

    // The user set is COMPUTED, never supplied. For "org" it stays undefined
    // and the query is unfiltered by user.
    let userIds: string[] | undefined;
    if (data.scope === "mine") userIds = [userId];
    else if (data.scope === "team") {
      userIds = [...new Set([userId, ...groups.members.map((m) => m.user_id)])];
    }

    let q = supabaseAdmin
      .from("execution_traces")
      .select("user_id, cost_usd, tokens_in, tokens_out, latency_ms, status, llm_model, created_at")
      .gte("created_at", from)
      .lt("created_at", to);
    if (userIds) q = q.in("user_id", userIds);

    const { data: rowsRaw, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (rowsRaw ?? []) as TraceRow[];

    const ok = rows.filter((r) => r.status === "success").length;
    const totals = {
      runs: rows.length,
      cost_usd: sum(rows, cost),
      tokens: sum(rows, tokens),
      // null rather than 0 when there is nothing to judge: "0% success" and
      // "no runs" are different facts and a KPI tile must not conflate them.
      successRate: rows.length > 0 ? (ok / rows.length) * 100 : null,
      avgLatencyMs:
        rows.length > 0
          ? Math.round(sum(rows, (r) => Number(r.latency_ms ?? 0)) / rows.length)
          : null,
    };

    // ── Per person ─────────────────────────────────────────────────────────
    const perUser = new Map<string, SpendRow>();
    for (const r of rows) {
      const e = perUser.get(r.user_id) ?? {
        id: r.user_id,
        label: r.user_id,
        runs: 0,
        cost_usd: 0,
        tokens: 0,
      };
      e.runs++;
      e.cost_usd += cost(r);
      e.tokens += tokens(r);
      perUser.set(r.user_id, e);
    }

    // Names come from the admin auth API, not from a profile table that may not
    // have a row for everyone. Only for the ids actually present, and only for
    // scopes where a breakdown is shown at all.
    //
    // AN ID THAT DOES NOT RESOLVE IS SAID SO, not printed raw. Traces outlive
    // the accounts that made them — a deleted user, or a database restored
    // beside a fresh auth project, leaves spend attributed to an id with no
    // owner. On the instance this was first checked against, SEVEN of eight
    // people in the breakdown were in that state, one of them with 96 runs.
    // A bare UUID in a chargeback table reads as a rendering fault and cannot
    // be charged to anyone; naming it as a removed account is the same
    // information, honestly labelled.
    if (data.scope !== "mine" && perUser.size > 0) {
      try {
        const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const emails = new Map((list?.users ?? []).map((u) => [u.id, u.email ?? u.id]));
        for (const [id, row] of perUser) {
          row.label = personLabel(id, emails.get(id));
        }
      } catch {
        // Falling back to ids is ugly but honest; failing the whole dashboard
        // because a name lookup broke is not.
      }
    }

    // ── Per team ───────────────────────────────────────────────────────────
    // A user in two teams contributes their spend to BOTH, so these do not sum
    // to the total. That is the correct reading of "what did this team cost",
    // and the UI says so.
    const byGroup: SpendRow[] = [];
    if (data.scope !== "mine") {
      const membersOf = new Map<string, string[]>();
      for (const m of groups.members) {
        membersOf.set(m.group_id, [...(membersOf.get(m.group_id) ?? []), m.user_id]);
      }
      for (const gid of groups.groupIds) {
        const ids = new Set(membersOf.get(gid) ?? []);
        const mine = rows.filter((r) => ids.has(r.user_id));
        byGroup.push({
          id: gid,
          label: groups.names.get(gid) ?? gid,
          runs: mine.length,
          cost_usd: sum(mine, cost),
          tokens: sum(mine, tokens),
        });
      }
      byGroup.sort((a, b) => b.cost_usd - a.cost_usd);
    }

    const perModel = new Map<string, { model: string; runs: number; cost_usd: number }>();
    for (const r of rows) {
      const key = r.llm_model ?? "unknown";
      const e = perModel.get(key) ?? { model: key, runs: 0, cost_usd: 0 };
      e.runs++;
      e.cost_usd += cost(r);
      perModel.set(key, e);
    }

    return {
      scope: data.scope,
      range: data.range,
      from,
      to,
      available,
      totals,
      byUser:
        data.scope === "mine"
          ? []
          : [...perUser.values()].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 50),
      byGroup,
      topModels: [...perModel.values()].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 6),
    };
  });
