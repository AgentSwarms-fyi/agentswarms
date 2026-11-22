// Everything that ran for the reader, read from each kind's own table.
//
// One read per kind, side by side, each with the reader's own token and each
// also limited to the reader's own rows (some kinds — ML jobs — are readable
// by grantees too, and "your runs" should mean yours). A kind that cannot be
// read is named in `unread` and the rest still return: a missing table on an
// older database, or one slow source, must not blank the whole page.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  durationOf,
  mergeRuns,
  normalizeStatus,
  normalizeTrigger,
  oneLineError,
  type RunKind,
  type RunRow,
} from "@/lib/runs";
import { explainEtlError } from "@/utils/etl/explainError";

/** The most runs read per kind; the page says when a kind was cut. */
const PER_KIND = 100;

// Untyped on purpose: thirteen tables, some newer than the generated types,
// each read for a handful of columns this file checks itself.
type Sb = SupabaseClient;

/** id → name for one table, for the ids a kind's runs point at. */
async function namesOf(
  sb: Sb,
  table: string,
  ids: Array<string | null | undefined>,
  col = "name",
): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const { data } = await sb.from(table).select(`id, ${col}`).in("id", want);
  return new Map(
    // A built column list leaves the client nothing to type the rows by.
    ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => [
      String(r.id),
      String(r[col] ?? ""),
    ]),
  );
}

const failed = (s: string) => normalizeStatus(s) === "failed" || s === "partial" || s === "alert";

export const runsListFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ days: z.number().int().min(1).max(90).default(14) }).parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    const sb = context.supabase as unknown as Sb;
    const uid = context.userId;
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const unread: RunKind[] = [];
    const capped: RunKind[] = [];

    const read = async (kind: RunKind, fn: () => Promise<RunRow[]>): Promise<RunRow[]> => {
      try {
        const rows = await fn();
        if (rows.length >= PER_KIND) capped.push(kind);
        return rows;
      } catch {
        unread.push(kind);
        return [];
      }
    };
    const must = <T>(r: { data: T[] | null; error: { message: string } | null }): T[] => {
      if (r.error) throw new Error(r.error.message);
      return r.data ?? [];
    };

    const lists = await Promise.all([
      read("etl", async () => {
        const rows = must(
          await sb
            .from("etl_runs")
            .select("id, pipeline_id, status, trigger, error, created_at, started_at, finished_at")
            .eq("user_id", uid)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        const names = await namesOf(
          sb,
          "etl_pipelines",
          rows.map((r) => r.pipeline_id),
        );
        return rows.map((r) => ({
          kind: "etl" as const,
          id: r.id!,
          name: names.get(r.pipeline_id ?? "") || "A pipeline",
          status: normalizeStatus(r.status),
          startedAt: r.started_at ?? r.created_at!,
          finishedAt: r.finished_at,
          durationMs: durationOf(r.started_at, r.finished_at),
          trigger: normalizeTrigger(r.trigger),
          error: r.error ? (explainEtlError(r.error)?.summary ?? oneLineError(r.error)) : null,
          costUsd: null,
          link: r.pipeline_id ? { to: "/etl", search: { open: r.pipeline_id } } : null,
        }));
      }),
      read("workflow", async () => {
        const rows = must(
          await sb
            .from("workflow_runs")
            .select("id, workflow_id, state, trigger, error, started_at, finished_at")
            .eq("user_id", uid)
            .gte("started_at", since)
            .order("started_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        const names = await namesOf(
          sb,
          "workflows",
          rows.map((r) => r.workflow_id),
        );
        return rows.map((r) => ({
          kind: "workflow" as const,
          id: r.id!,
          name: names.get(r.workflow_id ?? "") || "A workflow",
          status: normalizeStatus(r.state),
          startedAt: r.started_at!,
          finishedAt: r.finished_at,
          durationMs: durationOf(r.started_at, r.finished_at),
          trigger: normalizeTrigger(r.trigger),
          error: oneLineError(r.error),
          costUsd: null,
          link: r.workflow_id ? { to: "/workflows", search: { open: r.workflow_id } } : null,
        }));
      }),
      read("swarm", async () => {
        const rows = must(
          await sb
            .from("swarm_runs")
            .select(
              "id, swarm_id, swarm_name, status, error_message, created_at, started_at, finished_at, total_cost_usd",
            )
            .eq("user_id", uid)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | number | null>>;
        return rows.map((r) => ({
          kind: "swarm" as const,
          id: String(r.id),
          name: (r.swarm_name as string | null) || "A swarm",
          status: normalizeStatus(r.status as string),
          startedAt: (r.started_at ?? r.created_at) as string,
          finishedAt: r.finished_at as string | null,
          durationMs: durationOf(r.started_at as string, r.finished_at as string | null),
          trigger: null,
          error: oneLineError(r.error_message as string | null),
          costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
          link: { to: `/analytics/observability/${String(r.id)}` },
        }));
      }),
      read("delivery", async () => {
        const rows = must(
          await sb
            .from("bi_report_deliveries")
            .select("id, report_id, dashboard_id, status, trigger, detail, ran_at")
            .eq("user_id", uid)
            .gte("ran_at", since)
            .order("ran_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        const [reports, dashboards] = await Promise.all([
          namesOf(
            sb,
            "bi_reports",
            rows.map((r) => r.report_id),
          ),
          namesOf(
            sb,
            "bi_dashboards",
            rows.map((r) => r.dashboard_id),
          ),
        ]);
        return rows.map((r) => ({
          kind: "delivery" as const,
          id: r.id!,
          name: r.dashboard_id
            ? `Dashboard “${dashboards.get(r.dashboard_id) || "a dashboard"}”`
            : `Report “${reports.get(r.report_id ?? "") || "a report"}”`,
          status: normalizeStatus(r.status),
          startedAt: r.ran_at!,
          finishedAt: r.ran_at,
          durationMs: null,
          trigger: normalizeTrigger(r.trigger),
          error: r.status && failed(r.status) ? oneLineError(r.detail) : null,
          costUsd: null,
          link: r.dashboard_id
            ? { to: `/bi/${r.dashboard_id}` }
            : r.report_id
              ? { to: `/bi/report/${r.report_id}` }
              : null,
        }));
      }),
      read("ml_train", async () => {
        const rows = must(
          await sb
            .from("ml_training_jobs")
            .select("id, model_id, status, trigger, error, created_at, started_at, finished_at")
            .eq("user_id", uid)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        const names = await namesOf(
          sb,
          "ml_models",
          rows.map((r) => r.model_id),
        );
        return rows.map((r) => ({
          kind: "ml_train" as const,
          id: r.id!,
          name: names.get(r.model_id ?? "") || "A model",
          status: normalizeStatus(r.status),
          startedAt: r.started_at ?? r.created_at!,
          finishedAt: r.finished_at,
          durationMs: durationOf(r.started_at, r.finished_at),
          trigger: normalizeTrigger(r.trigger),
          error: oneLineError(r.error),
          costUsd: null,
          link: r.model_id ? { to: `/ml/${r.model_id}` } : null,
        }));
      }),
      read("ml_predict", async () => {
        const rows = must(
          await sb
            .from("ml_predictions")
            .select("id, model_id, status, via, error, created_at, started_at, finished_at")
            .eq("user_id", uid)
            .eq("kind", "batch")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        const names = await namesOf(
          sb,
          "ml_models",
          rows.map((r) => r.model_id),
        );
        return rows.map((r) => ({
          kind: "ml_predict" as const,
          id: r.id!,
          name: names.get(r.model_id ?? "") || "A model",
          status: normalizeStatus(r.status),
          startedAt: r.started_at ?? r.created_at!,
          finishedAt: r.finished_at,
          durationMs: durationOf(r.started_at, r.finished_at),
          trigger: normalizeTrigger(r.via),
          error: oneLineError(r.error),
          costUsd: null,
          link: r.model_id ? { to: `/ml/${r.model_id}` } : null,
        }));
      }),
      read("notebook", async () => {
        const rows = must(
          await sb
            .from("notebook_runtime_sessions")
            .select(
              "id, notebook_id, status, error, created_at, started_at, stopped_at, api_key_id",
            )
            .eq("user_id", uid)
            .eq("kind", "batch")
            .is("etl_run_id", null)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        const names = await namesOf(
          sb,
          "user_python_notebooks",
          rows.map((r) => r.notebook_id),
          "title",
        );
        return rows.map((r) => ({
          kind: "notebook" as const,
          id: r.id!,
          name: names.get(r.notebook_id ?? "") || "A notebook",
          status: normalizeStatus(r.status),
          startedAt: r.started_at ?? r.created_at!,
          finishedAt: r.stopped_at,
          durationMs: durationOf(r.started_at, r.stopped_at),
          trigger: r.api_key_id ? ("api" as const) : ("manual" as const),
          error: oneLineError(r.error),
          costUsd: null,
          link: r.notebook_id ? { to: `/notebooks/py/${r.notebook_id}` } : null,
        }));
      }),
      read("sql_models", async () => {
        const rows = must(
          await sb
            .from("sql_model_runs")
            .select("id, status, trigger, error, started_at, finished_at, duration_ms, selected")
            .eq("user_id", uid)
            .gte("started_at", since)
            .order("started_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, unknown>>;
        return rows.map((r) => {
          const selected = Array.isArray(r.selected) ? r.selected.length : 0;
          return {
            kind: "sql_models" as const,
            id: String(r.id),
            name: selected ? `${selected} SQL model${selected === 1 ? "" : "s"}` : "All SQL models",
            status: normalizeStatus(r.status as string),
            startedAt: r.started_at as string,
            finishedAt: (r.finished_at as string | null) ?? null,
            durationMs: durationOf(
              r.started_at as string,
              r.finished_at as string | null,
              r.duration_ms as number | null,
            ),
            trigger: normalizeTrigger(r.trigger as string | null),
            error: oneLineError(r.error as string | null),
            costUsd: null,
            link: { to: "/sql-models" },
          };
        });
      }),
      read("monitor", async () => {
        const rows = must(
          await sb
            .from("data_monitor_runs")
            .select("id, monitor_id, status, trigger, message, duration_ms, ran_at")
            .eq("user_id", uid)
            .gte("ran_at", since)
            .order("ran_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, unknown>>;
        const names = await namesOf(
          sb,
          "data_monitors",
          rows.map((r) => r.monitor_id as string | null),
        );
        return rows.map((r) => ({
          kind: "monitor" as const,
          id: String(r.id),
          name: names.get(String(r.monitor_id ?? "")) || "A monitor",
          status: normalizeStatus(r.status as string),
          startedAt: r.ran_at as string,
          finishedAt: r.ran_at as string,
          durationMs: durationOf(null, null, r.duration_ms as number | null),
          trigger: normalizeTrigger(r.trigger as string | null),
          error: failed(String(r.status)) ? oneLineError(r.message as string | null) : null,
          costUsd: null,
          link: r.monitor_id
            ? { to: "/data-monitors", search: { open: String(r.monitor_id) } }
            : null,
        }));
      }),
      read("eval", async () => {
        const rows = must(
          await sb
            .from("eval_runs")
            .select(
              "id, label, dataset_name, swarm_name, status, created_at, started_at, finished_at, total_cost_usd",
            )
            .eq("user_id", uid)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | number | null>>;
        return rows.map((r) => ({
          kind: "eval" as const,
          id: String(r.id),
          name:
            (r.label as string | null) ||
            [r.swarm_name, r.dataset_name].filter(Boolean).join(" on ") ||
            "An evaluation",
          status: normalizeStatus(r.status as string),
          startedAt: (r.started_at ?? r.created_at) as string,
          finishedAt: r.finished_at as string | null,
          durationMs: durationOf(r.started_at as string, r.finished_at as string | null),
          trigger: null,
          error: null,
          costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
          link: { to: "/evaluations" },
        }));
      }),
      // Kinds that keep only their latest result.
      read("prep_flow", async () => {
        const rows = must(
          await sb
            .from("user_prep_flows")
            .select("id, name, last_refresh_at, last_refresh_error, refresh_enabled")
            .eq("user_id", uid)
            .gte("last_refresh_at", since)
            .order("last_refresh_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | boolean | null>>;
        return rows.map((r) => ({
          kind: "prep_flow" as const,
          id: String(r.id),
          name: (r.name as string) || "A data-prep flow",
          status: r.last_refresh_error ? ("failed" as const) : ("succeeded" as const),
          startedAt: r.last_refresh_at as string,
          finishedAt: r.last_refresh_at as string,
          durationMs: null,
          trigger: r.refresh_enabled ? ("schedule" as const) : null,
          error: oneLineError(r.last_refresh_error as string | null),
          costUsd: null,
          link: null,
          latestOnly: true,
        }));
      }),
      read("analyst_schedule", async () => {
        const rows = must(
          await sb
            .from("ai_analyst_schedules")
            .select("id, thread_id, last_status, last_error, last_run_at")
            .eq("user_id", uid)
            .gte("last_run_at", since)
            .order("last_run_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        // A thread's title is sealed under its owner's key: name it by its analyst.
        const threads = (
          await sb
            .from("ai_analyst_threads")
            .select("id, analyst_id")
            .in("id", [...new Set(rows.map((r) => r.thread_id).filter(Boolean))])
        ).data as Array<{ id: string; analyst_id: string }> | null;
        const analystOf = new Map((threads ?? []).map((t) => [t.id, t.analyst_id]));
        const names = await namesOf(sb, "ai_analysts", [...analystOf.values()]);
        return rows.map((r) => {
          const analyst = analystOf.get(r.thread_id ?? "") ?? null;
          return {
            kind: "analyst_schedule" as const,
            id: r.id!,
            name: (analyst && names.get(analyst)) || "An AI analyst",
            status: normalizeStatus(r.last_status),
            startedAt: r.last_run_at!,
            finishedAt: r.last_run_at,
            durationMs: null,
            trigger: "schedule" as const,
            error: oneLineError(r.last_error),
            costUsd: null,
            link:
              analyst && r.thread_id
                ? { to: "/ai-analyst", search: { open: analyst, thread: r.thread_id } }
                : null,
            latestOnly: true,
          };
        });
      }),
      read("dashboard_refresh", async () => {
        const rows = must(
          await sb
            .from("bi_schedules")
            .select("id, dashboard_id, last_status, last_error, last_run_at")
            .eq("user_id", uid)
            .gte("last_run_at", since)
            .order("last_run_at", { ascending: false })
            .limit(PER_KIND),
        ) as Array<Record<string, string | null>>;
        const names = await namesOf(
          sb,
          "bi_dashboards",
          rows.map((r) => r.dashboard_id),
        );
        return rows.map((r) => ({
          kind: "dashboard_refresh" as const,
          id: r.id!,
          name: names.get(r.dashboard_id ?? "") || "A dashboard",
          status: normalizeStatus(r.last_status),
          startedAt: r.last_run_at!,
          finishedAt: r.last_run_at,
          durationMs: null,
          trigger: "schedule" as const,
          error: oneLineError(r.last_error),
          costUsd: null,
          link: r.dashboard_id ? { to: `/bi/${r.dashboard_id}` } : null,
          latestOnly: true,
        }));
      }),
    ]);

    return { ok: true as const, runs: mergeRuns(...lists), unread, capped, since };
  });
