// RPC surface for ETL pipelines (the /etl page).
//
// Reads run under the caller's own JWT so RLS decides visibility; writes that
// must not be forgeable (runs, trigger tokens) go through the service role
// after the caller has been resolved. Compilation of visual graphs happens
// here on save — `source_code` is always the executable truth, so the
// executor, the Runs tab and the AI refine prompt never care which mode
// authored the pipeline.
import { createHash, randomBytes } from "node:crypto";

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import {
  compilePreview,
  compileGraph,
  normalizeGraph,
  requirementsFor,
  type EtlGraph,
} from "@/utils/etl/codegen";
import {
  cancelEtlRun,
  startEtlRun,
  type EtlPipelineRow,
  type EtlRunRow,
} from "@/utils/etl/service.server";
import { nextEtlRunAt } from "@/utils/etl/schedule.server";
import { validateCron } from "@/lib/cron";
import { computeEtlOverview, type OverviewRun } from "@/lib/etlOverview";

// ── Caller resolution (house pattern) ───────────────────────────────────────

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const GraphSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.string().min(1).max(16),
          kind: z.enum(["source", "transform", "target"]),
          label: z.string().max(80).optional(),
          config: z.record(z.string(), z.unknown()),
          position: z.object({ x: z.number(), y: z.number() }).optional(),
        })
        .passthrough(),
    ),
    edges: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() }).passthrough()),
  })
  .passthrough();

const UpsertSchema = z.object({
  access_token: z.string().min(1),
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  mode: z.enum(["visual", "code"]),
  source_code: z.string().max(200_000).optional(),
  graph: GraphSchema.optional(),
  requirements: z.string().max(10_000).optional(),
  secret_refs: z.string().max(10_000).optional(),
  dest_catalog_source_id: z.string().uuid().nullable().optional(),
  schedule: z.enum(["manual", "hourly", "daily", "weekly", "cron"]).optional(),
  cron_expr: z.string().max(120).nullable().optional(),
  timezone: z.string().max(60).nullable().optional(),
  retry_count: z.number().int().min(0).max(5).optional(),
  allow_concurrent: z.boolean().optional(),
  default_params: z.record(z.string(), z.unknown()).nullable().optional(),
  run_after: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  timeout_minutes: z.number().int().min(1).max(240).optional(),
});

export type EtlPipelineSummary = Pick<
  EtlPipelineRow,
  | "id"
  | "name"
  | "description"
  | "mode"
  | "schedule"
  | "is_active"
  | "next_run_at"
  | "last_run_at"
  | "last_run_status"
  | "dest_catalog_source_id"
  | "created_at"
  | "updated_at"
> & { has_trigger_token: boolean };

// ── List / read ─────────────────────────────────────────────────────────────

export const listEtlPipelines = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<{ pipelines: EtlPipelineSummary[] }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: rows, error } = await supabaseAdmin
      .from("etl_pipelines")
      .select(
        "id, name, description, mode, schedule, is_active, next_run_at, last_run_at, last_run_status, dest_catalog_source_id, created_at, updated_at, trigger_token_hash",
      )
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return {
      pipelines: (rows ?? []).map((r) => ({
        ...r,
        has_trigger_token: Boolean(r.trigger_token_hash),
        trigger_token_hash: undefined,
      })) as unknown as EtlPipelineSummary[],
    };
  });

export const getEtlPipeline = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ pipeline: Omit<EtlPipelineRow, "trigger_token_hash"> }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: row, error } = await supabaseAdmin
      .from("etl_pipelines")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Pipeline not found");
    const { trigger_token_hash: _drop, ...safe } = row;
    return { pipeline: safe };
  });

export type EtlRecentRun = {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  status: string;
  trigger: string;
  attempt: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  rows_loaded: number;
};

/**
 * Everything the ETL home dashboard shows, in one round trip: the pipelines,
 * a week of aggregate health, per-pipeline run pulses, and the most recent
 * runs across all pipelines. Aggregation is the pure computeEtlOverview so
 * the numbers are unit-tested, not component folklore.
 */
export const getEtlOverview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const userId = await resolveCaller(data.access_token);

    const [{ data: pipelines, error: pErr }, { data: runs, error: rErr }] = await Promise.all([
      supabaseAdmin
        .from("etl_pipelines")
        .select(
          "id, name, description, mode, schedule, cron_expr, timezone, is_active, next_run_at, last_run_at, last_run_status, dest_catalog_source_id, retry_count, run_after, created_at, updated_at",
        )
        .eq("user_id", userId)
        .order("updated_at", { ascending: false }),
      supabaseAdmin
        .from("etl_runs")
        .select(
          "id, pipeline_id, status, trigger, attempt, created_at, started_at, finished_at, metrics",
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(300),
    ]);
    if (pErr) throw new Error(pErr.message);
    if (rErr) throw new Error(rErr.message);

    const overview = computeEtlOverview((runs ?? []) as OverviewRun[]);
    const nameOf = new Map((pipelines ?? []).map((p) => [p.id, p.name]));
    const { rowsLoadedOf } = await import("@/lib/etlOverview");
    const recent_runs: EtlRecentRun[] = (runs ?? []).slice(0, 8).map((r) => ({
      id: r.id,
      pipeline_id: r.pipeline_id,
      pipeline_name: nameOf.get(r.pipeline_id) ?? "(deleted)",
      status: r.status,
      trigger: r.trigger,
      attempt: r.attempt,
      created_at: r.created_at,
      started_at: r.started_at,
      finished_at: r.finished_at,
      rows_loaded: rowsLoadedOf(r.metrics),
    }));

    return {
      pipelines: pipelines ?? [],
      stats: overview.stats,
      per_pipeline: overview.per_pipeline,
      recent_runs,
    };
  });

// ── Create / update ─────────────────────────────────────────────────────────

/**
 * Snapshot a pipeline's editable content into the version history. Skips
 * writing when nothing meaningful changed since the newest version, so a
 * settings-only save (schedule, retries) does not spam the history.
 */
async function snapshotEtlVersion(
  pipelineId: string,
  userId: string,
  content: {
    name: string;
    mode: string;
    graph: unknown;
    source_code: string;
    requirements: string;
  },
): Promise<void> {
  const { data: last } = await supabaseAdmin
    .from("etl_pipeline_versions")
    .select("version_no, graph, source_code, requirements, name, mode")
    .eq("pipeline_id", pipelineId)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  const same =
    last &&
    last.source_code === content.source_code &&
    last.requirements === content.requirements &&
    last.mode === content.mode &&
    JSON.stringify(last.graph ?? null) === JSON.stringify(content.graph ?? null);
  if (same) return;
  await supabaseAdmin.from("etl_pipeline_versions").insert({
    pipeline_id: pipelineId,
    user_id: userId,
    version_no: (last?.version_no ?? 0) + 1,
    name: content.name,
    mode: content.mode,
    graph: content.graph as never,
    source_code: content.source_code,
    requirements: content.requirements,
  });
  // History is a safety net, not an archive: keep the newest 50.
  const { data: old } = await supabaseAdmin
    .from("etl_pipeline_versions")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .order("version_no", { ascending: false })
    .range(50, 1000);
  if (old?.length) {
    await supabaseAdmin
      .from("etl_pipeline_versions")
      .delete()
      .in(
        "id",
        old.map((r) => r.id),
      );
  }
}

export const saveEtlPipeline = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => UpsertSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ id: string; source_code: string; compile_error: string | null }> => {
      const userId = await resolveCaller(data.access_token);

      // Visual pipelines compile on every save. A half-built canvas must still
      // be saveable — losing work to "join needs two inputs" would be hostile —
      // so a compile failure saves the graph with empty source_code (which the
      // run path refuses) and reports the error for the UI to show.
      let sourceCode = data.source_code ?? "";
      let requirements = data.requirements;
      let compileError: string | null = null;
      if (data.mode === "visual") {
        if (!data.graph) throw new Error("Visual pipeline needs a graph");
        const graph: EtlGraph = normalizeGraph(data.graph) ?? (data.graph as unknown as EtlGraph);
        try {
          sourceCode = compileGraph(graph);
        } catch (e) {
          sourceCode = "";
          compileError = (e as Error).message;
        }
        if (requirements === undefined) requirements = requirementsFor(graph);
      }

      // Cron expressions and timezones are validated at save, not at sweep
      // time — a typo should bounce off the Settings form, not silently stop
      // the schedule.
      if ((data.schedule ?? "manual") === "cron") {
        if (!data.cron_expr) throw new Error("A cron schedule needs an expression");
        validateCron(data.cron_expr, data.timezone ?? null);
      }

      // Chaining: run_after must be the caller's own pipeline, not this one,
      // and must not close a cycle — a loop of "after each other" would
      // ping-pong forever at runtime, so it is refused here where the message
      // can name the offending link.
      if (data.run_after) {
        if (data.id && data.run_after === data.id) {
          throw new Error("A pipeline cannot run after itself");
        }
        let cursor: string | null = data.run_after;
        for (let hops = 0; cursor && hops < 20; hops++) {
          const { data: up } = (await supabaseAdmin
            .from("etl_pipelines")
            .select("id, run_after, user_id")
            .eq("id", cursor)
            .maybeSingle()) as {
            data: { id: string; run_after: string | null; user_id: string } | null;
          };
          if (!up) throw new Error("The pipeline to run after was not found");
          if (up.user_id !== userId) throw new Error("The pipeline to run after was not found");
          if (data.id && up.run_after === data.id) {
            throw new Error("That chain would loop back to this pipeline");
          }
          cursor = up.run_after;
        }
      }

      const payload = {
        user_id: userId,
        name: data.name,
        description: data.description ?? null,
        mode: data.mode,
        source_code: sourceCode,
        graph: (data.mode === "visual" ? (data.graph ?? null) : null) as never,
        requirements: requirements ?? "",
        secret_refs: data.secret_refs ?? "",
        dest_catalog_source_id: data.dest_catalog_source_id ?? null,
        schedule: data.schedule ?? "manual",
        cron_expr: data.cron_expr ?? null,
        timezone: data.timezone ?? null,
        retry_count: data.retry_count ?? 0,
        allow_concurrent: data.allow_concurrent ?? false,
        default_params: (data.default_params ?? null) as never,
        run_after: data.run_after ?? null,
        is_active: data.is_active ?? true,
        timeout_minutes: data.timeout_minutes ?? 30,
      };

      if (data.id) {
        const { data: existing } = await supabaseAdmin
          .from("etl_pipelines")
          .select("id, schedule, cron_expr, timezone")
          .eq("id", data.id)
          .eq("user_id", userId)
          .maybeSingle();
        if (!existing) throw new Error("Pipeline not found");
        const clockChanged =
          payload.schedule !== existing.schedule ||
          payload.cron_expr !== existing.cron_expr ||
          payload.timezone !== existing.timezone;
        const { error } = await supabaseAdmin
          .from("etl_pipelines")
          .update({
            ...payload,
            // Re-arm the clock only when the schedule itself changed, so an
            // unrelated edit does not push a due run into the future.
            ...(clockChanged
              ? {
                  next_run_at: nextEtlRunAt(
                    payload.schedule,
                    new Date(),
                    payload.cron_expr,
                    payload.timezone,
                  ),
                }
              : {}),
          })
          .eq("id", data.id)
          .eq("user_id", userId);
        if (error) throw new Error(error.message);
        auditEvent({
          userId,
          action: "etl.pipeline.update",
          resourceType: "etl_pipeline",
          resourceId: data.id,
          resourceName: data.name,
        });
        await snapshotEtlVersion(data.id, userId, {
          name: payload.name,
          mode: payload.mode,
          graph: payload.graph,
          source_code: payload.source_code,
          requirements: payload.requirements,
        });
        return { id: data.id, source_code: sourceCode, compile_error: compileError };
      }

      const { data: created, error } = await supabaseAdmin
        .from("etl_pipelines")
        .insert({
          ...payload,
          next_run_at: nextEtlRunAt(
            payload.schedule,
            new Date(),
            payload.cron_expr,
            payload.timezone,
          ),
        })
        .select("id")
        .single();
      if (error || !created) throw new Error(error?.message ?? "Failed to create pipeline");
      auditEvent({
        userId,
        action: "etl.pipeline.create",
        resourceType: "etl_pipeline",
        resourceId: created.id,
        resourceName: data.name,
      });
      await snapshotEtlVersion(created.id, userId, {
        name: payload.name,
        mode: payload.mode,
        graph: payload.graph,
        source_code: payload.source_code,
        requirements: payload.requirements,
      });
      return { id: created.id, source_code: sourceCode, compile_error: compileError };
    },
  );

export const deleteEtlPipeline = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: row } = await supabaseAdmin
      .from("etl_pipelines")
      .select("id, name")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return { ok: false };
    const { error } = await supabaseAdmin.from("etl_pipelines").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    auditEvent({
      userId,
      action: "etl.pipeline.delete",
      resourceType: "etl_pipeline",
      resourceId: data.id,
      resourceName: row.name,
    });
    return { ok: true };
  });

// ── Runs ────────────────────────────────────────────────────────────────────

export const runEtlPipeline = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; runId?: string; error?: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: pipeline } = await supabaseAdmin
      .from("etl_pipelines")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!pipeline) return { ok: false, error: "Pipeline not found" };
    const res = await startEtlRun(pipeline, "manual", data.params);
    return res.ok ? { ok: true, runId: res.runId } : { ok: false, error: res.error };
  });

export const cancelEtlRunFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), run_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const userId = await resolveCaller(data.access_token);
    return { ok: await cancelEtlRun(data.run_id, userId) };
  });

export type EtlRunSummary = Pick<
  EtlRunRow,
  | "id"
  | "status"
  | "trigger"
  | "started_at"
  | "finished_at"
  | "created_at"
  | "error"
  | "metrics"
  | "attempt"
  | "retries_remaining"
  | "retry_at"
  | "params"
>;

export const listEtlRuns = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        pipeline_id: z.string().uuid(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ runs: EtlRunSummary[] }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: rows, error } = await supabaseAdmin
      .from("etl_runs")
      .select(
        "id, status, trigger, started_at, finished_at, created_at, error, metrics, attempt, retries_remaining, retry_at, params",
      )
      .eq("pipeline_id", data.pipeline_id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 30);
    if (error) throw new Error(error.message);
    return { runs: rows ?? [] };
  });

export const getEtlRunLogs = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), run_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ logs: string; error: string | null; status: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: run } = await supabaseAdmin
      .from("etl_runs")
      .select("logs, error, status")
      .eq("id", data.run_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!run) throw new Error("Run not found");
    return { logs: run.logs ?? "", error: run.error, status: run.status };
  });

// ── External trigger token ──────────────────────────────────────────────────

/**
 * Mint (or rotate) the webhook trigger token. Shown once; only the SHA-256
 * lands in the row — the notebook API key rule, for the same reason.
 */
export const rotateEtlTriggerToken = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ token: string }> => {
    const userId = await resolveCaller(data.access_token);
    const token = `etl_${randomBytes(24).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const { data: updated, error } = await supabaseAdmin
      .from("etl_pipelines")
      .update({ trigger_token_hash: hash })
      .eq("id", data.id)
      .eq("user_id", userId)
      .select("id, name")
      .maybeSingle();
    if (error || !updated) throw new Error(error?.message ?? "Pipeline not found");
    auditEvent({
      userId,
      action: "etl.trigger_token.rotate",
      resourceType: "etl_pipeline",
      resourceId: data.id,
      resourceName: updated.name,
    });
    return { token };
  });

export type EtlVersionSummary = {
  version_no: number;
  name: string;
  mode: string;
  created_at: string;
};

export const listEtlVersions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), pipeline_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ versions: EtlVersionSummary[] }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: rows, error } = await supabaseAdmin
      .from("etl_pipeline_versions")
      .select("version_no, name, mode, created_at")
      .eq("pipeline_id", data.pipeline_id)
      .eq("user_id", userId)
      .order("version_no", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { versions: rows ?? [] };
  });

export const restoreEtlVersion = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        pipeline_id: z.string().uuid(),
        version_no: z.number().int().positive(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: v } = await supabaseAdmin
      .from("etl_pipeline_versions")
      .select("name, mode, graph, source_code, requirements")
      .eq("pipeline_id", data.pipeline_id)
      .eq("user_id", userId)
      .eq("version_no", data.version_no)
      .maybeSingle();
    if (!v) throw new Error("Version not found");
    const { error } = await supabaseAdmin
      .from("etl_pipelines")
      .update({
        name: v.name,
        mode: v.mode,
        graph: v.graph as never,
        source_code: v.source_code,
        requirements: v.requirements,
      })
      .eq("id", data.pipeline_id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    // The restore itself becomes the newest version — history moves only
    // forward, and "restore then regret" has its own undo.
    await snapshotEtlVersion(data.pipeline_id, userId, {
      name: v.name,
      mode: v.mode,
      graph: v.graph,
      source_code: v.source_code,
      requirements: v.requirements,
    });
    auditEvent({
      userId,
      action: "etl.pipeline.restore_version",
      resourceType: "etl_pipeline",
      resourceId: data.pipeline_id,
      resourceName: `${v.name} v${data.version_no}`,
    });
    return { ok: true };
  });

export type EtlPreviewCell = string | number | boolean | null;

export type EtlPreviewResult = {
  status: string;
  preview: {
    columns: { name: string; type: string }[];
    rows: Record<string, EtlPreviewCell>[];
    total_sampled: number;
  } | null;
  error: string | null;
};

/** Flatten preview cells to primitives — nested values render as JSON text. */
function previewCell(v: unknown): EtlPreviewCell {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
    return v as EtlPreviewCell;
  }
  return JSON.stringify(v);
}

export const previewEtlNode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        pipeline_id: z.string().uuid(),
        node_id: z.string().min(1).max(64),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ session_id: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: pipeline } = await supabaseAdmin
      .from("etl_pipelines")
      .select("id, graph")
      .eq("id", data.pipeline_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!pipeline) throw new Error("Pipeline not found");
    const graph = normalizeGraph(pipeline.graph);
    if (!graph) throw new Error("This pipeline has no visual graph to preview");
    // Compile now so a broken graph fails HERE with a message, not inside a
    // container that spins up just to die.
    compilePreview(graph, data.node_id);
    const { startSession } = await import("@/utils/notebookRuntime/service.server");
    const { session } = await startSession({
      userId,
      kind: "batch",
      entrypoint: "entrypoint",
      inputs: { __etl_preview: { pipeline_id: data.pipeline_id, node_id: data.node_id } },
    });
    return { session_id: session.id };
  });

export const getEtlPreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), session_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<EtlPreviewResult> => {
    const userId = await resolveCaller(data.access_token);
    const { getSession, refreshSession } = await import("@/utils/notebookRuntime/service.server");
    let session = await getSession(userId, data.session_id);
    if (!session) throw new Error("Preview session not found");
    if (["queued", "starting", "ready", "running"].includes(session.status)) {
      session = await refreshSession(session);
    }
    const result = session.result as {
      preview?: {
        columns: { name: string; type: string }[];
        rows: Record<string, unknown>[];
        total_sampled: number;
      };
    } | null;
    const raw = result?.preview;
    return {
      status: session.status,
      preview: raw
        ? {
            columns: raw.columns,
            total_sampled: raw.total_sampled,
            rows: raw.rows.map((r) =>
              Object.fromEntries(Object.entries(r).map(([k, v]) => [k, previewCell(v)])),
            ),
          }
        : null,
      error:
        session.status === "error"
          ? (session.error ??
            (session.logs ?? "").split("\n").filter(Boolean).slice(-1)[0] ??
            "Preview failed")
          : null,
    };
  });
