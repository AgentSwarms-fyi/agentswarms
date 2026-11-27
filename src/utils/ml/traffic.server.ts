// Drift on live traffic (R545): recording each online request's counts, and
// measuring a window of them.
//
// The rules and the formula are in `@/lib/mlTraffic` (pure, held to the batch
// path's own output by a fixture). This file reads and writes:
//
// - `recordTrafficProfile` bins one request's rows against the version that
//   answered it and keeps only the counts, on that request's own prediction
//   row (`input.profile`). Called after the answer is sent, so it adds nothing
//   to the request's time; it needs no migration.
// - `liveTraffic` sums a model's last 24 hours of requests per version and
//   measures them. The model page reads it on demand.
// - `runTrafficDriftChecks` does the same on the platform clock, hourly,
//   records the verdict per version, and raises the drift alert once a day at
//   most per version, which notifies the owner and may start their workflows
//   (R544). Recording needs migration 20261207000000; without it the sweep
//   measures nothing and says so once.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  TRAFFIC_MAX_REQUESTS,
  TRAFFIC_MIN_ROWS,
  TRAFFIC_WINDOW_HOURS,
  featureStatsOf,
  mergeProfiles,
  profileOf,
  profileRows,
  topFeaturesLine,
  trafficAlertKey,
  trafficDrift,
  type FeatureStats,
  type TrafficDrift,
  type TrafficProfile,
} from "@/lib/mlTraffic";
import { startedSentence } from "@/lib/workflowAlerts";
import { auditEvent } from "@/utils/audit.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { notifyUser } from "@/utils/notify.server";
import { alertStarts } from "@/utils/workflows/alertTriggers.server";

const PAGE = 1000;
/** Models looked at per pass of the hourly check. */
const MODELS_PER_PASS = 300;

// A version's training distribution never changes once it is trained, so it
// is read once per process. Bounded, oldest first out.
const statsCache = new Map<string, FeatureStats | null>();
async function statsFor(versionId: string): Promise<FeatureStats | null> {
  if (statsCache.has(versionId)) return statsCache.get(versionId) ?? null;
  const { data } = await supabaseAdmin
    .from("ml_model_versions")
    .select("feature_stats")
    .eq("id", versionId)
    .maybeSingle();
  const stats = featureStatsOf(data?.feature_stats ?? null);
  if (statsCache.size >= 500) statsCache.delete(statsCache.keys().next().value as string);
  statsCache.set(versionId, stats);
  return stats;
}

/**
 * Keep the counts of one online request's rows on its prediction row. Only
 * counts against the training bins: no value the caller sent is stored.
 * Never throws; a request is answered whether or not this lands.
 */
export async function recordTrafficProfile(
  predictionId: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  try {
    if (!rows.length) return;
    const { data: p } = await supabaseAdmin
      .from("ml_predictions")
      .select("id, version_id, kind, input")
      .eq("id", predictionId)
      .maybeSingle();
    if (!p || p.kind !== "rows" || !p.version_id) return;
    const stats = await statsFor(p.version_id);
    if (!stats) return;
    const input =
      p.input && typeof p.input === "object" && !Array.isArray(p.input)
        ? (p.input as Record<string, unknown>)
        : {};
    await supabaseAdmin
      .from("ml_predictions")
      .update({ input: { ...input, profile: profileRows(stats, rows) } as unknown as Json })
      .eq("id", predictionId);
  } catch (e) {
    console.warn(`[ml-traffic] not recorded for ${predictionId}: ${(e as Error).message}`);
  }
}

export type VersionTraffic = {
  versionId: string;
  requests: number;
  rows: number;
  /** Null below TRAFFIC_MIN_ROWS rows, or when nothing could be compared. */
  drift: TrafficDrift | null;
  /** The same, over the owner's own requests (theirs and their API keys'). */
  ownerRows: number;
  ownerDrift: TrafficDrift | null;
  /** More requests than are read for one window: the newest were measured. */
  truncated: boolean;
};

/** A model's online traffic over the last 24 hours, measured per version that answered it. */
export async function liveTraffic(
  model: { id: string; user_id: string },
  now: Date = new Date(),
): Promise<VersionTraffic[]> {
  const since = new Date(now.getTime() - TRAFFIC_WINDOW_HOURS * 3_600_000).toISOString();
  type Req = { version_id: string | null; user_id: string; profile: unknown };
  const reqs: Req[] = [];
  for (let from = 0; from < TRAFFIC_MAX_REQUESTS; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("ml_predictions")
      .select("version_id, user_id, profile:input->profile")
      .eq("model_id", model.id)
      .eq("kind", "rows")
      .eq("status", "succeeded")
      .gte("created_at", since)
      .not("input->profile", "is", null)
      .order("created_at", { ascending: false })
      .range(from, Math.min(from + PAGE, TRAFFIC_MAX_REQUESTS) - 1);
    if (error) throw new Error(error.message);
    reqs.push(...((data ?? []) as unknown as Req[]));
    if ((data ?? []).length < PAGE) break;
  }

  type Acc = { requests: number; all: TrafficProfile | null; own: TrafficProfile | null };
  const byVersion = new Map<string, Acc>();
  for (const r of reqs) {
    const p = profileOf(r.profile);
    if (!p || !r.version_id) continue;
    const acc = byVersion.get(r.version_id) ?? { requests: 0, all: null, own: null };
    acc.requests++;
    acc.all = acc.all ? mergeProfiles(acc.all, p) : p;
    if (r.user_id === model.user_id) acc.own = acc.own ? mergeProfiles(acc.own, p) : p;
    byVersion.set(r.version_id, acc);
  }

  const out: VersionTraffic[] = [];
  for (const [versionId, acc] of byVersion) {
    const stats = await statsFor(versionId);
    const measure = (p: TrafficProfile | null) =>
      stats && p && p.rows >= TRAFFIC_MIN_ROWS ? trafficDrift(stats, p) : null;
    out.push({
      versionId,
      requests: acc.requests,
      rows: acc.all?.rows ?? 0,
      drift: measure(acc.all),
      ownerRows: acc.own?.rows ?? 0,
      ownerDrift: measure(acc.own),
      truncated: reqs.length >= TRAFFIC_MAX_REQUESTS,
    });
  }
  return out.sort((a, b) => b.rows - a.rows);
}

let missingTableSaid = false;

/**
 * The hourly check on the platform clock: measure each model's live traffic,
 * record the verdict per version, and raise the drift alert at most once a
 * day per version.
 */
export async function runTrafficDriftChecks(
  now: Date = new Date(),
): Promise<{ checked: number; alerted: number }> {
  const since = new Date(now.getTime() - TRAFFIC_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: models } = await supabaseAdmin
    .from("ml_models")
    .select("id, user_id, name")
    .order("updated_at", { ascending: false })
    .limit(MODELS_PER_PASS);
  const limits = await getPlatformResources();
  let checked = 0;
  let alerted = 0;
  for (const model of models ?? []) {
    // Enough requests in the window to be worth reading? One counted query.
    const { count } = await supabaseAdmin
      .from("ml_predictions")
      .select("id", { count: "exact", head: true })
      .eq("model_id", model.id)
      .eq("kind", "rows")
      .eq("status", "succeeded")
      .gte("created_at", since)
      .not("input->profile", "is", null);
    if (!count) continue;
    let traffic: VersionTraffic[];
    try {
      traffic = await liveTraffic(model, now);
    } catch (e) {
      console.warn(`[ml-traffic] ${model.id}: ${(e as Error).message}`);
      continue;
    }
    for (const t of traffic) {
      if (!t.drift) continue;
      checked++;
      const { error } = await supabaseAdmin.from("ml_traffic_checks").upsert(
        {
          version_id: t.versionId,
          model_id: model.id,
          user_id: model.user_id,
          checked_at: now.toISOString(),
          window_hours: TRAFFIC_WINDOW_HOURS,
          requests: t.requests,
          row_count: t.rows,
          score: t.drift.score,
          features: t.drift.features as unknown as Json,
          owner_row_count: t.ownerRows,
          owner_score: t.ownerDrift?.score ?? null,
        },
        { onConflict: "version_id" },
      );
      if (error) {
        if (!missingTableSaid) {
          missingTableSaid = true;
          console.warn(
            `[ml-traffic] not recorded: ${error.message} — live-traffic drift needs migration 20261207000000`,
          );
        }
        return { checked, alerted };
      }
      await recordDay(model, t, now);
      if (t.drift.score < limits.mlDriftAlertPsi) continue;
      if (await claimAlert(t.versionId, now)) {
        alerted++;
        await raiseTrafficAlert(model, { ...t, drift: t.drift }, limits.mlDriftAlertPsi, now);
      }
    }
  }
  return { checked, alerted };
}

let missingDailySaid = false;

/**
 * The day's verdict for one version (R548): the latest check of the day
 * replaces the earlier ones, so a day reads as it ended. Its own migration
 * (20261208000000); without it the history is not kept and nothing else
 * changes.
 */
async function recordDay(
  model: { id: string; user_id: string },
  t: VersionTraffic & { drift: TrafficDrift | null },
  now: Date,
): Promise<void> {
  if (!t.drift) return;
  const { error } = await supabaseAdmin.from("ml_traffic_daily").upsert(
    {
      version_id: t.versionId,
      day: now.toISOString().slice(0, 10),
      model_id: model.id,
      user_id: model.user_id,
      requests: t.requests,
      row_count: t.rows,
      score: t.drift.score,
      features: t.drift.features as unknown as Json,
      checked_at: now.toISOString(),
    },
    { onConflict: "version_id,day" },
  );
  if (error && !missingDailySaid) {
    missingDailySaid = true;
    console.warn(
      `[ml-traffic] daily history not kept: ${error.message} — it needs migration 20261208000000`,
    );
  }
}

/**
 * At most one alert a day per version, claimed atomically: two replicas
 * running the hourly pass together raise it once. Two conditional updates,
 * each re-checked by Postgres under the row lock.
 */
async function claimAlert(versionId: string, now: Date): Promise<boolean> {
  const stamp = now.toISOString();
  const claim = () =>
    supabaseAdmin
      .from("ml_traffic_checks")
      .update({ alerted_at: stamp })
      .eq("version_id", versionId);
  const { data: first } = await claim().is("alerted_at", null).select("version_id").maybeSingle();
  if (first) return true;
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { data: again } = await claim().lt("alerted_at", dayAgo).select("version_id").maybeSingle();
  return Boolean(again);
}

async function raiseTrafficAlert(
  model: { id: string; user_id: string; name: string },
  t: VersionTraffic & { drift: TrafficDrift },
  threshold: number,
  now: Date,
): Promise<void> {
  auditEvent({
    userId: model.user_id,
    action: "ml.drift.alert",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      source: "traffic",
      version_id: t.versionId,
      window_hours: TRAFFIC_WINDOW_HOURS,
      requests: t.requests,
      rows: t.rows,
      score: t.drift.score,
      threshold,
      features: t.drift.features,
    },
  });
  // A workflow may answer it (R544), but only when the owner's OWN traffic
  // drifted too: requests from people the model is shared with notify the
  // owner, and start none of the owner's work.
  const ownDrifted = Boolean(t.ownerDrift && t.ownerDrift.score >= threshold);
  const started = ownDrifted
    ? await alertStarts({
        event: "drift",
        modelId: model.id,
        predictionId: trafficAlertKey(t.versionId, now),
        ranBy: model.user_id,
        versionId: t.versionId,
        score: t.drift.score,
      })
    : [];
  void notifyUser(model.user_id, {
    title: `Drift on "${model.name}" live traffic: PSI ${t.drift.score.toFixed(2)}`,
    body:
      `The last ${TRAFFIC_WINDOW_HOURS} hours of requests (${t.rows.toLocaleString()} rows) differ from the training data (${topFeaturesLine(t.drift)}).` +
      (started.length ? startedSentence(started.map((s) => s.name)) : " Consider retraining."),
    link: `/ml/${model.id}?tab=predictions`,
  });
}
