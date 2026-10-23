import { ML_LOWER_IS_BETTER, ML_METRIC_LABEL } from "@/utils/ml/types";

export const JOB_STATUS_STYLE: Record<string, string> = {
  succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  queued: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  cancelled: "bg-muted text-muted-foreground",
};

export const STAGE_STYLE: Record<string, string> = {
  production: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  staging: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  candidate: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground line-through",
};

export function fmtMetric(name: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (PERCENTS.has(name)) return `${(value * 100).toFixed(1)}%`;
  if (name === "mape" || name === "smape") return `${value.toFixed(1)}%`;
  if (name === "r2" || name === "log_loss") return value.toFixed(3);
  return Math.abs(value) >= 100_000 ? big.format(value) : compact.format(value);
}

export function metricLabel(name: string): string {
  return ML_METRIC_LABEL[name] ?? name.replace(/_/g, " ");
}

export function metricDirection(name: string): "lower" | "higher" {
  return ML_LOWER_IS_BETTER.has(name) ? "lower" : "higher";
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat().format(n);
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtDuration(startIso: string | null | undefined, endIso?: string | null): string {
  if (!startIso) return "—";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

/** Colour a primary metric by how good it looks for its task. */
export function metricTone(
  name: string,
  value: number | null | undefined,
): "good" | "warn" | "bad" | undefined {
  if (value === null || value === undefined) return undefined;
  if (name === "anomaly_rate" || name === "coverage") return undefined;
  if (name === "silhouette") return value >= 0.5 ? "good" : value >= 0.25 ? "warn" : "bad";
  if (name === "hit_rate_10") return value >= 0.3 ? "good" : value >= 0.1 ? "warn" : "bad";
  if (PERCENTS.has(name)) return value >= 0.8 ? "good" : value >= 0.6 ? "warn" : "bad";
  if (name === "r2") return value >= 0.7 ? "good" : value >= 0.4 ? "warn" : "bad";
  if (name === "mape") return value <= 10 ? "good" : value <= 25 ? "warn" : "bad";
  return undefined;
}

const PERCENTS = new Set([
  "accuracy",
  "f1_macro",
  "precision_macro",
  "recall_macro",
  "roc_auc",
  "hit_rate_10",
  "precision_10",
  "coverage",
  "anomaly_rate",
]);

const compact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

const big = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
