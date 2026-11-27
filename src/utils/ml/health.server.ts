// The latest health readings for a set of models, read as the platform.
//
// Two admin reads for any number of models: the most recent succeeded
// prediction that measured drift for each production version, and the most
// recent evaluation for it. The operator's drift threshold is read once, at
// the same moment, so a reading and the bar it is judged against belong to
// the same instant. Only the sentence leaves (describeModelHealth); nothing
// here is a row a grantee could not already see on the model page.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  describeModelHealth,
  type DriftReading,
  type EvaluationReading,
  type MissingReading,
  type ModelHealth,
  type TrafficReading,
} from "@/lib/mlHealth";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";

/** Model id → its health, for every model with a production version. */
export async function modelHealthFor(
  models: Array<{ id: string; production_version_id: string | null }>,
): Promise<Map<string, ModelHealth>> {
  const out = new Map<string, ModelHealth>();
  const live = models.filter((m) => m.production_version_id);
  if (live.length === 0) return out;
  const versionIds = live.map((m) => m.production_version_id as string);
  // The hourly check stops writing when the traffic stops, so a verdict older
  // than two days is about traffic that is no longer arriving: left out.
  const recent = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const [limits, { data: preds }, { data: evals }, checks, { data: scored }] = await Promise.all([
    getPlatformResources(),
    supabaseAdmin
      .from("ml_predictions")
      .select("version_id, drift_score, created_at")
      .in("version_id", versionIds)
      .eq("status", "succeeded")
      .not("drift_score", "is", null)
      .order("created_at", { ascending: false })
      .limit(versionIds.length * 8),
    supabaseAdmin
      .from("ml_evaluations")
      .select(
        "version_id, metric_name, metric_value, baseline_value, decay_ratio, verdict, created_at",
      )
      .in("version_id", versionIds)
      .order("created_at", { ascending: false })
      .limit(versionIds.length * 8),
    // One row per version (R545). Before migration 20261207000000 the table is
    // not there and the read errors: health is then what it was.
    trafficChecks(versionIds, recent),
    // The newest run that counted its missing inputs (R549), per version.
    // `->>`, not `->`: a run that could not count stores a JSON null, which
    // `->` returns as a value and `->>` as SQL NULL.
    supabaseAdmin
      .from("ml_predictions")
      .select("version_id, created_at, missing:result->missing")
      .in("version_id", versionIds)
      .eq("status", "succeeded")
      .not("result->>missing", "is", null)
      .order("created_at", { ascending: false })
      .limit(versionIds.length * 8),
  ]);
  // Newest first, so the first row seen per version is the latest reading.
  const drift = new Map<string, DriftReading>();
  for (const p of preds ?? []) {
    if (!p.version_id || drift.has(p.version_id) || typeof p.drift_score !== "number") continue;
    drift.set(p.version_id, {
      score: p.drift_score,
      threshold: limits.mlDriftAlertPsi,
      at: p.created_at,
    });
  }
  const evaluation = new Map<string, EvaluationReading>();
  for (const e of evals ?? []) {
    if (evaluation.has(e.version_id)) continue;
    evaluation.set(e.version_id, {
      metric: e.metric_name,
      value: e.metric_value,
      baseline: e.baseline_value ?? null,
      decayRatio: e.decay_ratio ?? null,
      verdict: (e.verdict as EvaluationReading["verdict"]) ?? null,
      at: e.created_at,
    });
  }
  const traffic = new Map<string, TrafficReading>();
  const missing = new Map<string, MissingReading[]>();
  const addMissing = (v: string, m: MissingReading) =>
    missing.set(v, [...(missing.get(v) ?? []), m]);
  for (const c of checks) {
    const n = Array.isArray(c.missing) ? c.missing.length : 0;
    if (n) addMissing(c.version_id, { source: "traffic", count: n, at: c.checked_at });
    if (typeof c.score !== "number") continue;
    traffic.set(c.version_id, {
      score: c.score,
      threshold: limits.mlDriftAlertPsi,
      at: c.checked_at,
    });
  }
  // Newest first: the first run seen per version is the latest that counted.
  const seen = new Set<string>();
  for (const p of (scored ?? []) as {
    version_id: string | null;
    created_at: string;
    missing: unknown;
  }[]) {
    // A run that could not count (too few rows) does not hide one that did.
    if (!p.version_id || seen.has(p.version_id) || !Array.isArray(p.missing)) continue;
    seen.add(p.version_id);
    const n = p.missing.length;
    if (n) addMissing(p.version_id, { source: "batch", count: n, at: p.created_at });
  }
  for (const m of live) {
    const v = m.production_version_id as string;
    out.set(
      m.id,
      describeModelHealth(
        drift.get(v) ?? null,
        evaluation.get(v) ?? null,
        traffic.get(v) ?? null,
        missing.get(v) ?? [],
      ),
    );
  }
  return out;
}

type CheckRow = { version_id: string; score: number | null; checked_at: string; missing: unknown };

/**
 * The live-traffic verdicts, with the missing inputs when they are recorded.
 * Before migration 20261209000000 there is no such column and the read is
 * made without it; before 20261207000000 there is no table, and nothing.
 */
async function trafficChecks(versionIds: string[], since: string): Promise<CheckRow[]> {
  const read = (cols: string) =>
    supabaseAdmin
      .from("ml_traffic_checks")
      .select(cols)
      .in("version_id", versionIds)
      .gte("checked_at", since);
  const full = await read("version_id, score, checked_at, missing");
  if (!full.error) return (full.data ?? []) as unknown as CheckRow[];
  const plain = await read("version_id, score, checked_at");
  if (plain.error) return [];
  return ((plain.data ?? []) as unknown as CheckRow[]).map((c) => ({ ...c, missing: null }));
}
