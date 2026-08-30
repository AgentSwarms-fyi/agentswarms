// Pure aggregation for the ETL home dashboard. Kept out of the RPC so the
// numbers a user trusts at a glance — success rate, rows loaded, what is
// running right now — are pinned by unit tests instead of recomputed ad hoc
// in a component.

export type OverviewRun = {
  pipeline_id: string;
  status: string;
  trigger: string;
  attempt: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  metrics: unknown;
};

export type PipelinePulse = {
  /** Newest-first statuses of the last runs, capped for the dot strip. */
  recent: string[];
  /** Success rate over those finished runs; null when none finished. */
  success_rate: number | null;
  /** Sandbox runtime attributed to this pipeline over the 7-day window. */
  runtime_ms_7d: number;
  /** Rows loaded by this pipeline's succeeded runs over the window. */
  rows_7d: number;
};

/** Wall-clock a run actually held a sandbox; 0 while queued or unstamped. */
export function runDurationMs(r: OverviewRun, now: Date): number {
  if (!r.started_at) return 0;
  const start = new Date(r.started_at).getTime();
  const end = r.finished_at ? new Date(r.finished_at).getTime() : now.getTime();
  return Math.max(0, end - start);
}

export type EtlOverviewStats = {
  runs_7d: number;
  /** Total sandbox runtime across all pipelines in the window. */
  runtime_ms_7d: number;
  succeeded_7d: number;
  failed_7d: number;
  /** Of FINISHED runs in the window — live/cancelled runs are not verdicts. */
  success_rate_7d: number | null;
  rows_loaded_7d: number;
  running_now: number;
};

const LIVE = new Set(["running", "queued", "retrying"]);
export const PULSE_LIMIT = 10;

export function rowsLoadedOf(metrics: unknown): number {
  const n = (metrics as { rows_loaded?: unknown } | null)?.rows_loaded;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function computeEtlOverview(
  runs: OverviewRun[],
  now: Date = new Date(),
): { stats: EtlOverviewStats; per_pipeline: Record<string, PipelinePulse> } {
  const weekAgo = now.getTime() - 7 * 86_400_000;

  let runs7d = 0;
  let ok7d = 0;
  let failed7d = 0;
  let rows7d = 0;
  let live = 0;

  const byPipeline = new Map<string, OverviewRun[]>();
  for (const r of runs) {
    if (LIVE.has(r.status)) live++;
    const t = new Date(r.created_at).getTime();
    if (t >= weekAgo) {
      runs7d++;
      if (r.status === "succeeded") {
        ok7d++;
        rows7d += rowsLoadedOf(r.metrics);
      } else if (r.status === "failed") {
        failed7d++;
      }
    }
    const list = byPipeline.get(r.pipeline_id) ?? [];
    list.push(r);
    byPipeline.set(r.pipeline_id, list);
  }

  const perPipeline: Record<string, PipelinePulse> = {};
  let runtime7d = 0;
  for (const [id, list] of byPipeline) {
    // Callers pass runs newest-first; keep that order and cap.
    const recent = list.slice(0, PULSE_LIMIT).map((r) => r.status);
    const finished = list.filter((r) => r.status === "succeeded" || r.status === "failed");
    const inWindow = list.filter((r) => new Date(r.created_at).getTime() >= weekAgo);
    const runtime = inWindow.reduce((acc, r) => acc + runDurationMs(r, now), 0);
    runtime7d += runtime;
    perPipeline[id] = {
      recent,
      success_rate: finished.length
        ? finished.filter((r) => r.status === "succeeded").length / finished.length
        : null,
      runtime_ms_7d: runtime,
      rows_7d: inWindow
        .filter((r) => r.status === "succeeded")
        .reduce((acc, r) => acc + rowsLoadedOf(r.metrics), 0),
    };
  }

  const finished7d = ok7d + failed7d;
  return {
    stats: {
      runs_7d: runs7d,
      runtime_ms_7d: runtime7d,
      succeeded_7d: ok7d,
      failed_7d: failed7d,
      success_rate_7d: finished7d ? ok7d / finished7d : null,
      rows_loaded_7d: rows7d,
      running_now: live,
    },
    per_pipeline: perPipeline,
  };
}
