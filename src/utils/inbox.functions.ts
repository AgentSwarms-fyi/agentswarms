// The approvals inbox and the notification bell, through the server (R450). What
// they show is sealed under its owner's user key, which the browser does not
// hold.
//
// The inbox reads with the caller's own token, so row-level security still
// decides who sees what, and the two can never disagree: the server opens only
// rows the caller could already read. An approver is usually not the row's
// owner; the text stays under the owner's key and is opened for them.
//
// A swarm run on the canvas raised its approval from the browser, which cannot
// seal. raiseSwarmApproval does it here, under the service role, so it makes the
// checks the insert policy made: the caller's own request, on the caller's run.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";
import type { Database } from "@/integrations/supabase/types";
import { callerFailure } from "@/utils/callerLookup.server";

type Tables = Database["public"]["Tables"];

export type ApprovalView = Tables["approvals"]["Row"] & {
  body_sealed: boolean;
  body_dropped: boolean;
  body_unreadable: string | null;
};

export type NotificationView = Pick<
  Tables["notifications"]["Row"],
  "id" | "kind" | "title" | "body" | "link" | "read_at" | "created_at"
> & { body_unreadable: string | null };

async function callerId(accessToken: string): Promise<string | { error: string }> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { error: callerFailure(error, "Unauthorized") };
  return data.user.id;
}

const token = z.string().min(1);
const uuid = z.string().uuid();

/** The pending approvals the caller may see, opened, newest first. */
export const listPendingApprovals = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token }).parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; approvals: ApprovalView[] } | { ok: false; error: string }> => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!url || !key) return { ok: false, error: "Server is not configured" };
      const asCaller = createClient<Database>(
        url,
        key,
        withNulSafeFetch({
          global: { headers: { Authorization: `Bearer ${data.access_token}` } },
        }),
      );
      const { data: rows, error } = await asCaller
        .from("approvals")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (error) return { ok: false, error: error.message };
      const { openApprovalRows } = await import("@/utils/sealedInbox.server");
      return { ok: true, approvals: (await openApprovalRows(rows ?? [])) as ApprovalView[] };
    },
  );

/** Raise a swarm step's approval for a run on the canvas, its text sealed. */
export const raiseSwarmApproval = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({
        access_token: token,
        run_id: uuid.nullable(),
        label: z.string().max(500),
        avatar: z.string().max(40),
        title: z.string().max(1000),
        risk: z.string().max(40),
        content: z.string().max(4000),
        approver_user_ids: z.array(uuid).max(500),
        approver_group_ids: z.array(uuid).max(500),
      })
      .parse(v),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return { ok: false, error: user.error };
    // The insert policy's check: a request may name only the caller's own run.
    if (data.run_id) {
      const { data: run, error } = await supabaseAdmin
        .from("swarm_runs")
        .select("id")
        .eq("id", data.run_id)
        .eq("user_id", user)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!run) return { ok: false, error: "Run not found" };
    }
    const { sealApprovalBody } = await import("@/utils/sealedInbox.server");
    const id = crypto.randomUUID();
    const body = await sealApprovalBody(user, id, "swarm_step", {
      description: data.content.slice(0, 1000),
      payload: { last_output: data.content },
    });
    const { error } = await supabaseAdmin.from("approvals").insert({
      id,
      user_id: user,
      agent_name: data.label,
      agent_avatar: data.avatar,
      action_type: "swarm_step",
      action_title: data.title,
      description: body.description,
      risk_level: data.risk,
      payload: body.payload as never,
      approver_user_ids: data.approver_user_ids,
      approver_group_ids: data.approver_group_ids,
      swarm_run_id: data.run_id,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id };
  });

/** The caller's latest notifications, opened. */
export const listNotifications = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token }).parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; notifications: NotificationView[] } | { ok: false; error: string }> => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      const { data: rows, error } = await supabaseAdmin
        .from("notifications")
        .select("id, kind, title, body, link, read_at, created_at")
        .eq("user_id", user)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) return { ok: false, error: error.message };
      const { openNotificationRow } = await import("@/utils/sealedInbox.server");
      const notifications: NotificationView[] = [];
      for (const row of rows ?? []) notifications.push(await openNotificationRow(row));
      return { ok: true, notifications };
    },
  );
