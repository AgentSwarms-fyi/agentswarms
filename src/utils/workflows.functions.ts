// Server functions behind Data engineering → Workflows.
//
// A workflow can start an ETL pipeline, build SQL models, retrain a model, run
// a notebook, run a swarm, call an API and ask a person a question — so every
// one of these re-resolves the caller and scopes by user_id. A graph that
// could start work its author cannot see would be a way around every grant the
// platform has. `workflowCandidates` exists for the same reason: the editor is
// only ever offered the caller's own things to wire up.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";
import { auditEvent } from "@/utils/audit.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { trashErrorText } from "@/lib/trash";
import { workflowChangedSinceRun } from "@/lib/workflowDrift";
import { MAX_NODES, WORKFLOW_NAME_MAX, type WorkflowNode } from "@/lib/workflows";
import { callerFailure } from "@/utils/callerLookup.server";
import { unversionedSave } from "@/lib/saveVersion";
import { WORKFLOW_NODE_SCHEMA } from "@/lib/workflowFile";
import { applyWorkflowDefinition } from "@/utils/workflows/definition.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Not signed in"));
  return data.user.id;
}

/**
 * A client that acts as the caller. Moving a workflow to the trash goes
 * through it, never the service role: trash_object reads auth.uid() and moves
 * only what that person owns.
 */
function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(
    url,
    key,
    withNulSafeFetch({
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
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
  /**
   * Whether the graph changed since the run behind `last_run_status` (R184);
   * null when there is no run to compare with. Set by the list only.
   */
  changed_since_last_run: boolean | null;
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
    changed_since_last_run: null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export const workflowsList = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<Fail | { ok: true; workflows: WorkflowRowDto[] }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: rows, error } = await supabaseAdmin
      .from("workflows")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    const workflows = (rows ?? []).map(toRow);
    // FOUND IN R184: the status beside a workflow outlived the graph it
    // vouched for. The run behind it is the latest one started: the run
    // writes "running" when it starts and its outcome when it ends.
    const drift = await Promise.all(
      workflows.map(async (w) => {
        if (!w.last_run_status) return null;
        const { data: run, error: runErr } = await supabaseAdmin
          .from("workflow_runs")
          .select("graph")
          .eq("workflow_id", w.id)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return runErr || !run ? null : workflowChangedSinceRun(w.graph, run.graph);
      }),
    );
    return {
      ok: true,
      workflows: workflows.map((w, i) => ({ ...w, changed_since_last_run: drift[i] })),
    };
  });

export const workflowGet = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
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

const NODE = WORKFLOW_NODE_SCHEMA;

export const workflowSave = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        // The updated_at this page read or last saved. Only a save sets it
        // (runs and the scheduler write other columns, and no trigger moves
        // it), so it is the version: the update lands only on it (R289).
        // "Overwrite with mine" sends `overwrite` instead; a save with neither
        // is refused (R303).
        expectedUpdatedAt: z.string().min(1).optional(),
        overwrite: z.literal(true).optional(),
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
  .handler(
    async ({ data }): Promise<(Fail & { stale?: boolean }) | { ok: true; updatedAt: string }> => {
      const userId = await resolveCaller(data.accessToken);
      const refused = unversionedSave("workflow", {
        version: data.expectedUpdatedAt,
        overwrite: data.overwrite,
      });
      if (refused) return { ok: false, error: refused };
      return applyWorkflowDefinition(
        userId,
        data.id,
        {
          name: data.name,
          description: data.description ?? null,
          schedule: data.schedule,
          cronExpr: data.cronExpr ?? null,
          timezone: data.timezone ?? null,
          overlap: data.overlap,
          notifyOn: data.notifyOn,
          timeoutMinutes: data.timeoutMinutes,
          graph: {
            nodes: data.nodes as WorkflowNode[],
            edges: data.edges,
            params: data.params,
          },
        },
        data.overwrite
          ? { overwrite: true }
          : { expectedUpdatedAt: data.expectedUpdatedAt as string },
        data.isActive,
      );
    },
  );

export const workflowCreate = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; trashId: string }> => {
    await resolveCaller(data.accessToken);
    const { data: trashId, error } = await userClient(data.accessToken).rpc("trash_object", {
      p_kind: "workflow",
      p_id: data.id,
    });
    if (error || typeof trashId !== "string") {
      return { ok: false, error: trashErrorText(error, "move") };
    }
    return { ok: true, trashId };
  });

export const workflowRunNow = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
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
  .validator((input: unknown) =>
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
