// Server functions backing the swarm approval-routing feature.
//
// - listApproverDirectory: any authenticated user can read a lightweight
//   directory of IAM users + groups so the approval node can target approvers.
//   Uses the service role (after validating the caller's token) because a
//   regular user's RLS only exposes their own memberships, not the whole team.
//
// - notifySwarmApprovers: resolves an approval's targeted approvers (users +
//   the members of any targeted groups) to email addresses and sends each a
//   "you have a pending approval" email. The person who ran the swarm is only
//   emailed if they explicitly appear in the approver set (i.e. they picked
//   themselves, or a group they belong to) — there is no auto-include.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendMail } from "@/lib/email/mailer.server";

export type ApproverDirectoryUser = {
  user_id: string;
  email: string | null;
  display_name: string | null;
};

export type ApproverDirectoryGroup = {
  id: string;
  name: string;
  member_user_ids: string[];
};

type AdminUser = { id: string; email?: string };

async function validateUser(accessToken: string | undefined) {
  if (!accessToken) return { ok: false as const, error: "Missing access token" };
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user)
    return { ok: false as const, error: error?.message ?? "Invalid session" };
  return { ok: true as const, userId: data.user.id };
}

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

export const listApproverDirectory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: false; error: string }
      | {
          ok: true;
          users: ApproverDirectoryUser[];
          groups: ApproverDirectoryGroup[];
          my_group_ids: string[];
        }
    > => {
      const auth = await validateUser(data.access_token);
      if (!auth.ok) return auth;

      const [authUsers, { data: profiles }, { data: groups }, { data: memberships }] =
        await Promise.all([
          listAllAuthUsers(),
          supabaseAdmin.from("profiles").select("user_id, display_name"),
          supabaseAdmin.from("iam_groups").select("id, name").order("name", { ascending: true }),
          supabaseAdmin.from("iam_group_members").select("group_id, user_id"),
        ]);

      const nameByUser = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));
      const membersByGroup = new Map<string, string[]>();
      const myGroupIds: string[] = [];
      for (const m of memberships ?? []) {
        const list = membersByGroup.get(m.group_id) ?? [];
        list.push(m.user_id);
        membersByGroup.set(m.group_id, list);
        if (m.user_id === auth.userId) myGroupIds.push(m.group_id);
      }

      const users: ApproverDirectoryUser[] = authUsers
        .map((u) => ({
          user_id: u.id,
          email: u.email ?? null,
          display_name: nameByUser.get(u.id) ?? null,
        }))
        .sort((a, b) =>
          (a.display_name ?? a.email ?? "").localeCompare(b.display_name ?? b.email ?? ""),
        );

      return {
        ok: true,
        users,
        groups: (groups ?? []).map((g) => ({
          id: g.id,
          name: g.name,
          member_user_ids: membersByGroup.get(g.id) ?? [],
        })),
        my_group_ids: myGroupIds,
      };
    },
  );

function approvalEmailHtml(args: {
  runnerName: string;
  actionTitle: string;
  swarmName: string;
  riskLevel: string;
  description: string;
  appOrigin: string;
}): string {
  const link = `${args.appOrigin.replace(/\/$/, "")}/dashboard`;
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
    <h2 style="margin:0 0 8px">Approval needed in AgentSwarms</h2>
    <p style="margin:0 0 16px;color:#475569">
      <strong>${esc(args.runnerName)}</strong> ran the swarm
      <strong>${esc(args.swarmName)}</strong> and it has paused for your approval.
    </p>
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:0 0 16px">
      <p style="margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#64748b">
        ${esc(args.riskLevel)} risk
      </p>
      <p style="margin:0 0 6px;font-weight:600">${esc(args.actionTitle)}</p>
      ${args.description ? `<p style="margin:0;color:#475569;font-size:14px;white-space:pre-wrap">${esc(args.description)}</p>` : ""}
    </div>
    <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">
      Review pending approvals
    </a>
    <p style="margin:16px 0 0;color:#94a3b8;font-size:12px">
      Open AgentSwarms and check the approvals bell in the top bar to approve or reject this step.
    </p>
  </div>`;
}

export const notifySwarmApprovers = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        approval_id: z.string().uuid(),
        app_origin: z.string().url(),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: false; error: string } | { ok: true; notified: number }> => {
      const auth = await validateUser(data.access_token);
      if (!auth.ok) return auth;

      const { data: approval, error } = await supabaseAdmin
        .from("approvals")
        .select(
          "id, user_id, agent_name, action_title, description, risk_level, approver_user_ids, approver_group_ids",
        )
        .eq("id", data.approval_id)
        .maybeSingle();
      if (error || !approval) return { ok: false, error: error?.message ?? "Approval not found" };
      // Only the swarm runner (owner) may trigger notifications for their run.
      if (approval.user_id !== auth.userId) return { ok: false, error: "Not authorized" };

      // Resolve recipients = explicit users ∪ members of targeted groups.
      // The runner is included ONLY if they appear here through their own
      // choices — we never auto-add them.
      const recipientIds = new Set<string>(approval.approver_user_ids ?? []);
      const groupIds = approval.approver_group_ids ?? [];
      if (groupIds.length > 0) {
        const { data: members } = await supabaseAdmin
          .from("iam_group_members")
          .select("user_id")
          .in("group_id", groupIds);
        for (const m of members ?? []) recipientIds.add(m.user_id);
      }
      if (recipientIds.size === 0) return { ok: true, notified: 0 };

      // Runner's display name for the email body.
      const { data: runnerProfile } = await supabaseAdmin
        .from("profiles")
        .select("display_name")
        .eq("user_id", approval.user_id)
        .maybeSingle();
      const { data: runnerAuth } = await supabaseAdmin.auth.admin.getUserById(approval.user_id);
      const runnerName = runnerProfile?.display_name || runnerAuth.user?.email || "A teammate";

      let notified = 0;
      await Promise.all(
        Array.from(recipientIds).map(async (uid) => {
          const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
          const email = u.user?.email;
          if (!email) return;
          const html = approvalEmailHtml({
            runnerName,
            actionTitle: approval.action_title,
            swarmName: approval.agent_name,
            riskLevel: approval.risk_level,
            description: approval.description ?? "",
            appOrigin: data.app_origin,
          });
          const res = await sendMail({
            to: email,
            subject: `Approval needed: ${approval.action_title}`,
            html,
            text: `${runnerName} ran a swarm that needs your approval: ${approval.action_title}. Open AgentSwarms and check the approvals bell.`,
          });
          if (res.sent) notified += 1;
        }),
      );

      await supabaseAdmin
        .from("approvals")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", approval.id);

      return { ok: true, notified };
    },
  );
