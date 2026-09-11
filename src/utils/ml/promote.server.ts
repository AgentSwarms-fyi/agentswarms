// Putting a version in front of customers, and asking somebody first.
//
// Promotion used to be audited but not gated: an owner could move a model into
// production alone, and the record said so afterwards. Model-risk practice asks
// for a second signature BEFORE the change, from someone who did not make it.
//
// TWO RULES, and the second is the one that makes the first mean anything:
//
//   ONE IMPLEMENTATION OF "PROMOTE". `applyPromotion` below is the only code
//   that moves a version to a stage. The direct path and the approved path
//   both call it, so an approval can never take a slightly different route
//   than the one it approved — which is how a gate ends up guarding a door
//   nobody uses.
//
//   THE REQUESTER IS NEVER THE APPROVER. Enforced here rather than trusted to
//   configuration: a self-signed approval is an audit trail that says a review
//   happened when it did not, which is worse than no gate at all.
//
// The approval itself is public.approvals, the same table and the same inbox
// the swarm gates use. A second approvals system would have meant two inboxes
// and two things to remember.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { notifyUser } from "@/utils/notify.server";
import type { MlModelRow, MlVersionRow } from "./access.server";

export type MlStage = "candidate" | "staging" | "production" | "archived";
export type ApprovalRow = Database["public"]["Tables"]["approvals"]["Row"];

/** The action_type that marks an approval as a model promotion. */
export const ML_PROMOTE_ACTION = "ml.promote";

/** Whether this model's promotions to production need somebody else's yes. */
export function promotionGated(model: MlModelRow, stage: MlStage): boolean {
  return stage === "production" && (model.promotion_approvers ?? []).length > 0;
}

/**
 * Move a version to a stage. THE ONLY PLACE THAT DOES.
 *
 * `decidedBy` is recorded when this ran because somebody approved it, so the
 * audit entry names both the person who asked and the person who agreed.
 */
export async function applyPromotion(
  model: MlModelRow,
  version: MlVersionRow,
  stage: MlStage,
  userId: string,
  decidedBy?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (stage === "production" && version.status !== "ready") {
    return { ok: false, error: "Only a trained version can serve production" };
  }
  const now = new Date().toISOString();
  if (stage === "production") {
    if (model.production_version_id && model.production_version_id !== version.id) {
      await supabaseAdmin
        .from("ml_model_versions")
        .update({ stage: "archived" })
        .eq("id", model.production_version_id);
    }
    await supabaseAdmin
      .from("ml_models")
      .update({ production_version_id: version.id, updated_at: now })
      .eq("id", model.id);
  } else if (model.production_version_id === version.id) {
    await supabaseAdmin
      .from("ml_models")
      .update({ production_version_id: null, updated_at: now })
      .eq("id", model.id);
  }
  await supabaseAdmin.from("ml_model_versions").update({ stage }).eq("id", version.id);
  auditEvent({
    userId,
    action: "ml.version.promote",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    decisionId: version.id,
    detail: {
      version_id: version.id,
      version: version.version,
      from: version.stage,
      stage,
      approved_by: decidedBy ?? null,
      gated: Boolean(decidedBy),
    },
  });
  return { ok: true };
}

/**
 * Ask for a promotion instead of making one.
 *
 * One pending request per version at a time: pressing the button twice is not
 * two reviews, and two rows would mean one approval silently leaves another
 * dangling.
 */
export async function requestPromotion(
  model: MlModelRow,
  version: MlVersionRow,
  requestedBy: string,
): Promise<{ ok: true; pending: true; approvalId: string } | { ok: false; error: string }> {
  const approvers = (model.promotion_approvers ?? []).filter((a) => a !== requestedBy);
  if (!approvers.length) {
    return {
      ok: false,
      error:
        "You are the only approver named for this model, and nobody may approve their own " +
        "promotion. Add someone else before promoting.",
    };
  }

  const { data: existing } = await supabaseAdmin
    .from("approvals")
    .select("id")
    .eq("action_type", ML_PROMOTE_ACTION)
    .eq("status", "pending")
    .contains("payload", { version_id: version.id })
    .maybeSingle();
  if (existing) {
    return { ok: true, pending: true, approvalId: existing.id };
  }

  const { data: row, error } = await supabaseAdmin
    .from("approvals")
    .insert({
      // The approval belongs to the model's owner for listing, while
      // approver_user_ids decides who may actually answer it.
      user_id: model.user_id,
      agent_name: model.name,
      action_type: ML_PROMOTE_ACTION,
      action_title: `Promote "${model.name}" v${version.version} to production`,
      description:
        `Requested by a user who may not approve it. ` +
        `v${version.version} would replace the version serving production now.`,
      risk_level: "high",
      approver_user_ids: approvers,
      payload: {
        model_id: model.id,
        version_id: version.id,
        version: version.version,
        requested_by: requestedBy,
      } as Json,
    })
    .select("id")
    .single();
  if (error || !row) {
    return { ok: false, error: error?.message ?? "Could not raise the approval" };
  }

  auditEvent({
    userId: requestedBy,
    action: "ml.version.promote.requested",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    decisionId: version.id,
    detail: { version_id: version.id, version: version.version, approvers, approval_id: row.id },
  });
  for (const approver of approvers) {
    void notifyUser(approver, {
      title: `Approve promoting "${model.name}" v${version.version}?`,
      body: "A model version is waiting to go into production. It will not until you decide.",
      link: `/ml/${model.id}`,
    });
  }
  return { ok: true, pending: true, approvalId: row.id };
}

/**
 * Carry out a promotion somebody approved.
 *
 * Everything is re-checked HERE rather than trusted from the row the inbox
 * just wrote: that the approval is a promotion, that it was approved, that the
 * caller is a named approver, and — the one that matters — that the caller is
 * not the person who asked.
 */
export async function applyApprovedPromotion(
  approvalId: string,
  callerId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: approval } = await supabaseAdmin
    .from("approvals")
    .select("*")
    .eq("id", approvalId)
    .maybeSingle();
  if (!approval) return { ok: false, error: "Approval not found" };
  if (approval.action_type !== ML_PROMOTE_ACTION) {
    return { ok: false, error: "That approval is not a model promotion" };
  }
  if (approval.status !== "approved") {
    return { ok: false, error: `That promotion was ${approval.status}` };
  }
  if (!(approval.approver_user_ids ?? []).includes(callerId)) {
    return { ok: false, error: "You are not a named approver for this model" };
  }

  const payload = (approval.payload ?? {}) as {
    model_id?: string;
    version_id?: string;
    requested_by?: string;
  };
  if (payload.requested_by === callerId) {
    // Belt to the braces: requesters are filtered out of approver_user_ids
    // when the request is raised, so reaching this line means the row was
    // edited. A self-signed approval is an audit trail that lies.
    return { ok: false, error: "The person who asked for a promotion cannot approve it" };
  }
  if (!payload.model_id || !payload.version_id) {
    return { ok: false, error: "That approval does not name a version" };
  }

  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", payload.model_id)
    .maybeSingle();
  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("*")
    .eq("id", payload.version_id)
    .maybeSingle();
  if (!model || !version) return { ok: false, error: "The model or version is gone" };

  return await applyPromotion(
    model,
    version,
    "production",
    payload.requested_by ?? approval.user_id,
    callerId,
  );
}

/**
 * Resolve the people named as approvers, by email.
 *
 * By email rather than from a directory, because listing users is a
 * superadmin's privilege and a model owner naming a colleague should not need
 * one. Only the resolved id is ever returned — the caller never sees the
 * directory, and an unknown address comes back as an unknown address rather
 * than as a silent empty gate.
 */
export async function resolveApprovers(
  emails: string[],
): Promise<{ ids: string[]; unknown: string[] }> {
  const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return { ids: [], unknown: [] };
  const byEmail = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 500 });
    if (error) break;
    for (const u of data.users) {
      if (u.email) byEmail.set(u.email.toLowerCase(), u.id);
    }
    if (data.users.length < 500) break;
  }
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const e of wanted) {
    const id = byEmail.get(e);
    if (id) ids.push(id);
    else unknown.push(e);
  }
  return { ids, unknown };
}

/** The email for each approver id, for showing a configuration back. */
export async function approverEmails(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const out: Record<string, string> = {};
  for (const id of ids.slice(0, 20)) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(id);
    if (data?.user?.email) out[id] = data.user.email;
  }
  return out;
}

/** The pending promotion for a version, if one is waiting. */
export async function pendingPromotion(versionId: string): Promise<ApprovalRow | null> {
  const { data } = await supabaseAdmin
    .from("approvals")
    .select("*")
    .eq("action_type", ML_PROMOTE_ACTION)
    .eq("status", "pending")
    .contains("payload", { version_id: versionId })
    .maybeSingle();
  return data ?? null;
}
