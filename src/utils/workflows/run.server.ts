// Running the graph.
//
// The decisions all live in `src/lib/workflows.ts` and are pure; this file is
// the part that touches the world. It does five things on every pass over a
// live run, in this order, and the order is the design:
//
//   1. ask each running step whether its work has finished,
//   2. retry the ones that failed and have attempts left,
//   3. mark the steps that can now never run as SKIPPED,
//   4. start the steps whose dependencies are satisfied,
//   5. if nothing is left, write the run's outcome.
//
// Polling rather than callbacks, deliberately. Each subsystem already
// finalises its own run row from its own path — the sandbox callback, or a
// synchronous return — and hooking a further thing into each of those is a
// dozen places to forget. Reading the row the subsystem already wrote is one
// place, and it also covers the case those callbacks cannot: a run whose
// sandbox died without ever calling back.
//
// Every step start is CLAIMED with a conditional update, the same idiom the
// pipeline sweep uses, so several app replicas can run this pass at once
// without starting the same step twice.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { nextCronOccurrence } from "@/lib/cron";
import { envInt } from "@/utils/rateLimit.server";
import {
  NODE_KIND_LABEL,
  isFinished,
  readyNodes,
  resolveParams,
  retryDelaySeconds,
  runOutcome,
  skippableNodes,
  validateWorkflow,
  type NodeBranches,
  type NodeStates,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@/lib/workflows";
import { auditEvent } from "@/utils/audit.server";
import { DETACHED, pollNode, startNode, type Settled } from "./adapters.server";

export type WorkflowRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  graph: WorkflowGraph;
  schedule: string;
  cron_expr: string | null;
  timezone: string | null;
  params: unknown;
  overlap: string;
  notify_on: string;
  timeout_minutes: number;
  next_run_at: string | null;
  is_active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * How long a step may stay running before the workflow gives up on it.
 *
 * Not a cap on the work itself — the pipeline, the training job and the
 * notebook each enforce their own limits. This is the backstop for the case
 * those limits cannot cover: a sandbox that vanished, or a detached promise
 * whose process died, which would otherwise leave the run waiting forever.
 */
const defaultStepTimeoutMs = () => envInt("WORKFLOW_STEP_TIMEOUT_MINUTES", 240) * 60_000;

/** How many due workflows one sweep starts, and how many live runs it advances. */
const runsPerSweep = () => envInt("WORKFLOW_RUNS_PER_SWEEP", 20);

type NodeRunRow = {
  id: string;
  node_id: string;
  kind: WorkflowNode["kind"];
  state: WorkflowNodeState;
  target_run_id: string | null;
  started_at: string | null;
  attempt: number;
  retry_at: string | null;
  branch: string | null;
};

function graphOf(value: unknown): WorkflowGraph {
  const g = (value ?? {}) as Partial<WorkflowGraph>;
  return {
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    edges: Array.isArray(g.edges) ? g.edges : [],
    params: Array.isArray(g.params) ? g.params : [],
  };
}

const stepTimeoutMs = (node: WorkflowNode | undefined) =>
  node?.timeoutMinutes ? node.timeoutMinutes * 60_000 : defaultStepTimeoutMs();

type StepOutcomeLike = { done: false } | { done: true; ok: true } | Settled;

// ── Starting a run ──────────────────────────────────────────────────────────

/**
 * Begin a run of `workflow`, and take the first pass immediately.
 *
 * The graph AND the parameters are pinned onto the run row. A workflow can be
 * edited while a run is in flight, and a run whose steps or inputs no longer
 * match what ran is evidence of nothing — the same reason an ETL run pins its
 * source code.
 */
export async function startWorkflowRun(
  workflow: WorkflowRow,
  trigger: "manual" | "schedule" | "api" | "workflow" | "rerun",
  opts: {
    params?: Record<string, string>;
    parentRunId?: string;
    rerunOf?: string;
    /** Steps to carry over as already-succeeded, for a re-run from failure. */
    keep?: Record<string, WorkflowNodeState>;
  } = {},
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const graph = graphOf(workflow.graph);
  if (!graph.nodes.length) return { ok: false, error: "This workflow has no steps yet" };
  const invalid = validateWorkflow({ name: workflow.name, graph });
  if (invalid) return { ok: false, error: invalid };

  // One run at a time per workflow. Two runs of the same graph would start
  // the same pipeline twice and race each other's tables, and the second
  // would report a failure caused by the first.
  const { data: live } = await supabaseAdmin
    .from("workflow_runs")
    .select("id")
    .eq("workflow_id", workflow.id)
    .eq("state", "running")
    .limit(1);
  if (live?.length) return { ok: false, error: "This workflow is already running" };

  const params = resolveParams(graph, opts.params ?? {});
  const { data: run, error } = await supabaseAdmin
    .from("workflow_runs")
    .insert({
      workflow_id: workflow.id,
      user_id: workflow.user_id,
      state: "running",
      trigger,
      graph: graph as unknown as Json,
      params: params as unknown as Json,
      branches: {} as unknown as Json,
      parent_run_id: opts.parentRunId ?? null,
      rerun_of: opts.rerunOf ?? null,
    })
    .select("id")
    .single();
  if (error || !run) return { ok: false, error: error?.message ?? "Could not start the run" };

  // Every run is audited HERE rather than at each caller, so a run started by
  // the scheduler, by the API or by a parent workflow is recorded on exactly
  // the same terms as one somebody clicked. `trigger` is the interesting
  // column: "api" means a bearer token was accepted for this workflow.
  auditEvent({
    userId: workflow.user_id,
    action: "workflow.run",
    resourceType: "workflow",
    resourceId: workflow.id,
    resourceName: workflow.name,
    detail: {
      run_id: String(run.id),
      trigger,
      steps: graph.nodes.length,
      params: Object.keys(params).sort(),
      ...(opts.parentRunId ? { parent_run_id: opts.parentRunId } : {}),
      ...(opts.rerunOf ? { rerun_of: opts.rerunOf } : {}),
    },
  });

  const now = new Date().toISOString();
  const { error: nodesErr } = await supabaseAdmin.from("workflow_node_runs").insert(
    graph.nodes.map((n) => {
      const carried = opts.keep?.[n.id];
      return {
        run_id: run.id,
        user_id: workflow.user_id,
        node_id: n.id,
        kind: n.kind,
        label: n.label || NODE_KIND_LABEL[n.kind],
        // A re-run keeps what already worked, so a four-hour load is not
        // repeated to get at the step after it that failed.
        state: carried ?? "pending",
        started_at: carried ? now : null,
        finished_at: carried ? now : null,
      };
    }),
  );
  if (nodesErr) {
    await supabaseAdmin
      .from("workflow_runs")
      .update({ state: "failed", error: nodesErr.message, finished_at: now })
      .eq("id", run.id);
    return { ok: false, error: nodesErr.message };
  }

  await supabaseAdmin
    .from("workflows")
    .update({ last_run_at: now, last_run_status: "running" })
    .eq("id", workflow.id);

  // Start the roots now rather than waiting up to a minute for the sweep —
  // but do NOT hold the caller while they run. Every write the pass makes is
  // claimed conditionally, so an overlapping pass is safe.
  void advanceWorkflowRun(run.id).catch((e) =>
    console.warn(`[workflow] first pass of "${workflow.name}" failed:`, (e as Error).message),
  );
  return { ok: true, runId: run.id };
}

// ── Advancing a run ─────────────────────────────────────────────────────────

/**
 * Take one pass over a live run.
 *
 * Safe to call concurrently. Every write that matters is conditional on the
 * state the caller believed it was changing.
 */
export async function advanceWorkflowRun(runId: string): Promise<void> {
  const { data: run } = await supabaseAdmin
    .from("workflow_runs")
    .select("id, user_id, workflow_id, state, graph, params, branches, started_at")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.state !== "running") return;

  const graph = graphOf(run.graph);
  const params = (run.params ?? {}) as Record<string, string>;
  const branches: NodeBranches = { ...((run.branches ?? {}) as NodeBranches) };
  const byNode = new Map(graph.nodes.map((n) => [n.id, n]));

  const { data: rows } = await supabaseAdmin
    .from("workflow_node_runs")
    .select("id, node_id, kind, state, target_run_id, started_at, attempt, retry_at, branch")
    .eq("run_id", runId);
  const nodeRuns = (rows ?? []) as NodeRunRow[];
  const byNodeId = new Map(nodeRuns.map((r) => [r.node_id, r]));
  for (const r of nodeRuns) if (r.branch) branches[r.node_id] = r.branch as "true" | "false";

  // The whole run's own ceiling, so a graph cannot hang on a step nobody is
  // watching. Checked first: there is no point starting anything on a run
  // that is already over its time.
  const { data: workflow } = await supabaseAdmin
    .from("workflows")
    .select("name, timeout_minutes")
    .eq("id", run.workflow_id)
    .maybeSingle();
  const runAge = run.started_at ? Date.now() - new Date(run.started_at).getTime() : 0;
  if (workflow && runAge > (workflow.timeout_minutes ?? 720) * 60_000) {
    await closeRun(runId, run.workflow_id, "failed", "The run exceeded its time limit");
    return;
  }

  // 1 and 2. Settle what finished; retry what failed and has attempts left.
  for (const row of nodeRuns) {
    if (row.state !== "running") continue;
    const node = byNode.get(row.node_id);
    const outcome: StepOutcomeLike = row.target_run_id
      ? await pollNode({ userId: run.user_id, kind: row.kind, targetRunId: row.target_run_id })
      : // Claimed but never started: the process died between the claim and
        // the start. The timeout below is what rescues it.
        { done: false };

    if (!outcome.done) {
      const age = row.started_at ? Date.now() - new Date(row.started_at).getTime() : 0;
      if (age > stepTimeoutMs(node)) {
        const next = await settleStep(row, node, "The step did not finish in time");
        byNodeId.set(row.node_id, { ...row, state: next });
      }
      continue;
    }
    if (outcome.ok) {
      await finishNode(row.id, "succeeded", null);
      byNodeId.set(row.node_id, { ...row, state: "succeeded" });
      continue;
    }
    const next = await settleStep(row, node, outcome.error);
    byNodeId.set(row.node_id, { ...row, state: next });
  }

  const states = (): NodeStates =>
    Object.fromEntries(graph.nodes.map((n) => [n.id, byNodeId.get(n.id)?.state ?? "pending"]));

  // 3. Anything the run can no longer reach is said so, rather than left
  //    pending forever.
  for (const nodeId of skippableNodes(graph, states(), branches)) {
    const row = byNodeId.get(nodeId);
    if (!row) continue;
    const { data: won } = await supabaseAdmin
      .from("workflow_node_runs")
      .update({
        state: "skipped",
        finished_at: new Date().toISOString(),
        error: "A step it depends on did not succeed, or its branch was not taken",
      })
      .eq("id", row.id)
      .eq("state", "pending")
      .select("id");
    if (won?.length) byNodeId.set(nodeId, { ...row, state: "skipped" });
  }

  // 4. Start what is ready. The claim is the update: only the replica that
  //    still sees `pending` wins, so a step starts once however many app
  //    instances take this pass at the same moment.
  const nowMs = Date.now();
  for (const nodeId of readyNodes(graph, states(), branches)) {
    const row = byNodeId.get(nodeId);
    const node = byNode.get(nodeId);
    if (!row || !node) continue;
    // A step waiting out its retry backoff is not ready yet.
    if (row.retry_at && Date.parse(row.retry_at) > nowMs) continue;

    const { data: won } = await supabaseAdmin
      .from("workflow_node_runs")
      .update({ state: "running", started_at: new Date().toISOString(), retry_at: null })
      .eq("id", row.id)
      .eq("state", "pending")
      .select("id");
    if (!won?.length) continue;
    byNodeId.set(nodeId, { ...row, state: "running" });

    const started = await startNode({
      userId: run.user_id,
      node,
      params,
      runId,
      nodeRunId: row.id,
      settle: async (outcome, output) => {
        // Conditional on still being `running`, so a timeout that already
        // failed this step wins and a late promise cannot resurrect it.
        await supabaseAdmin
          .from("workflow_node_runs")
          .update({
            state: outcome.ok ? "succeeded" : "failed",
            error: outcome.ok ? null : outcome.error,
            finished_at: new Date().toISOString(),
            output: (output ?? null) as Json,
          })
          .eq("id", row.id)
          .eq("state", "running");
      },
    });

    if (!started.ok) {
      const next = await settleStep({ ...row, state: "running" }, node, started.error);
      byNodeId.set(nodeId, { ...row, state: next });
      continue;
    }
    // What the start told us, recorded before we decide the step's fate: the
    // response body of a failed HTTP call is the most useful thing in the run
    // view, and a retry must not throw it away.
    const patch: {
      target_run_id: string;
      output?: Json;
      branch?: string;
      wait_until?: string;
    } = { target_run_id: started.targetRunId ?? DETACHED };
    if (started.output) patch.output = started.output as Json;
    if (started.branch) patch.branch = started.branch;
    if (started.waitUntil) patch.wait_until = started.waitUntil;
    await supabaseAdmin.from("workflow_node_runs").update(patch).eq("id", row.id);

    if (started.branch) {
      branches[nodeId] = started.branch;
      await supabaseAdmin
        .from("workflow_runs")
        .update({ branches: branches as unknown as Json })
        .eq("id", runId);
    }
    if (started.settled) {
      // FOUND FROM THE UI. This branch used to write `failed` straight into
      // the patch above, which meant a step that failed INSIDE its own start
      // call never reached `settleStep` and so was never retried — and the
      // immediate kinds are HTTP and SQL, the two most worth retrying. Every
      // failure, whichever of the three shapes produced it, now leaves through
      // the same door.
      if (started.settled.ok) {
        await finishNode(row.id, "succeeded", null);
        byNodeId.set(nodeId, { ...row, state: "succeeded" });
      } else {
        const next = await settleStep({ ...row, state: "running" }, node, started.settled.error);
        byNodeId.set(nodeId, { ...row, state: next });
      }
    } else {
      byNodeId.set(nodeId, {
        ...row,
        state: "running",
        target_run_id: patch.target_run_id,
      });
    }
  }

  // A model build, a sub-workflow and a wait all resolve quickly enough that
  // settling them on this same pass, rather than a minute later, is what makes
  // a small graph feel immediate.
  for (const row of nodeRuns) {
    const current = byNodeId.get(row.node_id);
    if (!current || current.state !== "running" || !current.target_run_id) continue;
    if (current.target_run_id === DETACHED) continue;
    if (!["sql_models", "sub_workflow", "wait"].includes(current.kind)) continue;
    const outcome = await pollNode({
      userId: run.user_id,
      kind: current.kind,
      targetRunId: current.target_run_id,
    });
    if (!outcome.done) continue;
    if (outcome.ok) {
      await finishNode(current.id, "succeeded", null);
      byNodeId.set(row.node_id, { ...current, state: "succeeded" });
    } else {
      const next = await settleStep(current, byNode.get(row.node_id), outcome.error);
      byNodeId.set(row.node_id, { ...current, state: next });
    }
  }

  // 5. Close the run once there is nothing left to start, skip or wait for.
  const final = states();
  if (!isFinished(graph, final, branches)) return;
  const outcome = runOutcome(final, graph);
  if (outcome === "running") return;
  await closeRun(runId, run.workflow_id, outcome, null);
}

/**
 * A step failed. Retry it if it has attempts left, otherwise fail it.
 *
 * The retry reuses the SAME row, incrementing `attempt`, so a step stays one
 * line in the run view however many times it was tried — one logical step,
 * one place to look.
 */
async function settleStep(
  row: NodeRunRow,
  node: WorkflowNode | undefined,
  error: string,
): Promise<WorkflowNodeState> {
  const allowed = node?.retries ?? 0;
  if (node && allowed > 0 && row.attempt <= allowed) {
    const delay = retryDelaySeconds(node, row.attempt);
    const { data: won } = await supabaseAdmin
      .from("workflow_node_runs")
      .update({
        state: "pending",
        attempt: row.attempt + 1,
        retry_at: new Date(Date.now() + delay * 1000).toISOString(),
        target_run_id: null,
        started_at: null,
        error: `Attempt ${row.attempt} failed (${error}) — retrying in ${delay}s`,
      })
      .eq("id", row.id)
      .eq("state", "running")
      .select("id");
    if (won?.length) return "pending";
  }
  await finishNode(row.id, "failed", error);
  return "failed";
}

async function finishNode(id: string, state: WorkflowNodeState, error: string | null) {
  await supabaseAdmin
    .from("workflow_node_runs")
    .update({ state, error, finished_at: new Date().toISOString() })
    .eq("id", id);
}

/** Write the run's outcome, stamp the workflow, and tell the owner if asked. */
async function closeRun(
  runId: string,
  workflowId: string,
  outcome: "succeeded" | "failed" | "cancelled",
  error: string | null,
): Promise<void> {
  const { data: won } = await supabaseAdmin
    .from("workflow_runs")
    .update({ state: outcome, error, finished_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("state", "running")
    .select("id, user_id");
  if (!won?.length) return; // another replica closed it first
  const { data: workflow } = await supabaseAdmin
    .from("workflows")
    .update({ last_run_status: outcome })
    .eq("id", workflowId)
    .select("name, notify_on")
    .maybeSingle();
  // Paired with `workflow.run`: the start says a run was authorised, this
  // says what it did. Written inside the conditional close, so exactly one
  // replica records the outcome however many took the pass.
  auditEvent({
    userId: String(won[0].user_id),
    action: "workflow.run.finished",
    resourceType: "workflow",
    resourceId: workflowId,
    resourceName: workflow?.name ?? undefined,
    detail: { run_id: runId, outcome, ...(error ? { error } : {}) },
  });
  const notifyOn = workflow?.notify_on ?? "failure";
  const wanted = notifyOn === "always" || (notifyOn === "failure" && outcome !== "succeeded");
  if (!wanted) return;
  const { notifyUser } = await import("@/utils/notify.server");
  await notifyUser(String(won[0].user_id), {
    kind: outcome === "succeeded" ? "workflow" : "alert",
    title: `${workflow?.name ?? "Workflow"} ${outcome}`,
    body: error ?? `The run ${outcome}. Open the workflow to see which step.`,
    link: "/workflows",
  });
}

/** Stop a run: nothing already started is killed, but nothing new begins. */
export async function cancelWorkflowRun(
  userId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: won } = await supabaseAdmin
    .from("workflow_runs")
    .update({ state: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("user_id", userId)
    .eq("state", "running")
    .select("id, workflow_id");
  if (!won?.length) return { ok: false, error: "That run is not running" };
  auditEvent({
    userId,
    action: "workflow.run.cancel",
    resourceType: "workflow",
    resourceId: String(won[0].workflow_id),
    detail: { run_id: runId },
  });
  // Steps that never started are skipped, which is the truth: they did not
  // run and they did not fail. A step already in flight is left alone — the
  // pipeline or training job it started keeps its own life.
  await supabaseAdmin
    .from("workflow_node_runs")
    .update({
      state: "skipped",
      finished_at: new Date().toISOString(),
      error: "The run was cancelled before this step started",
    })
    .eq("run_id", runId)
    .eq("state", "pending");
  await supabaseAdmin
    .from("workflows")
    .update({ last_run_status: "cancelled" })
    .eq("id", String(won[0].workflow_id));
  return { ok: true };
}

/**
 * Run it again, keeping the steps that already worked.
 *
 * The point of a re-run is usually the step that failed, not the four-hour
 * load above it. Anything that succeeded last time is carried over, and the
 * parameters come from the run being repeated so the repeat is of THAT run
 * rather than of today's defaults.
 */
export async function rerunWorkflowRun(
  userId: string,
  runId: string,
  opts: { fromFailed: boolean },
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const { data: prior } = await supabaseAdmin
    .from("workflow_runs")
    .select("id, workflow_id, params, state")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!prior) return { ok: false, error: "Run not found" };
  if (prior.state === "running") return { ok: false, error: "That run has not finished" };
  const { data: workflow } = await supabaseAdmin
    .from("workflows")
    .select("*")
    .eq("id", prior.workflow_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!workflow) return { ok: false, error: "Workflow not found" };

  let keep: Record<string, WorkflowNodeState> | undefined;
  if (opts.fromFailed) {
    const { data: steps } = await supabaseAdmin
      .from("workflow_node_runs")
      .select("node_id, state")
      .eq("run_id", runId);
    keep = Object.fromEntries(
      (steps ?? [])
        .filter((s) => s.state === "succeeded")
        .map((s) => [String(s.node_id), "succeeded" as WorkflowNodeState]),
    );
  }
  return startWorkflowRun(workflow as unknown as WorkflowRow, "rerun", {
    params: (prior.params ?? {}) as Record<string, string>,
    rerunOf: runId,
    keep,
  });
}

// ── The sweep ───────────────────────────────────────────────────────────────

/** Next time a workflow on this schedule is due, or null for manual. */
export function nextWorkflowRunAt(
  schedule: string,
  from = new Date(),
  cronExpr?: string | null,
  timezone?: string | null,
): string | null {
  if (schedule === "hourly") return new Date(from.getTime() + 3600_000).toISOString();
  if (schedule === "daily") return new Date(from.getTime() + 24 * 3600_000).toISOString();
  if (schedule === "weekly") return new Date(from.getTime() + 7 * 24 * 3600_000).toISOString();
  if (schedule === "cron" && cronExpr) {
    try {
      return nextCronOccurrence(cronExpr, timezone, from)?.toISOString() ?? null;
    } catch {
      // An expression that stopped parsing must not wedge the sweep; the
      // workflow simply stops being scheduled until it is fixed, which its
      // next_run_at makes visible.
      return null;
    }
  }
  return null;
}

/**
 * Start the workflows whose clock has come round.
 *
 * The clock advance doubles as the claim, exactly as the pipeline sweep does
 * it: only the replica that still sees the old `next_run_at` wins the row.
 */
export async function processDueWorkflows(force = false): Promise<number> {
  const nowIso = new Date().toISOString();
  let query = supabaseAdmin
    .from("workflows")
    .select("*")
    .eq("is_active", true)
    .neq("schedule", "manual")
    .order("next_run_at", { ascending: true })
    .limit(runsPerSweep());
  if (!force) query = query.lte("next_run_at", nowIso);

  const { data: due } = await query;
  let started = 0;
  for (const workflow of (due ?? []) as unknown as WorkflowRow[]) {
    let claim = supabaseAdmin
      .from("workflows")
      .update({
        next_run_at: nextWorkflowRunAt(
          workflow.schedule,
          new Date(),
          workflow.cron_expr,
          workflow.timezone,
        ),
      })
      .eq("id", workflow.id);
    claim =
      workflow.next_run_at === null
        ? claim.is("next_run_at", null)
        : claim.eq("next_run_at", workflow.next_run_at);
    const { data: won } = await claim.select("id");
    if (!won?.length) continue;
    const res = await startWorkflowRun(workflow, "schedule");
    if (res.ok) started++;
    else if (res.error !== "This workflow is already running") {
      console.warn(`[workflow] "${workflow.name}" did not start: ${res.error}`);
    }
  }
  return started;
}

/** Take a pass over every run still in flight. */
export async function advanceLiveWorkflowRuns(): Promise<number> {
  const { data: live } = await supabaseAdmin
    .from("workflow_runs")
    .select("id")
    .eq("state", "running")
    .order("started_at", { ascending: true })
    .limit(runsPerSweep());
  let advanced = 0;
  for (const run of live ?? []) {
    try {
      await advanceWorkflowRun(String(run.id));
      advanced++;
    } catch (e) {
      // One wedged run must never stop the others.
      console.warn(`[workflow] run ${run.id} could not advance:`, (e as Error).message);
    }
  }
  return advanced;
}
