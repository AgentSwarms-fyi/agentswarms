// ML platform server functions: the registry, training, and what the wizard
// needs to know about a table before it trains on it.
//
// Auth is the caller's access token in the payload (the house pattern, see
// lakehouse.functions.ts). Ownership vs. share is decided by
// ml/access.server.ts; every mutation demands ownership, every read accepts a
// grant. CRUD on ml_models is audited by trigger; the explicit auditEvent
// calls here cover what a trigger cannot see (why a version was promoted,
// which job was cancelled).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { listLakehouseTablesForUser } from "@/utils/lakehouse/tables.server";
import {
  accessibleSchemas,
  lakehouseConnection,
  lakehouseEnabled,
  runLakehouseStatement,
} from "@/utils/lakehouse/core.server";
import {
  listModelsForUser,
  loadModelForUser,
  type MlJobRow,
  type MlModelRow,
  type MlVersionRow,
} from "./ml/access.server";
import { cancelMlJob, refreshMlJob } from "./ml/train.server";
import {
  ML_ROWS_PREDICT_CAP,
  cancelPrediction,
  predictRowsSync,
  refreshPrediction,
  type MlPredictionRow,
  type MlRowsPredictResult,
} from "./ml/predict.server";
import {
  createAndTrainVersion,
  mlTrainConfig as trainConfig,
  pickVersion,
  startBatchPrediction,
  trainNewVersion,
  validateMlPrep as validatePrep,
} from "./ml/api.server";
import {
  ML_JOB_LIVE,
  ML_TARGET_TASKS,
  ML_TASKS,
  ML_TUNINGS,
  ML_VERSION_STAGES,
  type MlPrepConfig,
  type MlSource,
  type MlTrainConfig,
} from "./ml/types";

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const NAME = z.string().trim().min(1).max(120);
const IDENT = z.string().min(1).max(200);

export type MlLimits = {
  train_max_rows: number;
  train_time_budget_minutes: number;
  train_mem_limit_mb: number;
  max_concurrent_trainings_per_user: number;
  predict_max_rows: number;
};

async function limits(): Promise<MlLimits> {
  const r = await getPlatformResources();
  return {
    train_max_rows: r.mlTrainMaxRows,
    train_time_budget_minutes: r.mlTrainTimeBudgetMinutes,
    train_mem_limit_mb: r.mlTrainMemLimitMb,
    max_concurrent_trainings_per_user: r.mlMaxConcurrentTrainingsPerUser,
    predict_max_rows: r.mlPredictMaxRows,
  };
}

export type MlVersionSummary = Pick<
  MlVersionRow,
  | "id"
  | "version"
  | "status"
  | "stage"
  | "algorithm"
  | "metrics"
  | "trained_at"
  | "training_rows"
  | "created_at"
>;

export type MlModelSummary = MlModelRow & {
  shared: boolean;
  production: MlVersionSummary | null;
  latest: MlVersionSummary | null;
  versions_count: number;
  live_job: boolean;
};

const VERSION_SUMMARY =
  "id, model_id, version, status, stage, algorithm, metrics, trained_at, training_rows, created_at";

// ── Registry ─────────────────────────────────────────────────────────────────

export const mlListModels = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({ data }): Promise<{ enabled: boolean; models: MlModelSummary[]; limits: MlLimits }> => {
      const userId = await resolveCaller(data.access_token);
      const models = await listModelsForUser(userId);
      const lim = await limits();
      if (!models.length) return { enabled: lakehouseEnabled(), models: [], limits: lim };
      const ids = models.map((m) => m.id);
      const [{ data: versions }, { data: liveJobs }] = await Promise.all([
        supabaseAdmin
          .from("ml_model_versions")
          .select(VERSION_SUMMARY)
          .in("model_id", ids)
          .order("version", { ascending: false }),
        supabaseAdmin
          .from("ml_training_jobs")
          .select("model_id")
          .in("model_id", ids)
          .in("status", [...ML_JOB_LIVE]),
      ]);
      const byModel = new Map<string, MlVersionSummary[]>();
      for (const v of versions ?? []) {
        const list = byModel.get(v.model_id) ?? [];
        list.push(v);
        byModel.set(v.model_id, list);
      }
      const live = new Set((liveJobs ?? []).map((j) => j.model_id));
      return {
        enabled: lakehouseEnabled(),
        limits: lim,
        models: models.map((m) => {
          const list = byModel.get(m.id) ?? [];
          return {
            ...m,
            production: list.find((v) => v.id === m.production_version_id) ?? null,
            latest: list[0] ?? null,
            versions_count: list.length,
            live_job: live.has(m.id),
          };
        }),
      };
    },
  );

export type MlSourceTable = {
  schema: string;
  table: string;
  columns: { name: string; type: string }[];
};

/** Lakehouse tables the caller may train on, with their columns. */
export const mlListSources = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<{ enabled: boolean; tables: MlSourceTable[] }> => {
    const userId = await resolveCaller(data.access_token);
    const r = await listLakehouseTablesForUser(userId);
    return { enabled: r.enabled, tables: r.tables };
  });

export type MlColumnProfile = {
  name: string;
  type: string;
  approx_distinct: number | null;
  null_pct: number | null;
  min: string | null;
  max: string | null;
  samples: string[];
  /** What the column looks like to a trainer, for the wizard's suggestions. */
  kind: "numeric" | "categorical" | "datetime" | "boolean" | "text" | "identifier" | "constant";
  suggested_task: "classification" | "regression" | null;
};

const ID_NAME = /(^|_)(id|uuid|guid|key|code)$|^id$/i;

/**
 * What a column looks like to a trainer. Floats are never identifiers (a
 * price column is unique per row and still a fine target); integers and
 * strings are identifiers when named like one or near-unique; a constant
 * column cannot be predicted at all.
 */
function columnKind(
  name: string,
  type: string,
  distinct: number | null,
  rows: number,
): MlColumnProfile["kind"] {
  const t = type.toUpperCase();
  if (/BOOL/.test(t)) return "boolean";
  if (/DATE|TIME/.test(t)) return "datetime";
  const float = /FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL/.test(t);
  const integer = !float && /INT/.test(t);
  if (distinct !== null && distinct <= 1 && rows > 1) return "constant";
  if (!float && distinct !== null && distinct > 20 && ID_NAME.test(name)) return "identifier";
  if (!float && distinct !== null && rows > 20 && distinct >= 0.9 * rows && distinct > 20) {
    return "identifier";
  }
  if (float || integer) return "numeric";
  if (distinct !== null && distinct <= 200) return "categorical";
  return "text";
}

/** Profile one table: per-column statistics, samples and a task suggestion. */
export const mlProfileSource = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), schema: IDENT, table: IDENT }).parse(input),
  )
  .handler(async ({ data }): Promise<{ row_count: number; columns: MlColumnProfile[] }> => {
    const userId = await resolveCaller(data.access_token);
    // SUMMARIZE carries no schema the statement guard can extract, so the
    // access check is explicit here rather than inherited.
    const allowed = new Set((await accessibleSchemas(userId)).map((sch) => sch.name));
    if (!allowed.has(data.schema)) {
      throw new Error(`No access to lakehouse schema "${data.schema}"`);
    }
    const rel = `${q(data.schema)}.${q(data.table)}`;
    const [count, summary, sample] = await Promise.all([
      runLakehouseStatement(userId, `SELECT count(*) AS n FROM ${rel}`, { auditVia: "ml-profile" }),
      runLakehouseStatement(userId, `SUMMARIZE SELECT * FROM ${rel}`, {
        auditVia: "ml-profile",
        rowCap: 5000,
        timeoutMs: 120_000,
      }),
      runLakehouseStatement(userId, `SELECT * FROM ${rel} LIMIT 8`, {
        auditVia: "ml-profile",
        rowCap: 8,
      }),
    ]);
    const rows = Number(count.rows[0]?.[0] ?? 0);
    const si = Object.fromEntries(summary.columns.map((c, i) => [c.name, i]));
    const sampleIdx = Object.fromEntries(sample.columns.map((c, i) => [c.name, i]));
    const columns: MlColumnProfile[] = summary.rows.map((r) => {
      const name = String(r[si.column_name]);
      const type = String(r[si.column_type]);
      const distinctRaw = r[si.approx_unique];
      const distinct =
        distinctRaw === null || distinctRaw === undefined ? null : Number(distinctRaw);
      const nullRaw = r[si.null_percentage];
      const nullPct =
        nullRaw === null || nullRaw === undefined ? null : Number(String(nullRaw).replace("%", ""));
      const kind = columnKind(name, type, distinct, rows);
      const samples = sample.rows
        .map((s) => s[sampleIdx[name]])
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v))
        .slice(0, 5);
      const suggested =
        kind === "identifier" || kind === "datetime" || kind === "text" || kind === "constant"
          ? null
          : kind === "numeric" && distinct !== null && distinct > 20
            ? "regression"
            : "classification";
      return {
        name,
        type,
        approx_distinct: distinct,
        null_pct: nullPct,
        min: r[si.min] === null || r[si.min] === undefined ? null : String(r[si.min]),
        max: r[si.max] === null || r[si.max] === undefined ? null : String(r[si.max]),
        samples,
        kind,
        suggested_task: suggested,
      };
    });
    return { row_count: rows, columns };
  });

const prepSchema = z.object({
  where: z.string().max(2000).optional(),
  sql: z.string().max(20_000).optional(),
  impute: z
    .object({
      numeric: z.enum(["median", "mean", "constant"]).optional(),
      categorical: z.enum(["most_frequent", "constant"]).optional(),
    })
    .optional(),
  scale: z.boolean().optional(),
  encoding: z.enum(["onehot", "ordinal"]).optional(),
  class_weight: z.enum(["none", "balanced"]).optional(),
  target_clip: z
    .tuple([z.number().min(0).max(100), z.number().min(0).max(100)])
    .nullable()
    .optional(),
  drop_columns: z.array(IDENT).max(500).optional(),
});

export const mlValidatePrep = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        source: z.object({ kind: z.literal("lakehouse"), schema: IDENT, table: IDENT }),
        target_column: IDENT.optional(),
        prep: prepSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const userId = await resolveCaller(data.access_token);
    return validatePrep(userId, data.source, data.target_column, data.prep as MlPrepConfig);
  });

const createSchema = z.object({
  access_token: z.string().min(1),
  name: NAME,
  description: z.string().max(2000).optional(),
  task: z.enum(ML_TASKS),
  source: z.object({ kind: z.literal("lakehouse"), schema: IDENT, table: IDENT }),
  target_column: IDENT.optional(),
  time_column: IDENT.optional(),
  user_column: IDENT.optional(),
  item_column: IDENT.optional(),
  rating_column: IDENT.optional(),
  n_clusters: z.number().int().min(2).max(50).optional(),
  contamination: z.number().min(0.001).max(0.5).optional(),
  horizon: z.number().int().min(1).max(1000).optional(),
  aggregation: z.enum(["sum", "mean"]).optional(),
  feature_columns: z.array(IDENT).max(500).optional(),
  time_budget_minutes: z.number().int().min(1).optional(),
  max_rows: z.number().int().min(100).optional(),
  prep: prepSchema.optional(),
  tuning: z.enum(ML_TUNINGS).optional(),
});

/** Create a model and train its first version. */
export const mlCreateModel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; model_id: string; job_id: string }
      | { ok: false; error: string; model_id?: string }
    > => {
      const userId = await resolveCaller(data.access_token);
      if (data.task === "forecast" && !data.time_column) {
        return { ok: false, error: "A forecast needs a time column" };
      }
      if (ML_TARGET_TASKS.includes(data.task) && !data.target_column) {
        return { ok: false, error: "Choose the column to predict" };
      }
      if (data.task === "recommendation" && (!data.user_column || !data.item_column)) {
        return { ok: false, error: "A recommendation needs a user column and an item column" };
      }
      const allowed = new Set((await accessibleSchemas(userId)).map((s) => s.name));
      if (!allowed.has(data.source.schema)) {
        return { ok: false, error: `No access to lakehouse schema "${data.source.schema}"` };
      }
      const prep = (data.prep ?? {}) as MlPrepConfig;
      if (prep.sql || prep.where) {
        const checked = await validatePrep(userId, data.source, data.target_column, prep);
        if (!checked.ok) return { ok: false, error: checked.error };
      }
      const config = await trainConfig({ ...data, prep });
      const { data: model, error } = await supabaseAdmin
        .from("ml_models")
        .insert({
          prep: prep as Json,
          user_id: userId,
          name: data.name,
          description: data.description ?? null,
          task: data.task,
          source: data.source as Json,
          target_column: ML_TARGET_TASKS.includes(data.task) ? (data.target_column ?? null) : null,
          user_column: data.task === "recommendation" ? (data.user_column ?? null) : null,
          item_column: data.task === "recommendation" ? (data.item_column ?? null) : null,
          rating_column: data.task === "recommendation" ? (data.rating_column ?? null) : null,
          n_clusters: data.task === "clustering" ? (data.n_clusters ?? null) : null,
          contamination: data.task === "anomaly" ? (data.contamination ?? null) : null,
          time_column: data.task === "forecast" ? (data.time_column ?? null) : null,
          horizon: data.task === "forecast" ? (data.horizon ?? 12) : null,
          aggregation: data.task === "forecast" ? (data.aggregation ?? "sum") : null,
          feature_columns: data.feature_columns?.length ? data.feature_columns : null,
        })
        .select("*")
        .single();
      if (error || !model) {
        return {
          ok: false,
          error:
            error?.code === "23505"
              ? `You already have a model called "${data.name}"`
              : (error?.message ?? "Failed to create model"),
        };
      }
      const started = await createAndTrainVersion(model, config, 1);
      return started.ok
        ? { ok: true, model_id: model.id, job_id: started.jobId }
        : { ok: false, error: started.error, model_id: model.id };
    },
  );

/** Train a new version of an existing model (owner only). */
export const mlTrainVersion = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        time_budget_minutes: z.number().int().min(1).optional(),
        max_rows: z.number().int().min(100).optional(),
        feature_columns: z.array(IDENT).max(500).optional(),
        prep: prepSchema.optional(),
        tuning: z.enum(ML_TUNINGS).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; job_id: string; version_id: string } | { ok: false; error: string }
    > => {
      const userId = await resolveCaller(data.access_token);
      const { model } = await loadModelForUser(data.model_id, userId, { write: true });
      const started = await trainNewVersion(model, data, { userId });
      return started.ok
        ? { ok: true, job_id: started.jobId, version_id: started.versionId }
        : started;
    },
  );

export type MlModelDetail = {
  model: MlModelRow;
  shared: boolean;
  versions: MlVersionRow[];
  jobs: MlJobRow[];
  limits: MlLimits;
};

export const mlGetModel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), model_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<MlModelDetail> => {
    const userId = await resolveCaller(data.access_token);
    const { model, shared } = await loadModelForUser(data.model_id, userId);
    // Bring live jobs up to date before reading, so a finished sandbox whose
    // callback was missed resolves the moment someone looks.
    const { data: live } = await supabaseAdmin
      .from("ml_training_jobs")
      .select("id")
      .eq("model_id", model.id)
      .in("status", [...ML_JOB_LIVE]);
    for (const j of live ?? []) await refreshMlJob(j.id);
    const [{ data: versions }, { data: jobs }, { data: fresh }] = await Promise.all([
      supabaseAdmin
        .from("ml_model_versions")
        .select("*")
        .eq("model_id", model.id)
        .order("version", { ascending: false }),
      supabaseAdmin
        .from("ml_training_jobs")
        .select("*")
        .eq("model_id", model.id)
        .order("created_at", { ascending: false })
        .limit(20),
      supabaseAdmin.from("ml_models").select("*").eq("id", model.id).maybeSingle(),
    ]);
    return {
      model: fresh ?? model,
      shared,
      versions: versions ?? [],
      jobs: jobs ?? [],
      limits: await limits(),
    };
  });

export const mlGetJob = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), job_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ job: MlJobRow; version: MlVersionRow | null }> => {
    const userId = await resolveCaller(data.access_token);
    const job = await refreshMlJob(data.job_id);
    if (!job) throw new Error("Job not found");
    await loadModelForUser(job.model_id, userId);
    const { data: version } = await supabaseAdmin
      .from("ml_model_versions")
      .select("*")
      .eq("id", job.version_id)
      .maybeSingle();
    return { job, version: version ?? null };
  });

export const mlCancelJob = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), job_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const userId = await resolveCaller(data.access_token);
    return { ok: await cancelMlJob(data.job_id, userId) };
  });

/** Move a version between stages; `production` is exclusive per model. */
export const mlPromoteVersion = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        version_id: z.string().uuid(),
        stage: z.enum(ML_VERSION_STAGES),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: version } = await supabaseAdmin
      .from("ml_model_versions")
      .select("*")
      .eq("id", data.version_id)
      .maybeSingle();
    if (!version) return { ok: false, error: "Version not found" };
    const { model } = await loadModelForUser(version.model_id, userId, { write: true });
    if (data.stage === "production" && version.status !== "ready") {
      return { ok: false, error: "Only a trained version can serve production" };
    }
    const now = new Date().toISOString();
    if (data.stage === "production") {
      if (model.production_version_id && model.production_version_id !== version.id) {
        await supabaseAdmin
          .from("ml_model_versions")
          .update({ stage: "archived" })
          .eq("id", model.production_version_id);
      }
      await supabaseAdmin
        .from("ml_models")
        .update({ production_version_id: version.id, updated_at: now })
        .eq("id", model.id);
    } else if (model.production_version_id === version.id) {
      await supabaseAdmin
        .from("ml_models")
        .update({ production_version_id: null, updated_at: now })
        .eq("id", model.id);
    }
    await supabaseAdmin
      .from("ml_model_versions")
      .update({ stage: data.stage })
      .eq("id", version.id);
    auditEvent({
      userId,
      action: "ml.version.promote",
      resourceType: "ml_model",
      resourceId: model.id,
      resourceName: model.name,
      decisionId: version.id,
      detail: {
        version_id: version.id,
        version: version.version,
        from: version.stage,
        stage: data.stage,
      },
    });
    return { ok: true };
  });

export const mlUpdateModel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        name: NAME.optional(),
        description: z.string().max(2000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { model } = await loadModelForUser(data.model_id, userId, { write: true });
    const { error } = await supabaseAdmin
      .from("ml_models")
      .update({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", model.id);
    if (error) {
      return {
        ok: false,
        error:
          error.code === "23505" ? `You already have a model called "${data.name}"` : error.message,
      };
    }
    return { ok: true };
  });

/** Delete a model, its versions and jobs. Live jobs are cancelled first. */
export const mlDeleteModel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), model_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await resolveCaller(data.access_token);
    const { model } = await loadModelForUser(data.model_id, userId, { write: true });
    const { data: live } = await supabaseAdmin
      .from("ml_training_jobs")
      .select("id")
      .eq("model_id", model.id)
      .in("status", [...ML_JOB_LIVE]);
    for (const j of live ?? []) await cancelMlJob(j.id, userId);
    const { error } = await supabaseAdmin.from("ml_models").delete().eq("id", model.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── Predictions ──────────────────────────────────────────────────────────────

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Score a lakehouse table into a new lakehouse table the caller owns. */
export const mlPredictBatch = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        version_id: z.string().uuid().optional(),
        input: z.object({ schema: IDENT, table: IDENT, where: z.string().max(2000).optional() }),
        output: z.object({
          schema: IDENT,
          table: z.string().regex(TABLE_NAME, "lowercase letters, digits and _"),
        }),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; prediction_id: string } | { ok: false; error: string }> => {
      const userId = await resolveCaller(data.access_token);
      const { model } = await loadModelForUser(data.model_id, userId);
      const version = await pickVersion(model.id, data.version_id, model.production_version_id);
      if (!version) return { ok: false, error: "No trained version to predict with" };
      const started = await startBatchPrediction({
        userId,
        model,
        version,
        input: data.input,
        output: data.output,
        via: "ui",
      });
      return started.ok ? { ok: true, prediction_id: started.predictionId } : started;
    },
  );

/** Score up to a few hundred rows and wait for the answer (the try-it form). */
export const mlPredictRows = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        version_id: z.string().uuid().optional(),
        rows: z.array(z.record(z.string(), z.unknown())).min(1).max(ML_ROWS_PREDICT_CAP),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<MlRowsPredictResult> => {
    const userId = await resolveCaller(data.access_token);
    const { model } = await loadModelForUser(data.model_id, userId);
    const version = await pickVersion(model.id, data.version_id, model.production_version_id);
    if (!version) return { ok: false as const, error: "No trained version to predict with" };
    return predictRowsSync({ model, version, userId, rows: data.rows, via: "ui" });
  });

export const mlListPredictions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), model_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ predictions: MlPredictionRow[] }> => {
    const userId = await resolveCaller(data.access_token);
    const { model, shared } = await loadModelForUser(data.model_id, userId);
    // A grantee sees their own runs; the owner sees every run made with the model.
    let query = supabaseAdmin.from("ml_predictions").select("*").eq("model_id", model.id);
    if (shared) query = query.eq("user_id", userId);
    const { data: live } = await query.in("status", [...ML_JOB_LIVE]);
    for (const r of live ?? []) await refreshPrediction(r.id);
    let fresh = supabaseAdmin.from("ml_predictions").select("*").eq("model_id", model.id);
    if (shared) fresh = fresh.eq("user_id", userId);
    const { data: rows } = await fresh.order("created_at", { ascending: false }).limit(50);
    return { predictions: rows ?? [] };
  });

export const mlCancelPrediction = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), prediction_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const userId = await resolveCaller(data.access_token);
    return { ok: await cancelPrediction(data.prediction_id, userId) };
  });

// ── Forecast versions for BI ─────────────────────────────────────────────────
import { listForecastVersionsForUser, type MlForecastVersionOption } from "./ml/forecast.server";
export type { MlForecastVersionOption };

/** Ready forecast versions the caller may attach to a BI chart. */
export const mlListForecastVersions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<{ versions: MlForecastVersionOption[] }> => {
    const userId = await resolveCaller(data.access_token);
    return { versions: await listForecastVersionsForUser(userId) };
  });
