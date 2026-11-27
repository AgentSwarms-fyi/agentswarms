// What actually happened to an online prediction (R551): recording a caller's
// report, and measuring a version's last thirty days of them.
//
// The rules are in `@/lib/mlOnlineOutcomes` (pure). This file reads and writes:
//
// - `recordOutcomes` takes `POST /api/ml/outcomes`. Only the key that asked
//   for a prediction may report on it, and only for rows that request had;
//   what the model answered is copied from the request's own stored result,
//   never taken from the caller.
// - `evaluateOnline` measures one version's answers with the batch path's own
//   metric, records an evaluation (source "online"), and on decay tells the
//   owner. A workflow set to start on decay starts only when the owner's OWN
//   keys' answers show it, so someone the model is shared with cannot start
//   the owner's retraining by reporting answers.
// - `runOnlineEvaluations` does that hourly, at most once a day per version,
//   and only for a version with answers newer than its last measurement.
//
// Needs migration 20261211000000; without it the API says so and the hourly
// pass does nothing.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  coverage,
  decayRatio,
  evaluationVerdict,
  type MlEvaluationMetrics,
} from "@/lib/mlEvaluation";
import {
  ONLINE_MAX_ANSWERS,
  ONLINE_MIN_ANSWERS,
  ONLINE_WINDOW_DAYS,
  onlineAlertKey,
  onlineMetrics,
  onlineTask,
  parseOutcomes,
  predictedAt,
  rowsAnswered,
  type OutcomePair,
} from "@/lib/mlOnlineOutcomes";
import { startedSentence } from "@/lib/workflowAlerts";
import { auditEvent } from "@/utils/audit.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { notifyUser } from "@/utils/notify.server";
import { alertStarts } from "@/utils/workflows/alertTriggers.server";
import type { MlModelRow } from "./access.server";
import type { MlEvaluationRow } from "./evaluate.server";
import { ML_PRIMARY_METRIC } from "./types";

const PAGE = 1000;
/** Requests read to count the rows a version answered online in the window. */
const MAX_REQUESTS_COUNTED = 10_000;
const NEEDS_MIGRATION =
  "Reporting outcomes needs migration 20261211000000: apply the latest migrations (npx supabase db push --remote).";
const MISSING = /ml_outcomes|schema cache|does not exist|source|window_days/i;

export type RecordResult = { status: number; body: Record<string, unknown> };

/** POST /api/ml/outcomes, for a key already authenticated for its model. */
export async function recordOutcomes(args: {
  key: { id: string; user_id: string };
  model: MlModelRow;
  body: unknown;
}): Promise<RecordResult> {
  const task = onlineTask(args.model.task);
  if (!task) {
    return {
      status: 400,
      body: {
        error: `A ${args.model.task} model answers nothing that can be checked against what happened`,
      },
    };
  }
  const id = (args.body as { prediction_id?: unknown } | null)?.prediction_id;
  if (typeof id !== "string" || !id) {
    return {
      status: 400,
      body: { error: "prediction_id must be the id a prediction call returned" },
    };
  }
  const { data: p } = await supabaseAdmin
    .from("ml_predictions")
    .select("id, model_id, version_id, api_key_id, kind, status, result")
    .eq("id", id)
    .maybeSingle();
  // The same answer for "no such prediction" and "not yours": a key learns
  // nothing about predictions it did not make.
  if (!p || p.model_id !== args.model.id || p.api_key_id !== args.key.id || p.kind !== "rows") {
    return { status: 404, body: { error: "No prediction with that id was made with this key" } };
  }
  if (p.status !== "succeeded" || !p.version_id) {
    return {
      status: 409,
      body: { error: `That prediction ${p.status}; there is no answer to report on yet` },
    };
  }
  const rows = rowsAnswered(p.result);
  const parsed = parseOutcomes(args.body, task, rows);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const now = new Date().toISOString();
  const records = [];
  for (const o of parsed.outcomes) {
    const predicted = predictedAt(p.result, o.row);
    if (predicted === null) {
      return { status: 409, body: { error: `Row ${o.row} of that prediction kept no answer` } };
    }
    records.push({
      prediction_id: p.id,
      row_index: o.row,
      model_id: args.model.id,
      version_id: p.version_id,
      user_id: args.model.user_id,
      api_key_id: args.key.id,
      reported_by: args.key.user_id,
      predicted,
      actual: o.actual,
      received_at: now,
    });
  }
  const { error } = await supabaseAdmin
    .from("ml_outcomes")
    .upsert(records, { onConflict: "prediction_id,row_index" });
  if (error) {
    return MISSING.test(error.message)
      ? { status: 503, body: { error: NEEDS_MIGRATION } }
      : { status: 500, body: { error: error.message } };
  }
  auditEvent({
    userId: args.key.user_id,
    action: "ml.outcome.report",
    resourceType: "ml_model",
    resourceId: args.model.id,
    resourceName: args.model.name,
    detail: { prediction_id: p.id, key_id: args.key.id, rows: records.length },
  });
  return {
    status: 200,
    body: {
      prediction_id: p.id,
      recorded: records.length,
      note: `Measured hourly against the model's training score, from ${ONLINE_MIN_ANSWERS} answers in ${ONLINE_WINDOW_DAYS} days.`,
    },
  };
}

type Answer = { predicted: string; actual: string; reported_by: string | null };

/** A version's answers in the window, newest first, at most ONLINE_MAX_ANSWERS. */
async function answersFor(
  versionId: string,
  since: string,
): Promise<{ answers: Answer[]; truncated: boolean } | { error: string }> {
  const answers: Answer[] = [];
  for (let from = 0; from < ONLINE_MAX_ANSWERS; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("ml_outcomes")
      .select("predicted, actual, reported_by")
      .eq("version_id", versionId)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .range(from, Math.min(from + PAGE, ONLINE_MAX_ANSWERS) - 1);
    if (error) return { error: MISSING.test(error.message) ? NEEDS_MIGRATION : error.message };
    answers.push(...((data ?? []) as Answer[]));
    if ((data ?? []).length < PAGE) break;
  }
  return { answers, truncated: answers.length >= ONLINE_MAX_ANSWERS };
}

/** Rows the version answered online in the window: the denominator of coverage. */
async function rowsScoredOnline(versionId: string, since: string): Promise<number> {
  let total = 0;
  for (let from = 0; from < MAX_REQUESTS_COUNTED; from += PAGE) {
    const { data } = await supabaseAdmin
      .from("ml_predictions")
      .select("row_count")
      .eq("version_id", versionId)
      .eq("kind", "rows")
      .eq("status", "succeeded")
      .gte("created_at", since)
      .range(from, from + PAGE - 1);
    for (const r of data ?? []) total += Number(r.row_count ?? 0);
    if ((data ?? []).length < PAGE) break;
  }
  return total;
}

export type OnlineOutcome =
  { ok: true; evaluation: MlEvaluationRow } | { ok: false; error: string; answers?: number };

/**
 * Measure one version's last thirty days of reported answers, record the
 * evaluation, and on decay tell the owner. `triggeredBy` owns the row.
 */
export async function evaluateOnline(
  model: MlModelRow,
  versionId: string,
  triggeredBy: string,
  via: string,
  now: Date = new Date(),
): Promise<OnlineOutcome> {
  const task = onlineTask(model.task);
  if (!task) return { ok: false, error: `A ${model.task} model has no online answers to measure` };
  const since = new Date(now.getTime() - ONLINE_WINDOW_DAYS * 86_400_000).toISOString();
  const read = await answersFor(versionId, since);
  if ("error" in read) return { ok: false, error: read.error };
  const pairs: OutcomePair[] = read.answers;
  if (pairs.length < ONLINE_MIN_ANSWERS) {
    return {
      ok: false,
      answers: pairs.length,
      error: `${pairs.length} answer${pairs.length === 1 ? "" : "s"} reported in the last ${ONLINE_WINDOW_DAYS} days; online accuracy is measured from ${ONLINE_MIN_ANSWERS}.`,
    };
  }
  const metrics = onlineMetrics(task, pairs);
  if (!metrics || metrics.matched === 0) {
    return { ok: false, answers: pairs.length, error: "None of the answers could be measured" };
  }
  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("id, version, metrics")
    .eq("id", versionId)
    .maybeSingle();
  const metricName = ML_PRIMARY_METRIC[task];
  const baseline = baselineOf(version?.metrics ?? null, metricName);
  const decay = decayRatio(metrics.primary, baseline, metricName);
  const limits = await getPlatformResources();
  const verdict = evaluationVerdict(decay, limits.mlDecayAlertRatio);
  const scored = await rowsScoredOnline(versionId, since);

  const { data: row, error } = await supabaseAdmin
    .from("ml_evaluations")
    .insert({
      model_id: model.id,
      version_id: versionId,
      prediction_id: null,
      source: "online",
      window_days: ONLINE_WINDOW_DAYS,
      // The pass's own clock, so "once a day" is judged on one time line.
      created_at: now.toISOString(),
      user_id: triggeredBy,
      metric_name: metrics.primary_name,
      metric_value: metrics.primary,
      baseline_value: baseline,
      decay_ratio: decay,
      verdict,
      matched_rows: metrics.matched,
      // Never fewer than were answered: a request older than the window can be
      // answered inside it.
      scored_rows: Math.max(scored, metrics.matched),
      extra: {
        ...metrics.extra,
        coverage: coverage(metrics.matched, Math.max(scored, metrics.matched)),
        answers_truncated: read.truncated,
      } as Json,
    })
    .select()
    .single();
  if (error || !row) {
    const msg = error?.message ?? "Could not record the evaluation";
    return { ok: false, error: MISSING.test(msg) ? NEEDS_MIGRATION : msg };
  }

  auditEvent({
    userId: triggeredBy,
    action: "ml.evaluate",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      source: "online",
      version: version?.version ?? null,
      metric: metrics.primary_name,
      value: metrics.primary,
      baseline,
      decay_ratio: decay,
      verdict,
      matched_rows: metrics.matched,
      window_days: ONLINE_WINDOW_DAYS,
      via,
    },
  });

  if (verdict === "degraded") {
    await raiseOnlineDecay(model, versionId, task, read.answers, metrics, baseline, decay, now);
  }
  return { ok: true, evaluation: row };
}

function baselineOf(metrics: Json | null, name: string): number | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const v = (metrics as Record<string, unknown>)[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function raiseOnlineDecay(
  model: MlModelRow,
  versionId: string,
  task: "classification" | "regression",
  answers: Answer[],
  metrics: MlEvaluationMetrics,
  baseline: number | null,
  decay: number | null,
  now: Date,
): Promise<void> {
  const limits = await getPlatformResources();
  auditEvent({
    userId: model.user_id,
    action: "ml.decay.alert",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      source: "online",
      version_id: versionId,
      metric: metrics.primary_name,
      value: metrics.primary,
      baseline,
      decay_ratio: decay,
      threshold: limits.mlDecayAlertRatio,
      answers: metrics.matched,
    },
  });
  // A workflow may answer it (R544), but only on the owner's OWN answers: a
  // key someone the model is shared with holds could otherwise report its way
  // into the owner's retraining.
  const own = answers.filter((a) => a.reported_by === model.user_id);
  const ownMetrics = own.length >= ONLINE_MIN_ANSWERS ? onlineMetrics(task, own) : null;
  const ownDecay = ownMetrics
    ? decayRatio(ownMetrics.primary, baseline, metrics.primary_name)
    : null;
  const ownDegraded = evaluationVerdict(ownDecay, limits.mlDecayAlertRatio) === "degraded";
  const started = ownDegraded
    ? await alertStarts({
        event: "decay",
        modelId: model.id,
        predictionId: onlineAlertKey(versionId, now),
        ranBy: model.user_id,
        versionId,
        score: ownDecay,
      })
    : [];
  const pct = decay === null ? "" : ` (${(decay * 100).toFixed(0)}% worse)`;
  void notifyUser(model.user_id, {
    title: `"${model.name}" is answering online worse than it trained${pct}`,
    body:
      `Measured against the answers callers reported for the last ${ONLINE_WINDOW_DAYS} days: ` +
      `${metrics.primary_name} ${metrics.primary.toFixed(3)} against ${baseline?.toFixed(3) ?? "—"} ` +
      `at training, over ${metrics.matched} answers.` +
      (started.length
        ? startedSentence(started.map((s) => s.name))
        : " Retraining is the usual answer."),
    link: `/ml/${model.id}?tab=accuracy`,
  });
}

let missingSaid = false;

/**
 * The hourly pass: each version with answers newer than its last online
 * evaluation, measured at most once a day. Bounded by the operator's
 * evaluations per sweep.
 */
export async function runOnlineEvaluations(
  now: Date = new Date(),
): Promise<{ evaluated: number; alerted: number }> {
  const since = new Date(now.getTime() - ONLINE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: recent, error } = await supabaseAdmin
    .from("ml_outcomes")
    .select("version_id, model_id, received_at")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(5000);
  if (error) {
    if (!missingSaid) {
      missingSaid = true;
      console.warn(
        `[ml-online] not measured: ${error.message} — it needs migration 20261211000000`,
      );
    }
    return { evaluated: 0, alerted: 0 };
  }
  // Newest first, so the first row seen per version is its latest answer.
  const latest = new Map<string, { modelId: string; at: string }>();
  for (const r of recent ?? []) {
    if (!latest.has(r.version_id))
      latest.set(r.version_id, { modelId: r.model_id, at: r.received_at });
  }
  const limits = await getPlatformResources();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  let evaluated = 0;
  let alerted = 0;
  for (const [versionId, { modelId, at }] of latest) {
    if (evaluated >= limits.mlEvaluationsPerSweep) break;
    const { data: last } = await supabaseAdmin
      .from("ml_evaluations")
      .select("created_at")
      .eq("version_id", versionId)
      .eq("source", "online")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Once a day, and only for answers that arrived since.
    if (last && (last.created_at > dayAgo || last.created_at >= at)) continue;
    const { data: model } = await supabaseAdmin
      .from("ml_models")
      .select("*")
      .eq("id", modelId)
      .maybeSingle();
    if (!model) continue;
    const res = await evaluateOnline(
      model as MlModelRow,
      versionId,
      model.user_id,
      "schedule",
      now,
    );
    if (!res.ok) continue;
    evaluated++;
    if (res.evaluation.verdict === "degraded") alerted++;
  }
  return { evaluated, alerted };
}

/** How many answers a version has had reported in the window, for the model page. */
export async function onlineAnswerCount(
  versionId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const since = new Date(now.getTime() - ONLINE_WINDOW_DAYS * 86_400_000).toISOString();
  // A GET of one row, not a HEAD. FOUND IN THE UI TEST: a HEAD count against
  // a table that does not exist yet answers 204 with no error and no count,
  // so the card said "0 answers reported" before the migration that holds
  // them was applied. A GET says the table is missing.
  const { count, error } = await supabaseAdmin
    .from("ml_outcomes")
    .select("prediction_id", { count: "exact" })
    .eq("version_id", versionId)
    .gte("received_at", since)
    .limit(1);
  return error || count === null ? null : count;
}
