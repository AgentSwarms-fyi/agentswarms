// Starting an ML pipeline when a model raises an alert (R544).
//
// A model already says when it is going wrong: drift (the rows it scores no
// longer look like the rows it learned from) and accuracy below training
// (measured against real outcomes). Until now that was a notification, and
// someone had to read it and press Run. A workflow can now name the models
// and the alerts it answers, so retrain → check → promote → deploy starts by
// itself, and the alert closes its own loop.
//
// Starting work automatically is where a loop can run away, so every rule
// that decides whether an alert starts a run is written once, here, pure:
//
// - **The owner's own runs only.** A prediction someone the model is shared
//   with ran still notifies the owner, but does not spend the owner's compute
//   or move the owner's production version.
// - **The version in production only.** An alert about a version that has
//   since been replaced is about a model nobody is serving; acting on it would
//   retrain again for a problem already answered. Accuracy is re-measured
//   daily for a month, so this is the common case, not an edge.
// - **Once per alert.** The same prediction run never starts the same
//   workflow twice, however often it is re-measured.
// - **A wait between alert starts** (24 h by default), claimed atomically, so
//   two alerts landing together start one run, and a pipeline whose own
//   scoring step drifts again cannot start itself in a loop.
// - **Paused means paused**, and a workflow already running is not started
//   again (the runner's own rule).
//
// Pure: no database, no network.
import { z } from "zod";

import type { WorkflowGraph } from "@/lib/workflows";

export const ALERT_EVENTS = ["drift", "decay"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

/** What each alert is called where a person picks it. */
export const ALERT_EVENT_LABEL: Record<AlertEvent, string> = {
  drift: "Drift",
  decay: "Scoring worse than training",
};

export const ALERT_COOLDOWN_DEFAULT_HOURS = 24;
export const ALERT_COOLDOWN_MAX_HOURS = 720;
export const ALERT_MAX_MODELS = 10;

/** Which models' alerts start a workflow, and how often at most. */
export type AlertTrigger = {
  models: string[];
  events: AlertEvent[];
  cooldownHours: number;
};

export const ALERT_TRIGGER_SCHEMA = z.object({
  models: z.array(z.string().uuid()).min(1, "Pick a model").max(ALERT_MAX_MODELS),
  events: z.array(z.enum(ALERT_EVENTS)).min(1, "Pick an alert").max(ALERT_EVENTS.length),
  cooldownHours: z.number().int().min(1).max(ALERT_COOLDOWN_MAX_HOURS),
});

/**
 * The same trigger in one canonical form: each model once, in order, alerts
 * in their fixed order. Two triggers that mean the same thing compare equal,
 * and a file the platform writes is byte-identical for the same trigger.
 */
export function normaliseAlertTrigger(t: AlertTrigger): AlertTrigger {
  return {
    models: [...new Set(t.models)].sort(),
    events: ALERT_EVENTS.filter((e) => t.events.includes(e)),
    cooldownHours: t.cooldownHours,
  };
}

/** The trigger a stored value holds, or null when there is none or it is not one. */
export function alertTriggerOf(value: unknown): AlertTrigger | null {
  if (value === null || value === undefined) return null;
  const parsed = ALERT_TRIGGER_SCHEMA.safeParse(value);
  return parsed.success ? normaliseAlertTrigger(parsed.data) : null;
}

export function sameAlertTrigger(a: AlertTrigger | null, b: AlertTrigger | null): boolean {
  if (!a || !b) return !a && !b;
  return JSON.stringify(normaliseAlertTrigger(a)) === JSON.stringify(normaliseAlertTrigger(b));
}

/**
 * The models a workflow's own steps work on, in step order: the ones a
 * Promote or Deploy step names, and those its ML schedules train or score.
 * What "start on this model's alerts" nearly always means.
 */
export function modelsInGraph(
  graph: WorkflowGraph,
  schedules: { id: string; model_id: string }[],
): string[] {
  const modelOf = new Map(schedules.map((s) => [s.id, s.model_id]));
  const out: string[] = [];
  for (const n of graph.nodes) {
    const id =
      n.kind === "ml_promote" || n.kind === "ml_deploy"
        ? n.targetId
        : n.kind === "ml_schedule" && n.targetId
          ? modelOf.get(n.targetId)
          : undefined;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Whether a trigger answers this alert on this model. */
export function answersAlert(t: AlertTrigger | null, modelId: string, event: AlertEvent): boolean {
  return Boolean(t && t.models.includes(modelId) && t.events.includes(event));
}

/** What the decision needs to know, read by the server. */
export type AlertFacts = {
  event: AlertEvent;
  /** The workflow is switched on. */
  active: boolean;
  /** The prediction behind the alert was run by the model's owner. */
  ranByOwner: boolean;
  /** The version that scored the rows, and the model's production version now. */
  versionId: string | null;
  productionVersionId: string | null;
  /** This prediction run already started this workflow once. */
  alreadyStarted: boolean;
};

export type AlertDecision = { start: true } | { start: false; reason: string; quiet?: boolean };

/**
 * Whether an alert should start a workflow, before the wait between starts
 * is claimed (that needs the database, atomically). `quiet` skips are not
 * worth a note on the workflow: they repeat daily and change nothing.
 */
export function alertDecision(f: AlertFacts): AlertDecision {
  if (!f.ranByOwner) {
    return {
      start: false,
      reason: "the run was not yours: someone the model is shared with ran it",
    };
  }
  if (f.alreadyStarted) {
    return { start: false, reason: "this run's alert already started it", quiet: true };
  }
  if (f.productionVersionId && f.versionId && f.versionId !== f.productionVersionId) {
    return {
      start: false,
      reason: "the rows were scored by a version that is no longer in production",
      quiet: true,
    };
  }
  if (!f.active) return { start: false, reason: "the workflow is paused" };
  return { start: true };
}

/** The ISO time before which an earlier alert start no longer holds the next one back. */
export function cooldownCutoff(now: Date, cooldownHours: number): string {
  return new Date(now.getTime() - cooldownHours * 3_600_000).toISOString();
}

/** What a run started by an alert records about it. */
export type AlertRunDetail = {
  event: AlertEvent;
  model_id: string;
  model_name: string;
  prediction_id: string;
  /** Drift: the PSI. Decay: how much worse, as a ratio. */
  score: number | null;
};

/** "Drift on churn (PSI 0.31)" / "churn scoring 12% worse than training". */
export function alertRunLine(d: Partial<AlertRunDetail> | null | undefined): string {
  if (!d?.event) return "A model alert";
  const model = d.model_name ? `"${d.model_name}"` : "a model";
  const score = typeof d.score === "number" && Number.isFinite(d.score) ? d.score : null;
  if (d.event === "drift") {
    return `Drift on ${model}${score !== null ? ` (PSI ${score.toFixed(2)})` : ""}`;
  }
  return `${model} scoring ${score !== null ? `${Math.round(score * 100)}% ` : ""}worse than training`;
}

/** How a workflow answers alerts, in one line: "When churn drifts or scores worse than training". */
export function alertTriggerLine(
  t: AlertTrigger | null,
  modelName: (id: string) => string | undefined,
): string {
  if (!t) return "";
  const names = t.models.map((id) => modelName(id) ?? "a model that is gone");
  const who =
    names.length === 1
      ? `"${names[0]}"`
      : names.length === 2
        ? `"${names[0]}" or "${names[1]}"`
        : `one of ${names.length} models`;
  const what = t.events
    .map((e) => (e === "drift" ? "drifts" : "scores worse than training"))
    .join(" or ");
  return `When ${who} ${what}`;
}

/** The last alert a workflow heard, kept on it so "why didn't it start?" has an answer. */
export type AlertNote = {
  at: string;
  event: AlertEvent;
  model_name: string;
  started: boolean;
  run_id?: string;
  reason?: string;
};

export function alertNoteOf(value: unknown): AlertNote | null {
  const v = value as Partial<AlertNote> | null;
  if (!v || typeof v !== "object" || typeof v.at !== "string") return null;
  if (v.event !== "drift" && v.event !== "decay") return null;
  return {
    at: v.at,
    event: v.event,
    model_name: String(v.model_name ?? ""),
    started: v.started === true,
    ...(typeof v.run_id === "string" ? { run_id: v.run_id } : {}),
    ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
  };
}

/**
 * The note in words, to follow "Last alert 2 hours ago: ": 'drift on "churn"
 * started a run' / 'drift on "churn" did not start it: the workflow is paused'.
 */
export function alertNoteLine(n: AlertNote): string {
  const what =
    n.event === "drift"
      ? `drift on "${n.model_name}"`
      : `"${n.model_name}" scoring worse than training`;
  return n.started
    ? `${what} started a run`
    : `${what} did not start it: ${n.reason ?? "it was skipped"}`;
}

/** The sentence an alert's notification ends with when it started something. */
export function startedSentence(names: string[]): string {
  if (!names.length) return "";
  if (names.length === 1) return ` Started "${names[0]}".`;
  return ` Started ${names.length} workflows: ${names.map((n) => `"${n}"`).join(", ")}.`;
}

/** A wait between alert starts, in words: "24 hours", "1 hour", "7 days". */
export function cooldownWords(hours: number): string {
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
