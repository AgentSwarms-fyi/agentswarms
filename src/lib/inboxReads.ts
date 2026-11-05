// The approvals inbox and the notification bell, and a canvas run raising an
// approval. Since R450 what they carry is sealed under its owner's user key,
// which the browser does not hold, so they go through the server
// (src/utils/inbox.functions.ts); this gives the answers back as
// `{ data, error }`, as Supabase did, so the callers' handling stays what it was.
import { withToken } from "@/lib/chatHistory";
import {
  listNotifications,
  listPendingApprovals,
  raiseSwarmApproval,
} from "@/utils/inbox.functions";

/** The pending approvals the signed-in user may see, newest first. */
export async function pendingApprovals() {
  const r = await withToken((t) => listPendingApprovals({ data: { access_token: t } }));
  return { data: r.data?.approvals ?? null, error: r.error };
}

/** The signed-in user's latest notifications. */
export async function myNotifications() {
  const r = await withToken((t) => listNotifications({ data: { access_token: t } }));
  return { data: r.data?.notifications ?? null, error: r.error };
}

/** Raise an approval for a step of a run on the canvas. */
export async function raiseApproval(args: {
  runId: string | null;
  label: string;
  avatar: string;
  title: string;
  risk: string;
  content: string;
  approverUserIds: string[];
  approverGroupIds: string[];
}) {
  const r = await withToken((t) =>
    raiseSwarmApproval({
      data: {
        access_token: t,
        run_id: args.runId,
        label: args.label,
        avatar: args.avatar,
        title: args.title,
        risk: args.risk,
        content: args.content,
        approver_user_ids: args.approverUserIds,
        approver_group_ids: args.approverGroupIds,
      },
    }),
  );
  return { data: r.data?.id ? { id: r.data.id } : null, error: r.error };
}
