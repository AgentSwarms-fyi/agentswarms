// Retention purge for the high-volume observability tables. Driven off the
// shared 60s scheduler tick (see runCronPass), self-throttled to hourly.
//
// Controlled by iam_settings.trace_retention_days:
//   0 (default) → keep forever, purge disabled (no behaviour change).
//   N > 0       → delete execution_traces and swarm_runs older than N days.
//                 swarm_run_steps is removed automatically (ON DELETE CASCADE
//                 from swarm_runs).
//
// EVIDENCE IS HELD LONGER. A trace carrying a decision_id is not telemetry: it
// is the record behind an answer someone was given, and deleting it empties
// that answer's passport while leaving the decision pointing at nothing. Those
// rows are kept for at least iam_settings.provenance_retention_days (default
// 183 -- the EU AI Act Article 26(6) six-month deployer floor), so a shorter
// trace window trims the noise without destroying the evidence. The floor
// never SHORTENS retention: where the ordinary window is longer, it wins.
//
// Deletes are batched by id rather than issued as one unbounded statement, so a
// long-dormant instance with a huge backlog is cleared in bounded chunks
// instead of one giant, lock-holding transaction that could time out.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DELETE_BATCH = 1000;
let lastPurge = 0;

/**
 * Delete rows older than `cutoff` in bounded id batches. Returns the count.
 *
 * `carriesDecision` splits the table by whether a row is part of some answer's
 * provenance, so the two halves can expire on different clocks.
 */
async function purgeOlderThan(
  table: "execution_traces" | "swarm_runs",
  cutoff: string,
  carriesDecision?: boolean,
) {
  let removed = 0;
  for (;;) {
    let q = supabaseAdmin.from(table).select("id").lt("created_at", cutoff).limit(DELETE_BATCH);
    // swarm_runs has no decision_id column; the split applies to traces only.
    if (carriesDecision !== undefined && table === "execution_traces") {
      q = carriesDecision ? q.not("decision_id", "is", null) : q.is("decision_id", null);
    }
    const { data, error } = await q;
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
    // provenance_retention_days arrives with migration 20260849000000; the
    // generated Database types predate it, hence the cast.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { data: settings } = await (supabaseAdmin.from("iam_settings") as any)
      .select("trace_retention_days, provenance_retention_days")
      .limit(1)
      .maybeSingle();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const days = Number(settings?.trace_retention_days ?? 0);
    if (!Number.isFinite(days) || days <= 0) return { traces: 0, runs: 0 };

    const cutoffMs = now - days * 86_400_000;
    const cutoff = new Date(cutoffMs).toISOString();
    const floorDays = Number(settings?.provenance_retention_days ?? 183);
    // Math.min on the TIMESTAMP, not the day count: the earlier cutoff is the
    // one that keeps rows longer, so a longer ordinary window always wins.
    const evidenceCutoff = new Date(
      Number.isFinite(floorDays) && floorDays > 0
        ? Math.min(cutoffMs, now - floorDays * 86_400_000)
        : cutoffMs,
    ).toISOString();

    const traces =
      (await purgeOlderThan("execution_traces", cutoff, false)) +
      (await purgeOlderThan("execution_traces", evidenceCutoff, true));
    const runs = await purgeOlderThan("swarm_runs", cutoff);

    // Decisions expire with the evidence they point at, never before it: a
    // decision row whose chain had been deleted would render as an answer with
    // no reads at all, which reads as "it used no data" rather than "the record
    // is gone". Same cutoff as the evidence, so the two disappear together.
    // Table added by migration 20260848000000; the generated types predate it.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { error: decErr } = await (supabaseAdmin.from("decisions" as any) as any)
      .delete()
      .lt("created_at", evidenceCutoff);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (decErr) console.warn("[trace-retention] decisions purge failed:", decErr.message);

    return { traces, runs };
  } catch (e) {
    console.warn("[trace-retention] purge failed:", e instanceof Error ? e.message : String(e));
    return { traces: 0, runs: 0 };
  }
}
