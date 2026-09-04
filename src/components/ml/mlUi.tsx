// Display vocabulary shared by the ML pages: task and stage chips, metric
// formatting, tiles. Kept small and pure so the registry list, the wizard and
// the detail page cannot drift apart in how they name the same thing.
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ML_LOWER_IS_BETTER, ML_METRIC_LABEL, ML_TASK_LABEL, type MlTask } from "@/utils/ml/types";

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

const TASK_STYLE: Record<MlTask, string> = {
  classification: "border-violet-500/40 text-violet-600 dark:text-violet-400",
  regression: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  forecast: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  clustering: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  anomaly: "border-rose-500/40 text-rose-600 dark:text-rose-400",
  recommendation: "border-fuchsia-500/40 text-fuchsia-600 dark:text-fuchsia-400",
};

export function TaskBadge({ task, className }: { task: string; className?: string }) {
  const t = task as MlTask;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        TASK_STYLE[t] ?? "border-border text-muted-foreground",
        className,
      )}
    >
      {ML_TASK_LABEL[t] ?? task}
    </span>
  );
}

export function Chip({ label, style, pulse }: { label: string; style: string; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        style,
      )}
    >
      {pulse ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {label}
    </span>
  );
}

/** A version's state in one chip: training beats stage while it runs. */
export function StageChip({ stage, status }: { stage: string; status: string }) {
  if (status === "training")
    return <Chip label="training" style={JOB_STATUS_STYLE.running} pulse />;
  if (status === "failed") return <Chip label="failed" style={JOB_STATUS_STYLE.failed} />;
  if (status === "cancelled") return <Chip label="cancelled" style={JOB_STATUS_STYLE.cancelled} />;
  return <Chip label={stage} style={STAGE_STYLE[stage] ?? STAGE_STYLE.candidate} />;
}

export function JobStatusChip({ status }: { status: string }) {
  return (
    <Chip
      label={status}
      style={JOB_STATUS_STYLE[status] ?? JOB_STATUS_STYLE.cancelled}
      pulse={status === "running" || status === "queued"}
    />
  );
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

export function MetricTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "bad"
          ? "text-red-600 dark:text-red-400"
          : "";
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold tracking-tight tabular-nums", color)}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </Card>
  );
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
