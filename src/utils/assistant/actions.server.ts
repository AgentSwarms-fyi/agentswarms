// The assistant's proposals, and carrying one out once its owner approves (R553).
//
// The rules and the words are in `@/lib/assistantActions` (pure). This file:
//
// - `proposeAssistantAction` (the `propose_action` tool): reads the thing with
//   the READER'S token, refuses one that is not theirs (a thing shared with
//   them is its owner's to change), checks the change against it as it is,
//   and files an approval in the reader's own inbox. Nothing changes.
// - `applyApprovedAssistantAction`: on approval, once (claimed through
//   `resumed_at`), as the owner, through the page's own path, after checking
//   the thing again as it is now.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  ACTION_KINDS,
  ACTIONS,
  ASSISTANT_ACTION,
  actionFromPayload,
  actionLines,
  actionLink,
  actionTitle,
  checkAction,
  isAction,
  isActionKind,
  type ActionKind,
  type ActionTarget,
  type ProposedAction,
} from "@/lib/assistantActions";
import { auditEvent } from "@/utils/audit.server";
import type { AgentToolContext, ToolDef } from "@/utils/tools/registry.server";

type Fail = { ok: false; error: string };
type Row = {
  id: string;
  name: string;
  user_id: string;
  schedule: string | null;
  is_active: boolean;
};

const TABLE: Record<ActionKind, "workflows" | "etl_pipelines"> = {
  workflow: "workflows",
  etl_pipeline: "etl_pipelines",
};
const COLUMNS = "id, name, user_id, schedule, is_active";

const targetOf = (r: Row): ActionTarget => ({
  name: r.name,
  scheduled: !!r.schedule && r.schedule !== "manual",
  isActive: r.is_active,
});

export const proposeActionTool: ToolDef = {
  type: "function",
  function: {
    name: "propose_action",
    description:
      "Propose one change to one of the user's OWN workflows or pipelines: run it now, or pause " +
      "or resume its schedule. Nothing happens: it waits in the user's approvals inbox until " +
      "they approve it. Use it only when the user asks for that change, with the thing's kind " +
      "and id (from a mention, the page, or find_my_work).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...ACTION_KINDS] },
        id: { type: "string", description: "Its id, exactly as given." },
        action: { type: "string", enum: [...ACTIONS] },
      },
      required: ["kind", "id", "action"],
    },
  },
};

export type ProposalResult =
  { ok: true; approvalId: string; title: string; alreadyWaiting: boolean } | Fail;

/** File the proposal in the reader's inbox, or say why not. */
export async function proposeAssistantAction(
  ctx: Pick<AgentToolContext, "sb" | "userId">,
  args: { kind?: unknown; id?: unknown; action?: unknown },
): Promise<ProposalResult> {
  if (!isActionKind(args.kind)) {
    return {
      ok: false,
      error: "Only a workflow or a pipeline can be run, paused or resumed this way.",
    };
  }
  if (!isAction(args.action))
    return { ok: false, error: "The change must be run_now, pause or resume." };
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { ok: false, error: "Give the thing's id, exactly as given." };
  const kind = args.kind;
  const action = args.action;

  // Read as the reader: what they cannot open is not there.
  const { data } = await ctx.sb.from(TABLE[kind]).select(COLUMNS).eq("id", id).maybeSingle();
  const row = data as Row | null;
  if (!row) return { ok: false, error: "No such workflow or pipeline is open to this user." };
  if (row.user_id !== ctx.userId) {
    return {
      ok: false,
      error: "That one is shared with the user, not theirs: only its owner can run or pause it.",
    };
  }
  const checked = checkAction(action, kind, targetOf(row));
  if (!checked.ok) return checked;

  const proposal: ProposedAction = { kind, id, action, name: row.name };
  const title = actionTitle(proposal);
  // The same change already waiting is not filed twice.
  const { data: waiting } = await supabaseAdmin
    .from("approvals")
    .select("id, payload")
    .eq("user_id", ctx.userId)
    .eq("action_type", ASSISTANT_ACTION)
    .eq("status", "pending");
  const same = (waiting ?? []).find((w) => {
    const p = actionFromPayload(w.payload);
    return p && p.kind === kind && p.id === id && p.action === action;
  });
  if (same) return { ok: true, approvalId: same.id, title, alreadyWaiting: true };

  const { data: filed, error } = await supabaseAdmin
    .from("approvals")
    .insert({
      user_id: ctx.userId,
      agent_name: "Assistant",
      action_type: ASSISTANT_ACTION,
      action_title: title,
      description: actionLines(proposal).join(" "),
      risk_level: "low",
      payload: { action: proposal, link: actionLink(proposal) } as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !filed) return { ok: false, error: error?.message ?? "The proposal was not saved" };
  auditEvent({
    userId: ctx.userId,
    action: "assistant.action.proposed",
    resourceType: kind,
    resourceId: id,
    resourceName: row.name,
    decisionId: filed.id,
    detail: { approval_id: filed.id, action },
  });
  return { ok: true, approvalId: filed.id, title, alreadyWaiting: false };
}

/** The tool: the reader's own token, or nothing. */
export async function runProposeAction(
  ctx: AgentToolContext,
  args: { kind?: unknown; id?: unknown; action?: unknown },
): Promise<string> {
  if (ctx.scopeUserId || !ctx.authToken) {
    return "Proposing a change works only in the signed-in app.";
  }
  const res = await proposeAssistantAction(ctx, args ?? {});
  if (!res.ok) return `Not proposed: ${res.error}`;
  return res.alreadyWaiting
    ? `Already waiting for the user's approval: ${res.title}. Tell them it is in their approvals inbox; nothing has happened yet.`
    : `Waiting for the user's approval: ${res.title}. Tell them to approve it in their approvals inbox (the tray at the top of the page); nothing happens until they do. Do not say it is done.`;
}

/** Carry out an approved proposal: once, as its owner, re-checked now. */
export async function applyApprovedAssistantAction(
  approvalId: string,
  callerId: string,
): Promise<{ ok: true; message: string; link: string } | Fail> {
  const { data: approval } = await supabaseAdmin
    .from("approvals")
    .select("id, user_id, action_type, status, payload")
    .eq("id", approvalId)
    .maybeSingle();
  if (!approval || approval.user_id !== callerId) return { ok: false, error: "Approval not found" };
  if (approval.action_type !== ASSISTANT_ACTION) {
    return { ok: false, error: "That approval is not one of the assistant's proposals" };
  }
  if (approval.status !== "approved") return { ok: false, error: `It was ${approval.status}` };
  const p = actionFromPayload(approval.payload);
  if (!p) return { ok: false, error: "That approval does not hold a change to make" };

  const { data: claimed } = await supabaseAdmin
    .from("approvals")
    .update({ resumed_at: new Date().toISOString() })
    .eq("id", approvalId)
    .is("resumed_at", null)
    .select("id");
  if (!claimed?.length) return { ok: false, error: "It has already been carried out" };
  const release = () =>
    supabaseAdmin.from("approvals").update({ resumed_at: null }).eq("id", approvalId);

  // As the owner, and as it is now: it may have been changed, paused or
  // deleted since it was proposed.
  const { data } = await supabaseAdmin
    .from(TABLE[p.kind])
    .select("*")
    .eq("id", p.id)
    .eq("user_id", callerId)
    .maybeSingle();
  const row = data as (Row & Record<string, unknown>) | null;
  if (!row) {
    await release();
    return { ok: false, error: "It no longer exists, or is no longer yours" };
  }
  const checked = checkAction(p.action, p.kind, targetOf(row));
  if (!checked.ok) {
    await release();
    return checked;
  }

  const done = await carryOut(p, row);
  if (!done.ok) {
    await release();
    return done;
  }
  auditEvent({
    userId: callerId,
    action: "assistant.action.applied",
    resourceType: p.kind,
    resourceId: p.id,
    resourceName: row.name,
    decisionId: approvalId,
    detail: {
      approval_id: approvalId,
      action: p.action,
      ...(done.runId ? { run_id: done.runId } : {}),
    },
  });
  return { ok: true, message: done.message, link: actionLink(p) };
}

async function carryOut(
  p: ProposedAction,
  row: Row & Record<string, unknown>,
): Promise<{ ok: true; message: string; runId?: string } | Fail> {
  if (p.action === "run_now") {
    if (p.kind === "workflow") {
      const { startWorkflowRun } = await import("@/utils/workflows/run.server");
      const res = await startWorkflowRun(row as never, "manual", { params: {} });
      return res.ok ? { ok: true, message: "A run started.", runId: res.runId } : res;
    }
    const { startEtlRun } = await import("@/utils/etl/service.server");
    const res = await startEtlRun(row as never, "manual");
    return res.ok ? { ok: true, message: "A run started.", runId: res.runId } : res;
  }
  const isActive = p.action === "resume";
  let nextRunAt: string | null = (row.next_run_at as string | null) ?? null;
  if (isActive) {
    // From its next scheduled time, as the page computes it.
    if (p.kind === "workflow") {
      const { nextWorkflowRunAt } = await import("@/utils/workflows/run.server");
      nextRunAt = nextWorkflowRunAt(
        row.schedule as never,
        new Date(),
        (row.cron_expr as string | null) ?? null,
        (row.timezone as string | null) ?? null,
      );
    } else {
      const { nextEtlRunAt } = await import("@/utils/etl/schedule.server");
      nextRunAt = nextEtlRunAt(
        String(row.schedule),
        new Date(),
        (row.cron_expr as string | null) ?? null,
        (row.timezone as string | null) ?? null,
      );
    }
  }
  const { error } = await supabaseAdmin
    .from(TABLE[p.kind])
    .update({ is_active: isActive, next_run_at: nextRunAt })
    .eq("id", p.id)
    .eq("user_id", row.user_id);
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    message: isActive ? "Its schedule is running again." : "Its schedule is paused.",
  };
}
