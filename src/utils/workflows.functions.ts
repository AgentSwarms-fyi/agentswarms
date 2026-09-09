// Server functions behind Data & BI → Workflows.
//
// A workflow can start an ETL pipeline, build SQL models, retrain a model and
// run a notebook, so every one of these re-resolves the caller and scopes by
// user_id — a graph that could start work its author cannot see would be a way
// around every grant the platform has. `candidates` exists for the same
// reason: the editor is only ever offered the caller's own things to wire up.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  MAX_NODES,
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
 * it back on arrival.
 */
export type WorkflowRowDto = {
  id: string;
  name: string;
  description: string | null;
  graph: Json;
  schedule: string;
  next_run_at: string | null;
  is_active: boolean;
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
    next_run_at: (row.next_run_at as string | null) ?? null,
    is_active: Boolean(row.is_active),
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
  kind: z.enum(["pipeline", "sql_models", "ml_schedule", "notebook"]),
  label: z.string().max(200),
  targetId: z.string().optional(),
  models: z.array(z.string()).optional(),
  continueOnFailure: z.boolean().optional(),
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
        schedule: z.enum(["manual", "hourly", "daily", "weekly"]),
        isActive: z.boolean(),
        nodes: z.array(NODE).max(MAX_NODES),
        edges: z.array(z.object({ from: z.string(), to: z.string() })).max(MAX_NODES * 4),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const graph: WorkflowGraph = {
      nodes: data.nodes as WorkflowNode[],
      edges: data.edges,
    };
    const invalid = validateWorkflow({ name: data.name, graph });
    if (invalid) return { ok: false, error: invalid };

    // Every target must still be the caller's own. Checked at SAVE as well as
    // at run, because "it silently stopped running that pipeline" is a much
    // worse discovery than a refusal at the moment you press Save.
    const missing = await missingTargets(userId, graph);
    if (missing) return { ok: false, error: missing };

    const { nextWorkflowRunAt } = await import("@/utils/workflows/run.server");
    const { error } = await supabaseAdmin
      .from("workflows")
      .update({
        name: data.name,
        description: data.description ?? null,
        graph: graph as unknown as Json,
        schedule: data.schedule,
        is_active: data.isActive,
        // A schedule that changed needs a new clock; one that did not is left
        // alone so saving a label does not postpone tonight's run.
        next_run_at: data.schedule === "manual" ? null : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    if (data.schedule !== "manual") {
      const { data: row } = await supabaseAdmin
        .from("workflows")
        .select("next_run_at")
        .eq("id", data.id)
        .maybeSingle();
      if (!row?.next_run_at) {
        await supabaseAdmin
          .from("workflows")
          .update({ next_run_at: nextWorkflowRunAt(data.schedule) })
          .eq("id", data.id)
          .eq("user_id", userId);
      }
    }
    return { ok: true };
  });

/** Names the first target that is gone, so the refusal is actionable. */
async function missingTargets(userId: string, graph: WorkflowGraph): Promise<string | null> {
  const ids = {
    pipeline: graph.nodes.filter((n) => n.kind === "pipeline").map((n) => n.targetId ?? ""),
    ml_schedule: graph.nodes.filter((n) => n.kind === "ml_schedule").map((n) => n.targetId ?? ""),
    notebook: graph.nodes.filter((n) => n.kind === "notebook").map((n) => n.targetId ?? ""),
  };
  const tables = {
    pipeline: "etl_pipelines",
    ml_schedule: "ml_schedules",
    notebook: "user_python_notebooks",
  } as const;
  const what = {
    pipeline: "pipeline",
    ml_schedule: "ML schedule",
    notebook: "notebook",
  } as const;
  for (const kind of ["pipeline", "ml_schedule", "notebook"] as const) {
    const wanted = ids[kind].filter(Boolean);
    if (!wanted.length) continue;
    const { data: rows } = await supabaseAdmin
      .from(tables[kind])
      .select("id")
      .eq("user_id", userId)
      .in("id", wanted);
    const found = new Set((rows ?? []).map((r) => String(r.id)));
    const lost = wanted.find((id) => !found.has(id));
    if (lost) return `One step points at a ${what[kind]} that is gone, or is not yours.`;
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
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
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
    );
    return res.ok ? { ok: true, runId: res.runId } : res;
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
      .select("id, workflow_id, state, trigger, error, started_at, finished_at")
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
 * Advances the run first when it is still live, so opening the page shows the
 * truth rather than whatever the last sweep left. That also means a manual
 * run visibly moves while somebody watches it, instead of appearing frozen
 * for up to a minute.
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
        // Fired, not awaited: a step may be a SQL model build that resolves
        // only when the whole build is done, and a poll that hangs for that
        // long is worse than a poll that reports last-known state and comes
        // back in a few seconds.
        const { advanceWorkflowRun } = await import("@/utils/workflows/run.server");
        void advanceWorkflowRun(data.runId).catch(() => {});
      }
      const { data: run } = await supabaseAdmin
        .from("workflow_runs")
        .select("id, workflow_id, state, trigger, error, started_at, finished_at")
        .eq("id", data.runId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!run) return { ok: false, error: "Run not found" };
      const { data: nodes } = await supabaseAdmin
        .from("workflow_node_runs")
        .select("id, node_id, kind, label, state, target_run_id, error, started_at, finished_at")
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
  models: string[];
};

/** Everything the caller owns that a step could point at. */
export const workflowCandidates = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<Fail | ({ ok: true } & WorkflowCandidates)> => {
    const userId = await resolveCaller(data.accessToken);
    const [pipes, schedules, notebooks, models] = await Promise.all([
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
      supabaseAdmin
        .from("sql_models")
        .select("name")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("name"),
    ]);
    return {
      ok: true,
      pipelines: (pipes.data ?? []).map((p) => ({ id: String(p.id), name: String(p.name) })),
      mlSchedules: (schedules.data ?? []).map((s) => ({
        id: String(s.id),
        name: String(s.name),
        kind: String(s.kind),
      })),
      notebooks: (notebooks.data ?? []).map((n) => ({
        id: String(n.id),
        title: String(n.title),
      })),
      models: (models.data ?? []).map((m) => String(m.name)),
    };
  });
