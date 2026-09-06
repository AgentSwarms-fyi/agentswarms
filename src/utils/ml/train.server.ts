// Training jobs: start one in a batch sandbox, serve it its bundle, take its
// result, and never leave it half-finished.
//
// Modelled on etl_runs (src/utils/etl/service.server.ts): the sandbox is a
// headless batch session whose only linkage to the job is the job id in the
// session's inputs; the source route serves the program and the resolved
// environment separately so credentials never ride inside code text; the
// result callback finalises the job; an orphan sweep finalises jobs whose
// sandbox died without calling back. The terminal write is also the claim, so
// a duplicate callback or a reaper race cannot double-fire.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { beginDecision, type DecisionKind } from "@/utils/provenance/decision.server";
import { getPlatformResources, getRuntimeSettings } from "@/utils/notebookRuntime/config.server";
import { refreshSession, startSession, stopSession } from "@/utils/notebookRuntime/service.server";
import { etlPrelude, scrubSecrets } from "@/utils/etl/service.server";
import { lakehouseAttachFn } from "@/utils/etl/codegen";
import {
  accessibleSchemas,
  catalogUrlToLibpq,
  lakehouseConfig,
  lakehouseSnapshotId,
} from "@/utils/lakehouse/core.server";
import { notifyUser } from "@/utils/notify.server";
import { ensurePlatformEgress } from "@/utils/notebookRuntime/egressApply.server";
import {
  ML_CANDIDATES,
  candidateCount,
  isShardableTask,
  mergeLeaderboards,
  pickWinner,
  planShards,
  shardArtifactPath,
  shardOf,
  shardWarnings,
  type ShardOutcome,
} from "@/lib/mlShards";
import { TRAIN_PY } from "./pyTrain";
import type { MlJobRow, MlModelRow, MlVersionRow } from "./access.server";
import {
  ML_JOB_KEY,
  ML_JOB_LIVE,
  mlJobStashOf,
  type MlJobStash,
  type MlSource,
  type MlTrainConfig,
  type MlTrainResult,
} from "./types";

/**
 * What the trainer imports. Baked into the runtime image; listed here too so a
 * deployment still on an older image installs them at job start (pip treats
 * an already-satisfied requirement as a no-op).
 */
export const ML_REQUIREMENTS = [
  "scikit-learn>=1.4",
  "lightgbm>=4.0",
  "statsmodels>=0.14",
  "duckdb>=1.4",
  "pyarrow>=15",
  "s3fs>=2024.2",
  "joblib>=1.3",
  "scipy>=1.11",
];

const LOG_CAP = 200_000;
// Named rather than written inline: tests/unit/checkConstraintValues scans
// files that start sessions for `kind: "…"` literals and checks them against
// the SESSION kind constraint; this is a decision kind.
const TRAINING_DECISION_KIND: DecisionKind = "ml_training";
const LIVE = [...ML_JOB_LIVE];

/** Where a version's artifact lives: beside the lake, never inside its data path. */
export function mlArtifactUri(dataUrl: string, modelId: string, version: number): string {
  const m = /^s3:\/\/([^/]+)/.exec(dataUrl);
  if (!m) throw new Error("LAKEHOUSE_DATA_URL is not an s3:// URL");
  return `s3://${m[1]}/ml-artifacts/${modelId}/v${version}/model.joblib`;
}

/**
 * The environment a training sandbox receives: the lakehouse the app itself
 * uses, gated as the model's OWNER — the sandbox holds engine credentials, so
 * a schema the owner cannot reach must never become reachable by naming it.
 */
export async function mlTrainingEnv(
  model: Pick<MlModelRow, "id" | "user_id" | "source">,
  version: number,
  /** Which worker of a distributed search this is, when there is more than one. */
  shard?: { index: number; count: number },
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const cfg = lakehouseConfig();
  if (!cfg) {
    throw new Error(
      "Training reads from the lakehouse, but this deployment has no lakehouse configured (LAKEHOUSE_CATALOG_URL).",
    );
  }
  const source = model.source as MlSource;
  const allowed = new Set((await accessibleSchemas(model.user_id)).map((s) => s.name));
  if (!allowed.has(source.schema)) {
    throw new Error(
      `No access to lakehouse schema "${source.schema}" — it doesn't exist, or nobody shared it with the model's owner`,
    );
  }
  const env: Record<string, string> = {
    ETL_LAKEHOUSE_CATALOG: catalogUrlToLibpq(cfg.catalog),
    ETL_LAKEHOUSE_DATA_URL: cfg.dataUrl,
    ETL_LAKEHOUSE_S3_KEY_ID: cfg.s3.keyId,
    ETL_LAKEHOUSE_S3_SECRET: cfg.s3.secret,
    ETL_LAKEHOUSE_S3_URL_STYLE: cfg.s3.urlStyle,
    ETL_LAKEHOUSE_S3_USE_SSL: cfg.s3.useSsl ? "true" : "false",
    // Every worker uploads its own model; the job keeps the winner's URI
    // and the losers' blobs are the price of having searched in parallel.
    ML_ARTIFACT_URI: shardArtifactPath(
      mlArtifactUri(cfg.dataUrl, model.id, version),
      shard?.index ?? 0,
      shard?.count ?? 1,
    ),
    AGENTSWARMS_ML_JOB: "1",
  };
  if (cfg.s3.endpoint) env.ETL_LAKEHOUSE_S3_ENDPOINT = cfg.s3.endpoint;
  if (cfg.s3.region) env.ETL_LAKEHOUSE_S3_REGION = cfg.s3.region;
  return { env, secretValues: [env.ETL_LAKEHOUSE_CATALOG, cfg.s3.secret] };
}

async function loadJobBundle(jobId: string, userId: string) {
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!job) return null;
  const [{ data: model }, { data: version }] = await Promise.all([
    supabaseAdmin.from("ml_models").select("*").eq("id", job.model_id).maybeSingle(),
    supabaseAdmin.from("ml_model_versions").select("*").eq("id", job.version_id).maybeSingle(),
  ]);
  if (!model || !version) return null;
  return { job, model, version };
}

/** The code bundle for a training session (source route, default part). */
export async function mlBundleFor(
  stash: MlJobStash,
  userId: string,
): Promise<{ code: string } | { error: string }> {
  const b = await loadJobBundle(stash.job_id, userId);
  if (!b) return { error: "Training job not found for this session" };
  const cfg = b.version.config as Partial<MlTrainConfig>;
  const program = {
    job_id: b.job.id,
    model_id: b.model.id,
    version: b.version.version,
    task: b.model.task,
    source: b.model.source,
    target_column: b.model.target_column,
    time_column: b.model.time_column,
    horizon: b.model.horizon,
    aggregation: b.model.aggregation,
    period: b.model.period,
    feature_columns: b.model.feature_columns,
    user_column: b.model.user_column,
    item_column: b.model.item_column,
    rating_column: b.model.rating_column,
    n_clusters: b.model.n_clusters,
    contamination: b.model.contamination,
    max_rows: cfg.max_rows ?? 0,
    time_budget_minutes: cfg.time_budget_minutes ?? 30,
    validation_fraction: cfg.validation_fraction ?? 0.2,
    tuning: cfg.tuning ?? "none",
    prep: cfg.prep ?? (b.model as { prep?: unknown }).prep ?? {},
    mode: "train",
    // A distributed search deals the candidate names round-robin; a
    // single-container job sends none and the trainer tries them all, which
    // is what it did before any of this existed.
    ...(stash.shards && stash.shards > 1
      ? {
          candidates: shardOf(ML_CANDIDATES[b.model.task] ?? [], stash.shard ?? 0, stash.shards),
          shard_index: stash.shard ?? 0,
          shard_count: stash.shards,
        }
      : {}),
  };
  // The configuration is a base64 literal, not interpolated code: a column
  // named `'); import os` is a column name and nothing else.
  const b64 = Buffer.from(JSON.stringify(program), "utf8").toString("base64");
  const code =
    etlPrelude() +
    lakehouseAttachFn() +
    "\n" +
    TRAIN_PY +
    `\n_ML_CONFIG = json.loads(base64.b64decode('${b64}').decode('utf-8'))\n`;
  return { code };
}

/** The env + requirements for a training session ({"part":"etl_env"}). */
export async function mlEnvFor(
  stash: MlJobStash,
  userId: string,
): Promise<{ env: Record<string, string>; requirements: string[] } | { error: string }> {
  const b = await loadJobBundle(stash.job_id, userId);
  if (!b) return { error: "Training job not found for this session" };
  try {
    const { env } = await mlTrainingEnv(
      b.model,
      b.version.version,
      stash.shards && stash.shards > 1
        ? { index: stash.shard ?? 0, count: stash.shards }
        : undefined,
    );
    // The program checks its imports and installs the stack only if the image
    // lacks it; sending the list here would cost a pip round-trip every job.
    return { env, requirements: [] };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Start a training job for a freshly created version. Fails fast on anything
 * the sandbox would only discover after a cold start: no lakehouse, no access
 * to the source schema, the per-user concurrency cap.
 */
export async function startTrainingJob(args: {
  model: MlModelRow;
  version: MlVersionRow;
  trigger?: string;
}): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const { model, version } = args;
  try {
    await mlTrainingEnv(model, version.version);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const limits = await getPlatformResources();
  const { count } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", model.user_id)
    .in("status", LIVE);
  if ((count ?? 0) >= limits.mlMaxConcurrentTrainingsPerUser) {
    return {
      ok: false,
      error:
        `Concurrent training limit reached (${limits.mlMaxConcurrentTrainingsPerUser}). Wait for a ` +
        `running job to finish, or raise the limit under Admin -> Developer runtime.`,
    };
  }

  const { data: job, error: insErr } = await supabaseAdmin
    .from("ml_training_jobs")
    .insert({
      model_id: model.id,
      version_id: version.id,
      user_id: model.user_id,
      status: "queued",
      trigger: args.trigger ?? "manual",
    })
    .select("*")
    .single();
  if (insErr || !job) return { ok: false, error: insErr?.message ?? "Failed to create job" };

  // A training run is evidence: it adopts the version id as its decision id
  // and records the lakehouse snapshot current when it began, so the training
  // set can be re-read as of that moment.
  beginDecision({
    userId: model.user_id,
    kind: TRAINING_DECISION_KIND,
    id: version.id,
    rootRef: model.id,
  });
  const snapshot = await lakehouseSnapshotId().catch(() => null);
  await supabaseAdmin
    .from("ml_model_versions")
    .update({
      decision_id: version.id,
      training_snapshot_id: snapshot ? Number(snapshot) : null,
    })
    .eq("id", version.id);

  const cfg = version.config as Partial<MlTrainConfig>;
  const budget = cfg.time_budget_minutes ?? limits.mlTrainTimeBudgetMinutes;
  // The sandbox reads Parquet through the egress proxy; make sure the proxy
  // admits the lake endpoint before the job discovers it cannot.
  const egress = await ensurePlatformEgress();
  if (!egress.applied) console.warn("[ml] egress allow-list:", egress.reason);

  // How many sandboxes to search in. Only tasks whose candidates the server
  // can enumerate are splittable, and the runtime's per-user session limit is
  // the ceiling that actually bites — asking for more workers than the user
  // may hold would just fail the extras.
  const runtime = await getRuntimeSettings();
  const { count: sessionsInUse } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", model.user_id)
    .in("status", ["starting", "ready", "running"]);
  const plan = planShards({
    requested: isShardableTask(model.task) ? limits.mlTrainWorkers : 1,
    candidates: candidateCount(model.task),
    sessionsPerUser: runtime.maxSessionsPerUser,
    sessionsInUse: sessionsInUse ?? 0,
  });
  if (plan.reason) console.log(`[ml] search workers: ${plan.reason}`);

  const started: string[] = [];
  let startError: string | null = null;
  for (let shard = 0; shard < plan.shards; shard++) {
    try {
      const { session } = await startSession({
        userId: model.user_id,
        kind: "batch",
        entrypoint: "entrypoint",
        inputs: {
          [ML_JOB_KEY]: {
            job_id: job.id,
            ...(plan.shards > 1 ? { shard, shards: plan.shards } : {}),
          },
        },
        memLimitMb: limits.mlTrainMemLimitMb,
        gpus: limits.mlTrainGpus || undefined,
        // The sandbox outlives the budget by a margin: the trainer stops picking
        // new candidates at 85% of the budget, then evaluates and uploads.
        maxMinutes: Math.max(budget + 15, 20),
      });
      started.push(session.id);
    } catch (e) {
      // A worker that will not start is only fatal if it is the FIRST one:
      // after that the search is smaller than planned, which is a warning on
      // the version rather than a reason to throw away the workers running.
      startError = (e as Error).message;
      break;
    }
  }
  if (started.length === 0) {
    const message = startError ?? "No training sandbox could be started.";
    await markJobFailed(job.id, message, "");
    return { ok: false, error: message };
  }
  // `shards` is what actually started, never what was planned: the merge waits
  // for exactly this many callbacks, and a job waiting on a worker that never
  // existed would hang until the orphan sweep.
  await supabaseAdmin
    .from("ml_training_jobs")
    .update({
      status: "running",
      session_id: started[0],
      shards: started.length,
      shard_sessions: started,
      started_at: new Date().toISOString(),
    })
    .eq("id", job.id);
  if (started.length < plan.shards) {
    console.warn(
      `[ml] job ${job.id}: ${started.length} of ${plan.shards} workers started (${startError})`,
    );
  }

  auditEvent({
    userId: model.user_id,
    action: "ml.train.start",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    decisionId: version.id,
    detail: {
      job_id: job.id,
      version: version.version,
      task: model.task,
      source: model.source,
      target_column: model.target_column,
      training_snapshot_id: snapshot,
      time_budget_minutes: budget,
      max_rows: cfg.max_rows ?? limits.mlTrainMaxRows,
      search_workers: started.length,
    },
  });
  console.log(`[ml] training started model=${model.id} v${version.version} job=${job.id}`);
  return { ok: true, jobId: job.id };
}

/**
 * Turn the raw sandbox failure into what an operator can act on. The one
 * case worth translating: the egress proxy denying the lake endpoint, which
 * DuckDB reports as an S3 credential failure.
 */
export function mlErrorMessage(raw: string): string {
  const m = /HTTP GET error reading '(https?:\/\/[^/']+)[^']*' [^\n]*\(HTTP 403 Forbidden\)/.exec(
    raw,
  );
  if (m && /Authentication Failure/.test(raw)) {
    return (
      `The sandbox's egress proxy refused the lake endpoint ${m[1]} (HTTP 403), so the training rows could not be read. ` +
      `The allow-list is re-applied automatically when a job starts; if this persists, save the runtime settings under ` +
      `Admin -> Developer runtime, and check NOTEBOOK_EGRESS_ALLOWLIST_PATH is mounted writable. ` +
      `(DuckDB reports this as a credential failure; the credentials are fine.)\n\n` +
      raw.slice(-1200)
    );
  }
  return raw;
}

async function markJobFailed(jobId: string, error: string, logs: string): Promise<void> {
  error = mlErrorMessage(error);
  // The logs tell the whole story in one place: what ran, then why it stopped.
  logs = `${logs}${logs && !logs.endsWith("\n") ? "\n" : ""}\n===== failed =====\n${error}`;
  const now = new Date().toISOString();
  const { data: claimed } = await supabaseAdmin
    .from("ml_training_jobs")
    .update({
      status: "failed",
      error: error.slice(0, 4000),
      logs: logs.slice(-LOG_CAP),
      finished_at: now,
    })
    .eq("id", jobId)
    .in("status", LIVE)
    .select("id, model_id, version_id, user_id")
    .maybeSingle();
  if (!claimed) return;
  await supabaseAdmin
    .from("ml_model_versions")
    .update({ status: "failed" })
    .eq("id", claimed.version_id)
    .eq("status", "training");
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("name")
    .eq("id", claimed.model_id)
    .maybeSingle();
  auditEvent({
    userId: claimed.user_id,
    action: "ml.train.failed",
    resourceType: "ml_model",
    resourceId: claimed.model_id,
    resourceName: model?.name ?? undefined,
    decisionId: claimed.version_id,
    detail: { job_id: jobId, error: error.slice(0, 500) },
  });
  console.log(
    `[ml-train] ${JSON.stringify({ job_id: jobId, status: "failed", error: error.slice(0, 200) })}`,
  );
  void notifyUser(claimed.user_id, {
    title: `Training failed: ${model?.name ?? "model"}`,
    body: error.slice(0, 450),
    link: `/ml/${claimed.model_id}`,
  }).catch(() => {});
}

/** Live log streaming from the batch runner (every ~5s) while the job runs. */
export async function appendMlPartialLogs(jobId: string, logs: string): Promise<void> {
  const b = await supabaseAdmin
    .from("ml_training_jobs")
    .select("id, status, model_id, version_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!b.data || b.data.status !== "running") return;
  let secretValues: string[] = [];
  try {
    const { data: model } = await supabaseAdmin
      .from("ml_models")
      .select("id, user_id, source")
      .eq("id", b.data.model_id)
      .maybeSingle();
    if (model) secretValues = (await mlTrainingEnv(model, 0)).secretValues;
  } catch {
    /* scrub what we can */
  }
  await supabaseAdmin
    .from("ml_training_jobs")
    .update({ logs: scrubSecrets(logs.slice(-LOG_CAP), secretValues) })
    .eq("id", jobId)
    .eq("status", "running");
}

function isTrainResult(v: unknown): v is MlTrainResult {
  const r = v as Partial<MlTrainResult> | null;
  return Boolean(
    r &&
    r.ok === true &&
    typeof r.artifact_uri === "string" &&
    typeof r.artifact_sha256 === "string" &&
    r.metrics &&
    typeof r.metrics === "object",
  );
}

/** One worker's entry on the job, as `ml_job_record_shard` stores it. */
type ShardEntry = ShardOutcome & { result?: MlTrainResult; logs?: string };

/**
 * Take one worker's report and, if it is the last one, finish the job.
 *
 * The counting is done by the database in a single statement, so of n
 * simultaneous callbacks exactly one sees itself as last. Doing it as
 * read-then-write here would let two workers both believe they were last and
 * write the version twice.
 */
async function recordShardResult(
  jobId: string,
  shard: number,
  body: { status: string; result?: unknown; logs?: string; error?: string | null },
  secretValues: string[],
): Promise<void> {
  const ok = body.status !== "error" && isTrainResult(body.result);
  const r = ok ? (body.result as MlTrainResult) : null;
  const entry: ShardEntry = {
    shard,
    ok,
    ...(r
      ? {
          algorithm: r.algorithm,
          primary_metric: r.primary_metric,
          value: r.metrics[r.primary_metric] ?? null,
          higher_is_better: r.leaderboard?.[0]?.higher_is_better ?? true,
          result: r,
        }
      : {
          error: scrubSecrets(
            body.error ?? "The worker finished without returning a result.",
            secretValues,
          ).slice(0, 1000),
        }),
    logs: scrubSecrets((body.logs ?? "").slice(-40_000), secretValues),
  };

  const { data: counted, error } = await supabaseAdmin.rpc("ml_job_record_shard", {
    _job: jobId,
    _shard: shard,
    _result: entry as unknown as Json,
  });
  if (error) {
    console.warn(`[ml] shard ${shard} of ${jobId} not recorded:`, error.message);
    return;
  }
  const row = Array.isArray(counted) ? counted[0] : counted;
  // No row: this shard already reported. A retried callback is a no-op.
  if (!row) return;
  const done = Number(row.done ?? 0);
  const total = Number(row.total ?? 1);
  if (done < total) {
    // Still searching. Show the user what has come in so far rather than a
    // silent bar: a job with three workers is running until the third lands.
    await appendMlPartialLogs(
      jobId,
      `── search worker ${shard + 1} of ${total} finished ──\n${entry.logs ?? ""}`,
    );
    return;
  }

  const { data: full } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("shard_results")
    .eq("id", jobId)
    .maybeSingle();
  const entries = ((full?.shard_results as unknown as ShardEntry[]) ?? []).filter(
    (e) => e && typeof e.shard === "number",
  );
  const logs = entries
    .sort((a, b) => a.shard - b.shard)
    .map((e) => `── search worker ${e.shard + 1} of ${total} ──\n${e.logs ?? ""}`)
    .join("\n");

  const winner = pickWinner(entries);
  if (!winner?.ok || !winner.result) {
    // Every worker failed. The first error is the one worth showing: with a
    // shared dataset and a shared config they are usually the same error n
    // times, and n copies of it is not n times as informative.
    const first = entries.find((e) => !e.ok);
    await markJobFailed(
      jobId,
      first?.error ?? "Every search worker failed without reporting an error.",
      logs,
    );
    return;
  }

  // The winner's result IS the job's result, with two changes: the leaderboard
  // is every worker's rows, and the warnings say what the search missed.
  const merged: MlTrainResult = {
    ...winner.result,
    leaderboard: mergeLeaderboards(
      entries
        .filter((e) => e.result?.leaderboard)
        .map((e) => ({ shard: e.shard, rows: e.result!.leaderboard })),
    ) as MlTrainResult["leaderboard"],
    warnings: [...(winner.result.warnings ?? []), ...shardWarnings(entries, total)],
  };
  await writeTrainOutcome(jobId, merged, logs);
}

/**
 * Write a successful training result: the job row, the version, the audit
 * trail and the one structured log line. The single place that does this, so
 * a search split across workers cannot record a version differently from one
 * that ran in a single container.
 */
async function writeTrainOutcome(jobId: string, r: MlTrainResult, logs: string): Promise<void> {
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("id, model_id, version_id, user_id, status")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || !LIVE.includes(job.status as (typeof LIVE)[number])) return;
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", job.model_id)
    .maybeSingle();
  const now = new Date().toISOString();
  const { data: claimed } = await supabaseAdmin
    .from("ml_training_jobs")
    .update({
      status: "succeeded",
      logs,
      error: null,
      finished_at: now,
      result: {
        algorithm: r.algorithm,
        primary_metric: r.primary_metric,
        metrics: r.metrics,
        training_rows: r.training_rows,
        elapsed_seconds: r.elapsed_seconds,
      } as Json,
    })
    .eq("id", jobId)
    .in("status", LIVE)
    .select("id")
    .maybeSingle();
  if (!claimed) return;

  const promote = Boolean(model && !model.production_version_id);
  await supabaseAdmin
    .from("ml_model_versions")
    .update({
      status: "ready",
      stage: promote ? "production" : "candidate",
      algorithm: r.algorithm,
      metrics: r.metrics as Json,
      leaderboard: r.leaderboard as Json,
      feature_importance: r.feature_importance as Json,
      feature_schema: r.feature_schema as Json,
      feature_stats: (r.feature_stats ?? null) as Json,
      artifact_uri: r.artifact_uri,
      artifact_sha256: r.artifact_sha256,
      artifact_bytes: r.artifact_bytes,
      training_rows: r.training_rows,
      training_total_rows: r.training_total_rows,
      training_sampled: r.training_sampled,
      warnings: (r.warnings ?? []) as Json,
      forecast: (r.forecast
        ? { points: r.forecast, history: r.history ?? [], meta: r.series_meta ?? null }
        : null) as Json,
      trained_at: now,
    })
    .eq("id", job.version_id);
  if (model) {
    await supabaseAdmin
      .from("ml_models")
      .update({
        updated_at: now,
        ...(promote ? { production_version_id: job.version_id } : {}),
      })
      .eq("id", model.id);
  }
  const value = r.metrics[r.primary_metric] ?? null;
  auditEvent({
    userId: job.user_id,
    action: "ml.train.succeeded",
    resourceType: "ml_model",
    resourceId: job.model_id,
    resourceName: model?.name ?? undefined,
    decisionId: job.version_id,
    detail: {
      job_id: jobId,
      algorithm: r.algorithm,
      primary_metric: r.primary_metric,
      value,
      training_rows: r.training_rows,
      training_sampled: r.training_sampled,
      artifact_sha256: r.artifact_sha256,
      auto_promoted: promote,
    },
  });
  if (promote) {
    auditEvent({
      userId: job.user_id,
      action: "ml.version.promote",
      resourceType: "ml_model",
      resourceId: job.model_id,
      resourceName: model?.name ?? undefined,
      decisionId: job.version_id,
      detail: { version_id: job.version_id, stage: "production", automatic: true },
    });
  }
  // One structured line per finished job: the greppable correlation point
  // between logs, the audit trail and the version row.
  console.log(
    `[ml-train] ${JSON.stringify({
      job_id: jobId,
      model_id: job.model_id,
      version_id: job.version_id,
      status: "succeeded",
      algorithm: r.algorithm,
      metric: r.primary_metric,
      value,
      rows: r.training_rows,
      elapsed_s: r.elapsed_seconds,
    })}`,
  );
}

/**
 * The job's outcome, from the result callback or the orphan sweep. Success
 * turns the version `ready` and, if the model has no production version yet,
 * promotes this one so the first trained model is usable immediately.
 */
export async function finalizeMlJob(
  jobId: string,
  body: { status: string; result?: unknown; logs?: string; error?: string | null },
  /** Which worker reported, for a job whose search was split across several. */
  shard?: number,
): Promise<void> {
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("id, model_id, version_id, user_id, status, shards")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || !LIVE.includes(job.status as (typeof LIVE)[number])) return;
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", job.model_id)
    .maybeSingle();
  let secretValues: string[] = [];
  if (model) {
    try {
      secretValues = (await mlTrainingEnv(model, 0)).secretValues;
    } catch {
      /* scrub what we can */
    }
  }
  // A distributed search reports once per worker; the last one to land does
  // the merge and then takes the ordinary path below.
  if ((job.shards ?? 1) > 1 && typeof shard === "number") {
    await recordShardResult(jobId, shard, body, secretValues);
    return;
  }
  const logs = scrubSecrets((body.logs ?? "").slice(-LOG_CAP), secretValues);
  const ok = body.status !== "error" && isTrainResult(body.result);
  if (!ok) {
    const error = body.error
      ? scrubSecrets(body.error, secretValues)
      : body.status !== "error"
        ? "The trainer finished without returning a result."
        : "The sandbox ended with an error.";
    await markJobFailed(jobId, error, logs);
    return;
  }
  await writeTrainOutcome(jobId, body.result as MlTrainResult, logs);
}

/**
 * Bring a job up to date from its sandbox session. Called when the UI polls,
 * so a finished job whose callback was missed still resolves the moment
 * someone looks at it rather than on the next sweep.
 */
export async function refreshMlJob(jobId: string): Promise<MlJobRow | null> {
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return null;
  if (!LIVE.includes(job.status as (typeof LIVE)[number])) return job;
  // Every worker's sandbox. A single-container job has exactly one and behaves
  // as it always did; a distributed one is only finished when each of its
  // workers has been accounted for, whether it called back or died.
  const sessionIds = [
    ...new Set(
      [...((job.shard_sessions as string[] | null) ?? []), job.session_id].filter(Boolean),
    ),
  ] as string[];
  if (sessionIds.length === 0) return job;
  const { data: sessions } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("*")
    .in("id", sessionIds);
  if (!sessions?.length) return job;

  for (const session of sessions) {
    const fresh = await refreshSession(session).catch(() => session);
    // Which worker this was is in its own stash, put there when it started.
    const shard = mlJobStashOf(fresh.inputs)?.shard;
    if (fresh.status === "succeeded") {
      await finalizeMlJob(
        job.id,
        { status: "succeeded", result: fresh.result ?? undefined, logs: fresh.logs ?? "" },
        shard,
      );
    } else if (["error", "stopped"].includes(fresh.status)) {
      await finalizeMlJob(
        job.id,
        {
          status: "error",
          logs: fresh.logs ?? "",
          error:
            [fresh.error, fresh.logs?.slice(-2000)].filter(Boolean).join("\n") ||
            "The sandbox ended without reporting a result.",
        },
        shard,
      );
    } else if (typeof fresh.logs === "string" && fresh.logs && fresh.logs !== job.logs) {
      await appendMlPartialLogs(job.id, fresh.logs);
    }
  }
  const { data: updated } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  return updated ?? job;
}

/** Sweep: finalise jobs whose sandbox ended without calling back. */
export async function reconcileOrphanedMlJobs(): Promise<number> {
  const graceAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: live } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("id, session_id, shard_sessions, status, created_at")
    .in("status", LIVE)
    .lt("created_at", graceAgo)
    .limit(20);
  let reconciled = 0;
  for (const job of live ?? []) {
    if (!job.session_id && !(job.shard_sessions ?? []).length) {
      if (job.status === "queued") {
        await markJobFailed(job.id, "The job never acquired a sandbox session.", "");
        reconciled++;
      }
      continue;
    }
    const before = job.status;
    const after = await refreshMlJob(job.id);
    if (after && after.status !== before) reconciled++;
  }
  return reconciled;
}

/** Cancel a live job: the sandbox is stopped and the version marked cancelled. */
export async function cancelMlJob(jobId: string, userId: string): Promise<boolean> {
  const { data: claimed } = await supabaseAdmin
    .from("ml_training_jobs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", userId)
    .in("status", LIVE)
    .select("id, session_id, shard_sessions, model_id, version_id")
    .maybeSingle();
  if (!claimed) return false;
  await supabaseAdmin
    .from("ml_model_versions")
    .update({ status: "cancelled" })
    .eq("id", claimed.version_id)
    .eq("status", "training");
  // Every worker, not just the first: a cancelled search that left three of
  // four containers running would keep burning the budget it was cancelled to
  // stop.
  const sessionIds = [
    ...new Set([...(claimed.shard_sessions ?? []), claimed.session_id].filter(Boolean)),
  ] as string[];
  if (sessionIds.length) {
    const { data: sessions } = await supabaseAdmin
      .from("notebook_runtime_sessions")
      .select("*")
      .in("id", sessionIds);
    for (const session of sessions ?? []) await stopSession(session).catch(() => {});
  }
  auditEvent({
    userId,
    action: "ml.train.cancel",
    resourceType: "ml_model",
    resourceId: claimed.model_id,
    decisionId: claimed.version_id,
    detail: { job_id: jobId },
  });
  return true;
}
