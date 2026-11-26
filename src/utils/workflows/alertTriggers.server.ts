// Starting the owner's workflows when one of their models raises an alert (R544).
//
// Called from the two places an alert is raised: a prediction run whose rows
// drifted past ML_DRIFT_ALERT_PSI, and an evaluation that found the model
// scoring more than ML_DECAY_ALERT_RATIO worse than training. The rules that
// decide whether a run starts are in `@/lib/workflowAlerts` (pure, tested);
// this file reads the facts, claims the wait between alert starts, and starts
// the run through the one runner every other trigger uses.
//
// Never throws into the alert's own path: an alert is recorded and notified
// whether or not anything starts, so a failure here is reported and nothing
// else.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  alertDecision,
  alertTriggerOf,
  answersAlert,
  cooldownCutoff,
  cooldownWords,
  type AlertEvent,
  type AlertNote,
  type AlertRunDetail,
} from "@/lib/workflowAlerts";

export type ModelAlert = {
  event: AlertEvent;
  modelId: string;
  /** The prediction run the alert is about. */
  predictionId: string;
  /** Who ran that prediction. */
  ranBy: string;
  /** The version that scored its rows. */
  versionId: string | null;
  /** Drift: the PSI. Decay: how much worse than training, as a ratio. */
  score: number | null;
};

export type AlertStart = { workflowId: string; name: string; runId: string };

/** Workflows can only answer alerts once migration 20261206000000 is applied. */
const MISSING_COLUMN = /alert_trigger|schema cache|does not exist/i;

/**
 * Start every workflow of the model's owner that answers this alert, and say
 * which started (for the alert's notification). Each workflow is decided on
 * its own: one paused or waiting does not hold back another.
 */
export async function startWorkflowsOnAlert(
  alert: ModelAlert,
  now: Date = new Date(),
): Promise<AlertStart[]> {
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("id, user_id, name, production_version_id")
    .eq("id", alert.modelId)
    .maybeSingle();
  if (!model) return [];
  const { data: rows, error } = await supabaseAdmin
    .from("workflows")
    .select("*")
    // The model OWNER's workflows, and only theirs: a workflow naming someone
    // else's model id is never looked up by that model's alert.
    .eq("user_id", model.user_id)
    .not("alert_trigger", "is", null)
    .limit(200);
  if (error) {
    if (!MISSING_COLUMN.test(error.message)) {
      console.warn(`[workflow-alert] could not read workflows: ${error.message}`);
    }
    return [];
  }
  const answering = (rows ?? []).filter((w) =>
    answersAlert(alertTriggerOf(w.alert_trigger), model.id, alert.event),
  );
  if (!answering.length) return [];

  const { startWorkflowRun } = await import("./run.server");
  const started: AlertStart[] = [];
  for (const w of answering) {
    const trigger = alertTriggerOf(w.alert_trigger);
    if (!trigger) continue;
    const note = (n: Pick<AlertNote, "started" | "run_id" | "reason">) =>
      supabaseAdmin
        .from("workflows")
        .update({
          alert_last: {
            at: now.toISOString(),
            event: alert.event,
            model_name: model.name,
            ...n,
          } as unknown as Json,
        })
        .eq("id", w.id)
        .eq("user_id", model.user_id);

    // Once per alert: has this prediction run already started this workflow?
    const { data: prior } = await supabaseAdmin
      .from("workflow_runs")
      .select("id")
      .eq("workflow_id", w.id)
      .eq("trigger", "alert")
      .contains("trigger_detail", { prediction_id: alert.predictionId, event: alert.event })
      .limit(1);
    const decision = alertDecision({
      event: alert.event,
      active: Boolean(w.is_active),
      ranByOwner: alert.ranBy === model.user_id,
      versionId: alert.versionId,
      productionVersionId: model.production_version_id ?? null,
      alreadyStarted: Boolean(prior?.length),
    });
    if (!decision.start) {
      if (!decision.quiet) await note({ started: false, reason: decision.reason });
      continue;
    }

    // The wait between alert starts, claimed atomically: of two alerts that
    // land together, exactly one moves `alert_started_at`. Two conditional
    // updates rather than one OR, each of which Postgres re-checks under the
    // row lock: the loser of the first finds the column set, and the second
    // then finds it too recent.
    const stamp = now.toISOString();
    const previous = (w.alert_started_at as string | null) ?? null;
    const claim = () =>
      supabaseAdmin
        .from("workflows")
        .update({ alert_started_at: stamp })
        .eq("id", w.id)
        .eq("user_id", model.user_id);
    let { data: claimed } = await claim().is("alert_started_at", null).select("id").maybeSingle();
    if (!claimed) {
      ({ data: claimed } = await claim()
        .lt("alert_started_at", cooldownCutoff(now, trigger.cooldownHours))
        .select("id")
        .maybeSingle());
    }
    if (!claimed) {
      await note({
        started: false,
        reason: `an alert started it less than ${cooldownWords(trigger.cooldownHours)} ago`,
      });
      continue;
    }

    const detail: AlertRunDetail = {
      event: alert.event,
      model_id: model.id,
      model_name: model.name,
      prediction_id: alert.predictionId,
      score: alert.score,
    };
    const res = await startWorkflowRun(
      w as unknown as import("./run.server").WorkflowRow,
      "alert",
      { triggerDetail: detail },
    );
    if (!res.ok) {
      // Nothing started, so the wait is given back: the next alert may start it.
      await supabaseAdmin
        .from("workflows")
        .update({ alert_started_at: previous })
        .eq("id", w.id)
        .eq("alert_started_at", stamp);
      await note({ started: false, reason: lowerFirst(res.error) });
      continue;
    }
    await note({ started: true, run_id: res.runId });
    started.push({ workflowId: w.id, name: w.name, runId: res.runId });
  }
  return started;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * `startWorkflowsOnAlert` for the alert's own path: it never throws. A failure
 * is logged and nothing starts; the alert is still recorded and notified.
 */
export async function alertStarts(alert: ModelAlert): Promise<AlertStart[]> {
  try {
    return await startWorkflowsOnAlert(alert);
  } catch (e) {
    console.warn(
      `[workflow-alert] ${JSON.stringify({ model_id: alert.modelId, event: alert.event, error: (e as Error).message })}`,
    );
    return [];
  }
}
