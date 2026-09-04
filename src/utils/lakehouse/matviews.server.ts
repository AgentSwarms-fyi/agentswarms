/**
 * Materialized views: a query whose answer is kept as a real table.
 *
 * A refresh is `CREATE OR REPLACE TABLE <target> AS <query>`, which DuckLake
 * lands as one catalog commit. Readers therefore see the old table or the new
 * one and never a half-built one, which is what makes refreshing a table
 * people are actively querying safe.
 *
 * The result is an ordinary lakehouse table — queryable, joinable,
 * partitionable, and governed by the same chokepoint as everything else. Only
 * the definition and the schedule live here.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import {
  accessibleSchemas,
  assertSchemasAllowed,
  classifyStatement,
  lakehouseConnection,
  lakehouseEnabled,
  selectReferencedSchemas,
  stripSqlComments,
} from "@/utils/lakehouse/core.server";

export type MaterializedView = {
  id: string;
  user_id: string;
  schema_name: string;
  table_name: string;
  sql: string;
  schedule: "manual" | "hourly" | "daily" | "weekly";
  is_active: boolean;
  next_run_at: string | null;
  last_refreshed_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  last_duration_ms: number | null;
  last_row_count: number | null;
};

const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** How many views one sweep will refresh, so a big estate can't stall it. */
const VIEWS_PER_SWEEP = 10;

export function nextMatviewRunAt(
  schedule: MaterializedView["schedule"],
  from = new Date(),
): string | null {
  if (schedule === "manual") return null;
  const next = new Date(from);
  if (schedule === "hourly") next.setHours(next.getHours() + 1);
  else if (schedule === "daily") next.setDate(next.getDate() + 1);
  else next.setDate(next.getDate() + 7);
  return next.toISOString();
}

/**
 * Refresh one view as its OWNER. A schedule has no session behind it, so the
 * owner's grants are the only correct authority — running as whoever happened
 * to trigger the sweep would let a schedule read more (or less) than the
 * person who wrote it can.
 */
export async function refreshMaterializedView(
  view: MaterializedView,
  via: string,
): Promise<{ ok: boolean; rows?: number; error?: string; ms: number }> {
  const started = Date.now();
  let c: Awaited<ReturnType<typeof lakehouseConnection>> | null = null;
  try {
    // The definition is re-checked at every refresh, not just when it was
    // saved: a grant revoked since then must stop the refresh, and a
    // definition edited into a write must never execute as one.
    const classified = classifyStatement(view.sql);
    if (classified.kind !== "select") {
      throw new Error("A materialized view must be defined by a SELECT");
    }
    const allowed = await accessibleSchemas(view.user_id);
    const target = allowed.find((sch) => sch.name === view.schema_name);
    if (!target) throw new Error(`No access to schema "${view.schema_name}"`);
    if (target.user_id !== view.user_id) {
      throw new Error("A materialized view can only be written into a schema you own");
    }

    c = await lakehouseConnection();
    assertSchemasAllowed(await selectReferencedSchemas(c, view.sql), allowed);

    const body = stripSqlComments(view.sql).replace(/;\s*$/, "");
    // One commit: readers see the previous table until this lands.
    await c.run(
      `CREATE OR REPLACE TABLE ${qi(view.schema_name)}.${qi(view.table_name)} AS ${body}`,
    );
    const counted = await (
      await c.run(`SELECT count(*) FROM ${qi(view.schema_name)}.${qi(view.table_name)}`)
    ).getRows();
    const rows = Number(counted[0][0]);
    const ms = Date.now() - started;

    await supabaseAdmin
      .from("lakehouse_materialized_views")
      .update({
        last_refreshed_at: new Date().toISOString(),
        last_status: "ok",
        last_error: null,
        last_duration_ms: ms,
        last_row_count: rows,
      })
      .eq("id", view.id);

    auditEvent({
      userId: view.user_id,
      action: "lakehouse.matview.refresh",
      resourceType: "lakehouse_matview",
      resourceId: view.id,
      resourceName: `${view.schema_name}.${view.table_name}`,
      detail: { status: "ok", rows, duration_ms: ms, via },
    });
    return { ok: true, rows, ms };
  } catch (e) {
    const message = (e as Error).message;
    const ms = Date.now() - started;
    // A failed refresh leaves the PREVIOUS table in place. That is the right
    // trade: stale data a user can see and diagnose beats no data at all.
    await supabaseAdmin
      .from("lakehouse_materialized_views")
      .update({ last_status: "error", last_error: message.slice(0, 2000), last_duration_ms: ms })
      .eq("id", view.id);
    auditEvent({
      userId: view.user_id,
      action: "lakehouse.matview.refresh",
      resourceType: "lakehouse_matview",
      resourceId: view.id,
      resourceName: `${view.schema_name}.${view.table_name}`,
      detail: { status: "error", error: message.slice(0, 500), duration_ms: ms, via },
    });
    return { ok: false, error: message, ms };
  } finally {
    c?.closeSync();
  }
}

/**
 * Refresh every view whose schedule is due. Rides the same sweep as BI
 * refreshes and ETL schedules, and uses the same compare-and-set claim, so
 * every replica behind a load balancer can run it without double-refreshing.
 */
export async function processDueMaterializedViews(force = false): Promise<number> {
  if (!lakehouseEnabled()) return 0;
  const nowIso = new Date().toISOString();
  let query = supabaseAdmin
    .from("lakehouse_materialized_views")
    .select("*")
    .eq("is_active", true)
    .neq("schedule", "manual")
    .order("next_run_at", { ascending: true })
    .limit(VIEWS_PER_SWEEP);
  if (!force) query = query.lte("next_run_at", nowIso);

  const { data: due } = await query;
  let refreshed = 0;
  for (const row of (due ?? []) as MaterializedView[]) {
    // Advancing the clock IS the claim: only the sweep that still sees the
    // old next_run_at wins the row.
    let claim = supabaseAdmin
      .from("lakehouse_materialized_views")
      .update({ next_run_at: nextMatviewRunAt(row.schedule) })
      .eq("id", row.id);
    claim =
      row.next_run_at === null
        ? claim.is("next_run_at", null)
        : claim.eq("next_run_at", row.next_run_at);
    const { data: won } = await claim.select("id");
    if (!won?.length) continue; // another replica took this tick

    const res = await refreshMaterializedView(row, "schedule");
    if (res.ok) refreshed++;
    else {
      console.warn(
        `[lakehouse-matview] "${row.schema_name}.${row.table_name}" failed: ${res.error}`,
      );
    }
  }
  return refreshed;
}

/**
 * Define (or redefine) a materialized view as its owner and build it once.
 * The app's SQL workbench and a Data Prep flow saved to the lakehouse both
 * come through here, so the ownership rules cannot drift between them.
 */
export async function saveMatviewForUser(
  userId: string,
  input: { schema: string; table: string; sql: string; schedule: MaterializedView["schedule"] },
  via: string,
): Promise<{ id: string; rows: number | null; error?: string }> {
  const allowed = await accessibleSchemas(userId);
  const schemaRow = allowed.find((sch) => sch.name === input.schema);
  if (!schemaRow) throw new Error("No access to this schema");
  if (schemaRow.user_id !== userId) {
    throw new Error("A materialized view can only be written into a schema you own");
  }
  if (schemaRow.lake_source_id) {
    throw new Error("Data-lake mounts are read-only");
  }
  const { data: saved, error } = await supabaseAdmin
    .from("lakehouse_materialized_views")
    .upsert(
      {
        user_id: userId,
        schema_name: input.schema,
        table_name: input.table,
        sql: input.sql,
        schedule: input.schedule,
        is_active: true,
        next_run_at: nextMatviewRunAt(input.schedule),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "schema_name,table_name" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  auditEvent({
    userId,
    action: "lakehouse.matview.save",
    resourceType: "lakehouse_matview",
    resourceId: saved.id,
    resourceName: `${input.schema}.${input.table}`,
    detail: { schedule: input.schedule, via },
  });
  // Build it now. A failure here is reported but does not undo the save —
  // the definition is still worth keeping so the user can fix it.
  const res = await refreshMaterializedView({ ...saved, last_row_count: null } as never, via);
  return { id: saved.id as string, rows: res.rows ?? null, error: res.error };
}
