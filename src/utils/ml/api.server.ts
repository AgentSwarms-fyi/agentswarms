// The ML service behind both the app's server functions and the public
// /api/ml/* routes: one code path for training a version and starting a
// prediction, whoever asks. The routes add key authentication, scopes, a
// rate limit and attribution; the app adds a signed-in user. Neither has a
// private shortcut around the limits, the audit trail or the lakehouse guard.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { accessibleSchemas, runLakehouseStatement } from "@/utils/lakehouse/core.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";
import { clientIp, clientUserAgent } from "@/utils/requestMeta.server";
import { hashMlApiKey, looksLikeMlApiKey, type MlKeyScope } from "@/utils/mlApiKeys";
import type { MlModelRow, MlVersionRow } from "./access.server";
import { ML_ROWS_PREDICT_CAP, startPrediction } from "./predict.server";
import { startTrainingJob } from "./train.server";
import {
  ML_PRIMARY_METRIC,
  ML_TUNINGS,
  type MlPrepConfig,
  type MlSource,
  type MlTask,
  type MlTrainConfig,
} from "./types";

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;

// ── Training ─────────────────────────────────────────────────────────────────

export type MlTrainInput = {
  time_budget_minutes?: number;
  max_rows?: number;
  tuning?: MlTrainConfig["tuning"];
  prep?: MlPrepConfig;
  feature_columns?: string[];
};

/** The pinned config of a version: the operator's limits are the ceiling. */
export async function mlTrainConfig(input: MlTrainInput): Promise<MlTrainConfig> {
  const r = await getPlatformResources();
  return {
    tuning: input.tuning && ML_TUNINGS.includes(input.tuning) ? input.tuning : "none",
    prep: input.prep ?? {},
    max_rows: Math.min(input.max_rows ?? r.mlTrainMaxRows, r.mlTrainMaxRows),
    time_budget_minutes: input.time_budget_minutes ?? r.mlTrainTimeBudgetMinutes,
    validation_fraction: 0.2,
  };
}

/**
 * Run the prepared rows through the lakehouse guard as the caller — before
 * any sandbox starts — and confirm the target survives the preparation.
 */
export async function validateMlPrep(
  userId: string,
  source: MlSource,
  target: string | null | undefined,
  prep: MlPrepConfig,
): Promise<{ ok: true; rows: number } | { ok: false; error: string }> {
  const rel = `${q(source.schema)}.${q(source.table)}`;
  const body = prep.sql?.trim()
    ? `(${prep.sql.trim().replace(/;\s*$/, "")}) AS _prep`
    : prep.where?.trim()
      ? `${rel} WHERE (${prep.where.trim()})`
      : rel;
  try {
    const head = await runLakehouseStatement(userId, `SELECT * FROM ${body} LIMIT 0`, {
      auditVia: "ml-prep-check",
      rowCap: 1,
    });
    if (target && !head.columns.some((c) => c.name === target)) {
      return { ok: false, error: `The prepared rows have no "${target}" column` };
    }
    const count = await runLakehouseStatement(userId, `SELECT count(*) AS n FROM ${body}`, {
      auditVia: "ml-prep-check",
      rowCap: 1,
    });
    return { ok: true, rows: Number(count.rows[0]?.[0] ?? 0) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Insert the version row and start its sandbox; a start failure fails the version. */
export async function createAndTrainVersion(
  model: MlModelRow,
  config: MlTrainConfig,
  version: number,
  opts: { apiKeyId?: string | null; trigger?: string } = {},
): Promise<{ ok: true; jobId: string; versionId: string } | { ok: false; error: string }> {
  const { data: v, error } = await supabaseAdmin
    .from("ml_model_versions")
    .insert({
      model_id: model.id,
      user_id: model.user_id,
      version,
      status: "training",
      config: config as unknown as Json,
    })
    .select("*")
    .single();
  if (error || !v) return { ok: false, error: error?.message ?? "Failed to create version" };
  const started = await startTrainingJob({ model, version: v, trigger: opts.trigger });
  if (!started.ok) {
    await supabaseAdmin
      .from("ml_model_versions")
      .update({ status: "failed", warnings: [started.error] as Json })
      .eq("id", v.id);
    return started;
  }
  if (opts.apiKeyId) {
    await supabaseAdmin
      .from("ml_training_jobs")
      .update({ api_key_id: opts.apiKeyId })
      .eq("id", started.jobId);
  }
  return { ok: true, jobId: started.jobId, versionId: v.id };
}

/**
 * Train the next version of a model: optionally replace its saved data
 * preparation and feature list (checked first), then pin a config and start.
 */
export async function trainNewVersion(
  model: MlModelRow,
  input: MlTrainInput,
  opts: { userId: string; apiKeyId?: string | null; trigger?: string },
): Promise<{ ok: true; jobId: string; versionId: string } | { ok: false; error: string }> {
  if (input.prep) {
    const checked = await validateMlPrep(
      opts.userId,
      model.source as MlSource,
      model.target_column,
      input.prep,
    );
    if (!checked.ok) return { ok: false, error: checked.error };
    await supabaseAdmin
      .from("ml_models")
      .update({ prep: input.prep as Json, updated_at: new Date().toISOString() })
      .eq("id", model.id);
    (model as { prep?: unknown }).prep = input.prep;
  }
  if (input.feature_columns) {
    const cols = input.feature_columns.length ? input.feature_columns : null;
    await supabaseAdmin
      .from("ml_models")
      .update({ feature_columns: cols, updated_at: new Date().toISOString() })
      .eq("id", model.id);
    model.feature_columns = cols;
  }
  const { data: last } = await supabaseAdmin
    .from("ml_model_versions")
    .select("version")
    .eq("model_id", model.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const config = await mlTrainConfig({
    ...input,
    prep: ((model as { prep?: unknown }).prep ?? {}) as MlPrepConfig,
  });
  return createAndTrainVersion(model, config, (last?.version ?? 0) + 1, opts);
}

// ── Versions ─────────────────────────────────────────────────────────────────

/** A named version, else production, else the newest ready one. */
export async function pickVersion(
  modelId: string,
  versionId: string | undefined,
  productionId: string | null,
): Promise<MlVersionRow | null> {
  if (versionId) {
    const { data } = await supabaseAdmin
      .from("ml_model_versions")
      .select("*")
      .eq("id", versionId)
      .eq("model_id", modelId)
      .maybeSingle();
    return data ?? null;
  }
  if (productionId) {
    const { data } = await supabaseAdmin
      .from("ml_model_versions")
      .select("*")
      .eq("id", productionId)
      .maybeSingle();
    if (data) return data;
  }
  const { data } = await supabaseAdmin
    .from("ml_model_versions")
    .select("*")
    .eq("model_id", modelId)
    .eq("status", "ready")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * Register a version trained elsewhere. The artifact must already sit in the
 * lake bucket and follow the external contract (a joblib dict with task,
 * pipeline, features and, for classifiers, classes); inference verifies the
 * digest before loading it, exactly as it does for a trained one.
 */
export async function registerExternalVersion(
  model: MlModelRow,
  input: {
    artifact_uri: string;
    artifact_sha256: string;
    algorithm: string;
    metrics?: Record<string, number | null>;
    feature_schema?: { name: string; dtype: string; role: string; categories?: string[] }[];
    classes?: string[];
    promote?: boolean;
  },
  opts: { userId: string; apiKeyId?: string | null },
): Promise<{ ok: true; versionId: string; version: number } | { ok: false; error: string }> {
  if (!/^s3:\/\/[^/]+\/.+/.test(input.artifact_uri)) {
    return { ok: false, error: "artifact_uri must be an s3://bucket/path in the lake bucket" };
  }
  if (!/^[0-9a-f]{64}$/i.test(input.artifact_sha256)) {
    return { ok: false, error: "artifact_sha256 must be the hex SHA-256 of the artifact bytes" };
  }
  if (model.task === "forecast" || model.task === "recommendation") {
    return {
      ok: false,
      error: `External versions are supported for classification, regression, clustering and anomaly models, not ${model.task}`,
    };
  }
  const { data: last } = await supabaseAdmin
    .from("ml_model_versions")
    .select("version")
    .eq("model_id", model.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (last?.version ?? 0) + 1;
  const features = (input.feature_schema ?? []).filter((e) => e.role === "feature");
  const { data: v, error } = await supabaseAdmin
    .from("ml_model_versions")
    .insert({
      model_id: model.id,
      user_id: model.user_id,
      version,
      status: "ready",
      stage: "candidate",
      external: true,
      algorithm: input.algorithm,
      artifact_uri: input.artifact_uri,
      artifact_sha256: input.artifact_sha256.toLowerCase(),
      metrics: (input.metrics ?? {}) as Json,
      feature_schema: (input.feature_schema ?? []) as unknown as Json,
      config: {
        external: true,
        features: features.map((f) => f.name),
        classes: input.classes ?? null,
      } as unknown as Json,
      warnings: ["Registered through the API; metrics are as reported by the caller."] as Json,
      trained_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !v) return { ok: false, error: error?.message ?? "Failed to register the version" };
  auditEvent({
    userId: opts.userId,
    action: "ml.version.register",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      version,
      version_id: v.id,
      artifact_sha256: input.artifact_sha256.toLowerCase(),
      api_key_id: opts.apiKeyId ?? null,
    },
  });
  if (input.promote || !model.production_version_id) {
    await promoteVersion(model, v.id, opts.userId);
  }
  return { ok: true, versionId: v.id, version };
}

/** Make a version the production one; the previous production version is archived. */
export async function promoteVersion(
  model: MlModelRow,
  versionId: string,
  userId: string,
): Promise<void> {
  if (model.production_version_id && model.production_version_id !== versionId) {
    await supabaseAdmin
      .from("ml_model_versions")
      .update({ stage: "archived" })
      .eq("id", model.production_version_id);
  }
  await supabaseAdmin.from("ml_model_versions").update({ stage: "production" }).eq("id", versionId);
  await supabaseAdmin
    .from("ml_models")
    .update({ production_version_id: versionId, updated_at: new Date().toISOString() })
    .eq("id", model.id);
  model.production_version_id = versionId;
  auditEvent({
    userId,
    action: "ml.version.promote",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: { version_id: versionId },
  });
}

// ── Predictions ──────────────────────────────────────────────────────────────

/** Validate a batch prediction's tables and size, then start it. */
export async function startBatchPrediction(args: {
  userId: string;
  model: MlModelRow;
  version: MlVersionRow;
  input: { schema: string; table: string; where?: string };
  output: { schema: string; table: string };
  via: string;
  apiKeyId?: string | null;
}): Promise<{ ok: true; predictionId: string } | { ok: false; error: string }> {
  const { userId, model, version } = args;
  const schemas = await accessibleSchemas(userId);
  if (!schemas.some((s) => s.name === args.input.schema)) {
    return { ok: false, error: `No access to lakehouse schema "${args.input.schema}"` };
  }
  // The output must be a schema the caller OWNS: a shared schema is
  // read-only for them, and a mounted lake source is read-only for everyone.
  const out = schemas.find((s) => s.name === args.output.schema);
  if (!out || out.user_id !== userId || out.lake_source_id) {
    return {
      ok: false,
      error: `Predictions can only be written to a lakehouse schema you own (not "${args.output.schema}")`,
    };
  }
  const r = await getPlatformResources();
  const rel = `${q(args.input.schema)}.${q(args.input.table)}`;
  let rows = 0;
  try {
    const count = await runLakehouseStatement(
      userId,
      `SELECT count(*) AS n FROM ${rel}${args.input.where?.trim() ? ` WHERE (${args.input.where.trim()})` : ""}`,
      { auditVia: "ml-predict-check", rowCap: 1 },
    );
    rows = Number(count.rows[0]?.[0] ?? 0);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (rows === 0) return { ok: false, error: "No rows match" };
  if (rows > r.mlPredictMaxRows) {
    return {
      ok: false,
      error: `${rows.toLocaleString()} rows to score, above the ${r.mlPredictMaxRows.toLocaleString()}-row limit. Add a filter, or raise ML_PREDICT_MAX_ROWS under Admin -> Developer runtime.`,
    };
  }
  const started = await startPrediction({
    model,
    version,
    userId,
    input: { kind: "lakehouse", ...args.input },
    output: args.output,
    kind: "batch",
    via: args.via,
  });
  if (!started.ok) return started;
  if (args.apiKeyId) {
    await supabaseAdmin
      .from("ml_predictions")
      .update({ api_key_id: args.apiKeyId })
      .eq("id", started.predictionId);
  }
  return { ok: true, predictionId: started.predictionId };
}

export { ML_ROWS_PREDICT_CAP };

// ── Public route authentication ──────────────────────────────────────────────

export type MlApiKeyRecord = {
  id: string;
  user_id: string;
  model_id: string;
  scopes: string[];
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  use_count: number;
};

export type MlApiAuth =
  | { ok: true; key: MlApiKeyRecord; model: MlModelRow }
  | { ok: false; status: number; error: string };

/** The documented ceiling per key; a governance claim, so the global limiter. */
export const mlApiRateLimitPerMinute = () => envInt("ML_API_RATE_LIMIT_PER_MIN", 60);

/**
 * Resolve `Authorization: Bearer mlk_…` to its key and model, or say why not.
 * Denials are audited with the reason, the key id when one matched, and the
 * caller's address — a leaked or expired key shows up in the audit log the
 * first time it is tried.
 */
export async function authenticateMlApiKey(
  request: Request,
  scope: MlKeyScope,
): Promise<MlApiAuth> {
  const auth = request.headers.get("authorization") || "";
  const raw = auth.replace(/^Bearer\s+/i, "").trim();
  const meta = { ip: clientIp(request), user_agent: clientUserAgent(request) };
  const deny = (
    reason: string,
    error: string,
    status: number,
    key?: { id: string; user_id: string; model_id: string } | null,
  ): MlApiAuth => {
    if (key) {
      auditEvent({
        userId: key.user_id,
        action: "ml.api_key.denied",
        resourceType: "ml_model",
        resourceId: key.model_id,
        detail: { reason, key_id: key.id, scope, ...meta },
      });
    }
    return { ok: false, status, error };
  };
  if (!raw) return deny("missing", "Missing API key", 401);
  if (!looksLikeMlApiKey(raw)) return deny("malformed", "Invalid API key", 401);

  const { data: key } = await supabaseAdmin
    .from("ml_api_keys")
    .select("id, user_id, model_id, scopes, is_active, expires_at, revoked_at, use_count")
    .eq("key_hash", await hashMlApiKey(raw))
    .maybeSingle();
  if (!key) return deny("unknown", "Invalid API key", 401);
  if (!key.is_active || key.revoked_at) {
    return deny("revoked", "This API key has been revoked", 401, key);
  }
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    return deny("expired", "This API key has expired", 401, key);
  }
  if (!key.scopes.includes(scope)) {
    return deny("scope", `This key does not have the "${scope}" scope`, 403, key);
  }
  if (await rateLimitedGlobal(`ml-api:${key.id}`, mlApiRateLimitPerMinute())) {
    return deny("rate_limited", "Rate limit exceeded for this key; retry in a minute", 429, key);
  }
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", key.model_id)
    .maybeSingle();
  if (!model) return deny("model_missing", "The model behind this key no longer exists", 404, key);

  // Usage tracking is best-effort and must never fail the call.
  void supabaseAdmin
    .from("ml_api_keys")
    .update({
      use_count: (key.use_count ?? 0) + 1,
      last_used_at: new Date().toISOString(),
      last_used_ip: meta.ip ?? null,
    })
    .eq("id", key.id)
    .then(() => {});

  return { ok: true, key, model };
}

// ── Response shapes ──────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export const mlJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

export const mlOptions = (): Response => new Response(null, { status: 204, headers: CORS });

export async function mlBody<T extends Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const parsed = (await request.json()) as unknown;
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

/** What the outside world sees of a model: no owner ids, no artifact paths. */
export function modelSummary(model: MlModelRow, versions: MlVersionRow[]) {
  const production = versions.find((v) => v.id === model.production_version_id) ?? null;
  const schema = (production?.feature_schema ?? []) as {
    name: string;
    dtype: string;
    role: string;
    categories?: string[];
  }[];
  return {
    id: model.id,
    name: model.name,
    task: model.task,
    target_column: model.target_column,
    user_column: model.user_column,
    item_column: model.item_column,
    source: model.source,
    primary_metric: ML_PRIMARY_METRIC[model.task as MlTask] ?? null,
    production_version: production
      ? {
          id: production.id,
          version: production.version,
          algorithm: production.algorithm,
          metrics: production.metrics,
          trained_at: production.trained_at,
          external: Boolean((production as { external?: boolean }).external),
          warnings: (production.warnings ?? []) as string[],
          features: schema
            .filter((e) => e.role === "feature")
            .map((e) => ({ name: e.name, type: e.dtype, categories: e.categories?.slice(0, 50) })),
        }
      : null,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      stage: v.stage,
      status: v.status,
      algorithm: v.algorithm,
      metrics: v.metrics,
      trained_at: v.trained_at,
      external: Boolean((v as { external?: boolean }).external),
      warnings: (v.warnings ?? []) as string[],
    })),
  };
}

export function jobSummary(job: {
  id: string;
  version_id: string | null;
  status: string;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds?: number | null;
}) {
  return {
    job_id: job.id,
    version_id: job.version_id,
    status: job.status,
    error: job.error,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

export function predictionSummary(row: {
  id: string;
  status: string;
  error: string | null;
  kind: string;
  row_count: number | null;
  output: Json;
  result: Json;
  started_at: string | null;
  finished_at: string | null;
}) {
  const result = (row.result ?? {}) as {
    columns?: string[];
    sample?: unknown[][];
    result_digest?: string;
    warnings?: string[];
    algorithm?: string | null;
    drift?: { score: number; features: Record<string, number>; rows: number } | null;
  };
  return {
    prediction_id: row.id,
    status: row.status,
    kind: row.kind,
    error: row.error,
    row_count: row.row_count,
    output: row.output,
    columns: result.columns ?? null,
    sample: result.sample ?? null,
    result_digest: result.result_digest ?? null,
    warnings: result.warnings ?? [],
    algorithm: result.algorithm ?? null,
    drift: result.drift ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}
