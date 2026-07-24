// Retention purge for the high-volume observability tables. Driven off the
// shared 60s scheduler tick (see runCronPass), self-throttled to hourly.
//
// Controlled by iam_settings.trace_retention_days:
//   0 (default) → keep forever, purge disabled (no behaviour change).
//   N > 0       → delete execution_traces and swarm_runs older than N days.
//                 swarm_run_steps is removed automatically (ON DELETE CASCADE
//                 from swarm_runs).
//
// Deletes are batched by id rather than issued as one unbounded statement, so a
// long-dormant instance with a huge backlog is cleared in bounded chunks
// instead of one giant, lock-holding transaction that could time out.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DELETE_BATCH = 1000;
let lastPurge = 0;

/** Delete rows older than `cutoff` in bounded id batches. Returns the count. */
async function purgeOlderThan(table: "execution_traces" | "swarm_runs", cutoff: string) {
  let removed = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("id")
      .lt("created_at", cutoff)
      .limit(DELETE_BATCH);
    if (error) {
      console.warn(`[trace-retention] ${table} read failed:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    const ids = data.map((r) => r.id);
    const { error: delErr } = await supabaseAdmin.from(table).delete().in("id", ids);
    if (delErr) {
      console.warn(`[trace-retention] ${table} delete failed:`, delErr.message);
      break;
    }
    removed += ids.length;
    if (data.length < DELETE_BATCH) break;
  }
  return removed;
}

/**
 * Purge execution traces and swarm runs beyond the configured retention window.
 * No-op when retention is 0/unset. Best-effort: never throws (the scheduler
 * treats a rejection as a warning, but there's no reason to surface one).
 */
export async function purgeTraces(force = false): Promise<{ traces: number; runs: number }> {
  const now = Date.now();
  if (!force && now - lastPurge < PURGE_INTERVAL_MS) return { traces: 0, runs: 0 };
  lastPurge = now;

  try {
    const { data: settings } = await supabaseAdmin
      .from("iam_settings")
      .select("trace_retention_days")
      .limit(1)
      .maybeSingle();
    const days = Number(settings?.trace_retention_days ?? 0);
    if (!Number.isFinite(days) || days <= 0) return { traces: 0, runs: 0 };

    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const traces = await purgeOlderThan("execution_traces", cutoff);
    const runs = await purgeOlderThan("swarm_runs", cutoff);
    return { traces, runs };
  } catch (e) {
    console.warn("[trace-retention] purge failed:", e instanceof Error ? e.message : String(e));
    return { traces: 0, runs: 0 };
  }
}
