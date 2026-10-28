// Actions: changing data through the ontology, with a record of every change.
//
// An action type (src/lib/ontology/spec.ts) says what may change on which
// type, with which parameters, under which submission criteria, whether a
// person must approve it, and what an agent may do with it. Requesting one:
//
//   1. the object must exist AND be visible to the requester — their share's
//      row filter applies, so a grantee cannot act on what they cannot see;
//   2. no parameter may set a property hidden from the requester;
//   3. the criteria must hold on the object as it is now;
//   4. then it is APPLIED as the requester, or recorded as PROPOSED when the
//      type requires approval (or an agent asks and may only propose). The
//      owner's approval re-checks the criteria on the data as it is then and
//      applies it as the owner.
//
// The write is an UPDATE / INSERT / DELETE through the governed lakehouse
// path: the lakehouse checks the writer may write that schema and records
// the statement. ontology_actions keeps the before and after of every change;
// every request, decision and failure is audited.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import type { OntologyAccess } from "@/utils/ontology/access.server";
import {
  friendlyLakehouseError,
  runRows,
  runSql,
  type ObjectRow,
} from "@/utils/ontology/run.server";
import {
  compileAction,
  compileGetObject,
  CompileError,
  isMasked,
  type CompileOpts,
  type Scalar,
} from "@/lib/ontology/compile";
import { findObjectType, type ActionType } from "@/lib/ontology/spec";

export type ActionOutcome =
  | {
      ok: true;
      status: "applied";
      action_id: string;
      before: ObjectRow | null;
      after: ObjectRow | null;
    }
  | { ok: true; status: "proposed"; action_id: string }
  | { ok: false; error: string; action_id?: string };

type Via = "ui" | "agent" | "api";

function findAction(access: OntologyAccess, name: string): ActionType | undefined {
  return access.spec.actionTypes.find((a) => a.name === name);
}

/** Run the write of an action, as `asUser`. Returns before / after. */
async function applyWrite(
  asUser: string,
  access: OntologyAccess,
  action: ActionType,
  key: Record<string, Scalar> | null,
  params: Record<string, Scalar | null>,
): Promise<{ before: ObjectRow | null; after: ObjectRow | null }> {
  const w = compileAction(access.spec, action, key, params);
  let before: ObjectRow | null = null;
  if (w.beforeSql) {
    const b = await runRows(asUser, w.beforeSql, null, { rowCap: 2, via: "ontology:action" });
    if (action.kind === "create") {
      if (b.rows.length) throw new CompileError("An object with that key already exists");
    } else {
      if (!b.rows.length) throw new CompileError("That object no longer exists");
      if (b.rows.length > 1)
        throw new CompileError("Two objects share that key; the action would change both");
      before = b.rows[0];
    }
  }
  if (w.criteriaSql) {
    const c = await runRows(asUser, w.criteriaSql, null, { rowCap: 1, via: "ontology:action" });
    if (c.rows[0]?.ok !== true) {
      throw new CompileError(`The object does not meet this action's criteria: ${action.criteria}`);
    }
  }
  await runSql(asUser, w.writeSql, { rowCap: 1, via: "ontology:action" });
  let after: ObjectRow | null = null;
  if (w.afterSql) {
    const a = await runRows(asUser, w.afterSql, null, { rowCap: 1, via: "ontology:action" });
    after = a.rows[0] ?? null;
  }
  return { before, after };
}

export async function requestAction(args: {
  userId: string;
  access: OntologyAccess;
  opts: CompileOpts;
  actionName: string;
  key: Record<string, Scalar> | null;
  params: Record<string, Scalar | null>;
  via: Via;
}): Promise<ActionOutcome> {
  const { userId, access, opts, actionName, key, params, via } = args;
  const action = findAction(access, actionName);
  if (!action) return { ok: false, error: `This ontology has no action \`${actionName}\`` };
  const t = findObjectType(access.spec, action.objectType);
  if (!t) return { ok: false, error: `Unknown object type ${action.objectType}` };
  if (via === "agent" && action.agentMode === "none") {
    return { ok: false, error: `Agents may not use the action "${action.label ?? action.name}"` };
  }
  // 2. Nothing hidden from the requester may be written by them.
  for (const p of action.parameters) {
    if (p.name in params && isMasked(access.spec, t, p.property, opts)) {
      return { ok: false, error: `You cannot set ${t.name}.${p.property}: it is hidden from you` };
    }
  }
  // 1. The object must be one the requester can see.
  if (action.kind !== "create") {
    if (!key) return { ok: false, error: "Which object? The key is missing" };
    try {
      const g = compileGetObject(access.spec, t.name, key, opts);
      const seen = await runRows(userId, g.sql, g.columns, { rowCap: 2, via: "ontology:action" });
      if (!seen.rows.length)
        return { ok: false, error: `No ${t.name} with that key is visible to you` };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof CompileError ? e.message : friendlyLakehouseError(e),
      };
    }
  }
  // Check the parameters compile before anything is recorded.
  try {
    compileAction(access.spec, action, key, params);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const mustPropose =
    action.requiresApproval || (via === "agent" && action.agentMode === "propose");
  const base = {
    ontology_id: access.row.id,
    action_name: action.name,
    object_type: t.name,
    object_key: (key ?? null) as unknown as Json,
    params: params as unknown as Json,
    via,
    requested_by: userId,
  };
  if (mustPropose) {
    const { data: row, error } = await supabaseAdmin
      .from("ontology_actions")
      .insert({ ...base, status: "proposed" })
      .select("id")
      .single();
    if (error || !row)
      return { ok: false, error: error?.message ?? "Could not record the request" };
    auditEvent({
      userId,
      action: "ontology.action.propose",
      resourceType: "ontology",
      resourceId: access.row.id,
      resourceName: access.row.name,
      detail: { action_id: row.id, action: action.name, object_type: t.name, key, params, via },
    });
    return { ok: true, status: "proposed", action_id: row.id };
  }

  try {
    const { before, after } = await applyWrite(userId, access, action, key, params);
    const { data: row } = await supabaseAdmin
      .from("ontology_actions")
      .insert({
        ...base,
        status: "applied",
        before: before as unknown as Json,
        after: after as unknown as Json,
        decided_by: userId,
        decided_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    auditEvent({
      userId,
      action: "ontology.action.apply",
      resourceType: "ontology",
      resourceId: access.row.id,
      resourceName: access.row.name,
      detail: {
        action_id: row?.id ?? null,
        action: action.name,
        object_type: t.name,
        key,
        params,
        via,
      },
    });
    return { ok: true, status: "applied", action_id: row?.id ?? "", before, after };
  } catch (e) {
    const error = e instanceof CompileError ? e.message : friendlyLakehouseError(e);
    const { data: row } = await supabaseAdmin
      .from("ontology_actions")
      .insert({ ...base, status: "failed", error: error.slice(0, 4000) })
      .select("id")
      .single();
    auditEvent({
      userId,
      action: "ontology.action.fail",
      resourceType: "ontology",
      resourceId: access.row.id,
      resourceName: access.row.name,
      detail: {
        action_id: row?.id ?? null,
        action: action.name,
        key,
        error: error.slice(0, 500),
        via,
      },
    });
    return { ok: false, error, ...(row?.id ? { action_id: row.id } : {}) };
  }
}

/** The owner approves or rejects a proposed action. Approving applies it, as the owner. */
export async function decideAction(args: {
  userId: string;
  access: OntologyAccess;
  actionId: string;
  approve: boolean;
  note?: string;
}): Promise<ActionOutcome> {
  const { userId, access, actionId, approve, note } = args;
  const { data: req } = await supabaseAdmin
    .from("ontology_actions")
    .select("id, action_name, object_type, object_key, params, status, requested_by, via")
    .eq("id", actionId)
    .eq("ontology_id", access.row.id)
    .maybeSingle();
  if (!req) return { ok: false, error: "That request does not exist" };
  if (req.status !== "proposed")
    return { ok: false, error: `That request is already ${req.status}` };
  const decidedAt = new Date().toISOString();
  if (!approve) {
    await supabaseAdmin
      .from("ontology_actions")
      .update({
        status: "rejected",
        decided_by: userId,
        decided_at: decidedAt,
        decision_note: note ?? null,
      })
      .eq("id", req.id)
      .eq("status", "proposed");
    auditEvent({
      userId,
      action: "ontology.action.reject",
      resourceType: "ontology",
      resourceId: access.row.id,
      resourceName: access.row.name,
      detail: {
        action_id: req.id,
        action: req.action_name,
        requested_by: req.requested_by,
        note: note ?? null,
      },
    });
    return { ok: false, error: "Rejected", action_id: req.id };
  }
  const action = findAction(access, req.action_name);
  if (!action) {
    return {
      ok: false,
      error: `The action "${req.action_name}" is no longer in the model`,
      action_id: req.id,
    };
  }
  try {
    const { before, after } = await applyWrite(
      userId,
      access,
      action,
      (req.object_key ?? null) as Record<string, Scalar> | null,
      (req.params ?? {}) as Record<string, Scalar | null>,
    );
    // Only a still-proposed request moves to applied: two approvals at once
    // cannot both claim it.
    await supabaseAdmin
      .from("ontology_actions")
      .update({
        status: "applied",
        before: before as unknown as Json,
        after: after as unknown as Json,
        decided_by: userId,
        decided_at: decidedAt,
        decision_note: note ?? null,
      })
      .eq("id", req.id)
      .eq("status", "proposed");
    auditEvent({
      userId,
      action: "ontology.action.approve",
      resourceType: "ontology",
      resourceId: access.row.id,
      resourceName: access.row.name,
      detail: {
        action_id: req.id,
        action: req.action_name,
        requested_by: req.requested_by,
        via: req.via,
      },
    });
    return { ok: true, status: "applied", action_id: req.id, before, after };
  } catch (e) {
    const error = e instanceof CompileError ? e.message : friendlyLakehouseError(e);
    await supabaseAdmin
      .from("ontology_actions")
      .update({
        status: "failed",
        error: error.slice(0, 4000),
        decided_by: userId,
        decided_at: decidedAt,
      })
      .eq("id", req.id)
      .eq("status", "proposed");
    auditEvent({
      userId,
      action: "ontology.action.fail",
      resourceType: "ontology",
      resourceId: access.row.id,
      resourceName: access.row.name,
      detail: { action_id: req.id, action: req.action_name, error: error.slice(0, 500) },
    });
    return { ok: false, error, action_id: req.id };
  }
}
