// Display vocabulary shared by the ML pages: task and stage chips, metric
// formatting, tiles. Kept small and pure so the registry list, the wizard and
// the detail page cannot drift apart in how they name the same thing.
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ML_LOWER_IS_BETTER, ML_METRIC_LABEL, ML_TASK_LABEL, type MlTask } from "@/utils/ml/types";
import { JOB_STATUS_STYLE, STAGE_STYLE } from "./mlFormat";

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
