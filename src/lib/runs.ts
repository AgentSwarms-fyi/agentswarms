// Everything that ran for the reader, as one list.
//
// Each kind of run has its own table and its own words: a pipeline run
// "succeeded", a SQL model run was a "success", a monitor was "ok", a report
// was "sent", an evaluation is "done". The Runs page says each in the same
// words, so "what failed this week" is one question with one answer. Pure, so
// every mapping is held by a test; the server reads the tables.
import type { ObjectLink } from "@/lib/objectKinds";

export const RUN_KINDS = [
  { id: "etl", label: "Pipeline" },
  { id: "workflow", label: "Workflow" },
  { id: "swarm", label: "Swarm" },
  { id: "delivery", label: "Scheduled email" },
  { id: "ml_train", label: "Model training" },
  { id: "ml_predict", label: "Batch prediction" },
  { id: "notebook", label: "Notebook" },
  { id: "sql_models", label: "SQL models" },
  { id: "monitor", label: "Data monitor" },
  { id: "eval", label: "Evaluation" },
  { id: "prep_flow", label: "Data-prep refresh" },
  { id: "analyst_schedule", label: "Scheduled analysis" },
  { id: "dashboard_refresh", label: "Dashboard refresh" },
] as const;

export type RunKind = (typeof RUN_KINDS)[number]["id"];

export function runKindLabel(kind: RunKind): string {
  return RUN_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

/** One vocabulary for every kind. */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "partial"
  | "alert"
  | "skipped"
  | "failed"
  | "cancelled";

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for approval",
  succeeded: "Succeeded",
  partial: "Partly done",
  alert: "Alerted",
  skipped: "Skipped",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Statuses that need someone to look. */
export const NEEDS_A_LOOK = new Set<RunStatus>(["failed", "partial", "alert"]);
/** Statuses of a run that has not finished. */
export const IN_FLIGHT = new Set<RunStatus>(["queued", "running", "waiting"]);

const MAP: Record<string, RunStatus> = {
  queued: "queued",
  starting: "queued",
  pending: "queued",
  running: "running",
  retrying: "running",
  ready: "running",
  stopping: "running",
  waiting: "waiting",
  suspended: "waiting",
  succeeded: "succeeded",
  success: "succeeded",
  ok: "succeeded",
  sent: "succeeded",
  done: "succeeded",
  pass: "succeeded",
  partial: "partial",
  alert: "alert",
  skipped: "skipped",
  failed: "failed",
  error: "failed",
  fail: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  stopped: "cancelled",
};

/**
 * A kind's own word for how a run went, in the shared vocabulary. A word no
 * mapping knows is called failed rather than succeeded: an unknown state is
 * the one to look at, not the one to hide.
 */
export function normalizeStatus(raw: string | null | undefined): RunStatus {
  return (
    MAP[
      String(raw ?? "")
        .trim()
        .toLowerCase()
    ] ?? "failed"
  );
}

export type RunTrigger = "manual" | "schedule" | "api" | "chain" | "retry";

export function normalizeTrigger(raw: string | null | undefined): RunTrigger | null {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!t) return null;
  if (t === "schedule" || t === "cron" || t === "scheduled") return "schedule";
  if (t === "api" || t === "webhook" || t === "trigger") return "api";
  if (t === "chain" || t === "pipeline" || t === "workflow") return "chain";
  if (t === "rerun" || t === "retry") return "retry";
  return "manual";
}

export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: "Started by hand",
  schedule: "On a schedule",
  api: "From the API",
  chain: "Started by another run",
  retry: "A retry",
};

/**
 * A failure in one line a person can read: the last line of a traceback
 * (where Python puts the exception), without terminal colours, cut at 200.
 */
export function oneLineError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  const clean = String(raw).replace(/\u001b\[[0-9;]*m/g, "");
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const tb = lines.findIndex((l) => l.startsWith("Traceback (most recent call last)"));
  const line = tb >= 0 ? lines[lines.length - 1] : lines[0];
  const one = line.replace(/\s+/g, " ");
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
}

export type RunRow = {
  kind: RunKind;
  id: string;
  /** What ran: the pipeline's, workflow's, model's… name. */
  name: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: RunTrigger | null;
  /** Why it failed, in one line, when it did. */
  error: string | null;
  costUsd: number | null;
  link: ObjectLink | null;
  /** This kind keeps only its latest result, not a history of runs. */
  latestOnly?: boolean;
  /** What a failure here could be fixed on (R525): a check or a pipeline. */
  fixTarget?: { type: "data_monitor" | "etl_pipeline"; id: string } | null;
};

/** How long it took: recorded, or from start to finish. */
export function durationOf(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  recordedMs?: number | null,
): number | null {
  if (typeof recordedMs === "number" && Number.isFinite(recordedMs) && recordedMs >= 0)
    return recordedMs;
  if (!startedAt || !finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Every list, newest first; a run with no start time last. */
export function mergeRuns(...lists: ReadonlyArray<readonly RunRow[]>): RunRow[] {
  return lists
    .flat()
    .slice()
    .sort(
      (a, b) =>
        (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || a.id.localeCompare(b.id),
    );
}

export type RunFilter = {
  kinds?: ReadonlySet<RunKind>;
  show?: "all" | "needs_a_look" | "in_flight";
};

export function filterRuns(rows: readonly RunRow[], f: RunFilter): RunRow[] {
  return rows.filter(
    (r) =>
      (!f.kinds || f.kinds.size === 0 || f.kinds.has(r.kind)) &&
      (f.show === "needs_a_look"
        ? NEEDS_A_LOOK.has(r.status)
        : f.show === "in_flight"
          ? IN_FLIGHT.has(r.status)
          : true),
  );
}

export function runCounts(rows: readonly RunRow[]) {
  const byKind = new Map<RunKind, number>();
  let needsALook = 0;
  let inFlight = 0;
  for (const r of rows) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    if (NEEDS_A_LOOK.has(r.status)) needsALook++;
    if (IN_FLIGHT.has(r.status)) inFlight++;
  }
  return { total: rows.length, byKind, needsALook, inFlight };
}

/** "Today", "Yesterday", or the date, for grouping the list by day. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown day";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** What to ask the assistant about a failed run. */
export function askAboutFailure(r: Pick<RunRow, "kind" | "name" | "error">): string {
  // The error's own full stop is dropped: the sentence ends after it.
  const error = r.error?.replace(/[\s.]+$/, "");
  return `My ${runKindLabel(r.kind).toLowerCase()} “${r.name}” failed${error ? ` with: ${error}` : ""}. What usually causes this, and what should I check?`;
}
