// What a person made since they started a tutorial (R529).
//
// Every read goes through the caller's own client, so row-level security
// decides what it may see, and every read also names the caller: an
// administrator who can see everyone's audit events does not tick their own
// tutorial with somebody else's import. What the rows amount to is decided in
// src/lib/tutorialChecks.ts.
//
// Only the columns a check reads are fetched. An analysis's turns hold every
// step's rows, so a conversation is read as its first answers alone.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { STAGING_PREFIX } from "@/lib/datasetParse";
import type { TutorialRows } from "@/lib/tutorialChecks";
import { SHIPMENTS_TABLE, type TutorialId } from "@/lib/tutorials";

type Db = SupabaseClient<Database>;

/** The most rows of one kind a check reads: a tutorial makes a handful. */
const LIMIT = 25;

function rows<T>(res: { data: T[] | null; error: { message: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`Could not read ${what}: ${res.error.message}`);
  return res.data ?? [];
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Lakehouse tables this person made from the sample shipments that are still
 * there. `since` null means at any time: the forecast tutorial starts from a
 * table the lakehouse tutorial may have made the week before.
 */
async function shipmentTables(db: Db, userId: string, since: string | null): Promise<string[]> {
  const { lakehouseEnabled, lakehouseTableExists } = await import("@/utils/lakehouse/core.server");
  if (!lakehouseEnabled()) return [];
  let q = db
    .from("audit_events")
    .select("resource_name, detail, created_at")
    .eq("user_id", userId)
    .eq("action", "lakehouse.import")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (since) q = q.gte("created_at", since);
  const imports = rows(await q, "lakehouse imports");
  const named = [
    ...new Set(
      imports
        .filter((i) => {
          const src = obj(i.detail).source_dataset;
          return typeof src === "string" && src.toLowerCase() === SHIPMENTS_TABLE;
        })
        .map((i) => i.resource_name)
        .filter((n): n is string => typeof n === "string" && n.includes(".")),
    ),
  ].slice(0, 5);
  // An import that was dropped since is not a table to build on.
  const still: string[] = [];
  for (const fqn of named) {
    const dot = fqn.indexOf(".");
    if (await lakehouseTableExists(fqn.slice(0, dot), fqn.slice(dot + 1))) still.push(fqn);
  }
  return still;
}

export async function loadTutorialRows(
  db: Db,
  userId: string,
  tutorial: TutorialId,
  since: string,
): Promise<TutorialRows> {
  switch (tutorial) {
    case "ask_analyst": {
      const analysts = rows(
        await db
          .from("ai_analysts")
          .select("id, name, source")
          .eq("user_id", userId)
          .gte("created_at", since)
          .limit(LIMIT),
        "analysts",
      );
      const ids = analysts.map((a) => a.id);
      const threads = ids.length
        ? rows(
            await db
              .from("ai_analyst_threads")
              .select(
                "id, analyst_id, title, a0:turns->0->>answer, a1:turns->1->>answer, a2:turns->2->>answer",
              )
              .eq("user_id", userId)
              .in("analyst_id", ids)
              .limit(LIMIT),
            "analyses",
          )
        : [];
      const threadIds = threads.map((t) => t.id);
      const schedules = threadIds.length
        ? rows(
            await db
              .from("ai_analyst_schedules")
              .select("thread_id, enabled")
              .eq("user_id", userId)
              .in("thread_id", threadIds)
              .limit(LIMIT),
            "analysis schedules",
          )
        : [];
      return {
        tutorial,
        analysts,
        threads: threads.map((t) => ({
          id: t.id,
          analyst_id: t.analyst_id,
          title: t.title,
          turns: [t.a0, t.a1, t.a2].map((answer) => ({ answer })),
        })),
        schedules,
      };
    }
    case "dashboard": {
      const dashboards = rows(
        await db
          .from("bi_dashboards")
          .select("id, name, widgets, pages")
          .eq("user_id", userId)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(LIMIT),
        "dashboards",
      );
      const ids = dashboards.map((d) => d.id);
      const schedules = ids.length
        ? rows(
            await db
              .from("bi_schedules")
              .select("dashboard_id, enabled, email_report")
              .eq("user_id", userId)
              .in("dashboard_id", ids)
              .limit(LIMIT),
            "dashboard schedules",
          )
        : [];
      return { tutorial, dashboards, schedules };
    }
    case "rest_api": {
      const sources = rows(
        await db
          .from("saas_connections")
          .select("id, name, sync_schedule, last_sync_status, last_sync_error")
          .eq("user_id", userId)
          .eq("provider", "rest_api")
          .gte("created_at", since)
          .limit(LIMIT),
        "app sources",
      );
      const ids = sources.map((s) => s.id);
      const datasets = ids.length
        ? rows(
            await db
              .from("user_data_tables")
              .select("id, name, saas_connection_id")
              .eq("user_id", userId)
              .in("saas_connection_id", ids)
              // A sync still running writes into a staging row (R529, seen in
              // the guide as `__upload_…`); every listing leaves those out.
              .not("name", "like", `${STAGING_PREFIX}%`)
              .limit(LIMIT),
            "datasets",
          )
        : [];
      const dashboards = datasets.length
        ? rows(
            await db
              .from("bi_dashboards")
              .select("id, name, widgets, pages")
              .eq("user_id", userId)
              .gte("created_at", since)
              .order("created_at", { ascending: false })
              .limit(LIMIT),
            "dashboards",
          )
        : [];
      return { tutorial, sources, datasets, dashboards };
    }
    case "lake_watch": {
      const tables = await shipmentTables(db, userId, since);
      const monitors = rows(
        await db
          .from("data_monitors")
          .select("id, name, source_kind, schema_name, table_name")
          .eq("user_id", userId)
          .gte("created_at", since)
          .limit(LIMIT),
        "data monitors",
      );
      const ids = monitors.map((m) => m.id);
      const runs = ids.length
        ? rows(
            await db
              .from("data_monitor_runs")
              .select("monitor_id")
              .eq("user_id", userId)
              .in("monitor_id", ids)
              .gte("ran_at", since)
              .limit(LIMIT),
            "check runs",
          )
        : [];
      return {
        tutorial,
        imports: tables.map((table) => ({ table, source: SHIPMENTS_TABLE })),
        monitors,
        runs,
      };
    }
    case "forecast": {
      const tables = await shipmentTables(db, userId, null);
      const models = rows(
        await db
          .from("ml_models")
          .select("id, name, task, source, production_version_id")
          .eq("user_id", userId)
          .eq("task", "forecast")
          .gte("created_at", since)
          .limit(LIMIT),
        "models",
      );
      const ids = models.map((m) => m.id);
      const versions = ids.length
        ? rows(
            await db
              .from("ml_model_versions")
              .select("model_id, status")
              .eq("user_id", userId)
              .in("model_id", ids)
              .limit(LIMIT * 4),
            "model versions",
          )
        : [];
      return { tutorial, tables, models, versions };
    }
    case "swarm_approval": {
      const swarms = rows(
        await db
          .from("swarms")
          .select("id, name, nodes")
          .eq("user_id", userId)
          .gte("created_at", since)
          .limit(LIMIT),
        "swarms",
      );
      const runs = rows(
        await db
          .from("swarm_runs")
          .select("id, swarm_id, swarm_snapshot, status")
          .eq("user_id", userId)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(LIMIT),
        "swarm runs",
      );
      const runIds = runs.map((r) => r.id);
      const approvals = runIds.length
        ? rows(
            await db
              .from("approvals")
              .select("swarm_run_id, decided_at")
              .eq("user_id", userId)
              .in("swarm_run_id", runIds)
              .limit(LIMIT * 2),
            "approvals",
          )
        : [];
      return { tutorial, swarms, runs, approvals };
    }
  }
}

/**
 * Whether this person can call a model: their own key, one shared with them,
 * or the server's. Said beside a tutorial that needs one, never a reason to
 * refuse it: a key added halfway through still counts.
 */
export async function hasModelAccess(db: Db, userId: string): Promise<boolean> {
  if (process.env.OPENROUTER_API_KEY?.trim()) return true;
  const [own, legacy] = await Promise.all([
    db
      .from("provider_credentials")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    db.from("integrations").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  if ((own.count ?? 0) > 0 || (legacy.count ?? 0) > 0) return true;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
    for (const type of ["provider_credential", "integration"] as const) {
      if ((await resolveGrantedResourceIds(supabaseAdmin, userId, type)).size > 0) return true;
    }
  } catch {
    // Unknown is said as "not found" beside the tutorial, which only suggests.
  }
  return false;
}
