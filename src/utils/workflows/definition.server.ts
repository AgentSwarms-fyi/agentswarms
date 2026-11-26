// Writing a workflow's definition: ONE path for every way a definition arrives.
//
// The editor's Save, "Update from repo", an import from the repository and a
// CI job that deploys a commit all end here (R541). A second path for the
// repository would be a second set of rules, and the weaker set would be the
// one an attacker used: a file in a repo is text anybody with push access can
// write, so it must meet every check a save from the editor meets — the graph
// validates, the cron parses, and every step still points at something its
// owner owns.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { validateCron } from "@/lib/cron";
import {
  definitionFromFile,
  fileTargetNames,
  stepTarget,
  withTargetId,
  type StepTarget,
  type TargetHint,
  type TargetKind,
  type WorkflowDefinition,
  type WorkflowFile,
} from "@/lib/workflowFile";
import { validateWorkflow, type WorkflowGraph, type WorkflowNode } from "@/lib/workflows";

type Fail = { ok: false; error: string };

export type ApplyOptions =
  | { expectedUpdatedAt: string; overwrite?: undefined }
  | { overwrite: true; expectedUpdatedAt?: undefined };

/** The definition a stored workflow row holds. */
export function definitionOfRow(row: Record<string, unknown>): WorkflowDefinition {
  const graph = (row.graph ?? {}) as Partial<WorkflowGraph>;
  const params = Array.isArray(row.params) ? (row.params as WorkflowGraph["params"]) : [];
  return {
    name: String(row.name ?? ""),
    description: (row.description as string | null) ?? null,
    schedule: (row.schedule as WorkflowDefinition["schedule"]) ?? "manual",
    cronExpr: (row.cron_expr as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    overlap: (row.overlap as WorkflowDefinition["overlap"]) ?? "skip",
    notifyOn: (row.notify_on as WorkflowDefinition["notifyOn"]) ?? "failure",
    timeoutMinutes: Number(row.timeout_minutes ?? 240),
    graph: {
      nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
      edges: Array.isArray(graph.edges) ? graph.edges : [],
      params: params?.length ? params : (graph.params ?? []),
    },
  };
}

/**
 * Save a definition over workflow `id`, owned by `userId`.
 *
 * `expectedUpdatedAt` lands the write only on the version the caller read
 * (the editor); `overwrite` is for a source that is the authority (a pull
 * the person confirmed, a CI deploy). `isActive` is left alone unless given:
 * whether a pipeline is switched on is not part of its definition.
 */
export async function applyWorkflowDefinition(
  userId: string,
  id: string,
  def: WorkflowDefinition,
  opts: ApplyOptions,
  isActive?: boolean,
): Promise<(Fail & { stale?: boolean }) | { ok: true; updatedAt: string }> {
  const graph: WorkflowGraph = {
    nodes: def.graph.nodes,
    edges: def.graph.edges,
    params: def.graph.params ?? [],
  };
  const invalid = await validateDefinition(userId, def, id);
  if (invalid) return { ok: false, error: invalid };

  const { nextWorkflowRunAt } = await import("@/utils/workflows/run.server");
  const reclock = await scheduleDiffers(id, def);
  let q = supabaseAdmin
    .from("workflows")
    .update({
      name: def.name,
      description: def.description ?? null,
      graph: graph as unknown as Json,
      schedule: def.schedule,
      cron_expr: def.schedule === "cron" ? (def.cronExpr ?? null) : null,
      timezone: def.timezone ?? null,
      overlap: def.overlap,
      notify_on: def.notifyOn,
      timeout_minutes: def.timeoutMinutes,
      params: (graph.params ?? []) as unknown as Json,
      ...(isActive !== undefined ? { is_active: isActive } : {}),
      // A schedule that changed needs a new clock; one that did not is left
      // alone so saving a label does not postpone tonight's run.
      ...(reclock
        ? {
            next_run_at:
              def.schedule === "manual"
                ? null
                : nextWorkflowRunAt(def.schedule, new Date(), def.cronExpr, def.timezone),
          }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId);
  if (opts.expectedUpdatedAt) q = q.eq("updated_at", opts.expectedUpdatedAt);
  const { data: row, error } = await q.select("id, updated_at").maybeSingle();
  if (error) {
    return {
      ok: false,
      error: error.code === "23505" ? "You already have a workflow with that name" : error.message,
    };
  }
  if (!row) {
    // Nothing matched: the workflow is gone, or it moved on since this page
    // read it. Only the second is a stale save.
    if (opts.expectedUpdatedAt) {
      const { data: still, error: stillError } = await supabaseAdmin
        .from("workflows")
        .select("id")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (stillError) return { ok: false, error: stillError.message };
      if (still) {
        return {
          ok: false,
          stale: true,
          error: "This workflow was changed in another tab or session after this page read it",
        };
      }
    }
    return { ok: false, error: "Workflow not found" };
  }
  return { ok: true, updatedAt: String(row.updated_at) };
}

/**
 * Every rule a definition must meet before it is written, as the refusal a
 * person can act on, or null. `selfId` is the workflow it would be written
 * over (null for one not created yet).
 */
export async function validateDefinition(
  userId: string,
  def: WorkflowDefinition,
  selfId: string | null,
): Promise<string | null> {
  const graph: WorkflowGraph = {
    nodes: def.graph.nodes,
    edges: def.graph.edges,
    params: def.graph.params ?? [],
  };
  const invalid = validateWorkflow({ name: def.name, graph });
  if (invalid) return invalid;
  if (def.schedule === "cron") {
    if (!def.cronExpr?.trim()) return "A cron schedule needs an expression";
    try {
      validateCron(def.cronExpr, def.timezone ?? undefined);
    } catch (e) {
      return (e as Error).message;
    }
  }
  // Every target must still be the caller's own. Checked at SAVE as well as
  // at run, because "it silently stopped running that pipeline" is a much
  // worse discovery than a refusal at the moment you press Save.
  return missingTargets(userId, graph, selfId ?? "");
}

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
  ["ml_promote", "ml_models", "model"],
  ["ml_deploy", "ml_models", "model"],
  ["notebook", "user_python_notebooks", "notebook"],
  ["swarm", "swarms", "swarm"],
  ["prep_flow", "user_prep_flows", "prep flow"],
  ["dashboard_refresh", "bi_dashboards", "dashboard"],
  ["data_monitor", "data_monitors", "data monitor"],
  ["sub_workflow", "workflows", "workflow"],
] as const;

/** Names the first target that is gone, so the refusal is actionable. */
export async function missingTargets(
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
  // A Kubeflow step runs with its owner's own connection, and its token
  // goes with every call (R540).
  const connections = graph.nodes
    .filter((n) => n.kind === "kubeflow_run")
    .map((n) => n.kubeflow?.integrationId ?? "")
    .filter(Boolean);
  if (connections.length) {
    const { data: rows } = await supabaseAdmin
      .from("integrations")
      .select("id")
      .eq("user_id", userId)
      .eq("type", "kubeflow")
      .in("id", connections);
    const found = new Set((rows ?? []).map((r) => String(r.id)));
    if (connections.some((id) => !found.has(id))) {
      return "One Kubeflow step uses a connection that is gone, or is not yours.";
    }
  }
  return null;
}

// ── Names, so a file can find its targets in another workspace ──────────

type NamedRow = { id: string; name: string; model?: string };

const TARGET_WORD: Record<TargetKind, string> = {
  pipeline: "ETL pipeline",
  ml_schedule: "ML schedule",
  ml_promote: "model",
  ml_deploy: "model",
  notebook: "notebook",
  swarm: "swarm",
  prep_flow: "prep flow",
  dashboard_refresh: "dashboard",
  data_monitor: "data monitor",
  sub_workflow: "workflow",
  kubeflow_connection: "Kubeflow connection",
};

/** The caller's own rows of one target kind, by id or by name. */
async function ownTargets(
  userId: string,
  kind: TargetKind,
  by: { ids?: string[]; names?: string[] },
): Promise<NamedRow[]> {
  const ids = by.ids?.filter(Boolean) ?? [];
  const names = by.names?.filter(Boolean) ?? [];
  if (!ids.length && !names.length) return [];
  switch (kind) {
    case "ml_schedule": {
      const base = supabaseAdmin
        .from("ml_schedules")
        .select("id, name, model_id")
        .eq("user_id", userId);
      const { data } = await (ids.length ? base.in("id", ids) : base.in("name", names));
      const modelIds = [...new Set((data ?? []).map((r) => String(r.model_id)))];
      const { data: models } = modelIds.length
        ? await supabaseAdmin
            .from("ml_models")
            .select("id, name")
            .eq("user_id", userId)
            .in("id", modelIds)
        : { data: [] as { id: string; name: string }[] };
      const modelName = new Map((models ?? []).map((m) => [String(m.id), String(m.name)]));
      return (data ?? []).map((r) => ({
        id: String(r.id),
        name: String(r.name),
        model: modelName.get(String(r.model_id)),
      }));
    }
    case "notebook": {
      const base = supabaseAdmin
        .from("user_python_notebooks")
        .select("id, title")
        .eq("user_id", userId);
      const { data } = await (ids.length ? base.in("id", ids) : base.in("title", names));
      return (data ?? []).map((r) => ({ id: String(r.id), name: String(r.title) }));
    }
    case "kubeflow_connection": {
      const base = supabaseAdmin
        .from("integrations")
        .select("id, name")
        .eq("user_id", userId)
        .eq("type", "kubeflow");
      const { data } = await (ids.length ? base.in("id", ids) : base.in("name", names));
      return (data ?? []).map((r) => ({ id: String(r.id), name: String(r.name) }));
    }
    default: {
      const table = TARGET_TABLES.find(([k]) => k === kind)?.[1];
      if (!table || table === "user_python_notebooks" || table === "ml_schedules") return [];
      const base = supabaseAdmin.from(table).select("id, name").eq("user_id", userId);
      const { data } = await (ids.length ? base.in("id", ids) : base.in("name", names));
      return ((data ?? []) as unknown as { id: unknown; name: unknown }[]).map((r) => ({
        id: String(r.id),
        name: String(r.name),
      }));
    }
  }
}

function groupTargets(
  nodes: WorkflowNode[],
): Map<TargetKind, { node: WorkflowNode; t: StepTarget }[]> {
  const out = new Map<TargetKind, { node: WorkflowNode; t: StepTarget }[]>();
  for (const node of nodes) {
    const t = stepTarget(node);
    if (!t) continue;
    const list = out.get(t.kind) ?? [];
    list.push({ node, t });
    out.set(t.kind, list);
  }
  return out;
}

/** What each step points at is called, by step id, for writing a file. */
export async function targetNamesFor(
  userId: string,
  graph: WorkflowGraph,
): Promise<Record<string, TargetHint>> {
  const out: Record<string, TargetHint> = {};
  for (const [kind, steps] of groupTargets(graph.nodes)) {
    const rows = await ownTargets(userId, kind, { ids: steps.map((s) => s.t.id) });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const { node, t } of steps) {
      const row = byId.get(t.id);
      if (row) out[node.id] = { name: row.name, ...(row.model ? { model: row.model } : {}) };
    }
  }
  return out;
}

/**
 * The definition in a file, with every target made the reader's own: kept
 * when the id is one of theirs, otherwise found by the name the file gives.
 * Refuses, naming the step, when a name finds nothing or more than one.
 */
export async function resolveFileTargets(
  userId: string,
  file: WorkflowFile,
): Promise<Fail | { ok: true; def: WorkflowDefinition; renamed: number }> {
  const def = definitionFromFile(file);
  const hints = fileTargetNames(file);
  const replaced = new Map<string, WorkflowNode>();
  for (const [kind, steps] of groupTargets(def.graph.nodes)) {
    const owned = new Set(
      (await ownTargets(userId, kind, { ids: steps.map((s) => s.t.id) })).map((r) => r.id),
    );
    const lost = steps.filter((s) => !owned.has(s.t.id));
    if (!lost.length) continue;
    const named = await ownTargets(userId, kind, {
      names: [...new Set(lost.map((s) => hints[s.node.id]?.name ?? ""))],
    });
    for (const { node } of lost) {
      const hint = hints[node.id];
      const step = node.label?.trim() || node.kind;
      if (!hint) {
        return {
          ok: false,
          error: `The step "${step}" points at a ${TARGET_WORD[kind]} that is not yours, and the file does not say its name`,
        };
      }
      const matches = named.filter(
        (r) => r.name === hint.name && (!hint.model || r.model === hint.model),
      );
      const what = hint.model ? `"${hint.name}" of the model "${hint.model}"` : `"${hint.name}"`;
      if (matches.length === 0) {
        return {
          ok: false,
          error: `The step "${step}" needs the ${TARGET_WORD[kind]} ${what}, and you have none by that name`,
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: `The step "${step}" needs the ${TARGET_WORD[kind]} ${what}, and you have ${matches.length} by that name — rename one`,
        };
      }
      replaced.set(node.id, withTargetId(node, matches[0].id));
    }
  }
  return {
    ok: true,
    renamed: replaced.size,
    def: {
      ...def,
      graph: { ...def.graph, nodes: def.graph.nodes.map((n) => replaced.get(n.id) ?? n) },
    },
  };
}
