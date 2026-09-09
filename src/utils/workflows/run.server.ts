// Running the graph.
//
// The decisions all live in `src/lib/workflows.ts` and are pure; this file is
// the part that touches the world. It does four things on every pass over a
// live run, in this order, and the order is the design:
//
//   1. ask each running step whether its work has finished,
//   2. mark the steps that can now never run as SKIPPED,
//   3. start the steps whose dependencies are satisfied,
//   4. if nothing is left, write the run's outcome.
//
// Polling rather than callbacks, deliberately. Each of the four subsystems
// already finalises its own run row from its own path — the sandbox callback,
// or a synchronous return — and hooking a fifth thing into each of those is
// four places to forget. Reading the row the subsystem already wrote is one
// place, and it also covers the case those callbacks cannot: a run whose
// sandbox died without ever calling back.
//
// Every step start is CLAIMED with a conditional update, the same idiom the
// pipeline sweep uses, so several app replicas can run this pass at once
// without starting the same step twice.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { envInt } from "@/utils/rateLimit.server";
import {
  NODE_KIND_LABEL,
  isFinished,
  readyNodes,
  runOutcome,
  skippableNodes,
  validateWorkflow,
  type NodeStates,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@/lib/workflows";
import { pollNode, startNode } from "./adapters.server";

export type WorkflowRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  graph: WorkflowGraph;
  schedule: string;
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
 * those limits cannot cover: a sandbox that vanished without ever writing a
 * terminal status, which would otherwise leave the run waiting forever.
 * Settings-free on purpose but env-tunable, because the right number depends
 * on the longest job somebody runs.
 */
const stepTimeoutMs = () => envInt("WORKFLOW_STEP_TIMEOUT_MINUTES", 240) * 60_000;

/** How many live runs one sweep advances. Keeps a pass bounded. */
const runsPerSweep = () => envInt("WORKFLOW_RUNS_PER_SWEEP", 20);

type NodeRunRow = {
  id: string;
  node_id: string;
  kind: WorkflowNode["kind"];
  state: WorkflowNodeState;
  target_run_id: string | null;
  started_at: string | null;
};

function graphOf(value: unknown): WorkflowGraph {
  const g = (value ?? {}) as Partial<WorkflowGraph>;
  return {
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    edges: Array.isArray(g.edges) ? g.edges : [],
  };
}

// ── Starting a run ──────────────────────────────────────────────────────────

/**
 * Begin a run of `workflow`, and take the first pass immediately.
 *
 * The graph is PINNED onto the run row. A workflow can be edited while a run
 * is in flight, and a run whose steps no longer match what ran is evidence of
 * nothing — the same reason an ETL run pins its source code.
 */
export async function startWorkflowRun(
  workflow: WorkflowRow,
  trigger: "manual" | "schedule",
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

  const { data: run, error } = await supabaseAdmin
    .from("workflow_runs")
    .insert({
      workflow_id: workflow.id,
      user_id: workflow.user_id,
      state: "running",
      trigger,
      graph: graph as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !run) return { ok: false, error: error?.message ?? "Could not start the run" };

  const { error: nodesErr } = await supabaseAdmin.from("workflow_node_runs").insert(
    graph.nodes.map((n) => ({
      run_id: run.id,
      user_id: workflow.user_id,
      node_id: n.id,
      kind: n.kind,
      label: n.label || NODE_KIND_LABEL[n.kind],
      state: "pending",
    })),
  );
  if (nodesErr) {
    await supabaseAdmin
      .from("workflow_runs")
      .update({ state: "failed", error: nodesErr.message, finished_at: new Date().toISOString() })
      .eq("id", run.id);
    return { ok: false, error: nodesErr.message };
  }

  await supabaseAdmin
    .from("workflows")
    .update({ last_run_at: new Date().toISOString(), last_run_status: "running" })
    .eq("id", workflow.id);

  // Start the roots now rather than waiting up to a minute for the sweep —
  // but do NOT hold the caller while they run. A SQL model build resolves only
  // when the whole build is done, so awaiting this would turn "start the run"
  // into a request that hangs for as long as the first step takes. Every write
  // the pass makes is claimed conditionally, so an overlapping pass is safe.
  void advanceWorkflowRun(run.id).catch((e) =>
    console.warn(`[workflow] first pass of "${workflow.name}" failed:`, (e as Error).message),
  );
  return { ok: true, runId: run.id };
}

// ── Advancing a run ─────────────────────────────────────────────────────────

/**
 * Take one pass over a live run: settle what finished, skip what cannot run,
 * start what is ready, and close the run if nothing is left.
 *
 * Safe to call concurrently. Every write that matters is conditional on the
 * state the caller believed it was changing.
 */
export async function advanceWorkflowRun(runId: string): Promise<void> {
  const { data: run } = await supabaseAdmin
    .from("workflow_runs")
    .select("id, user_id, workflow_id, state, graph, started_at")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.state !== "running") return;

  const graph = graphOf(run.graph);
  const { data: rows } = await supabaseAdmin
    .from("workflow_node_runs")
    .select("id, node_id, kind, state, target_run_id, started_at")
    .eq("run_id", runId);
  const nodeRuns = (rows ?? []) as NodeRunRow[];
  const byNodeId = new Map(nodeRuns.map((r) => [r.node_id, r]));

  // 1. Settle every step that was running.
  for (const row of nodeRuns) {
    if (row.state !== "running") continue;
    const outcome = row.target_run_id
      ? await pollNode({ userId: run.user_id, kind: row.kind, targetRunId: row.target_run_id })
      : // Claimed but never started: the process died between the claim and
        // the start. The timeout below is what rescues it.
        ({ done: false } as const);
    if (!outcome.done) {
      const age = row.started_at ? Date.now() - new Date(row.started_at).getTime() : 0;
      if (age > stepTimeoutMs()) {
        await finishNode(row.id, "failed", "The step did not finish in time and was given up on");
        byNodeId.set(row.node_id, { ...row, state: "failed" });
      }
      continue;
    }
    const state: WorkflowNodeState = outcome.ok ? "succeeded" : "failed";
    await finishNode(row.id, state, outcome.ok ? null : outcome.error);
    byNodeId.set(row.node_id, { ...row, state });
  }

  const states = (): NodeStates =>
    Object.fromEntries(graph.nodes.map((n) => [n.id, byNodeId.get(n.id)?.state ?? "pending"]));

  // 2. Anything downstream of a failure can never run. Say so rather than
  //    leaving it pending forever.
  for (const nodeId of skippableNodes(graph, states())) {
    const row = byNodeId.get(nodeId);
    if (!row) continue;
    const { data: won } = await supabaseAdmin
      .from("workflow_node_runs")
      .update({
        state: "skipped",
        finished_at: new Date().toISOString(),
        error: "A step it depends on did not succeed",
      })
      .eq("id", row.id)
      .eq("state", "pending")
      .select("id");
    if (won?.length) byNodeId.set(nodeId, { ...row, state: "skipped" });
  }

  // 3. Start what is ready. The claim is the update: only the replica that
  //    still sees `pending` wins, so a step starts once however many app
  //    instances take this pass at the same moment.
  for (const nodeId of readyNodes(graph, states())) {
    const row = byNodeId.get(nodeId);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!row || !node) continue;
    const { data: won } = await supabaseAdmin
      .from("workflow_node_runs")
      .update({ state: "running", started_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("state", "pending")
      .select("id");
    if (!won?.length) continue;
    byNodeId.set(nodeId, { ...row, state: "running" });

    const started = await startNode({ userId: run.user_id, node });
    if (started.ok) {
      await supabaseAdmin
        .from("workflow_node_runs")
        .update({ target_run_id: started.targetRunId })
        .eq("id", row.id);
      byNodeId.set(nodeId, { ...row, state: "running", target_run_id: started.targetRunId });
    } else {
      await finishNode(row.id, "failed", started.error);
      byNodeId.set(nodeId, { ...row, state: "failed" });
    }
  }

  // A SQL model build finishes inside its own start call, so its step can be
  // settled on this same pass instead of a minute later.
  for (const row of nodeRuns) {
    const current = byNodeId.get(row.node_id);
    if (!current || current.state !== "running" || !current.target_run_id) continue;
    if (current.kind !== "sql_models") continue;
    const outcome = await pollNode({
      userId: run.user_id,
      kind: "sql_models",
      targetRunId: current.target_run_id,
    });
    if (!outcome.done) continue;
    const state: WorkflowNodeState = outcome.ok ? "succeeded" : "failed";
    await finishNode(current.id, state, outcome.ok ? null : outcome.error);
    byNodeId.set(row.node_id, { ...current, state });
  }

  // 4. Close the run once there is nothing left to start, skip or wait for.
  const final = states();
  if (!isFinished(graph, final)) return;
  const outcome = runOutcome(final);
  if (outcome === "running") return;
  await supabaseAdmin
    .from("workflow_runs")
    .update({ state: outcome, finished_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("state", "running");
  await supabaseAdmin
    .from("workflows")
    .update({ last_run_status: outcome })
    .eq("id", run.workflow_id);
}

async function finishNode(id: string, state: WorkflowNodeState, error: string | null) {
  await supabaseAdmin
    .from("workflow_node_runs")
    .update({ state, error, finished_at: new Date().toISOString() })
    .eq("id", id);
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
    .eq("id", won[0].workflow_id);
  return { ok: true };
}

// ── The sweep ───────────────────────────────────────────────────────────────

/** Next time a workflow on this schedule is due, or null for manual. */
export function nextWorkflowRunAt(schedule: string, from = new Date()): string | null {
  if (schedule === "hourly") return new Date(from.getTime() + 3600_000).toISOString();
  if (schedule === "daily") return new Date(from.getTime() + 24 * 3600_000).toISOString();
  if (schedule === "weekly") return new Date(from.getTime() + 7 * 24 * 3600_000).toISOString();
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
  for (const workflow of (due ?? []) as WorkflowRow[]) {
    let claim = supabaseAdmin
      .from("workflows")
      .update({ next_run_at: nextWorkflowRunAt(workflow.schedule) })
      .eq("id", workflow.id);
    claim =
      workflow.next_run_at === null
        ? claim.is("next_run_at", null)
        : claim.eq("next_run_at", workflow.next_run_at);
    const { data: won } = await claim.select("id");
    if (!won?.length) continue;
    const res = await startWorkflowRun(workflow, "schedule");
    if (res.ok) started++;
    else console.warn(`[workflow] "${workflow.name}" did not start: ${res.error}`);
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
      await advanceWorkflowRun(run.id);
      advanced++;
    } catch (e) {
      // One wedged run must never stop the others.
      console.warn(`[workflow] run ${run.id} could not advance:`, (e as Error).message);
    }
  }
  return advanced;
}
