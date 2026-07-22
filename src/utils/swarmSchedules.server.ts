// Interval-based scheduled swarm runs. Wired into the shared 60s scheduler
// tick (bi/refresh.server ensureScheduler) and the /api/bi/cron catch-up path.
// Idempotent: a schedule runs only when interval_minutes have elapsed since its
// last run, and last_run_at is stamped BEFORE execution so overlapping ticks
// don't double-fire.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { executeSwarmServer } from "@/utils/swarmExecute.server";

function baseOrigin(passed?: string): string {
  return passed || process.env.PUBLIC_APP_URL || "http://localhost:8080";
}

export async function processDueSwarmSchedules(force = false, origin?: string): Promise<number> {
  const { data: rows, error } = await supabaseAdmin
    .from("swarm_schedules")
    .select("id, user_id, swarm_id, input, input_state, interval_minutes, reject_approvals, last_run_at")
    .eq("is_active", true);
  if (error || !rows || rows.length === 0) return 0;

  const now = Date.now();
  const base = baseOrigin(origin);
  let ran = 0;

  for (const s of rows) {
    const dueAt = s.last_run_at
      ? new Date(s.last_run_at).getTime() + s.interval_minutes * 60_000
      : 0;
    if (!force && now < dueAt) continue;

    // Claim this run immediately so a concurrent tick won't also fire it.
    await supabaseAdmin
      .from("swarm_schedules")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", s.id)
      .then(undefined, () => undefined);

    const { data: swarm } = await supabaseAdmin
      .from("swarms")
      .select("id, name, nodes, edges, user_id")
      .eq("id", s.swarm_id)
      .maybeSingle();
    if (!swarm || swarm.user_id !== s.user_id) {
      await supabaseAdmin
        .from("swarm_schedules")
        .update({ last_run_status: "error", last_run_error: "Swarm not found" })
        .eq("id", s.id)
        .then(undefined, () => undefined);
      continue;
    }

    const initialState =
      s.input_state && typeof s.input_state === "object" && !Array.isArray(s.input_state)
        ? (s.input_state as Record<string, string>)
        : {};

    try {
      const result = await executeSwarmServer({
        swarm,
        userId: s.user_id,
        origin: base,
        input: s.input ?? "",
        initialState,
        rejectApprovals: s.reject_approvals,
        source: "schedule",
      });
      await supabaseAdmin
        .from("swarm_schedules")
        .update({ last_run_status: result.status, last_run_error: result.error })
        .eq("id", s.id)
        .then(undefined, () => undefined);
    } catch (e) {
      await supabaseAdmin
        .from("swarm_schedules")
        .update({
          last_run_status: "error",
          last_run_error: e instanceof Error ? e.message : String(e),
        })
        .eq("id", s.id)
        .then(undefined, () => undefined);
    }
    ran++;
  }
  return ran;
}
