// Starting and watching one step, whatever kind it is.
//
// The four subsystems a workflow orchestrates do not agree on words. An ETL
// run is `succeeded | failed | cancelled`; a SQL model build is
// `success | partial | error`; a notebook sandbox is `succeeded | error |
// stopped`. Left alone, that disagreement would leak into the runner as four
// branches of `if (status === ...)` and one of them would eventually be wrong
// in a way nobody notices, because a step that never resolves looks exactly
// like a step that is still working.
//
// So one adapter per kind, each answering two questions and nothing else:
// "start this, and give me something I can look it up by" and "given that
// something, is it done, and did it work?". The vocabulary is normalised here,
// once, where the mapping sits next to the reason for it.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { WorkflowNode } from "@/lib/workflows";

/** What a step's underlying work has come to. */
export type StepOutcome =
  | { done: false }
  | { done: true; ok: true }
  | { done: true; ok: false; error: string };

export type StartResult = { ok: true; targetRunId: string } | { ok: false; error: string };

/**
 * A SQL model build that skipped some models is a `partial`.
 *
 * Treated as a FAILURE, deliberately. A partial means at least one model
 * failed and everything downstream of it was skipped, so the tables a later
 * step is about to train on are stale. Calling that green is exactly the
 * silent-staleness bug a workflow exists to prevent — and the run detail names
 * which models, so the operator is not left guessing.
 */
function sqlBuildOutcome(status: string, error: string | null): StepOutcome {
  if (status === "running") return { done: false };
  if (status === "success") return { done: true, ok: true };
  return {
    done: true,
    ok: false,
    error:
      error ??
      (status === "partial"
        ? "Some models failed, so everything downstream of them was skipped"
        : "The build failed"),
  };
}

// ── Starting ────────────────────────────────────────────────────────────────

/**
 * Start the work behind one node.
 *
 * Every branch returns an id the poller can use. SQL models are the exception
 * worth naming: `buildSqlModels` resolves only when the whole build is done,
 * so this awaits it and hands back a run id that is already terminal. The
 * poller then reads it once and finds it finished, which keeps the runner's
 * shape identical for all four kinds instead of special-casing one.
 */
export async function startNode(args: {
  userId: string;
  node: WorkflowNode;
}): Promise<StartResult> {
  const { userId, node } = args;
  try {
    switch (node.kind) {
      case "pipeline": {
        const { data: pipeline } = await supabaseAdmin
          .from("etl_pipelines")
          .select("*")
          .eq("id", node.targetId ?? "")
          .eq("user_id", userId)
          .maybeSingle();
        if (!pipeline) return { ok: false, error: "That pipeline no longer exists" };
        const { startEtlRun } = await import("@/utils/etl/service.server");
        const res = await startEtlRun(pipeline, "chain");
        return res.ok ? { ok: true, targetRunId: res.runId } : res;
      }
      case "sql_models": {
        const { buildSqlModels } = await import("@/utils/sqlModels/run.server");
        const res = await buildSqlModels({
          userId,
          selected: node.models ?? [],
          trigger: "chain",
        });
        return { ok: true, targetRunId: res.runId };
      }
      case "ml_schedule": {
        const { data: schedule } = await supabaseAdmin
          .from("ml_schedules")
          .select("*")
          .eq("id", node.targetId ?? "")
          .eq("user_id", userId)
          .maybeSingle();
        if (!schedule) return { ok: false, error: "That ML schedule no longer exists" };
        if (!schedule.is_active) return { ok: false, error: "That ML schedule is paused" };
        const { runMlSchedule } = await import("@/utils/ml/schedule.server");
        const res = await runMlSchedule(schedule, "workflow");
        // The id is polymorphic: a training job for a retrain, a prediction
        // for a batch predict. The kind is carried in the id so the poller
        // does not have to re-read the schedule row, which may have been
        // deleted by then.
        return res.ok ? { ok: true, targetRunId: `${schedule.kind}:${res.refId}` } : res;
      }
      case "notebook": {
        const { data: notebook } = await supabaseAdmin
          .from("user_python_notebooks")
          .select("id")
          .eq("id", node.targetId ?? "")
          .eq("user_id", userId)
          .maybeSingle();
        if (!notebook) return { ok: false, error: "That notebook no longer exists" };
        const { startSession } = await import("@/utils/notebookRuntime/service.server");
        const { session } = await startSession({
          userId,
          notebookId: notebook.id,
          kind: "batch",
          inputs: { trigger: "workflow" },
        });
        return { ok: true, targetRunId: session.id };
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Watching ────────────────────────────────────────────────────────────────

/**
 * Has this step's work finished, and did it work?
 *
 * A row that has vanished is reported as failed rather than as still running.
 * The alternative — treating "no row" as "not done yet" — is how a workflow
 * waits forever on something that was deleted under it.
 */
export async function pollNode(args: {
  userId: string;
  kind: WorkflowNode["kind"];
  targetRunId: string;
}): Promise<StepOutcome> {
  const { userId, kind, targetRunId } = args;
  const gone = (what: string): StepOutcome => ({
    done: true,
    ok: false,
    error: `The ${what} it started is no longer there`,
  });

  switch (kind) {
    case "pipeline": {
      const { data } = await supabaseAdmin
        .from("etl_runs")
        .select("status, error")
        .eq("id", targetRunId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!data) return gone("pipeline run");
      if (["queued", "running", "retrying"].includes(data.status)) return { done: false };
      if (data.status === "succeeded") return { done: true, ok: true };
      return { done: true, ok: false, error: data.error ?? `The run ${data.status}` };
    }
    case "sql_models": {
      const { data } = await supabaseAdmin
        .from("sql_model_runs")
        .select("status, error")
        .eq("id", targetRunId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!data) return gone("model build");
      return sqlBuildOutcome(data.status, data.error);
    }
    case "ml_schedule": {
      // `retrain:<job id>` or `batch_predict:<prediction id>` — see startNode.
      const sep = targetRunId.indexOf(":");
      const mlKind = sep > 0 ? targetRunId.slice(0, sep) : "retrain";
      const refId = sep > 0 ? targetRunId.slice(sep + 1) : targetRunId;
      const table = mlKind === "batch_predict" ? "ml_predictions" : "ml_training_jobs";
      const { data } = await supabaseAdmin
        .from(table)
        .select("status, error")
        .eq("id", refId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!data) return gone(mlKind === "batch_predict" ? "prediction" : "training job");
      if (["queued", "running"].includes(data.status)) return { done: false };
      if (data.status === "succeeded") return { done: true, ok: true };
      return { done: true, ok: false, error: data.error ?? `The job ${data.status}` };
    }
    case "notebook": {
      const { data } = await supabaseAdmin
        .from("notebook_runtime_sessions")
        .select("status, error")
        .eq("id", targetRunId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!data) return gone("notebook run");
      // The sandbox's own vocabulary: `error`, not `failed`, and `stopped`
      // for a session that was reaped or killed.
      if (["queued", "starting", "ready", "running"].includes(data.status)) return { done: false };
      if (data.status === "succeeded") return { done: true, ok: true };
      return {
        done: true,
        ok: false,
        error: data.error ?? (data.status === "stopped" ? "The run was stopped" : "The run failed"),
      };
    }
  }
}

/** Where a finished step's own log lives, so a red step can be opened. */
export function targetRunLink(
  kind: WorkflowNode["kind"],
  targetRunId: string,
  targetId?: string,
): string | null {
  switch (kind) {
    case "pipeline":
      return "/etl";
    case "sql_models":
      return "/sql-models";
    case "ml_schedule":
      return targetId ? `/ml` : "/ml";
    case "notebook":
      return targetRunId ? "/notebooks" : null;
  }
}
