// Starting and watching one step, whatever kind it is.
//
// The subsystems a workflow orchestrates do not agree on words. An ETL run is
// `succeeded | failed | cancelled`; a SQL model build is
// `success | partial | error`; a notebook sandbox is `succeeded | error |
// stopped`; a swarm is `success | error | suspended`. Left alone, that
// disagreement would leak into the runner as a dozen branches of
// `if (status === ...)` and one of them would eventually be wrong in a way
// nobody notices, because a step that never resolves looks exactly like a step
// that is still working.
//
// So one adapter per kind, each answering two questions and nothing else:
// "start this, and give me something I can look it up by" and "given that
// something, is it done, and did it work?". The vocabulary is normalised here,
// once, where the mapping sits next to the reason for it.
//
// Three shapes of work, and the difference matters:
//
//   POLLED    the subsystem records its own run row; we store its id and read
//             it back. ETL, ML, notebooks, sub-workflows, approvals.
//   IMMEDIATE the work is over before the call returns. Conditions, waits,
//             notifications, HTTP.
//   DETACHED  the call resolves only when the whole job is done, which can be
//             minutes. We start it without awaiting and it settles its own
//             step. SQL, swarms, prep flows, dashboard refreshes, monitors.
//
// A detached step is the one that needs the run's timeout: if the process
// holding that promise dies, nothing will ever settle it, and the timeout is
// what turns "hung forever" into "failed, and here is why".
import { createHash, randomBytes } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { substituteParams, type WorkflowNode } from "@/lib/workflows";

/** What a step's underlying work has come to. */
export type StepOutcome =
  | { done: false }
  | { done: true; ok: true }
  | { done: true; ok: false; error: string };

export type Settled = { done: true; ok: true } | { done: true; ok: false; error: string };

export type StartResult =
  | {
      ok: true;
      /** Poll this id later. Absent for immediate and detached work. */
      targetRunId?: string;
      /** The step is already over. */
      settled?: Settled;
      /** A condition's decision. */
      branch?: "true" | "false";
      /** A wait's own clock. */
      waitUntil?: string;
      /** Anything worth showing beside the step. */
      output?: Record<string, unknown>;
    }
  | { ok: false; error: string };

export type StartArgs = {
  userId: string;
  node: WorkflowNode;
  /** The run's resolved parameters, for `{{ params.x }}`. */
  params: Record<string, string>;
  runId: string;
  nodeRunId: string;
  /**
   * Write this step's terminal state, later, from a detached promise.
   * Conditional on the step still being `running`, so a timeout that already
   * failed it wins and a late promise cannot resurrect a closed run.
   */
  settle: (outcome: Settled, output?: Record<string, unknown>) => Promise<void>;
};

/** The marker a detached step carries so the poller knows to leave it alone. */
export const DETACHED = "detached";

const text = (n: WorkflowNode, params: Record<string, string>) =>
  substituteParams(n.text ?? "", params);

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

/** Run a long job without holding the caller, and let it settle its own step. */
function detach(
  args: StartArgs,
  job: () => Promise<{ ok: true; output?: Record<string, unknown> } | { ok: false; error: string }>,
): StartResult {
  void (async () => {
    try {
      const res = await job();
      await args.settle(
        res.ok ? { done: true, ok: true } : { done: true, ok: false, error: res.error },
        res.ok ? res.output : undefined,
      );
    } catch (e) {
      await args.settle({ done: true, ok: false, error: (e as Error).message });
    }
  })();
  return { ok: true, targetRunId: DETACHED };
}

/**
 * Does this row belong to the caller? Checked at run time, not only at save.
 *
 * The table name is a literal union rather than a string so the typed client
 * keeps checking it — a typo here would silently make every ownership check
 * pass, which is the one bug this function exists to prevent.
 */
type OwnedTable = "user_python_notebooks" | "user_prep_flows" | "bi_dashboards";

async function owned(table: OwnedTable, id: string | undefined, userId: string): Promise<boolean> {
  if (!id) return false;
  const { data } = await supabaseAdmin
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}

// ── Starting ────────────────────────────────────────────────────────────────

export async function startNode(args: StartArgs): Promise<StartResult> {
  const { userId, node, params } = args;
  try {
    switch (node.kind) {
      // ── Polled ──────────────────────────────────────────────────────────
      case "pipeline": {
        const { data: pipeline } = await supabaseAdmin
          .from("etl_pipelines")
          .select("*")
          .eq("id", node.targetId ?? "")
          .eq("user_id", userId)
          .maybeSingle();
        if (!pipeline) return { ok: false, error: "That pipeline no longer exists" };
        const { startEtlRun } = await import("@/utils/etl/service.server");
        // The workflow's parameters are handed on: a pipeline that takes a
        // date window should get the run's window, not its own default.
        const res = await startEtlRun(pipeline, "chain", params);
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
        // for a batch predict. The kind travels with it so the poller does not
        // have to re-read a schedule row that may be gone.
        return res.ok ? { ok: true, targetRunId: `${schedule.kind}:${res.refId}` } : res;
      }
      case "notebook": {
        if (!(await owned("user_python_notebooks", node.targetId, userId))) {
          return { ok: false, error: "That notebook no longer exists" };
        }
        const { startSession } = await import("@/utils/notebookRuntime/service.server");
        const { session } = await startSession({
          userId,
          notebookId: node.targetId,
          kind: "batch",
          inputs: { trigger: "workflow", params },
        });
        return { ok: true, targetRunId: session.id };
      }
      case "sub_workflow": {
        if (node.targetId === args.runId) {
          return { ok: false, error: "A workflow cannot run itself" };
        }
        const { data: child } = await supabaseAdmin
          .from("workflows")
          .select("*")
          .eq("id", node.targetId ?? "")
          .eq("user_id", userId)
          .maybeSingle();
        if (!child) return { ok: false, error: "That workflow no longer exists" };
        const { startWorkflowRun } = await import("./run.server");
        const res = await startWorkflowRun(
          child as unknown as import("./run.server").WorkflowRow,
          "workflow",
          { params, parentRunId: args.runId },
        );
        return res.ok ? { ok: true, targetRunId: res.runId } : res;
      }
      case "approval": {
        // The same table the approvals inbox already reads, so a workflow's
        // question arrives where a swarm's does rather than in a new place
        // nobody has learned to check.
        const { data: approval, error } = await supabaseAdmin
          .from("approvals")
          .insert({
            user_id: userId,
            agent_name: "Workflow",
            action_type: "workflow_step",
            action_title: node.label || "A workflow is waiting for approval",
            description: text(node, params).slice(0, 1000) || null,
            risk_level: "medium",
            payload: { workflow_run_id: args.runId, node_run_id: args.nodeRunId },
            approver_user_ids: [userId],
            approver_group_ids: [],
          } as never)
          .select("id")
          .single();
        if (error || !approval) {
          return { ok: false, error: error?.message ?? "Could not raise the approval" };
        }
        const { notifyUser } = await import("@/utils/notify.server");
        await notifyUser(userId, {
          kind: "approval",
          title: "A workflow is waiting for you",
          body: node.label || "A step needs approval before the run can continue.",
          link: "/workflows",
        });
        return { ok: true, targetRunId: `approval:${approval.id}` };
      }

      // ── Detached ────────────────────────────────────────────────────────
      case "sql": {
        const statement = text(node, params);
        if (!statement.trim()) return { ok: false, error: "The SQL step has no statement" };
        return detach(args, async () => {
          const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
          const res = await runLakehouseStatement(userId, statement, { auditVia: "workflow" });
          return { ok: true, output: { kind: res.kind, row_count: res.row_count } };
        });
      }
      case "swarm": {
        const { data: swarm } = await supabaseAdmin
          .from("swarms")
          .select("id, name, nodes, edges, published_nodes, published_edges")
          .eq("id", node.targetId ?? "")
          .eq("user_id", userId)
          .maybeSingle();
        if (!swarm) return { ok: false, error: "That swarm no longer exists" };
        return detach(args, async () => {
          const [{ executeSwarmServer }, { resolveDeployedGraph }] = await Promise.all([
            import("@/utils/swarmExecute.server"),
            import("@/lib/swarmPublish"),
          ]);
          // The PUBLISHED graph, as a scheduled run gets: an unattended run
          // must not pick up whatever is half-edited in the canvas.
          const pinned = resolveDeployedGraph(swarm as never);
          const res = await executeSwarmServer({
            swarm: { id: String(swarm.id), name: String(swarm.name), ...pinned },
            userId,
            origin: process.env.APP_ORIGIN ?? "http://localhost:8080",
            input: text(node, params) || "Run this swarm.",
            // A workflow is unattended, so an approval node inside the swarm
            // would park it forever. Rejecting is the honest answer.
            rejectApprovals: true,
            source: "schedule",
          });
          if (res.status === "success") {
            return { ok: true, output: { run_id: res.runId, output: res.output?.slice(0, 500) } };
          }
          return {
            ok: false,
            error:
              res.error ??
              (res.status === "suspended"
                ? "The swarm stopped at an approval, which an unattended run cannot answer"
                : "The swarm failed"),
          };
        });
      }
      case "prep_flow": {
        if (!(await owned("user_prep_flows", node.targetId, userId))) {
          return { ok: false, error: "That prep flow no longer exists" };
        }
        const flowId = node.targetId as string;
        return detach(args, async () => {
          const { refreshPrepFlowServer } = await import("@/utils/bi/refresh.server");
          const res = await refreshPrepFlowServer(flowId);
          return { ok: true, output: { rows: res.rowCount } };
        });
      }
      case "dashboard_refresh": {
        if (!(await owned("bi_dashboards", node.targetId, userId))) {
          return { ok: false, error: "That dashboard no longer exists" };
        }
        const dashboardId = node.targetId as string;
        return detach(args, async () => {
          const { refreshDashboardServer } = await import("@/utils/bi/refresh.server");
          const res = await refreshDashboardServer(dashboardId);
          // A per-widget failure is not a failed refresh — the dashboard did
          // update — but it must be visible rather than swallowed.
          return {
            ok: true,
            output: { widgets: res.widgets.length, failures: res.failures.slice(0, 5) },
          };
        });
      }
      case "data_monitor": {
        const { data: monitor } = await supabaseAdmin
          .from("data_monitors")
          .select("*")
          .eq("id", node.targetId ?? "")
          .eq("user_id", userId)
          .maybeSingle();
        if (!monitor) return { ok: false, error: "That data monitor no longer exists" };
        return detach(args, async () => {
          const { runDataMonitor } = await import("@/utils/dataMonitors/run.server");
          const res = await runDataMonitor(monitor as never, "pipeline");
          // An ALERT is the monitor doing its job and finding something. It
          // fails the step, because the whole point of putting a monitor in a
          // workflow is to stop what comes after it.
          if (res.status === "ok") return { ok: true, output: { message: res.message } };
          return { ok: false, error: res.message || `The monitor reported ${res.status}` };
        });
      }

      // ── Immediate ───────────────────────────────────────────────────────
      case "condition": {
        const { evaluateCondition } = await import("@/lib/workflows");
        const res = evaluateCondition(node.text ?? "", params);
        if (!res.ok) return { ok: false, error: res.error };
        return {
          ok: true,
          settled: { done: true, ok: true },
          branch: res.value ? "true" : "false",
          output: { expression: text(node, params), result: res.value },
        };
      }
      case "wait": {
        const until = new Date(Date.now() + (node.waitSeconds ?? 0) * 1000).toISOString();
        return { ok: true, targetRunId: `wait:${until}`, waitUntil: until };
      }
      case "notify": {
        const { notifyUser } = await import("@/utils/notify.server");
        await notifyUser(userId, {
          kind: "workflow",
          title: node.label || "Workflow",
          body: text(node, params),
          link: "/workflows",
        });
        return { ok: true, settled: { done: true, ok: true } };
      }
      case "http": {
        const spec = node.http;
        if (!spec) return { ok: false, error: "The HTTP step has no request" };
        const { runHttpNodeCore } = await import("@/utils/swarmNodes.server");
        // Parameters first, then secrets: `interpolate` leaves an unresolved
        // {{secret:NAME}} verbatim, which is what lets the two coexist.
        const res = await runHttpNodeCore(userId, {
          method: spec.method,
          url: substituteParams(spec.url, params),
          headers: Object.entries(spec.headers ?? {}).map(([key, value]) => ({
            key,
            value: substituteParams(value, params),
          })),
          body: spec.body ? substituteParams(spec.body, params) : undefined,
          timeout_ms: (node.timeoutMinutes ?? 1) * 60_000,
        });
        if (!res.ok) return { ok: false, error: res.error };
        const okStatuses = spec.okStatuses ?? [];
        const good = okStatuses.length
          ? okStatuses.includes(res.status)
          : res.status >= 200 && res.status < 300;
        return {
          ok: true,
          settled: good
            ? { done: true, ok: true }
            : { done: true, ok: false, error: `The endpoint answered ${res.status}` },
          output: { status: res.status, body: res.body.slice(0, 500) },
        };
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
  // A detached step settles itself; the run's timeout is its backstop.
  if (targetRunId === DETACHED) return { done: false };

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
    case "sub_workflow": {
      const { data } = await supabaseAdmin
        .from("workflow_runs")
        .select("state, error")
        .eq("id", targetRunId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!data) return gone("workflow run");
      if (data.state === "running") return { done: false };
      if (data.state === "succeeded") return { done: true, ok: true };
      return { done: true, ok: false, error: data.error ?? `The workflow ${data.state}` };
    }
    case "approval": {
      const id = targetRunId.replace(/^approval:/, "");
      const { data } = await supabaseAdmin
        .from("approvals")
        .select("status, decided_by")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!data) return gone("approval");
      if (data.status === "pending") return { done: false };
      if (data.status === "approved") return { done: true, ok: true };
      return { done: true, ok: false, error: "The approval was rejected" };
    }
    case "wait": {
      const until = targetRunId.replace(/^wait:/, "");
      return Date.parse(until) <= Date.now() ? { done: true, ok: true } : { done: false };
    }
    default:
      // Immediate kinds settle at start and never reach the poller.
      return { done: false };
  }
}

// ── The external trigger token ──────────────────────────────────────────────
//
// Copied from an ETL pipeline's, deliberately: an operator who has wired one
// into their CI should find the second one identical. The plaintext is
// returned once and never stored.

export function mintTriggerToken(): { token: string; hash: string } {
  const token = `wfk_${randomBytes(24).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export function hashToken(presented: string): string {
  return createHash("sha256").update(presented).digest("hex");
}
