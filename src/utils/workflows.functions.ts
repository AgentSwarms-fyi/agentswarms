// Server functions behind Data & BI → Workflows.
//
// A workflow can start an ETL pipeline, build SQL models, retrain a model, run
// a notebook, run a swarm, call an API and ask a person a question — so every
// one of these re-resolves the caller and scopes by user_id. A graph that
// could start work its author cannot see would be a way around every grant the
// platform has. `workflowCandidates` exists for the same reason: the editor is
// only ever offered the caller's own things to wire up.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import type { Json } from "@/integrations/supabase/types";
import { validateCron } from "@/lib/cron";
import {
  MAX_NODES,
  NODE_KINDS,
  TRIGGER_RULES,
  WORKFLOW_NAME_MAX,
  validateWorkflow,
  type WorkflowGraph,
  type WorkflowNode,
} from "@/lib/workflows";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

/**
 * A workflow over the wire.
 *
 * `graph` stays `Json` rather than `WorkflowGraph` for the same reason a
 * dashboard's widgets do: the framework proves the return type serialisable
 * and a node's shape is a union the prover will not accept. The client parses
 * it back on arrival. `trigger_token_hash` never leaves the server — only
 * whether one exists.
 */
export type WorkflowRowDto = {
  id: string;
  name: string;
  description: string | null;
  graph: Json;
  schedule: string;
  cron_expr: string | null;
  timezone: string | null;
  overlap: string;
  notify_on: string;
  timeout_minutes: number;
  next_run_at: string | null;
  is_active: boolean;
  has_trigger_token: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkflowRunDto = {
  id: string;
  workflow_id: string;
  state: string;
  trigger: string;
  error: string | null;
  params: Json;
  started_at: string;
  finished_at: string | null;
};

export type WorkflowNodeRunDto = {
  id: string;
  node_id: string;
  kind: string;
  label: string;
  state: string;
  target_run_id: string | null;
  error: string | null;
  attempt: number;
  branch: string | null;
  output: Json;
  started_at: string | null;
  finished_at: string | null;
};

function toRow(row: Record<string, unknown>): WorkflowRowDto {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: (row.description as string | null) ?? null,
    graph: (row.graph ?? { nodes: [], edges: [] }) as Json,
    schedule: String(row.schedule ?? "manual"),
    cron_expr: (row.cron_expr as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    overlap: String(row.overlap ?? "skip"),
    notify_on: String(row.notify_on ?? "failure"),
    timeout_minutes: Number(row.timeout_minutes ?? 720),
    next_run_at: (row.next_run_at as string | null) ?? null,
    is_active: Boolean(row.is_active),
    // The hash itself is never sent; only the fact that a token was minted.
    has_trigger_token: Boolean(row.trigger_token_hash),
    last_run_at: (row.last_run_at as string | null) ?? null,
    last_run_status: (row.last_run_status as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export const workflowsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<Fail | { ok: true; workflows: WorkflowRowDto[] }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: rows, error } = await supabaseAdmin
      .from("workflows")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, workflows: (rows ?? []).map(toRow) };
  });

export const workflowGet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; workflow: WorkflowRowDto }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: row } = await supabaseAdmin
      .from("workflows")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return { ok: false, error: "Workflow not found" };
    return { ok: true, workflow: toRow(row) };
  });

const NODE = z.object({
  id: z.string().min(1),
  kind: z.enum(NODE_KINDS),
  label: z.string().max(200),
  targetId: z.string().optional(),
  models: z.array(z.string()).optional(),
  text: z.string().max(20000).optional(),
  http: z
    .object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      url: z.string().max(2000),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().max(20000).optional(),
      okStatuses: z.array(z.number().int()).optional(),
    })
    .optional(),
  waitSeconds: z.number().int().positive().max(86400).optional(),
  continueOnFailure: z.boolean().optional(),
  triggerRule: z.enum(TRIGGER_RULES).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryBackoffSeconds: z.number().int().positive().max(3600).optional(),
  timeoutMinutes: z.number().int().positive().max(10080).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const workflowSave = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX),
        description: z.string().trim().max(2000).nullable().optional(),
        schedule: z.enum(["manual", "hourly", "daily", "weekly", "cron"]),
        cronExpr: z.string().trim().max(120).nullable().optional(),
        timezone: z.string().trim().max(64).nullable().optional(),
        overlap: z.enum(["skip", "queue"]),
        notifyOn: z.enum(["never", "failure", "always"]),
        timeoutMinutes: z.number().int().min(1).max(10080),
        isActive: z.boolean(),
        nodes: z.array(NODE).max(MAX_NODES),
        edges: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              branch: z.enum(["true", "false"]).optional(),
            }),
          )
          .max(MAX_NODES * 4),
        params: z
          .array(
            z.object({
              name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
              default: z.string().max(2000).optional(),
              description: z.string().max(200).optional(),
            }),
          )
          .max(30),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const graph: WorkflowGraph = {
      nodes: data.nodes as WorkflowNode[],
      edges: data.edges,
      params: data.params,
    };
    const invalid = validateWorkflow({ name: data.name, graph });
    if (invalid) return { ok: false, error: invalid };
    if (data.schedule === "cron") {
      if (!data.cronExpr?.trim()) {
        return { ok: false, error: "A cron schedule needs an expression" };
      }
      try {
        validateCron(data.cronExpr, data.timezone ?? undefined);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }

    // Every target must still be the caller's own. Checked at SAVE as well as
    // at run, because "it silently stopped running that pipeline" is a much
    // worse discovery than a refusal at the moment you press Save.
    const missing = await missingTargets(userId, graph, data.id);
    if (missing) return { ok: false, error: missing };

    const { nextWorkflowRunAt } = await import("@/utils/workflows/run.server");
    const reclock = await scheduleDiffers(data.id, data);
    const { error } = await supabaseAdmin
      .from("workflows")
      .update({
        name: data.name,
        description: data.description ?? null,
        graph: graph as unknown as Json,
        schedule: data.schedule,
        cron_expr: data.schedule === "cron" ? (data.cronExpr ?? null) : null,
        timezone: data.timezone ?? null,
        overlap: data.overlap,
        notify_on: data.notifyOn,
        timeout_minutes: data.timeoutMinutes,
        params: data.params as unknown as Json,
        is_active: data.isActive,
        // A schedule that changed needs a new clock; one that did not is left
        // alone so saving a label does not postpone tonight's run.
        ...(reclock
          ? {
              next_run_at:
                data.schedule === "manual"
                  ? null
                  : nextWorkflowRunAt(data.schedule, new Date(), data.cronExpr, data.timezone),
            }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

async function scheduleDiffers(
  id: string,
  next: { schedule: string; cronExpr?: string | null; timezone?: string | null },
): Promise<boolean> {
  const { data: row } = await supabaseAdmin
    .from("workflows")
    .select("schedule, cron_expr, timezone, next_run_at")
    .eq("id", id)
    .maybeSingle();
  if (!row) return true;
  if (row.schedule !== next.schedule) return true;
  if ((row.cron_expr ?? null) !== (next.cronExpr ?? null)) return true;
  if ((row.timezone ?? null) !== (next.timezone ?? null)) return true;
  // A scheduled workflow with no clock has never been given one.
  return next.schedule !== "manual" && !row.next_run_at;
}

const TARGET_TABLES = [
  ["pipeline", "etl_pipelines", "pipeline"],
  ["ml_schedule", "ml_schedules", "ML schedule"],
  ["notebook", "user_python_notebooks", "notebook"],
  ["swarm", "swarms", "swarm"],
  ["prep_flow", "user_prep_flows", "prep flow"],
  ["dashboard_refresh", "bi_dashboards", "dashboard"],
  ["data_monitor", "data_monitors", "data monitor"],
  ["sub_workflow", "workflows", "workflow"],
] as const;

/** Names the first target that is gone, so the refusal is actionable. */
async function missingTargets(
  userId: string,
  graph: WorkflowGraph,
  selfId: string,
): Promise<string | null> {
  for (const [kind, table, what] of TARGET_TABLES) {
    const wanted = graph.nodes
      .filter((n) => n.kind === kind)
      .map((n) => n.targetId ?? "")
      .filter(Boolean);
    if (!wanted.length) continue;
    if (kind === "sub_workflow" && wanted.includes(selfId)) {
      return "A workflow cannot run itself";
    }
    const { data: rows } = await supabaseAdmin
      .from(table)
      .select("id")
      .eq("user_id", userId)
      .in("id", wanted);
    const found = new Set((rows ?? []).map((r) => String(r.id)));
    if (wanted.some((id) => !found.has(id))) {
      return `One step points at a ${what} that is gone, or is not yours.`;
    }
  }
  const names = graph.nodes.filter((n) => n.kind === "sql_models").flatMap((n) => n.models ?? []);
  if (names.length) {
    const { data: rows } = await supabaseAdmin
      .from("sql_models")
      .select("name")
      .eq("user_id", userId)
      .in("name", names);
    const found = new Set((rows ?? []).map((r) => String(r.name)));
    const lost = names.find((n) => !found.has(n));
    if (lost) return `No SQL model named "${lost}" — a workflow can only build models you own.`;
  }
  return null;
}

export const workflowCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; id: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: row, error } = await supabaseAdmin
      .from("workflows")
      .insert({ user_id: userId, name: data.name })
      .select("id")
      .single();
    if (error || !row) {
      return {
        ok: false,
        error:
          error?.code === "23505"
            ? "You already have a workflow with that name"
            : (error?.message ?? "Could not create the workflow"),
      };
    }
    return { ok: true, id: String(row.id) };
  });

export const workflowDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { error } = await supabaseAdmin
      .from("workflows")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const workflowRunNow = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        params: z.record(z.string(), z.string()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; runId: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: row } = await supabaseAdmin
      .from("workflows")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return { ok: false, error: "Workflow not found" };
    const { startWorkflowRun } = await import("@/utils/workflows/run.server");
    const res = await startWorkflowRun(
      row as unknown as import("@/utils/workflows/run.server").WorkflowRow,
      "manual",
      { params: data.params ?? {} },
    );
    return res.ok ? { ok: true, runId: res.runId } : res;
  });

export const workflowRerun = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        runId: z.string().uuid(),
        fromFailed: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; runId: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const { rerunWorkflowRun } = await import("@/utils/workflows/run.server");
    return rerunWorkflowRun(userId, data.runId, { fromFailed: data.fromFailed });
  });

/**
 * Mint a bearer for POST /api/workflows/run.
 *
 * Returned once and never stored in plaintext, exactly as an ETL pipeline's
 * trigger token is. Rotating replaces the old one immediately.
 */
export const workflowRotateToken = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; token: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const { mintTriggerToken } = await import("@/utils/workflows/adapters.server");
    const { token, hash } = mintTriggerToken();
    const { data: won, error } = await supabaseAdmin
      .from("workflows")
      .update({ trigger_token_hash: hash })
      .eq("id", data.id)
      .eq("user_id", userId)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (!won?.length) return { ok: false, error: "Workflow not found" };
    // The token itself is never audited, only the fact that one was minted.
    auditEvent({
      userId,
      action: "workflow.trigger_token.rotate",
      resourceType: "workflow",
      resourceId: data.id,
    });
    return { ok: true, token };
  });

export const workflowRevokeToken = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: won, error } = await supabaseAdmin
      .from("workflows")
      .update({ trigger_token_hash: null })
      .eq("id", data.id)
      .eq("user_id", userId)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (won?.length) {
      auditEvent({
        userId,
        action: "workflow.trigger_token.revoke",
        resourceType: "workflow",
        resourceId: data.id,
      });
    }
    return { ok: true };
  });

export const workflowRunsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        workflowId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; runs: WorkflowRunDto[] }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: rows, error } = await supabaseAdmin
      .from("workflow_runs")
      .select("id, workflow_id, state, trigger, error, params, started_at, finished_at")
      .eq("workflow_id", data.workflowId)
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(data.limit ?? 20);
    if (error) return { ok: false, error: error.message };
    return { ok: true, runs: (rows ?? []) as WorkflowRunDto[] };
  });

/**
 * One run's steps.
 *
 * Nudges the run along first when it is still live, without waiting for it: a
 * step may be a model build that resolves only when the whole build is done,
 * and a poll that hangs for that long is worse than one that reports
 * last-known state and comes back in a few seconds.
 */
export const workflowRunGet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), runId: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; run: WorkflowRunDto; nodes: WorkflowNodeRunDto[] }> => {
      const userId = await resolveCaller(data.accessToken);
      const { data: pre } = await supabaseAdmin
        .from("workflow_runs")
        .select("state")
        .eq("id", data.runId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!pre) return { ok: false, error: "Run not found" };
      if (pre.state === "running") {
        const { advanceWorkflowRun } = await import("@/utils/workflows/run.server");
        void advanceWorkflowRun(data.runId).catch(() => {});
      }
      const { data: run } = await supabaseAdmin
        .from("workflow_runs")
        .select("id, workflow_id, state, trigger, error, params, started_at, finished_at")
        .eq("id", data.runId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!run) return { ok: false, error: "Run not found" };
      const { data: nodes } = await supabaseAdmin
        .from("workflow_node_runs")
        .select(
          "id, node_id, kind, label, state, target_run_id, error, attempt, branch, output, started_at, finished_at",
        )
        .eq("run_id", data.runId)
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      return {
        ok: true,
        run: run as WorkflowRunDto,
        nodes: (nodes ?? []) as WorkflowNodeRunDto[],
      };
    },
  );

export const workflowRunCancel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), runId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { cancelWorkflowRun } = await import("@/utils/workflows/run.server");
    return cancelWorkflowRun(userId, data.runId);
  });

export type WorkflowCandidates = {
  pipelines: { id: string; name: string }[];
  mlSchedules: { id: string; name: string; kind: string }[];
  notebooks: { id: string; title: string }[];
  swarms: { id: string; name: string }[];
  prepFlows: { id: string; name: string }[];
  dashboards: { id: string; name: string }[];
  monitors: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
  models: string[];
  /** Secret NAMES only. A value is never sent to the browser. */
  secrets: string[];
};

/** Everything the caller owns that a step could point at. */
export const workflowCandidates = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ accessToken: z.string().min(1), exclude: z.string().uuid().optional() })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | ({ ok: true } & WorkflowCandidates)> => {
    const userId = await resolveCaller(data.accessToken);
    const [
      pipes,
      schedules,
      notebooks,
      swarms,
      flows,
      dashboards,
      monitors,
      workflows,
      models,
      secrets,
    ] = await Promise.all([
      supabaseAdmin.from("etl_pipelines").select("id, name").eq("user_id", userId).order("name"),
      supabaseAdmin
        .from("ml_schedules")
        .select("id, name, kind")
        .eq("user_id", userId)
        .order("name"),
      supabaseAdmin
        .from("user_python_notebooks")
        .select("id, title")
        .eq("user_id", userId)
        .order("title"),
      supabaseAdmin.from("swarms").select("id, name").eq("user_id", userId).order("name"),
      supabaseAdmin.from("user_prep_flows").select("id, name").eq("user_id", userId).order("name"),
      supabaseAdmin.from("bi_dashboards").select("id, name").eq("user_id", userId).order("name"),
      supabaseAdmin.from("data_monitors").select("id, name").eq("user_id", userId).order("name"),
      supabaseAdmin.from("workflows").select("id, name").eq("user_id", userId).order("name"),
      supabaseAdmin
        .from("sql_models")
        .select("name")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("name"),
      // Names, so a header can point at one without anybody typing the
      // `{{secret:NAME}}` spelling. The value column is not selected here
      // and is resolved server-side at run time.
      supabaseAdmin.from("user_secrets").select("name").eq("user_id", userId).order("name"),
    ]);
    const named = (rows: { id: unknown; name: unknown }[] | null) =>
      (rows ?? []).map((r) => ({ id: String(r.id), name: String(r.name) }));
    return {
      ok: true,
      pipelines: named(pipes.data),
      mlSchedules: (schedules.data ?? []).map((s) => ({
        id: String(s.id),
        name: String(s.name),
        kind: String(s.kind),
      })),
      notebooks: (notebooks.data ?? []).map((n) => ({ id: String(n.id), title: String(n.title) })),
      swarms: named(swarms.data),
      prepFlows: named(flows.data),
      dashboards: named(dashboards.data),
      monitors: named(monitors.data),
      // A workflow cannot run itself, so it is not offered as its own child.
      workflows: named(workflows.data).filter((w) => w.id !== data.exclude),
      models: (models.data ?? []).map((m) => String(m.name)),
      secrets: (secrets.data ?? []).map((r) => String(r.name)),
    };
  });
