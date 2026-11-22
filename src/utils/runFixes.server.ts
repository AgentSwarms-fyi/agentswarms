// Fixing what keeps failing (R525): reading what failed, applying the change,
// and asking its owner in the approvals inbox.
//
// The same three rules as hiding personal columns (R521) and promoting a
// model: ONE implementation of each change, which the Runs page's button and
// an approved suggestion both call; AUTHORITY IS THE THING BEING CHANGED, never
// the approval row its owner can write; and each change is checked again
// against the thing as it is now, not as it was when the fix was proposed.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  fixFromPayload,
  fixSignature,
  pickTimestampColumn,
  proposeRunFix,
  RUN_FIX_ACTION,
  type FixInput,
  type FixTarget,
  type FixVerdict,
  type PastRun,
  type RunFix,
} from "@/lib/runFixes";
import { auditEvent } from "@/utils/audit.server";
import { notifyUser } from "@/utils/notify.server";

/** Past runs read per thing: enough to say "the last N runs failed the same way". */
const HISTORY = 500;
/** Things looked at per sweep. */
const SWEEP_CAP = 100;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long a table's columns are waited for before saying they could not be read. */
export const COLUMNS_TIMEOUT_MS = 20_000;

type Fail = { ok: false; error: string };
type Done = { ok: true; message: string };

/** A lakehouse table's columns, as its owner may see them; null when unreadable. */
async function lakehouseColumns(
  userId: string,
  schema: string,
  table: string,
): Promise<Array<{ name: string; type: string }> | null> {
  try {
    // FOUND FROM THE UI (R525). This read the whole lakehouse listing, which
    // attaches every Iceberg mount first; one on an unreachable host held the
    // fix dialog at "Reading its recent runs…" for over a minute, every time.
    // One table's columns come from one statement against that table, read
    // through the same access check, and bounded: unread columns are said,
    // not waited for.
    const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
    const { qualifiedTable } = await import("@/utils/dataMonitors/core");
    const res = await Promise.race([
      runLakehouseStatement(userId, `SELECT * FROM ${qualifiedTable(schema, table)} LIMIT 0`, {
        rowCap: 1,
        timeoutMs: COLUMNS_TIMEOUT_MS,
        auditVia: "run_fix",
        useCache: false,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), COLUMNS_TIMEOUT_MS)),
    ]);
    return res ? res.columns.map((c) => ({ name: c.name, type: c.type })) : null;
  } catch {
    return null;
  }
}

/** What a fix is proposed from, read for its owner only. Null when it is not theirs. */
export async function loadFixInput(target: FixTarget, userId: string): Promise<FixInput | null> {
  if (target.type === "data_monitor") {
    const { data: m } = await supabaseAdmin
      .from("data_monitors")
      .select("id, name, user_id, kind, config, is_active, source_kind, schema_name, table_name")
      .eq("id", target.id)
      .maybeSingle();
    if (!m || m.user_id !== userId) return null;
    const { data: runs } = await supabaseAdmin
      .from("data_monitor_runs")
      .select("status, message")
      .eq("monitor_id", m.id)
      .order("ran_at", { ascending: false })
      .limit(HISTORY);
    const column = (m.config as { column?: unknown } | null)?.column;
    // Columns are read only where they decide something: a freshness check,
    // on the lakehouse (a warehouse table's columns are not read here yet).
    const columns =
      m.kind === "freshness" && m.source_kind === "lakehouse"
        ? await lakehouseColumns(userId, m.schema_name, m.table_name)
        : null;
    return {
      target,
      name: m.name,
      active: m.is_active,
      monitorKind: m.kind,
      column: typeof column === "string" ? column : null,
      columns,
      runs: (runs ?? []).map((r): PastRun => ({
        status: r.status,
        // A check that passed has a message too ("836 rows."); only a
        // failure or an alert carries an error.
        error: r.status === "ok" ? null : r.message,
      })),
      capped: (runs ?? []).length >= HISTORY,
    };
  }
  const { data: p } = await supabaseAdmin
    .from("etl_pipelines")
    .select("id, name, user_id, is_active")
    .eq("id", target.id)
    .maybeSingle();
  if (!p || p.user_id !== userId) return null;
  const { data: runs } = await supabaseAdmin
    .from("etl_runs")
    .select("status, error")
    .eq("pipeline_id", p.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY);
  return {
    target,
    name: p.name,
    active: p.is_active,
    runs: (runs ?? []).map((r): PastRun => ({
      status: r.status,
      error: /^(succeeded|success|ok|completed|running|queued|pending)$/i.test(r.status)
        ? null
        : r.error,
    })),
    capped: (runs ?? []).length >= HISTORY,
  };
}

/** Why it failed and the change that would fix it, for its owner. */
export async function diagnoseRun(target: FixTarget, userId: string): Promise<FixVerdict | null> {
  const input = await loadFixInput(target, userId);
  return input ? proposeRunFix(input) : null;
}

/**
 * Apply a fix. THE ONLY PLACE THAT DOES. Checked against the thing as it is
 * now: its owner, and for a column, that the column is still there and still
 * holds dates or times.
 */
export async function applyRunFix(
  target: FixTarget,
  fix: RunFix,
  actorId: string,
  approvalId?: string | null,
): Promise<Done | Fail> {
  const notYours: Fail = { ok: false, error: "Only its owner can change it" };
  const audit = (name: string, detail: Record<string, unknown>) => {
    // FOUND FROM THE UI (R525). The sweep had already put this fix in the
    // inbox when its owner applied it from the Runs page; the suggestion
    // stayed, waiting for a yes to a change already made. Applied once, any
    // suggestion still waiting for the same thing is withdrawn.
    void supabaseAdmin
      .from("approvals")
      .update({ status: "cancelled", decided_at: new Date().toISOString(), decided_by: actorId })
      .eq("action_type", RUN_FIX_ACTION)
      .eq("status", "pending")
      .eq("user_id", actorId)
      .contains("payload", { target: { id: target.id } })
      .then(({ error }) => {
        if (error) console.warn(`[run-fix] waiting suggestions kept: ${error.message}`);
      });
    auditEvent({
      userId: actorId,
      action: "run.fix.applied",
      resourceType: target.type,
      resourceId: target.id,
      resourceName: name,
      decisionId: approvalId ?? null,
      detail: { fix: fix.fix, approval_id: approvalId ?? null, ...detail },
    });
  };

  if (target.type === "data_monitor") {
    const { data: m } = await supabaseAdmin
      .from("data_monitors")
      .select("id, name, user_id, kind, config, is_active, source_kind, schema_name, table_name")
      .eq("id", target.id)
      .maybeSingle();
    if (!m || m.user_id !== actorId) return notYours;
    if (fix.fix === "pause") {
      const { error } = await supabaseAdmin
        .from("data_monitors")
        .update({ is_active: false })
        .eq("id", m.id)
        .eq("user_id", actorId);
      if (error) return { ok: false, error: error.message };
      audit(m.name, {});
      return { ok: true, message: `"${m.name}" is paused. Turn it back on from Data monitors.` };
    }
    if (m.kind !== "freshness")
      return { ok: false, error: "That check does not read a timestamp column" };
    if (m.source_kind !== "lakehouse") {
      return { ok: false, error: "Only a lakehouse table's columns can be checked here" };
    }
    const columns = await lakehouseColumns(actorId, m.schema_name, m.table_name);
    const col = columns?.find((c) => c.name.toLowerCase() === fix.column.toLowerCase());
    // The column must still be there and still be a date or time: picking it
    // from the columns that qualify is the same test the proposal used.
    if (!columns || !col || pickTimestampColumn([col]) !== col.name) {
      return {
        ok: false,
        error: `"${fix.column}" is not a date or time column of that table any more`,
      };
    }
    const config = { ...((m.config ?? {}) as Record<string, unknown>), column: col.name };
    const { error } = await supabaseAdmin
      .from("data_monitors")
      .update({
        config: config as Json,
        // A changed rule does not keep the old rule's result (R319), and it
        // is checked on the scheduler's next pass.
        last_status: null,
        last_value: null,
        last_message: null,
        last_run_at: null,
        consecutive_alerts: 0,
        next_run_at: m.is_active ? new Date().toISOString() : null,
      } as never)
      .eq("id", m.id)
      .eq("user_id", actorId);
    if (error) return { ok: false, error: error.message };
    audit(m.name, { column: col.name, from: (m.config as { column?: unknown })?.column ?? null });
    return { ok: true, message: `"${m.name}" now checks "${col.name}". It runs on the next pass.` };
  }

  const { data: p } = await supabaseAdmin
    .from("etl_pipelines")
    .select("id, name, user_id")
    .eq("id", target.id)
    .maybeSingle();
  if (!p || p.user_id !== actorId) return notYours;
  if (fix.fix !== "pause") return { ok: false, error: "A pipeline can only be paused here" };
  const { error } = await supabaseAdmin
    .from("etl_pipelines")
    .update({ is_active: false })
    .eq("id", p.id)
    .eq("user_id", actorId);
  if (error) return { ok: false, error: error.message };
  audit(p.name, {});
  return {
    ok: true,
    message: `"${p.name}" is paused. Turn its schedule back on from ETL Pipelines.`,
  };
}

/** Carry out a fix its owner approved, once, checked against the thing itself. */
export async function applyApprovedRunFix(
  approvalId: string,
  callerId: string,
): Promise<Done | Fail> {
  const { data: approval } = await supabaseAdmin
    .from("approvals")
    .select("id, user_id, action_type, status, payload")
    .eq("id", approvalId)
    .maybeSingle();
  if (!approval || approval.user_id !== callerId) return { ok: false, error: "Approval not found" };
  if (approval.action_type !== RUN_FIX_ACTION) {
    return { ok: false, error: "That approval is not a suggested fix" };
  }
  if (approval.status !== "approved") return { ok: false, error: `It was ${approval.status}` };
  const parsed = fixFromPayload(approval.payload);
  if (!parsed) return { ok: false, error: "That approval does not name a fix" };

  const { data: claimed } = await supabaseAdmin
    .from("approvals")
    .update({ resumed_at: new Date().toISOString() })
    .eq("id", approvalId)
    .is("resumed_at", null)
    .select("id");
  if (!claimed?.length) return { ok: false, error: "It has already been carried out" };

  const res = await applyRunFix(parsed.target, parsed.fix, callerId, approvalId);
  // A failure gives the claim back, so pressing again can still carry it out.
  if (!res.ok)
    await supabaseAdmin.from("approvals").update({ resumed_at: null }).eq("id", approvalId);
  return res;
}

/** Whether this fix, or any fix for this thing, has been asked about. */
async function alreadyAsked(target: FixTarget, fix: RunFix): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("approvals")
    .select("status, payload")
    .eq("action_type", RUN_FIX_ACTION)
    .contains("payload", { target: { id: target.id } });
  const sig = fixSignature(target, fix);
  return (data ?? []).some((r) => {
    if (r.status === "pending") return true;
    const prior = fixFromPayload(r.payload);
    return !!prior && fixSignature(prior.target, prior.fix) === sig;
  });
}

/** Ask a thing's owner, in the approvals inbox, whether to apply its fix. */
export async function suggestRunFix(target: FixTarget, ownerId: string): Promise<boolean> {
  const verdict = await diagnoseRun(target, ownerId);
  const p = verdict?.proposal;
  if (!p || (await alreadyAsked(p.target, p.fix))) return false;
  const link =
    target.type === "data_monitor" ? `/data-monitors?open=${target.id}` : `/etl?open=${target.id}`;
  const { data: row, error } = await supabaseAdmin
    .from("approvals")
    .insert({
      user_id: ownerId,
      agent_name: p.name,
      action_type: RUN_FIX_ACTION,
      action_title: p.title,
      description: `${p.cause} ${p.why} ${p.evidence} Approving makes this change; rejecting leaves it as it is, and you will not be asked about this change again.`,
      risk_level: "low",
      payload: {
        target: p.target,
        fix: p.fix,
        evidence: p.evidence,
        link,
      } as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "the suggestion was not saved");
  auditEvent({
    userId: ownerId,
    action: "run.fix.suggested",
    resourceType: target.type,
    resourceId: target.id,
    resourceName: p.name,
    decisionId: row.id,
    detail: { fix: p.fix, approval_id: row.id },
  });
  await notifyUser(ownerId, {
    title: `${p.name} keeps failing`,
    body: `${p.title}? ${p.evidence} Approve or reject it in your approvals.`,
    link,
    kind: "alert",
  });
  return true;
}

let lastSweep = 0;

/**
 * Checks and pipelines whose latest run failed, looked at for a fix their
 * owner can approve. Rides the scheduler's pass, a few times a day.
 */
export async function sweepRunFixes(force = false): Promise<number | null> {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return null;
  lastSweep = now;

  const [monitors, pipelines] = await Promise.all([
    supabaseAdmin
      .from("data_monitors")
      .select("id, user_id")
      .eq("is_active", true)
      .in("last_status", ["alert", "error"])
      .limit(SWEEP_CAP),
    supabaseAdmin
      .from("etl_pipelines")
      .select("id, user_id")
      .eq("is_active", true)
      .in("last_run_status", ["failed", "error"])
      .limit(SWEEP_CAP),
  ]);
  if (monitors.error) throw new Error(`run-fix sweep: ${monitors.error.message}`);
  if (pipelines.error) throw new Error(`run-fix sweep: ${pipelines.error.message}`);
  const targets: Array<{ target: FixTarget; owner: string }> = [
    ...(monitors.data ?? []).map((m) => ({
      target: { type: "data_monitor" as const, id: m.id },
      owner: m.user_id,
    })),
    ...(pipelines.data ?? []).map((p) => ({
      target: { type: "etl_pipeline" as const, id: p.id },
      owner: p.user_id,
    })),
  ];
  let asked = 0;
  for (const t of targets) {
    try {
      if (await suggestRunFix(t.target, t.owner)) asked++;
    } catch (e) {
      // One thing that cannot be read does not stop the rest.
      console.warn(
        `[run-fix] ${t.target.type} ${t.target.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return asked;
}
