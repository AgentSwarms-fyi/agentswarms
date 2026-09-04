// Shared shapes for the ML platform. Pure types and constants only — this file
// is imported by the browser (registry pages, wizard) and the server alike.

export const ML_TASKS = ["classification", "regression", "forecast"] as const;
export type MlTask = (typeof ML_TASKS)[number];

export const ML_TASK_LABEL: Record<MlTask, string> = {
  classification: "Classification",
  regression: "Regression",
  forecast: "Forecast",
};

/** Where the training rows come from. Lakehouse tables first; other kinds later. */
export type MlSource = { kind: "lakehouse"; schema: string; table: string };

export const ML_VERSION_STAGES = ["candidate", "staging", "production", "archived"] as const;
export type MlVersionStage = (typeof ML_VERSION_STAGES)[number];

export const ML_VERSION_STATUSES = ["training", "ready", "failed", "cancelled"] as const;
export type MlVersionStatus = (typeof ML_VERSION_STATUSES)[number];

export const ML_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type MlJobStatus = (typeof ML_JOB_STATUSES)[number];
export const ML_JOB_LIVE: readonly MlJobStatus[] = ["queued", "running"];

/** Per-run knobs, pinned on the version so a retrain can reproduce them. */
export type MlTrainConfig = {
  time_budget_minutes: number;
  max_rows: number;
  /** Classification/regression holdout share; forecasting holds out `horizon`. */
  validation_fraction: number;
};

/** One row of the leaderboard the trainer returns. */
export type MlLeaderboardRow = {
  algorithm: string;
  metric: string;
  value: number | null;
  higher_is_better: boolean;
  fit_seconds: number;
  status: "ok" | "skipped" | "failed";
  note?: string;
};

export type MlFeatureImportance = { feature: string; importance: number; std?: number };

export type MlColumnDtype = "numeric" | "categorical" | "datetime" | "boolean" | "text";
export type MlColumnRole = "feature" | "target" | "time" | "dropped";

/** How the trainer read each input column, and why it kept or dropped it. */
export type MlFeatureSchemaEntry = {
  name: string;
  dtype: MlColumnDtype;
  role: MlColumnRole;
  reason?: string;
  /** Categorical features: the categories seen in training, for the try-it form. */
  categories?: string[];
  /** Numeric features: seen range, for the try-it form's defaults. */
  min?: number | null;
  max?: number | null;
  median?: number | null;
};

export type MlForecastPoint = { period: string; yhat: number; lo: number; hi: number };
export type MlHistoryPoint = { period: string; y: number };

/** What the training program returns through the batch-result callback. */
export type MlTrainResult = {
  ok: true;
  task: MlTask;
  algorithm: string;
  /** Flat metric name → value; nested structures (confusion matrix) beside it. */
  metrics: Record<string, number | null> & {
    confusion_matrix?: { labels: string[]; matrix: number[][] };
  };
  primary_metric: string;
  leaderboard: MlLeaderboardRow[];
  feature_importance: MlFeatureImportance[];
  feature_schema: MlFeatureSchemaEntry[];
  classes?: string[];
  artifact_uri: string;
  artifact_sha256: string;
  artifact_bytes: number;
  training_rows: number;
  training_total_rows: number;
  training_sampled: boolean;
  holdout_rows: number;
  elapsed_seconds: number;
  warnings: string[];
  forecast?: MlForecastPoint[];
  history?: MlHistoryPoint[];
  series_meta?: {
    freq: string;
    season_length: number | null;
    aggregation: string;
    last_period: string;
  };
};

/** The key a training session carries in its runtime session inputs. */
export const ML_JOB_KEY = "__ml_job";
export type MlJobStash = { job_id: string };

/** Pull the job id out of a session's inputs, or null for any other session. */
export function mlJobStashOf(inputs: unknown): MlJobStash | null {
  const raw = (inputs as { [ML_JOB_KEY]?: unknown } | null)?.[ML_JOB_KEY];
  if (!raw || typeof raw !== "object") return null;
  const j = (raw as { job_id?: unknown }).job_id;
  return typeof j === "string" && j.length > 0 ? { job_id: j } : null;
}

/** Human label for a metric key, shared by the UI and documentation. */
export const ML_METRIC_LABEL: Record<string, string> = {
  accuracy: "Accuracy",
  f1_macro: "F1 (macro)",
  precision_macro: "Precision (macro)",
  recall_macro: "Recall (macro)",
  roc_auc: "ROC AUC",
  log_loss: "Log loss",
  rmse: "RMSE",
  mae: "MAE",
  median_ae: "Median abs. error",
  r2: "R²",
  mape: "MAPE",
  smape: "sMAPE",
};

/** Lower-is-better metrics, so the UI colours direction correctly. */
export const ML_LOWER_IS_BETTER = new Set([
  "log_loss",
  "rmse",
  "mae",
  "median_ae",
  "mape",
  "smape",
]);

/** The primary metric per task, mirrored from the trainer. */
export const ML_PRIMARY_METRIC: Record<MlTask, string> = {
  classification: "f1_macro",
  regression: "rmse",
  forecast: "rmse",
};
