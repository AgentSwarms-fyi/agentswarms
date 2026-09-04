// Prediction runs: score a lakehouse table (or a small payload) with a
// registered version, inside the same kind of batch sandbox that trained it.
//
// A run is a row in ml_predictions with its own decision id ('ml_prediction')
// unless it serves an agent's turn, in which case it adopts that decision —
// so the data a prediction read, the artifact it used and the rows it wrote
// hang off one id. Success is audited as a data read (ml.predict_query, which
// isDataRead counts) with a digest over the prediction column, so a replay can
// tell "same model, same rows, same answers" from drift.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { beginDecision, type DecisionKind } from "@/utils/provenance/decision.server";
import { resultDigest } from "@/utils/provenance/canonical";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { refreshSession, startSession, stopSession } from "@/utils/notebookRuntime/service.server";
import { ensurePlatformEgress } from "@/utils/notebookRuntime/egressApply.server";
import { etlPrelude, scrubSecrets } from "@/utils/etl/service.server";
import { lakehouseAttachFn } from "@/utils/etl/codegen";
import { notifyUser } from "@/utils/notify.server";
import { TRAIN_PY } from "./pyTrain";
import { mlErrorMessage, mlTrainingEnv } from "./train.server";
import type { MlModelRow, MlVersionRow } from "./access.server";
import {
  ML_JOB_KEY,
  ML_JOB_LIVE,
  type MlCell,
  type MlJobStash,
  type MlPredictInput,
  type MlPredictOutput,
  type MlPredictionKind,
} from "./types";
export type { MlCell, MlPredictInput, MlPredictOutput, MlPredictionKind } from "./types";

export type MlPredictionRow = Database["public"]["Tables"]["ml_predictions"]["Row"];

/** What the trainer program returns in predict mode. */
export type MlPredictResult = {
  ok: true;
  mode: "predict";
  row_count: number;
  total_input_rows: number;
  output: { schema: string; table: string } | null;
  columns: string[];
  sample: MlCell[][];
  digest_columns: string[];
  digest_rows: MlCell[][];
  algorithm?: string;
  warnings?: string[];
  elapsed_seconds?: number;
};

const LOG_CAP = 200_000;
// Named, not written inline: tests/unit/checkConstraintValues scans files that
// start sessions for `kind: "…"` literals against the SESSION kind constraint.
// These are the stash kind and the payload kind, not session kinds.
const PREDICT_STASH_KIND = "predict" as const;
const ROWS_KIND = "rows" as const;
const LAKEHOUSE_KIND = "lakehouse" as const;
const LIVE = [...ML_JOB_LIVE];
const PREDICTION_DECISION_KIND: DecisionKind = "ml_prediction";
/** Rows a `rows`-kind run may carry (the try-it form, the agent tool). */
export const ML_ROWS_PREDICT_CAP = 200;

/** Rows for a `rows`-kind run ride in the session inputs beside the stash. */
export function mlStashRows(inputs: unknown): Record<string, unknown>[] {
  const rows = (inputs as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function loadPredictionBundle(predictionId: string, userId: string) {
  const { data: prediction } = await supabaseAdmin
    .from("ml_predictions")
    .select("*")
    .eq("id", predictionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!prediction) return null;
  const [{ data: model }, { data: version }] = await Promise.all([
    supabaseAdmin.from("ml_models").select("*").eq("id", prediction.model_id).maybeSingle(),
    supabaseAdmin
      .from("ml_model_versions")
      .select("*")
      .eq("id", prediction.version_id)
      .maybeSingle(),
  ]);
  if (!model || !version) return null;
  return { prediction, model, version };
}

/** The code bundle for a prediction session (source route, default part). */
export async function mlPredictBundleFor(
  stash: MlJobStash,
  userId: string,
  sessionInputs: unknown,
): Promise<{ code: string } | { error: string }> {
  const b = await loadPredictionBundle(stash.job_id, userId);
  if (!b) return { error: "Prediction run not found for this session" };
  const limits = await getPlatformResources();
  const stored = b.prediction.input as MlPredictInput | { kind: typeof ROWS_KIND; count: number };
  const input =
    stored.kind === "rows"
      ? { kind: ROWS_KIND, rows: mlStashRows(sessionInputs).slice(0, ML_ROWS_PREDICT_CAP) }
      : stored;
  const program = {
    mode: "predict",
    prediction_id: b.prediction.id,
    model_id: b.model.id,
    version: b.version.version,
    task: b.model.task,
    target_column: b.model.target_column,
    artifact_uri: b.version.artifact_uri,
    artifact_sha256: b.version.artifact_sha256,
    input,
    output: b.prediction.output,
    max_rows: limits.mlPredictMaxRows,
  };
  const b64 = Buffer.from(JSON.stringify(program), "utf8").toString("base64");
  const code =
    etlPrelude() +
    lakehouseAttachFn() +
    "\n" +
    TRAIN_PY +
    `\n_ML_CONFIG = json.loads(base64.b64decode('${b64}').decode('utf-8'))\n`;
  return { code };
}

/** The env for a prediction session ({"part":"etl_env"}). */
export async function mlPredictEnvFor(
  stash: MlJobStash,
  userId: string,
): Promise<{ env: Record<string, string>; requirements: string[] } | { error: string }> {
  const b = await loadPredictionBundle(stash.job_id, userId);
  if (!b) return { error: "Prediction run not found for this session" };
  try {
    // Same lakehouse env as training; the program self-installs the ML
    // stack only if the image lacks it, so no pip round-trip here.
    const { env } = await mlTrainingEnv(b.model, b.version.version);
    return { env, requirements: [] };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function summariseInput(input: MlPredictInput): Json {
  return input.kind === "rows"
    ? ({ kind: ROWS_KIND, count: input.rows.length } as Json)
    : (input as unknown as Json);
}

/**
 * Start a prediction run. Access to the model and the output schema is the
 * CALLER's responsibility (ml.functions / the agent tool decide who may
 * predict); this function only refuses what cannot work: an untrained
 * version, a forecast model, a missing lakehouse, too many live runs.
 */
export async function startPrediction(args: {
  model: MlModelRow;
  version: MlVersionRow;
  userId: string;
  input: MlPredictInput;
  output: MlPredictOutput;
  kind: MlPredictionKind;
  via: string;
  /** Adopt the calling decision (an agent's turn) instead of minting one. */
  decisionId?: string | null;
}): Promise<{ ok: true; predictionId: string; decisionId: string } | { ok: false; error: string }> {
  const { model, version } = args;
  if (version.status !== "ready" || !version.artifact_uri || !version.artifact_sha256) {
    return { ok: false, error: `Version v${version.version} is not trained` };
  }
  if (model.task === "forecast") {
    return {
      ok: false,
      error:
        "Forecast models are served from their training forecast; retrain to change the horizon.",
    };
  }
  if (args.input.kind === "rows" && args.input.rows.length > ML_ROWS_PREDICT_CAP) {
    return {
      ok: false,
      error: `At most ${ML_ROWS_PREDICT_CAP} rows per direct prediction; use a batch run for more`,
    };
  }
  try {
    await mlTrainingEnv(model, version.version);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const limits = await getPlatformResources();
  const { count } = await supabaseAdmin
    .from("ml_predictions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", args.userId)
    .in("status", LIVE);
  if ((count ?? 0) >= Math.max(2, limits.mlMaxConcurrentTrainingsPerUser)) {
    return { ok: false, error: "Too many prediction runs in progress; wait for one to finish." };
  }

  const { data: row, error } = await supabaseAdmin
    .from("ml_predictions")
    .insert({
      model_id: model.id,
      version_id: version.id,
      user_id: args.userId,
      status: "queued",
      kind: args.kind,
      via: args.via,
      input: summariseInput(args.input),
      output: args.output as Json,
    })
    .select("*")
    .single();
  if (error || !row)
    return { ok: false, error: error?.message ?? "Failed to create prediction run" };

  const decisionId = args.decisionId ?? row.id;
  if (!args.decisionId) {
    beginDecision({
      userId: args.userId,
      kind: PREDICTION_DECISION_KIND,
      id: row.id,
      rootRef: model.id,
    });
  }
  await supabaseAdmin.from("ml_predictions").update({ decision_id: decisionId }).eq("id", row.id);

  const egress = await ensurePlatformEgress();
  if (!egress.applied) console.warn("[ml] egress allow-list:", egress.reason);
  try {
    const { session } = await startSession({
      userId: args.userId,
      kind: "batch",
      entrypoint: "entrypoint",
      inputs: {
        [ML_JOB_KEY]: { job_id: row.id, kind: PREDICT_STASH_KIND },
        ...(args.input.kind === "rows" ? { rows: args.input.rows } : {}),
      },
      memLimitMb: limits.mlTrainMemLimitMb,
      maxMinutes: args.kind === "rows" ? 15 : 120,
    });
    await supabaseAdmin
      .from("ml_predictions")
      .update({ status: "running", session_id: session.id, started_at: new Date().toISOString() })
      .eq("id", row.id);
  } catch (e) {
    const message = (e as Error).message;
    await markPredictionFailed(row.id, message, "");
    return { ok: false, error: message };
  }
  console.log(
    `[ml] prediction started model=${model.id} v${version.version} run=${row.id} kind=${args.kind}`,
  );
  return { ok: true, predictionId: row.id, decisionId };
}

async function markPredictionFailed(id: string, error: string, logs: string): Promise<void> {
  error = mlErrorMessage(error);
  logs = `${logs}${logs && !logs.endsWith("\n") ? "\n" : ""}\n===== failed =====\n${error}`;
  const now = new Date().toISOString();
  const { data: claimed } = await supabaseAdmin
    .from("ml_predictions")
    .update({
      status: "failed",
      error: error.slice(0, 4000),
      logs: logs.slice(-LOG_CAP),
      finished_at: now,
    })
    .eq("id", id)
    .in("status", LIVE)
    .select("id, model_id, version_id, user_id, kind, via, decision_id")
    .maybeSingle();
  if (!claimed) return;
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("name")
    .eq("id", claimed.model_id)
    .maybeSingle();
  auditEvent({
    userId: claimed.user_id,
    action: "ml.predict.failed",
    resourceType: "ml_model",
    resourceId: claimed.model_id,
    resourceName: model?.name ?? undefined,
    decisionId: claimed.decision_id,
    detail: { prediction_id: id, kind: claimed.kind, via: claimed.via, error: error.slice(0, 500) },
  });
  console.log(
    `[ml-predict] ${JSON.stringify({ prediction_id: id, status: "failed", error: error.slice(0, 200) })}`,
  );
  if (claimed.kind === "batch") {
    void notifyUser(claimed.user_id, {
      title: `Prediction failed: ${model?.name ?? "model"}`,
      body: error.slice(0, 450),
      link: `/ml/${claimed.model_id}`,
    }).catch(() => {});
  }
}

export async function appendPredictionLogs(id: string, logs: string): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from("ml_predictions")
    .select("id, status, model_id")
    .eq("id", id)
    .maybeSingle();
  if (!row || row.status !== "running") return;
  let secretValues: string[] = [];
  try {
    const { data: model } = await supabaseAdmin
      .from("ml_models")
      .select("id, user_id, source")
      .eq("id", row.model_id)
      .maybeSingle();
    if (model) secretValues = (await mlTrainingEnv(model, 0)).secretValues;
  } catch {
    /* scrub what we can */
  }
  await supabaseAdmin
    .from("ml_predictions")
    .update({ logs: scrubSecrets(logs.slice(-LOG_CAP), secretValues) })
    .eq("id", id)
    .eq("status", "running");
}

function isPredictResult(v: unknown): v is MlPredictResult {
  const r = v as Partial<MlPredictResult> | null;
  return Boolean(
    r &&
    r.ok === true &&
    r.mode === "predict" &&
    typeof r.row_count === "number" &&
    Array.isArray(r.columns),
  );
}

/** The run's outcome, from the result callback or the orphan sweep. */
export async function finalizePrediction(
  id: string,
  body: { status: string; result?: unknown; logs?: string; error?: string | null },
): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from("ml_predictions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!row || !LIVE.includes(row.status as (typeof LIVE)[number])) return;
  const [{ data: model }, { data: version }] = await Promise.all([
    supabaseAdmin.from("ml_models").select("*").eq("id", row.model_id).maybeSingle(),
    supabaseAdmin
      .from("ml_model_versions")
      .select("version")
      .eq("id", row.version_id)
      .maybeSingle(),
  ]);
  let secretValues: string[] = [];
  if (model) {
    try {
      secretValues = (await mlTrainingEnv(model, 0)).secretValues;
    } catch {
      /* scrub what we can */
    }
  }
  const logs = scrubSecrets((body.logs ?? "").slice(-LOG_CAP), secretValues);
  const ok = body.status !== "error" && isPredictResult(body.result);
  if (!ok) {
    const error = body.error
      ? scrubSecrets(body.error, secretValues)
      : body.status !== "error"
        ? "The sandbox finished without returning predictions."
        : "The sandbox ended with an error.";
    await markPredictionFailed(id, error, logs);
    return;
  }
  const r = body.result as MlPredictResult;
  const now = new Date().toISOString();
  const limits = await getPlatformResources();
  const digest = resultDigest(r.digest_columns, r.digest_rows as never[]);
  const { data: claimed } = await supabaseAdmin
    .from("ml_predictions")
    .update({
      status: "succeeded",
      logs,
      error: null,
      finished_at: now,
      row_count: r.row_count,
      output: (r.output ?? row.output) as Json,
      result: {
        columns: r.columns,
        sample: r.sample.slice(0, row.kind === "rows" ? ML_ROWS_PREDICT_CAP : 50),
        algorithm: r.algorithm ?? null,
        warnings: r.warnings ?? [],
        result_digest: digest,
        elapsed_seconds: r.elapsed_seconds ?? null,
      } as Json,
    })
    .eq("id", id)
    .in("status", LIVE)
    .select("id")
    .maybeSingle();
  if (!claimed) return;
  const input = row.input as {
    kind: string;
    schema?: string;
    table?: string;
    where?: string;
    count?: number;
  };
  auditEvent({
    userId: row.user_id,
    action: "ml.predict_query",
    resourceType: "ml_model",
    resourceId: row.model_id,
    resourceName: model?.name ?? undefined,
    decisionId: row.decision_id,
    detail: {
      via: row.via,
      prediction_id: id,
      kind: row.kind,
      version: version?.version ?? null,
      input:
        input.kind === "rows"
          ? { kind: ROWS_KIND, count: input.count ?? r.row_count }
          : {
              kind: LAKEHOUSE_KIND,
              table: `${input.schema}.${input.table}`,
              where: input.where ?? null,
            },
      output: r.output ? `${r.output.schema}.${r.output.table}` : null,
      row_count: r.row_count,
      row_cap: row.kind === "rows" ? ML_ROWS_PREDICT_CAP : limits.mlPredictMaxRows,
      result_digest: digest,
    },
  });
  console.log(
    `[ml-predict] ${JSON.stringify({
      prediction_id: id,
      model_id: row.model_id,
      version: version?.version ?? null,
      status: "succeeded",
      kind: row.kind,
      via: row.via,
      rows: r.row_count,
      output: r.output ? `${r.output.schema}.${r.output.table}` : null,
      elapsed_s: r.elapsed_seconds ?? null,
    })}`,
  );
}

/** Bring a run up to date from its sandbox session (UI polls, sync waits). */
export async function refreshPrediction(id: string): Promise<MlPredictionRow | null> {
  const { data: row } = await supabaseAdmin
    .from("ml_predictions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!row) return null;
  if (!LIVE.includes(row.status as (typeof LIVE)[number]) || !row.session_id) return row;
  const { data: session } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("*")
    .eq("id", row.session_id)
    .maybeSingle();
  if (!session) return row;
  const fresh = await refreshSession(session).catch(() => session);
  if (fresh.status === "succeeded") {
    await finalizePrediction(id, {
      status: "succeeded",
      result: fresh.result ?? undefined,
      logs: fresh.logs ?? "",
    });
  } else if (["error", "stopped"].includes(fresh.status)) {
    await finalizePrediction(id, {
      status: "error",
      logs: fresh.logs ?? "",
      error:
        [fresh.error, fresh.logs?.slice(-2000)].filter(Boolean).join("\n") ||
        "The sandbox ended without reporting a result.",
    });
  } else if (typeof fresh.logs === "string" && fresh.logs && fresh.logs !== row.logs) {
    await appendPredictionLogs(id, fresh.logs);
  }
  const { data: updated } = await supabaseAdmin
    .from("ml_predictions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return updated ?? row;
}

/** Sweep: finalise runs whose sandbox ended without calling back. */
export async function reconcileOrphanedPredictions(): Promise<number> {
  const graceAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: live } = await supabaseAdmin
    .from("ml_predictions")
    .select("id, session_id, status, created_at")
    .in("status", LIVE)
    .lt("created_at", graceAgo)
    .limit(20);
  let reconciled = 0;
  for (const row of live ?? []) {
    if (!row.session_id) {
      if (row.status === "queued") {
        await markPredictionFailed(row.id, "The run never acquired a sandbox session.", "");
        reconciled++;
      }
      continue;
    }
    const before = row.status;
    const after = await refreshPrediction(row.id);
    if (after && after.status !== before) reconciled++;
  }
  return reconciled;
}

export async function cancelPrediction(id: string, userId: string): Promise<boolean> {
  const { data: claimed } = await supabaseAdmin
    .from("ml_predictions")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .in("status", LIVE)
    .select("id, session_id, model_id, decision_id")
    .maybeSingle();
  if (!claimed) return false;
  if (claimed.session_id) {
    const { data: session } = await supabaseAdmin
      .from("notebook_runtime_sessions")
      .select("*")
      .eq("id", claimed.session_id)
      .maybeSingle();
    if (session) await stopSession(session).catch(() => {});
  }
  auditEvent({
    userId,
    action: "ml.predict.cancel",
    resourceType: "ml_model",
    resourceId: claimed.model_id,
    decisionId: claimed.decision_id,
    detail: { prediction_id: id },
  });
  return true;
}

/**
 * Score a small payload and wait for the answer — the try-it form and the
 * agent tool. Polls the run; past the deadline it hands back the id so the
 * caller can keep polling instead of holding a connection open.
 */
export async function predictRowsSync(args: {
  model: MlModelRow;
  version: MlVersionRow;
  userId: string;
  rows: Record<string, unknown>[];
  via: string;
  decisionId?: string | null;
  waitMs?: number;
}): Promise<
  | {
      ok: true;
      predictionId: string;
      columns: string[];
      rows: MlCell[][];
      algorithm: string | null;
      warnings: string[];
      elapsedSeconds: number | null;
    }
  | { ok: false; error: string; predictionId?: string; pending?: boolean }
> {
  const started = await startPrediction({
    model: args.model,
    version: args.version,
    userId: args.userId,
    input: { kind: ROWS_KIND, rows: args.rows },
    output: null,
    kind: ROWS_KIND,
    via: args.via,
    decisionId: args.decisionId,
  });
  if (!started.ok) return started;
  const deadline = Date.now() + (args.waitMs ?? 90_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const row = await refreshPrediction(started.predictionId);
    if (!row) break;
    if (row.status === "succeeded") {
      const res = row.result as {
        columns: string[];
        sample: MlCell[][];
        algorithm: string | null;
        warnings: string[];
        elapsed_seconds: number | null;
      };
      return {
        ok: true,
        predictionId: row.id,
        columns: res.columns,
        rows: res.sample,
        algorithm: res.algorithm,
        warnings: res.warnings ?? [],
        elapsedSeconds: res.elapsed_seconds,
      };
    }
    if (row.status === "failed" || row.status === "cancelled") {
      return { ok: false, error: row.error ?? "Prediction failed", predictionId: row.id };
    }
  }
  return {
    ok: false,
    pending: true,
    predictionId: started.predictionId,
    error:
      "Still scoring — the sandbox is taking longer than expected; the result appears under Predictions when it lands.",
  };
}

/** What predictRowsSync (and the mlPredictRows server function) resolve to. */
export type MlRowsPredictResult = Awaited<ReturnType<typeof predictRowsSync>>;
