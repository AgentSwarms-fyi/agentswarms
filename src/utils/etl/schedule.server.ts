// Scheduled ETL runs + retry attempts. Same trigger fabric as everything else
// that runs on a clock here: the in-process 60s scheduler and /api/bi/cron
// both reach this through processScheduledWork() in bi/refresh.server.ts,
// under one cron lease, so N app replicas produce one sweep — the documented
// cadence, not N of them.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { nextCronOccurrence } from "@/lib/cron";
import {
  reconcileOrphanedEtlRuns,
  restartEtlAttempt,
  startEtlRun,
  type EtlPipelineRow,
} from "./service.server";

/** Fallback only — the effective value comes from Admin -> Developer runtime. */
const DEFAULT_PIPELINES_PER_SWEEP = 3;
const RETRIES_PER_SWEEP = 5;

export function nextEtlRunAt(
  schedule: string,
  from = new Date(),
  cronExpr?: string | null,
  timezone?: string | null,
): string | null {
  if (schedule === "hourly") return new Date(from.getTime() + 3600_000).toISOString();
  if (schedule === "daily") return new Date(from.getTime() + 24 * 3600_000).toISOString();
  if (schedule === "weekly") return new Date(from.getTime() + 7 * 24 * 3600_000).toISOString();
  if (schedule === "cron" && cronExpr) {
    try {
      return nextCronOccurrence(cronExpr, timezone, from)?.toISOString() ?? null;
    } catch {
      // An expression that stopped parsing (edited by hand in the DB, say)
      // must not wedge the sweep; the pipeline simply stops being scheduled
      // until it is fixed, which its next_run_at makes visible.
      return null;
    }
  }
  return null; // manual
}

/**
 * Run every active pipeline whose next_run_at has passed, then restart every
 * retrying run whose backoff has elapsed. next_run_at is advanced BEFORE the
 * run starts, not after it finishes: a pipeline that takes longer than its
 * interval should skip a beat, not queue an ever-growing backlog behind
 * itself.
 */
export async function processDueEtlPipelines(force = false): Promise<number> {
  const nowIso = new Date().toISOString();
  const { getPlatformResources } = await import("@/utils/notebookRuntime/config.server");
  const perSweep =
    (await getPlatformResources()).etlPipelinesPerSweep || DEFAULT_PIPELINES_PER_SWEEP;
  let query = supabaseAdmin
    .from("etl_pipelines")
    .select("*")
    .eq("is_active", true)
    .neq("schedule", "manual")
    .order("next_run_at", { ascending: true })
    .limit(perSweep);
  if (!force) query = query.lte("next_run_at", nowIso);

  const { data: due } = await query;
  let started = 0;
  for (const pipeline of (due ?? []) as EtlPipelineRow[]) {
    // The clock advance doubles as a compare-and-set CLAIM: only the sweep
    // that still sees the old next_run_at wins the row, so app replicas
    // behind a load balancer can all run this sweep without double-starting
    // a due pipeline.
    let claim = supabaseAdmin
      .from("etl_pipelines")
      .update({
        next_run_at: nextEtlRunAt(
          pipeline.schedule,
          new Date(),
          pipeline.cron_expr,
          pipeline.timezone,
        ),
      })
      .eq("id", pipeline.id);
    claim =
      pipeline.next_run_at === null
        ? claim.is("next_run_at", null)
        : claim.eq("next_run_at", pipeline.next_run_at);
    const { data: won } = await claim.select("id");
    if (!won?.length) continue; // another replica claimed this tick
    const res = await startEtlRun(pipeline, "schedule");
    if (res.ok) started++;
    else console.warn(`[etl-schedule] "${pipeline.name}" did not start: ${res.error}`);
  }

  // Retry attempts. These are ordinary starts of an existing run row, so the
  // overlap guard, audit trail and logs all see one logical run.
  const { data: retries } = await supabaseAdmin
    .from("etl_runs")
    .select("id, pipeline_id")
    .eq("status", "retrying")
    .lte("retry_at", nowIso)
    .order("retry_at", { ascending: true })
    .limit(RETRIES_PER_SWEEP);
  for (const r of retries ?? []) {
    const ok = await restartEtlAttempt(r.id);
    if (ok) started++;
  }

  // Orphaned runs: sessions that died without calling home.
  await reconcileOrphanedEtlRuns().catch((e) =>
    console.warn("[etl-reaper] failed:", (e as Error).message),
  );
  // Training jobs share the sandbox and the failure modes; sweep them too.
  await import("@/utils/ml/train.server")
    .then((m) => m.reconcileOrphanedMlJobs())
    .catch((e) => console.warn("[ml] orphan sweep failed:", (e as Error).message));

  return started;
}
