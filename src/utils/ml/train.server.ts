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
import {
  assembledArtifactPath,
  parallelPlan,
  parallelWarnings,
  partitionSql,
  type ParallelPlan,
} from "@/lib/mlDataParallel";
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
  /** The assemble step, which needs a path of its own rather than the base. */
  assembled?: boolean,
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
    ML_ARTIFACT_URI: assembled
      ? assembledArtifactPath(mlArtifactUri(cfg.dataUrl, model.id, version))
      : shardArtifactPath(
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
  const resources = await getPlatformResources();
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
    // Selection never reads the holdout; this only decides whether it pays for
    // k folds or one inner split. Missing from the program config, the trainer
    // falls back to the same 2000 and nothing breaks quietly.
    cv_min_holdout_rows: resources.mlCvMinHoldoutRows,
    tuning: cfg.tuning ?? "none",
    prep: cfg.prep ?? (b.model as { prep?: unknown }).prep ?? {},
    mode: "train",
    // A distributed search deals the candidate names round-robin; a
    // single-container job sends none and the trainer tries them all, which
    // is what it did before any of this existed.
    ...(stash.shards && stash.shards > 1 && stash.phase !== "parallel_fit"
      ? {
          candidates: shardOf(ML_CANDIDATES[b.model.task] ?? [], stash.shard ?? 0, stash.shards),
          shard_index: stash.shard ?? 0,
          shard_count: stash.shards,
        }
      : {}),
    // A DATA-PARALLEL worker is the other shape of shard: one algorithm the
    // search already chose, fitted on its own hashed slice of the rows rather
    // than on the same rows as everybody else. Tuning is off because the
    // search tuned it — re-tuning per slice would give the workers different
    // hyper-parameters, and averaging those is averaging different models.
    ...(stash.phase === "parallel_fit" && b.job.parallel_algorithm
      ? {
          candidates: [b.job.parallel_algorithm],
          tuning: "none",
          partition: {
            sql: partitionSql(partitionColumns(b.job), stash.shard ?? 0, stash.shards ?? 1),
            index: stash.shard ?? 0,
            workers: stash.shards ?? 1,
          },
        }
      : {}),
    // ASSEMBLING is not a fit at all: one container loads what the workers
    // uploaded and averages them into a single model.
    ...(stash.phase === "assemble" ? { mode: "assemble", parts: assembleParts(b.job) } : {}),
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
      stash.phase === "assemble",
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
  phase: string,
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

  // Read BEFORE recording: the record is what makes this worker the last one,
  // and the phase it belongs to is the phase it was started for.
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  const { data: counted, error } = await supabaseAdmin.rpc("ml_job_record_shard", {
    _job: jobId,
    _shard: shard,
    _result: entry as unknown as Json,
    // THE PHASE THIS WORKER WAS STARTED FOR, from its own stash. Clearing
    // shard_results between phases makes an already-recorded shard eligible
    // again, so without this a retried callback from the phase that just ended
    // is accepted into the one that just began and counts toward completing
    // it. Seen live: a search worker's duplicate report completed the
    // parallel_fit phase while the second slice was still being created.
    _phase: phase ?? "search",
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
      `── ${phaseNoun(job?.phase)} ${shard + 1} of ${total} finished ──\n${entry.logs ?? ""}`,
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

  // ── The last worker of a PARALLEL FIT: assemble what they produced ─────
  if (job?.phase === "parallel_fit") {
    await finishParallelFit(jobId, entries, logs);
    return;
  }
  // ── The assemble container: its artifact IS the model ──────────────────
  if (job?.phase === "assemble") {
    await finishAssemble(jobId, entries, logs);
    return;
  }

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

  // ── The search sampled: refit its winner across the rows instead ────────
  if (job) {
    const bundle = await loadJobBundle(jobId, job.user_id);
    const plan = bundle ? await planParallelFit(job, bundle.model, merged) : null;
    if (plan && bundle) {
      const claimed = await advancePhase(jobId, "search", "parallel_fit", plan.workers, {
        algorithm: merged.algorithm ?? null,
        search: merged as unknown as Json,
      });
      if (claimed) {
        const limits = await getPlatformResources();
        const { started, error: startErr } = await startPhaseWorkers({
          job: {
            ...job,
            parallel_algorithm: merged.algorithm ?? null,
            search_result: merged as unknown as Json,
          },
          model: bundle.model,
          phase: "parallel_fit",
          count: plan.workers,
          budget: (await getPlatformResources()).mlTrainTimeBudgetMinutes,
          memLimitMb: limits.mlTrainMemLimitMb,
          gpus: limits.mlTrainGpus || 0,
        });
        if (started.length > 0) {
          await supabaseAdmin
            .from("ml_training_jobs")
            .update({
              shards: started.length,
              shard_sessions: started,
              parallel_workers: started.length,
              parallel_rows: plan.rowsUsed,
              parallel_total_rows: plan.totalRows,
            })
            .eq("id", jobId);
          await appendMlPartialLogs(
            jobId,
            `── the search chose ${merged.algorithm}; refitting it on ${started.length} slices of the rows ──\n`,
          );
          return;
        }
        // Not a single slice would start. The searched model is a real model
        // and is better than no model, so the job keeps it and says why.
        console.warn(`[ml] job ${jobId}: no parallel worker started (${startErr})`);
        merged.warnings = [
          ...(merged.warnings ?? []),
          "Wanted to refit across containers on more rows, but none would start; this is the sampled fit.",
        ];
        await advancePhase(jobId, "parallel_fit", "search", total, {});
      }
    }
  }
  await writeTrainOutcome(jobId, merged, logs);
}

/**
 * The columns a row is hashed on to decide which worker owns it.
 *
 * The FEATURES the search settled on, not `SELECT *`: a column dropped by the
 * prep step is not in the frame the workers read, so hashing on it would ask
 * the database for something that is not there. Sorted, because the predicate
 * has to be identical in every container and object key order is not a
 * promise worth resting disjointness on.
 */
function partitionColumns(job: MlJobRow): string[] {
  const schema = (
    job.search_result as { feature_schema?: { name?: string; role?: string }[] } | null
  )?.feature_schema;
  const names = (schema ?? [])
    // ROLE "feature" ONLY. The schema also lists the target and every column
    // the prep step dropped, and those are not promised to exist in the frame
    // a worker reads: a prep step with its own SQL selects what it likes, and
    // hashing on a column that subquery never produced fails the whole fit.
    // The comment here used to claim this filter existed while the code took
    // every name; reading a real feature_schema is what showed the difference.
    .filter((f) => f?.role === "feature")
    .map((f) => (typeof f?.name === "string" ? f.name : ""))
    .filter((n) => n.length > 0);
  return [...names].sort();
}

/** The workers' uploaded models, for the container that averages them. */
function assembleParts(job: MlJobRow): { artifact_uri: string; artifact_sha256: string }[] {
  // FROM parallel_parts, not shard_results. The transition into the assemble
  // phase CLEARS shard_results — it has to, or the slices' entries make the
  // assemble phase look finished before its container has said anything — and
  // the container reads the job fresh from the database after that. It found
  // an empty list and raised "nothing to assemble".
  const entries = ((job.parallel_parts as unknown as ShardEntry[]) ?? []).filter(
    (e) => e?.ok && e.result?.artifact_uri && e.result?.artifact_sha256,
  );
  // Sorted by shard so the assembled model is byte-identical whichever order
  // the callbacks happened to arrive in. A model whose digest depends on
  // network timing cannot be compared against itself later.
  return entries
    .sort((a, b) => a.shard - b.shard)
    .map((e) => ({
      artifact_uri: e.result!.artifact_uri as string,
      artifact_sha256: e.result!.artifact_sha256 as string,
    }));
}

/**
 * Should this job refit its winner across containers?
 *
 * ONLY WHEN THE SEARCH HAD TO SAMPLE. That is exactly the case this exists
 * for: the rows did not fit, so the model was fitted on a reservoir sample of
 * them, and the same containers can instead each take a slice and have their
 * fits averaged. When the rows fitted, there is nothing to win and a split
 * would only cost accuracy.
 *
 * Returns null rather than throwing when it is not worth it; the job then
 * finishes the way it always did.
 */
async function planParallelFit(
  job: MlJobRow,
  model: MlModelRow,
  winner: MlTrainResult,
): Promise<ParallelPlan | null> {
  if (!winner.training_sampled) return null;
  // Averaging is only meaningful where the same answer means the same thing,
  // the same reason shadowing refuses to compare clustering: cluster 3 of one
  // worker's fit has nothing to do with cluster 3 of another's.
  if (model.task !== "classification" && model.task !== "regression") return null;

  const limits = await getPlatformResources();
  const runtime = await getRuntimeSettings();
  // EXCLUDING THIS JOB'S OWN WORKERS. A session is marked finished AFTER its
  // callback, so at the moment the last search worker reports, every search
  // container is still counted as in use — and the allowance looks full. The
  // split was then refused with "this instance allows only one training
  // container", and whether it happened at all depended on how quickly the
  // other sessions had been reaped. Seen live, twice, differently.
  const own = new Set((job.shard_sessions ?? []) as string[]);
  const { data: live } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("id")
    .eq("user_id", model.user_id)
    .in("status", ["starting", "ready", "running"]);
  const inUse = (live ?? []).filter((sess) => !own.has(sess.id)).length;
  const planned = parallelPlan({
    totalRows: Number(winner.training_total_rows ?? 0),
    perWorker: limits.mlTrainMaxRows,
    // The workers that just finished searching are gone by now, so the whole
    // allowance is available again — minus anything else this person is
    // holding, which is what the search itself is bounded by too.
    maxWorkers: Math.min(limits.mlTrainWorkers, Math.max(0, runtime.maxSessionsPerUser - inUse)),
    minRowsPerWorker: limits.mlParallelMinRows,
  });
  if (!planned.ok) {
    console.log(`[ml] job ${job.id}: not splitting the rows — ${planned.reason}`);
    return null;
  }
  // Nothing safe to hash on means no disjoint slices. Without this the
  // predicate would come back null, every worker would read EVERY row, and
  // their fits would be averaged over the same data several times over —
  // which is not an error anything downstream could detect.
  if (
    partitionSql(partitionColumns({ ...job, search_result: winner as unknown as Json }), 0, 2) ===
    null
  ) {
    console.log(`[ml] job ${job.id}: not splitting the rows — no feature columns to hash on`);
    return null;
  }
  return planned.plan;
}

/**
 * Start one container per slice, or per assemble step.
 *
 * The same launcher for both because they differ only in the stash: a phase
 * that starts fewer workers than it planned records what actually started, so
 * the merge waits for exactly those and a job cannot hang on a container that
 * never existed.
 */
async function startPhaseWorkers(args: {
  job: MlJobRow;
  model: MlModelRow;
  phase: "parallel_fit" | "assemble";
  count: number;
  budget: number;
  memLimitMb: number;
  gpus: number;
}): Promise<{ started: string[]; error: string | null }> {
  const started: string[] = [];
  let error: string | null = null;
  for (let shard = 0; shard < args.count; shard++) {
    try {
      const { session } = await startSession({
        userId: args.model.user_id,
        kind: "batch",
        entrypoint: "entrypoint",
        inputs: {
          [ML_JOB_KEY]: {
            job_id: args.job.id,
            phase: args.phase,
            ...(args.count > 1 ? { shard, shards: args.count } : { shard: 0, shards: 1 }),
          },
        },
        memLimitMb: args.memLimitMb,
        gpus: args.gpus || undefined,
        maxMinutes: Math.max(args.budget + 15, 20),
      });
      started.push(session.id);
    } catch (e) {
      error = (e as Error).message;
      break;
    }
  }
  return { started, error };
}

/** What to call a worker in the logs, so a phase is legible from them. */
function phaseNoun(phase: string | null | undefined): string {
  if (phase === "parallel_fit") return "slice";
  if (phase === "assemble") return "assembly";
  return "search worker";
}

/**
 * Move the job to its next phase, once.
 *
 * The claim is in the database, not here: `WHERE phase = _from` means that of
 * several workers finishing at the same moment exactly one starts the next
 * phase. The losers read no row back and do nothing, which is the same shape
 * as the shard merge one level down.
 */
async function advancePhase(
  jobId: string,
  from: string,
  to: string,
  shards: number,
  opts: { algorithm?: string | null; search?: Json; parts?: Json },
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("ml_job_advance_phase", {
    _job: jobId,
    _from: from,
    _to: to,
    _shards: shards,
    _algorithm: opts.algorithm ?? null,
    _search: opts.search ?? null,
    // Written in the SAME statement that clears shard_results, because that
    // clear is what would otherwise destroy them.
    _parts: opts.parts ?? null,
  });
  if (error) {
    console.warn(`[ml] job ${jobId}: phase ${from} -> ${to} failed:`, error.message);
    return false;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return Boolean(row?.claimed);
}

/**
 * Every slice has reported. Start the container that averages them.
 *
 * A slice that failed is not fatal on its own — the average is over whichever
 * fits exist, and three of four slices is still more rows than the sample the
 * search used. Losing ALL of them is fatal, because then there is no model.
 */
async function finishParallelFit(
  jobId: string,
  entries: ShardEntry[],
  logs: string,
): Promise<void> {
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return;
  const good = entries.filter((e) => e.ok && e.result?.artifact_uri);
  const search = job.search_result as unknown as MlTrainResult | null;

  if (good.length === 0) {
    // Fall back to what the search already produced rather than failing the
    // job: a sampled model is worse than a distributed one and far better
    // than nothing, and the person asked for a model.
    if (search) {
      console.warn(`[ml] job ${jobId}: every slice failed; keeping the searched fit`);
      await writeTrainOutcome(
        jobId,
        {
          ...search,
          warnings: [
            ...(search.warnings ?? []),
            "Tried to refit across containers on more rows and every slice failed; this is the sampled fit.",
          ],
        },
        logs,
      );
      return;
    }
    await markJobFailed(jobId, entries.find((e) => !e.ok)?.error ?? "Every slice failed.", logs);
    return;
  }

  const bundle = await loadJobBundle(jobId, job.user_id);
  if (!bundle) return;
  if (
    !(await advancePhase(jobId, "parallel_fit", "assemble", 1, {
      parts: good as unknown as Json,
    }))
  ) {
    return;
  }

  const limits = await getPlatformResources();
  const { started, error: startErr } = await startPhaseWorkers({
    job: { ...job, shard_results: entries as unknown as Json },
    model: bundle.model,
    phase: "assemble",
    count: 1,
    budget: (await getPlatformResources()).mlTrainTimeBudgetMinutes,
    memLimitMb: limits.mlTrainMemLimitMb,
    gpus: 0,
  });
  if (started.length === 0) {
    console.warn(`[ml] job ${jobId}: the assemble container would not start (${startErr})`);
    if (search) {
      await writeTrainOutcome(
        jobId,
        {
          ...search,
          warnings: [
            ...(search.warnings ?? []),
            "The slices were fitted but no container was free to combine them; this is the sampled fit.",
          ],
        },
        logs,
      );
      return;
    }
    await markJobFailed(jobId, startErr ?? "No container could assemble the fitted slices.", logs);
    return;
  }
  await supabaseAdmin
    .from("ml_training_jobs")
    .update({ shards: 1, shard_sessions: started })
    .eq("id", jobId);
  await appendMlPartialLogs(
    jobId,
    `── ${good.length} slice(s) fitted; combining them into one model ──\n`,
  );
}

/**
 * The assembled model is the job's model.
 *
 * The SEARCH's result carries everything a version needs — leaderboard,
 * metrics, feature schema, statistics — because it is the same algorithm on
 * the same columns. Only the artifact and the row counts are replaced, and
 * the metrics keep saying what they always said: they were measured on the
 * search's holdout, not re-measured here.
 */
async function finishAssemble(jobId: string, entries: ShardEntry[], logs: string): Promise<void> {
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return;
  const search = job.search_result as unknown as MlTrainResult | null;
  const done = entries.find((e) => e.ok && e.result?.artifact_uri);

  if (!done?.result || !search) {
    if (search) {
      await writeTrainOutcome(
        jobId,
        {
          ...search,
          warnings: [
            ...(search.warnings ?? []),
            "The fitted slices could not be combined; this is the sampled fit.",
          ],
        },
        logs,
      );
      return;
    }
    await markJobFailed(jobId, done?.error ?? "The model could not be assembled.", logs);
    return;
  }

  const plan: ParallelPlan = {
    workers: Number(job.parallel_workers ?? 0),
    rowsPerWorker: Math.ceil(
      Number(job.parallel_rows ?? 0) / Math.max(1, Number(job.parallel_workers ?? 1)),
    ),
    rowsUsed: Number(job.parallel_rows ?? 0),
    totalRows: Number(job.parallel_total_rows ?? 0),
  };
  await writeTrainOutcome(
    jobId,
    {
      ...search,
      artifact_uri: done.result.artifact_uri,
      artifact_sha256: done.result.artifact_sha256,
      artifact_bytes: done.result.artifact_bytes,
      training_rows: plan.rowsUsed,
      training_total_rows: plan.totalRows,
      // NOT sampled any more, and this flag is what the panel reads to say so.
      training_sampled: false,
      warnings: [
        // The search's own "trained on a sample" warning is dropped: it
        // described a fit that is no longer the model being shipped.
        ...(search.warnings ?? []).filter((w) => !w.startsWith("Trained on a ")),
        ...parallelWarnings(plan),
      ],
    },
    logs,
  );
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
  /** The phase that worker was started for, from its own stash. */
  phase?: "parallel_fit" | "assemble",
): Promise<void> {
  const { data: job } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("id, model_id, version_id, user_id, status, shards, phase")
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
  //
  // ALSO every worker of a job that is past the search, whatever the count.
  // The assemble phase runs ONE container, and the old condition sent it down
  // the single-worker path below — which writes the job's outcome directly
  // from a result that has no leaderboard and no metrics, bypassing the phase
  // machinery that was supposed to finish the job. Seen live.
  if (
    ((job.shards ?? 1) > 1 || (job.phase ?? "search") !== "search") &&
    typeof shard === "number"
  ) {
    await recordShardResult(jobId, shard, body, secretValues, phase ?? "search");
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
