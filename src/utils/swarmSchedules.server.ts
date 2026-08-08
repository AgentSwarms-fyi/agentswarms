// Interval-based scheduled swarm runs. Wired into the shared 60s scheduler
// tick (bi/refresh.server ensureScheduler) and the /api/bi/cron catch-up path.
//
// A scheduled swarm run is NOT idempotent from the outside: it calls models,
// spends budget, and can send notifications or hit webhooks. Firing one twice
// is a real, billable, sometimes user-visible event — so the guards below are
// about "exactly once", not about tidiness.
//
// The decision logic is exported and unit-tested. The database calls are not
// worth mocking, but which schedules are DUE, and whether a swarm may be run
// by a given schedule, are decisions that must be right and were previously
// untestable because they were inline.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { executeSwarmServer } from "@/utils/swarmExecute.server";
import { resolveDeployedGraph } from "@/lib/swarmPublish";
import { resolveInternalOrigin } from "@/utils/internalOrigin.server";

export type ScheduleRow = {
  id: string;
  user_id: string;
  swarm_id: string;
  input: string | null;
  input_state: unknown;
  interval_minutes: number;
  reject_approvals: boolean;
  last_run_at: string | null;
};

/**
 * Whether a schedule is due.
 *
 * A schedule that has NEVER run is due immediately — otherwise creating one
 * means waiting a full interval before anything happens, and for a weekly
 * schedule that reads as broken.
 *
 * An unusable interval is treated as NOT due rather than as "every tick". A
 * zero or negative interval_minutes would otherwise make the swarm run once a
 * minute, for ever, spending real money.
 */
export function isScheduleDue(
  s: Pick<ScheduleRow, "last_run_at" | "interval_minutes">,
  now: number,
  force = false,
): boolean {
  if (force) return true;
  if (!s.last_run_at) return true;
  const interval = Number(s.interval_minutes);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  const last = new Date(s.last_run_at).getTime();
  // An unparseable timestamp must not compute NaN and compare false for ever,
  // stranding the schedule; treat it as never-run.
  if (!Number.isFinite(last)) return true;
  return now >= last + interval * 60_000;
}

/**
 * The stored input_state as a string map.
 *
 * Arrays are excluded deliberately: `typeof [] === "object"`, so an array
 * would pass a naive check and then spread into `{0: …, 1: …}` state keys.
 */
export function coerceInitialState(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
    else if (val !== null && val !== undefined && typeof val !== "object") out[k] = String(val);
  }
  return out;
}

/**
 * Whether this schedule may run this swarm.
 *
 * A TENANT BOUNDARY, not a sanity check. These run under the service role with
 * RLS off, so a schedule row carrying another user's swarm_id would otherwise
 * execute that user's swarm — reading their data, spending their connections —
 * under the scheduler's authority. Fails closed on a missing swarm.
 */
export function scheduleMayRun(
  s: Pick<ScheduleRow, "user_id">,
  swarm: { user_id?: string | null } | null | undefined,
): boolean {
  return !!swarm && !!swarm.user_id && swarm.user_id === s.user_id;
}

let processing = false;

/**
 * Claim a schedule by stamping last_run_at, conditionally.
 *
 * The condition is the value we READ — optimistic concurrency. If another
 * instance (or an overlapping tick) already claimed it, last_run_at no longer
 * matches and this update touches nothing, so exactly one caller proceeds.
 *
 * The previous version updated unconditionally, which claimed nothing: both
 * callers had already read the same due row, both stamped it, and both ran the
 * swarm. `.is(null)` rather than `.eq(null)` matters — PostgREST does not
 * translate an equality against null into IS NULL, so a never-run schedule
 * would never match and could never be claimed.
 */
async function claimSchedule(s: ScheduleRow): Promise<boolean> {
  let q = supabaseAdmin
    .from("swarm_schedules")
    .update({ last_run_at: new Date().toISOString() })
    .eq("id", s.id);
  q = s.last_run_at ? q.eq("last_run_at", s.last_run_at) : q.is("last_run_at", null);
  const { data } = await q.select("id");
  return (data ?? []).length > 0;
}

export async function processDueSwarmSchedules(force = false): Promise<number> {
  // Two ticks overlapping inside ONE process would both read the same due rows.
  // The conditional claim below already makes that safe, but not re-entering is
  // cheaper than racing and losing.
  if (processing) return 0;
  processing = true;
  try {
    const { data: rows, error } = await supabaseAdmin
      .from("swarm_schedules")
      .select(
        "id, user_id, swarm_id, input, input_state, interval_minutes, reject_approvals, last_run_at",
      )
      .eq("is_active", true);
    if (error || !rows || rows.length === 0) return 0;

    const now = Date.now();
    const base = resolveInternalOrigin();
    let ran = 0;

    for (const s of rows as ScheduleRow[]) {
      if (!isScheduleDue(s, now, force)) continue;
      if (!(await claimSchedule(s))) continue;

      const { data: swarm } = await supabaseAdmin
        .from("swarms")
        .select("id, name, nodes, edges, user_id, published_nodes, published_edges, published_at")
        .eq("id", s.swarm_id)
        .maybeSingle();

      if (!scheduleMayRun(s, swarm)) {
        await supabaseAdmin
          .from("swarm_schedules")
          .update({ last_run_status: "error", last_run_error: "Swarm not found" })
          .eq("id", s.id)
          .then(undefined, () => undefined);
        continue;
      }

      try {
        // Scheduled runs are unattended — they get the published snapshot for
        // the same reason API keys do.
        const pinned = resolveDeployedGraph(swarm!);
        const result = await executeSwarmServer({
          swarm: { id: swarm!.id, name: swarm!.name, nodes: pinned.nodes, edges: pinned.edges },
          userId: s.user_id,
          origin: base,
          input: s.input ?? "",
          initialState: coerceInitialState(s.input_state),
          rejectApprovals: s.reject_approvals,
          source: "schedule",
        });
        await supabaseAdmin
          .from("swarm_schedules")
          .update({
            last_run_status: result.status,
            last_run_error: result.error,
            // Re-stamp on COMPLETION so the next due time is measured from when
            // this run finished. Stamping only at claim time means a run lasting
            // longer than interval_minutes is already overdue when it ends, so
            // the following tick fires immediately and runs pile up.
            last_run_at: new Date().toISOString(),
          })
          .eq("id", s.id)
          .then(undefined, () => undefined);
      } catch (e) {
        await supabaseAdmin
          .from("swarm_schedules")
          .update({
            last_run_status: "error",
            last_run_error: e instanceof Error ? e.message : String(e),
            last_run_at: new Date().toISOString(),
          })
          .eq("id", s.id)
          .then(undefined, () => undefined);
      }
      ran++;
    }
    return ran;
  } finally {
    processing = false;
  }
}
