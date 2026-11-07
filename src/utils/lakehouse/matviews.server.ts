/**
 * Materialized views: a query whose answer is kept as a real table.
 *
 * A refresh is `CREATE OR REPLACE TABLE <target> AS <query>`, which DuckLake
 * lands as one catalog commit. Readers therefore see the old table or the new
 * one and never a half-built one, which is what makes refreshing a table
 * people are actively querying safe.
 *
 * The result is an ordinary lakehouse table â€” queryable, joinable,
 * partitionable, and governed by the same chokepoint as everything else. Only
 * the definition and the schedule live here.
 */
import { createHash } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import {
  appendShapeRefusal,
  decideRefresh,
  floorSubquerySql,
  queryFacts,
  withRowFloor,
  type RefreshDecision,
  type RefreshState,
  type SourceNow,
  type SourceState,
} from "@/utils/lakehouse/matviewPlan";
import { snapshotKinds, tableIdentitySql, tableSnapshotsSql } from "@/utils/lakehouse/tableHistory";
import {
  accessibleSchemas,
  classifyStatement,
  governSelect,
  lakehouseConnection,
  lakehouseEnabled,
  lakehouseTableExists,
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
const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** How many views one sweep will refresh, so a big estate can't stall it. */
const VIEWS_PER_SWEEP = 10;

/**
 * What each view's last refresh recorded (matviewPlan.ts), in the lakehouse
 * itself and written in the same commit as the view's rows, so the record and
 * the rows cannot disagree. `_agentswarms` is not a registered schema: nobody
 * lists or queries it through the app.
 */
const STATE_SCHEMA = "_agentswarms";
const STATE_TABLE = "matview_state";
const STATE = `${qi(STATE_SCHEMA)}.${qi(STATE_TABLE)}`;
/** Changes to a source after the last refresh that are read one by one; more than this rebuilds. */
const MAX_CHANGES_READ = 500;

type Conn = Awaited<ReturnType<typeof lakehouseConnection>>;
const rowsOf = async (c: Conn, sql: string) => (await c.run(sql)).getRows();

let aggregateNames: Set<string> | null = null;
async function aggregates(c: Conn): Promise<Set<string>> {
  if (!aggregateNames) {
    aggregateNames = new Set(
      (
        await rowsOf(
          c,
          "SELECT DISTINCT lower(function_name) FROM duckdb_functions() WHERE function_type = 'aggregate'",
        )
      ).map((r) => String(r[0])),
    );
  }
  return aggregateNames;
}

async function serialize(c: Conn, sql: string): Promise<string> {
  return String((await rowsOf(c, `SELECT json_serialize_sql(${sq(sql)})::VARCHAR`))[0]![0]);
}

/** The functions in `names` whose answer can change between two runs, or that the engine does not know. */
async function volatileOf(c: Conn, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const consistent = new Map(
    (
      await rowsOf(
        c,
        `SELECT lower(function_name), bool_and(stability = 'CONSISTENT') FROM duckdb_functions()
         WHERE lower(function_name) IN (${names.map(sq).join(", ")}) GROUP BY 1`,
      )
    ).map((r) => [String(r[0]), r[1] === true]),
  );
  return names.filter((n) => consistent.get(n) !== true);
}

/** A DuckLake table's id and every name it has had, or null when it is not one (a view, a mount). */
async function identity(c: Conn, schema: string, table: string) {
  const real = await rowsOf(
    c,
    `SELECT schema_name, table_name FROM duckdb_tables()
     WHERE database_name = 'lake' AND lower(schema_name) = lower(${sq(schema)})
       AND lower(table_name) = lower(${sq(table)})`,
  );
  if (!real.length) return null;
  const s = String(real[0]![0]);
  const t = String(real[0]![1]);
  const ids = await rowsOf(c, tableIdentitySql(s, t));
  if (!ids.length) return null;
  return { schema: s, table: t, id: String(ids[0]![0]), names: ids.map((r) => String(r[1])) };
}

/** The kinds of each change to a table after `after`, oldest first; null when there are too many to read. */
async function kindsSince(
  c: Conn,
  t: { id: string; names: string[] },
  after: number,
): Promise<string[][] | null> {
  const snaps = await rowsOf(c, tableSnapshotsSql(t.id, t.names, MAX_CHANGES_READ + 1));
  const newer = snaps.filter((r) => Number(r[0]) > after);
  if (newer.length > MAX_CHANGES_READ) return null;
  return newer.reverse().map((r) => snapshotKinds(String(r[2]), t.id, t.names));
}

async function readState(c: Conn, viewId: string): Promise<RefreshState | null> {
  try {
    const r = await rowsOf(
      c,
      `SELECT digest, snapshot, sources FROM ${STATE} WHERE view_id = ${sq(viewId)}`,
    );
    if (!r.length) return null;
    return {
      digest: String(r[0]![0]),
      snapshot: Number(r[0]![1]),
      sources: JSON.parse(String(r[0]![2])) as SourceState[],
    };
  } catch {
    return null; // no state table yet: every view rebuilds once
  }
}

/**
 * Whether the view's table is as the last refresh left it: its newest change
 * that altered rows was a refresh's commit, which writes the state table in
 * the same snapshot. A flush or a compaction by the maintenance pass leaves
 * the rows as they were and does not count.
 */
async function targetIntact(c: Conn, view: MaterializedView): Promise<boolean> {
  const target = await identity(c, view.schema_name, view.table_name);
  const state = await identity(c, STATE_SCHEMA, STATE_TABLE);
  if (!target || !state) return false;
  const snaps = await rowsOf(c, tableSnapshotsSql(target.id, target.names, 50));
  for (const r of snaps) {
    const kinds = snapshotKinds(String(r[2]), target.id, target.names);
    if (kinds.every((k) => k === "flushed" || k === "compacted")) continue;
    return snapshotKinds(String(r[2]), state.id, state.names).length > 0;
  }
  return false;
}

/** What to do, from the refresh's own snapshot, and what to record afterwards. */
async function planRefresh(
  c: Conn,
  view: MaterializedView,
  body: string,
  policed: boolean,
  full: boolean,
): Promise<{
  decision: RefreshDecision;
  digest: string;
  snapshot: number;
  sources: SourceState[];
}> {
  const digest = createHash("sha256").update(body).digest("hex");
  const snapshot = Number((await rowsOf(c, "SELECT id FROM lake.current_snapshot()"))[0]![0]);
  const facts = queryFacts(await serialize(c, body));
  let tracked: SourceNow[] | null = [];
  let untrackedWhy: string | undefined;
  const prev = full ? null : await readState(c, view.id);
  if (facts.tableFunctions.length) {
    tracked = null;
    untrackedWhy = `it reads ${facts.tableFunctions[0]}(), whose input cannot be tracked`;
  } else if (facts.unqualified.length) {
    tracked = null;
    untrackedWhy = `it names ${facts.unqualified[0]} without a schema`;
  } else {
    const seen = new Set<string>();
    for (const ref of facts.tables) {
      const key = `${ref.schema}.${ref.table}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const id =
        ref.catalog && ref.catalog.toLowerCase() !== "lake"
          ? null
          : await identity(c, ref.schema, ref.table);
      if (!id) {
        tracked = null;
        untrackedWhy = `it reads ${ref.schema}.${ref.table}, a view or a mount, whose changes cannot be followed`;
        break;
      }
      const floorRow = await rowsOf(
        c,
        `SELECT coalesce(max(rowid), -1)::BIGINT + 1 FROM "lake".${qi(id.schema)}.${qi(id.table)}`,
      );
      const kinds = prev ? await kindsSince(c, id, prev.snapshot) : [];
      tracked.push({
        schema: id.schema,
        table: id.table,
        id: id.id,
        floor: Number(floorRow[0]![0]),
        // Too many changes to read is treated as a change of every kind.
        kindsSince: kinds ?? [["unknown"]],
      });
    }
  }
  const decision: RefreshDecision = full
    ? { mode: "rebuild", why: "a full rebuild was asked for" }
    : decideRefresh({
        prev,
        digest,
        tracked,
        untrackedWhy,
        volatile: await volatileOf(c, facts.functions),
        targetIntact: prev ? await targetIntact(c, view) : false,
        appendRefusal: appendShapeRefusal(
          await serialize(c, stripSqlComments(view.sql).replace(/;\s*$/, "")),
          await aggregates(c),
        ),
        policed,
      });
  return {
    decision,
    digest,
    snapshot,
    sources: (tracked ?? []).map(({ schema, table, id, floor }) => ({ schema, table, id, floor })),
  };
}

/** The view's SELECT reading its one table from `floor` up, as text the engine parsed and printed. */
async function appendSql(c: Conn, viewSql: string, source: SourceState): Promise<string> {
  const tree = withRowFloor(
    await serialize(c, stripSqlComments(viewSql).replace(/;\s*$/, "")),
    await serialize(c, floorSubquerySql(source.schema, source.table, source.floor)),
  );
  return String((await rowsOf(c, `SELECT json_deserialize_sql(${sq(tree)})`))[0]![0]).replace(
    /;\s*$/,
    "",
  );
}

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
 * owner's grants are the only correct authority â€” running as whoever happened
 * to trigger the sweep would let a schedule read more (or less) than the
 * person who wrote it can.
 */
export async function refreshMaterializedView(
  view: MaterializedView,
  via: string,
  opts?: { full?: boolean },
): Promise<{
  ok: boolean;
  rows?: number;
  error?: string;
  ms: number;
  /** What the refresh did (R458): left as it was, appended the new rows, or rebuilt. */
  mode?: RefreshDecision["mode"];
  why?: string;
  appended?: number;
}> {
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
    // FOUND IN R128. The name was free when the view was saved (R101), but a
    // Sheets import can have taken it since: the view's table dropped, a file
    // uploaded under the same name. A table a sheet holds is changed only by
    // Sheets (sheets/owned.server), and the refresh below would replace it.
    const { sheetOwnedRefusal } = await import("@/utils/sheets/owned.server");
    const held = await sheetOwnedRefusal([{ schema: view.schema_name, table: view.table_name }]);
    if (held) throw new Error(held);

    c = await lakehouseConnection();
    // Govern the body for its owner, exactly as a read of the same SELECT would
    // be: a materialized view over a table shared with the owner must hold only
    // the rows and columns the owner may see, not the whole table
    // (VA-2026-10-25-08). governSelect runs the same schema-access check and
    // rewrites every reference to a policed foreign table into its governed
    // subquery, and refuses rather than materializing unfiltered when a policy
    // covers a referenced table but cannot be applied.
    const { sql: governed, policyTables } = await governSelect(c, view.user_id, view.sql, allowed);
    const body = stripSqlComments(governed).replace(/;\s*$/, "");
    const viewTable = `${qi(view.schema_name)}.${qi(view.table_name)}`;
    // One transaction: it reads one snapshot of the lakehouse, so what it
    // records is what it read; and one commit, so readers see the previous
    // table until this lands, and the record lands with the rows (R458).
    await c.run("BEGIN TRANSACTION");
    let plan: Awaited<ReturnType<typeof planRefresh>>;
    let appended: number | undefined;
    try {
      plan = await planRefresh(c, view, body, policyTables.length > 0, !!opts?.full);
      if (plan.decision.mode === "append") {
        // The view's own SELECT over the new rows only, governed like the
        // definition: the owner's grants and nothing else.
        const fresh = await governSelect(
          c,
          view.user_id,
          await appendSql(c, view.sql, plan.decision.source),
          allowed,
        );
        const r = await rowsOf(
          c,
          `INSERT INTO ${viewTable} BY NAME SELECT * FROM (${stripSqlComments(fresh.sql).replace(/;\s*$/, "")})`,
        );
        appended = Number(r[0]?.[0] ?? 0);
      } else if (plan.decision.mode === "rebuild") {
        await c.run(`CREATE OR REPLACE TABLE ${viewTable} AS ${body}`);
      }
      if (plan.decision.mode !== "skip") {
        await c.run(`CREATE SCHEMA IF NOT EXISTS ${qi(STATE_SCHEMA)}`);
        await c.run(
          `CREATE TABLE IF NOT EXISTS ${STATE} (view_id VARCHAR, digest VARCHAR, snapshot BIGINT, sources VARCHAR, refreshed_at TIMESTAMP)`,
        );
        await c.run(`DELETE FROM ${STATE} WHERE view_id = ${sq(view.id)}`);
        await c.run(
          `INSERT INTO ${STATE} VALUES (${sq(view.id)}, ${sq(plan.digest)}, ${plan.snapshot}, ` +
            `${sq(JSON.stringify(plan.sources))}, now())`,
        );
        await c.run("COMMIT");
      } else {
        await c.run("ROLLBACK");
      }
    } catch (e) {
      await c.run("ROLLBACK").catch(() => undefined);
      throw e;
    }
    const counted = await (await c.run(`SELECT count(*) FROM ${viewTable}`)).getRows();
    const rows = Number(counted[0][0]);
    const ms = Date.now() - started;
    const { mode, why } = plan.decision;

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
      detail: { status: "ok", rows, duration_ms: ms, via, mode, why, appended },
    });
    return { ok: true, rows, ms, mode, why, appended };
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
 * Forget the views whose table a drop just removed, as their owner (R458).
 *
 * FOUND IN R458: dropping a view's table, or its schema, left the definition
 * behind. A scheduled refresh then rebuilt a table its owner had dropped, or,
 * with the schema gone, failed on every schedule with nowhere to show it: the
 * badge that says a refresh failed lives on the table's tab, and there was no
 * table. Only the dropper's own views go; the table is already gone, so there
 * is nothing else to keep. Best effort: the drop has happened either way, and
 * a definition that could not be removed is said in the log.
 */
export async function forgetMatviewsFor(
  userId: string,
  targets: { schema: string; table?: string }[],
): Promise<number> {
  let forgotten = 0;
  for (const t of targets) {
    if (!t.schema) continue;
    let q = supabaseAdmin
      .from("lakehouse_materialized_views")
      .delete()
      .eq("user_id", userId)
      .ilike("schema_name", t.schema.replace(/[%_\\]/g, "\\$&"));
    if (t.table) q = q.ilike("table_name", t.table.replace(/[%_\\]/g, "\\$&"));
    const { data, error } = await q.select("id, schema_name, table_name");
    if (error) {
      console.warn(
        `[lakehouse-matview] ${t.schema}${t.table ? `.${t.table}` : ""} was dropped, but its view definitions could not be removed: ${error.message}`,
      );
      continue;
    }
    for (const row of data ?? []) {
      forgotten++;
      auditEvent({
        userId,
        action: "lakehouse.matview.delete",
        resourceType: "lakehouse_matview",
        resourceId: String(row.id),
        resourceName: `${row.schema_name}.${row.table_name}`,
        detail: { reason: t.table ? "its table was dropped" : "its schema was dropped" },
      });
    }
  }
  return forgotten;
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
  if (schemaRow.lake_source_id || schemaRow.iceberg_catalog_id) {
    throw new Error("Data-lake mounts are read-only");
  }

  // FOUND IN R101. The build below is CREATE OR REPLACE TABLE, and nothing
  // asked what was already at the name. "Save as view" on the name of an
  // ordinary table (an upload, an ETL output, anything) replaced its rows
  // with the query's answer and reported "Built â€¦ 1 row(s)". Redefining a
  // view you already have is what the upsert is for. Writing a view over a
  // table that was never one is refused, and saying so is the whole fix.
  const { data: existingView, error: viewErr } = await supabaseAdmin
    .from("lakehouse_materialized_views")
    .select("id")
    .eq("schema_name", input.schema)
    .eq("table_name", input.table)
    .maybeSingle();
  if (viewErr) {
    throw new Error(
      `Could not check whether ${input.schema}.${input.table} is a view: ${viewErr.message}`,
    );
  }
  if (!existingView && (await lakehouseTableExists(input.schema, input.table))) {
    throw new Error(
      `${input.schema}.${input.table} is an existing table, not a materialized view. ` +
        `Saving a view there would replace its rows with this query's answer. ` +
        `Pick a new name, or drop the table first if replacing it is what you mean.`,
    );
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
  // Build it now. A failure here is reported but does not undo the save â€”
  // the definition is still worth keeping so the user can fix it.
  const res = await refreshMaterializedView({ ...saved, last_row_count: null } as never, via);
  return { id: saved.id as string, rows: res.rows ?? null, error: res.error };
}
