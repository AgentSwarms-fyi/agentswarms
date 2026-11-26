// Making a model and training its first version: ONE implementation, for the
// wizard and for a model proposed in chat and approved by its owner (R527).
// The caller has already said who the owner is; everything else (the schema
// grant, the data preparation, the limits) is checked here, as that owner.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { accessibleSchemas } from "@/utils/lakehouse/core.server";
import { invalidDrivers } from "@/lib/mlForecastDrivers";
import {
  createAndTrainVersion,
  mlTrainConfig as trainConfig,
  validateMlPrep as validatePrep,
} from "./api.server";
import {
  ML_TARGET_TASKS,
  type MlPeriod,
  type MlPrepConfig,
  type MlSource,
  type MlTask,
  type MlTrainConfig,
} from "./types";

export type MlCreateInput = {
  name: string;
  description?: string;
  task: MlTask;
  source: MlSource;
  target_column?: string;
  time_column?: string;
  user_column?: string;
  item_column?: string;
  rating_column?: string;
  n_clusters?: number;
  contamination?: number;
  horizon?: number;
  aggregation?: "sum" | "mean";
  period?: MlPeriod;
  /** Forecasting: one forecast per value of this column, beside the total (R526). */
  series_column?: string;
  feature_columns?: string[];
  time_budget_minutes?: number;
  max_rows?: number;
  prep?: MlPrepConfig;
  tuning?: MlTrainConfig["tuning"];
};

export type MlCreateResult =
  { ok: true; model_id: string; job_id: string } | { ok: false; error: string; model_id?: string };

/** Create a model owned by `userId` and start training its first version. */
export async function createModelAndTrain(
  userId: string,
  data: MlCreateInput,
  opts: { trigger?: string } = {},
): Promise<MlCreateResult> {
  if (data.task === "forecast" && !data.time_column) {
    return { ok: false, error: "A forecast needs a time column" };
  }
  // A forecast's feature columns are its known-ahead drivers (R547).
  if (data.task === "forecast" && data.feature_columns?.length) {
    const bad = invalidDrivers(data.feature_columns, {
      time: data.time_column,
      target: data.target_column,
      series: data.series_column,
    });
    if (bad) return { ok: false, error: bad };
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
      // Forecasting REQUIRES one — it is the axis being predicted along.
      // Classification and regression may have one, and when they do it
      // means something different: the rows are ordered, so the split and
      // the folds must respect that order.
      //
      // This line used to read `task === "forecast" ? ... : null`, which
      // silently discarded the column for every other task. The wizard
      // sent it, the validator accepted it, the review step told the user
      // "in time, by signed_up_on" — and the model was stored with a null,
      // so the trainer shuffled the rows anyway. Found by reading the row
      // back after a real run, not by anything failing.
      time_column:
        data.task === "forecast" || data.task === "classification" || data.task === "regression"
          ? (data.time_column ?? null)
          : null,
      horizon: data.task === "forecast" ? (data.horizon ?? 12) : null,
      aggregation: data.task === "forecast" ? (data.aggregation ?? "sum") : null,
      period: data.task === "forecast" ? (data.period ?? "auto") : "auto",
      // Only when set: a database without migration 20261124000000 still
      // takes a single-series forecast.
      ...(data.task === "forecast" && data.series_column
        ? { series_column: data.series_column }
        : {}),
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
          : /series_column/.test(error?.message ?? "")
            ? "A forecast for each series needs a database update first (migration " +
              "20261124000000, for example npx supabase db push --remote). Choose " +
              '"One series: the total" to train without it.'
            : (error?.message ?? "Failed to create model"),
    };
  }
  const started = await createAndTrainVersion(model, config, 1, { trigger: opts.trigger });
  return started.ok
    ? { ok: true, model_id: model.id, job_id: started.jobId }
    : { ok: false, error: started.error, model_id: model.id };
}
