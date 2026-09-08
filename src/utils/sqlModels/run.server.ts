/**
 * Building a set of SQL models, in dependency order.
 *
 * One build walks the plan and, for each model, runs
 * `CREATE OR REPLACE TABLE|VIEW <target> AS <rendered select>` — the same
 * single-commit DuckLake write a materialized view refresh uses, so readers
 * see the previous table or the new one and never a half-built one.
 *
 * Two things make this a transformation layer rather than a loop over
 * matviews. Order: a model is built only after everything it refs. And
 * propagation: when a model fails, or an `error` test on it fails, everything
 * downstream is SKIPPED rather than built on data that is wrong or stale. A
 * fact silently rebuilt from a broken staging table is the failure mode this
 * exists to prevent.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  accessibleSchemas,
  assertSchemasAllowed,
  classifyStatement,
  lakehouseConnection,
  lakehouseEnabled,
  selectReferencedSchemas,
  selectReferencedTables,
  stripSqlComments,
} from "@/utils/lakehouse/core.server";
import { nextEtlRunAt } from "@/utils/etl/schedule.server";
import {
  buildPlan,
  type BuildPlan,
  descendantsOf,
  buildStatus,
  modelTarget,
  quotedTarget,
  refNames,
  renderSql,
  testSql,
  type ModelOutcome,
  type SqlModel,
  type SqlModelTest,
} from "@/lib/sqlModels";

/** The row as the table stores it. */
export type SqlModelRow = SqlModel & {
  user_id: string;
  description: string | null;
  tags: string[];
  schedule: "manual" | "hourly" | "daily" | "weekly" | "cron";
  cron_expr: string | null;
  timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "built" | "failed" | "skipped" | null;
  last_error: string | null;
  last_row_count: number | null;
  last_duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type TestResult = {
  kind: SqlModelTest["kind"];
  column: string | null;
  severity: SqlModelTest["severity"];
  failing: number;
  status: "pass" | "fail" | "error";
  error?: string;
};

export type ModelResult = {
  name: string;
  target: string;
  outcome: ModelOutcome;
  ms: number;
  rows: number | null;
  error?: string;
  /** Why it was skipped: the model whose failure reached it. */
  blocked_by?: string;
  tests: TestResult[];
};

/** How many owners one sweep will build for, so a big estate cannot stall it. */
const OWNERS_PER_SWEEP = 5;

export function nextModelRunAt(
  schedule: SqlModelRow["schedule"],
  from = new Date(),
  cronExpr?: string | null,
  timezone?: string,
): string | null {
  if (schedule === "manual") return null;
  return nextEtlRunAt(schedule, from, cronExpr ?? undefined, timezone);
}

/** Every model one owner has, in the shape the planner wants. */
export async function loadModels(userId: string): Promise<SqlModelRow[]> {
  const { data, error } = await supabaseAdmin
    .from("sql_models")
    .select("*")
    .eq("user_id", userId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    tests: Array.isArray(r.tests) ? (r.tests as SqlModelTest[]) : [],
  })) as SqlModelRow[];
}

/**
 * Build models for one owner, as that owner.
 *
 * A schedule has no session behind it, so the owner's grants are the only
 * correct authority — the same rule every other sweep in the platform follows.
 */
export async function buildSqlModels(args: {
  userId: string;
  /** Model names to build with their ancestors; empty builds everything active. */
  selected?: string[];
  trigger: "manual" | "schedule" | "api" | "chain";
}): Promise<{ runId: string; status: string; models: ModelResult[]; error?: string }> {
  const started = Date.now();
  const { data: runRow, error: runErr } = await supabaseAdmin
    .from("sql_model_runs")
    .insert({
      user_id: args.userId,
      trigger: args.trigger,
      selected: args.selected ?? [],
      status: "running",
    })
    .select("id")
    .single();
  if (runErr) throw new Error(runErr.message);
  const runId = runRow.id as string;

  const finish = async (
    status: "success" | "partial" | "error",
    models: ModelResult[],
    error?: string,
  ) => {
    const ms = Date.now() - started;
    await supabaseAdmin
      .from("sql_model_runs")
      .update({
        status,
        models: models as unknown as Json,
        error: error?.slice(0, 2000) ?? null,
        finished_at: new Date().toISOString(),
        duration_ms: ms,
      })
      .eq("id", runId);
    auditEvent({
      userId: args.userId,
      action: "sql_model.build",
      resourceType: "sql_model_run",
      resourceId: runId,
      resourceName: args.selected?.length ? args.selected.join(", ") : "all models",
      detail: {
        status,
        trigger: args.trigger,
        duration_ms: ms,
        built: models.filter((m) => m.outcome === "built").length,
        failed: models.filter((m) => m.outcome === "failed").length,
        skipped: models.filter((m) => m.outcome === "skipped").length,
        models: models.map((m) => ({ name: m.name, outcome: m.outcome, rows: m.rows })),
        ...(error ? { error: error.slice(0, 500) } : {}),
      },
    });
    return { runId, status, models, error };
  };

  if (!lakehouseEnabled()) {
    return finish("error", [], "The lakehouse is not configured on this instance");
  }

  let all: SqlModelRow[];
  let plan: BuildPlan<SqlModelRow>;
  try {
    all = await loadModels(args.userId);
    plan = buildPlan(all, args.selected);
  } catch (e) {
    // A cycle, or a ref to a model that is gone. Refused before anything is
    // written, because half a graph built in the wrong order is worse than
    // nothing built at all.
    return finish("error", [], (e as Error).message);
  }
  if (plan.order.length === 0) {
    return finish("success", [], undefined);
  }

  // Every model resolves by name, INCLUDING paused ones: pausing stops a model
  // being rebuilt, not being read, and its table is still on disk.
  const targets = new Map(all.map((m) => [m.name, quotedTarget(m)]));
  const allowed = await accessibleSchemas(args.userId);

  const results: ModelResult[] = [];
  const failed = new Set<string>();
  const skipped = new Map<string, string>();

  let c: Awaited<ReturnType<typeof lakehouseConnection>> | null = null;
  try {
    c = await lakehouseConnection();
    for (const model of plan.order) {
      const blocker = (plan.deps.get(model.name) ?? []).find(
        (d) => failed.has(d) || skipped.has(d),
      );
      if (blocker) {
        const root = failed.has(blocker) ? blocker : (skipped.get(blocker) as string);
        skipped.set(model.name, root);
        results.push({
          name: model.name,
          target: modelTarget(model),
          outcome: "skipped",
          ms: 0,
          rows: null,
          blocked_by: root,
          tests: [],
        });
        continue;
      }
      const res = await buildOne(c, model, targets, allowed, args.userId);
      results.push(res);
      if (res.outcome === "failed") failed.add(model.name);
    }
  } catch (e) {
    return finish("error", results, (e as Error).message);
  } finally {
    c?.closeSync();
  }

  await writeLineage(args.userId, plan.order, all);
  return finish(buildStatus(results.map((r) => r.outcome)), results);
}

/** Build one model and run its tests. Never throws: a failure is a result. */
async function buildOne(
  c: Awaited<ReturnType<typeof lakehouseConnection>>,
  model: SqlModelRow,
  targets: Map<string, string>,
  allowed: Awaited<ReturnType<typeof accessibleSchemas>>,
  userId: string,
): Promise<ModelResult> {
  const started = Date.now();
  const target = quotedTarget(model);
  const base: Omit<ModelResult, "outcome" | "ms"> = {
    name: model.name,
    target: modelTarget(model),
    rows: null,
    tests: [],
  };
  const fail = (error: string): ModelResult => ({
    ...base,
    outcome: "failed",
    ms: Date.now() - started,
    error,
  });
  try {
    // Re-checked at every build, not just when it was saved: a grant revoked
    // since then must stop the build, and a definition edited into a write
    // must never execute as one.
    const rendered = renderSql(model.sql, (n) => targets.get(n) ?? null);
    if (classifyStatement(rendered).kind !== "select") {
      return fail("A model must be a SELECT");
    }
    const schema = allowed.find((s) => s.name === model.schema_name);
    if (!schema) return fail(`No access to schema "${model.schema_name}"`);
    if (schema.user_id !== userId) return fail("A model can only be built into a schema you own");
    if (schema.lake_source_id || schema.iceberg_catalog_id) {
      return fail("Data-lake mounts are read-only");
    }
    assertSchemasAllowed(await selectReferencedSchemas(c, rendered), allowed);

    const body = stripSqlComments(rendered).replace(/;\s*$/, "");
    const kind = model.materialization === "view" ? "VIEW" : "TABLE";
    // A model changing materialization leaves the old object behind, and
    // CREATE OR REPLACE TABLE cannot replace a view. Drop the other shape
    // first so the switch is a normal edit rather than a stuck model.
    await c
      .run(`DROP ${kind === "TABLE" ? "VIEW" : "TABLE"} IF EXISTS ${target}`)
      .catch(() => undefined);
    await c.run(`CREATE OR REPLACE ${kind} ${target} AS ${body}`);

    const counted = await (await c.run(`SELECT count(*) FROM ${target}`)).getRows();
    const rows = Number(counted[0][0]);

    const tests = await runTests(c, model, target);
    const broke = tests.find((t) => t.severity === "error" && t.status !== "pass");
    const ms = Date.now() - started;
    const outcome: ModelOutcome = broke ? "failed" : "built";
    const error = broke
      ? `${broke.kind} on ${broke.column ?? "the table"} failed: ${broke.failing} row(s)`
      : undefined;

    await stampModel(model.id, outcome, error, rows, ms);
    return { ...base, outcome, ms, rows, tests, ...(error ? { error } : {}) };
  } catch (e) {
    const message = (e as Error).message;
    const ms = Date.now() - started;
    await stampModel(model.id, "failed", message, null, ms);
    // A failed build leaves the PREVIOUS table in place. Stale data someone
    // can see and diagnose beats no data at all.
    return { ...base, outcome: "failed", ms, error: message };
  }
}

async function runTests(
  c: Awaited<ReturnType<typeof lakehouseConnection>>,
  model: SqlModelRow,
  target: string,
): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of model.tests ?? []) {
    try {
      const rows = await (await c.run(testSql(t, target))).getRows();
      const failing = Number(rows[0]?.[0] ?? 0);
      out.push({
        kind: t.kind,
        column: t.column,
        severity: t.severity,
        failing,
        status: failing === 0 ? "pass" : "fail",
      });
    } catch (e) {
      // A test that cannot run is not a pass. A misspelled column would
      // otherwise read as a clean assertion for ever.
      out.push({
        kind: t.kind,
        column: t.column,
        severity: t.severity,
        failing: 0,
        status: "error",
        error: (e as Error).message.slice(0, 300),
      });
    }
  }
  return out;
}

async function stampModel(
  id: string,
  status: ModelOutcome,
  error: string | undefined,
  rows: number | null,
  ms: number,
): Promise<void> {
  await supabaseAdmin
    .from("sql_models")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: status,
      last_error: error?.slice(0, 2000) ?? null,
      last_row_count: rows,
      last_duration_ms: ms,
    })
    .eq("id", id);
}

/**
 * Record model-to-model edges where the Data Catalog already shows lineage.
 *
 * Replaced wholesale for this owner's models on every build, the same way the
 * ETL writer replaces a pipeline's edges: an edge for a ref that has been
 * deleted is worse than a missing one, because a stale graph is believed.
 */
async function writeLineage(userId: string, built: SqlModel[], all: SqlModelRow[]): Promise<void> {
  const byName = new Map(all.map((m) => [m.name, m]));
  type LineageRow = Database["public"]["Tables"]["catalog_lineage"]["Insert"];
  const rows: LineageRow[] = built.flatMap((m) =>
    refNames(m.sql)
      .map((r) => byName.get(r))
      .filter((up): up is SqlModelRow => Boolean(up))
      .map((up) => ({
        user_id: userId,
        source_id: null,
        upstream_fqn: modelTarget(up),
        downstream_fqn: modelTarget(m),
        source_system: "sql_model",
        // Explicit: a bulk insert with the column rows below sends null for
        // a key these omit, and null is not the column's default.
        exact: true,
      })),
  );
  rows.push(...(await columnLineageRows(userId, built, byName)));
  try {
    await supabaseAdmin
      .from("catalog_lineage")
      .delete()
      .eq("user_id", userId)
      .eq("source_system", "sql_model");
    if (rows.length > 0) await supabaseAdmin.from("catalog_lineage").insert(rows);
  } catch (e) {
    // Lineage is a view of the build, not part of it. Losing it must not fail
    // a build that actually wrote the tables.
    console.warn("[sql-models] could not record lineage:", (e as Error).message);
  }
}

/**
 * Build for every owner with a model that is due.
 *
 * A due model builds ITSELF AND ITS ANCESTORS, which is dbt's `+model`:
 * rebuilding a fact without the staging table it reads would leave the two
 * disagreeing. Several due models for one owner become ONE build over the
 * union of their ancestors, so a shared upstream is built once per sweep
 * rather than once per dependant.
 */
export async function processDueSqlModels(force = false): Promise<number> {
  if (!lakehouseEnabled()) return 0;
  const nowIso = new Date().toISOString();
  let query = supabaseAdmin
    .from("sql_models")
    .select("id, user_id, name, schedule, cron_expr, timezone, next_run_at")
    .eq("is_active", true)
    .neq("schedule", "manual")
    .order("next_run_at", { ascending: true })
    .limit(50);
  if (!force) query = query.lte("next_run_at", nowIso);
  const { data: due } = await query;
  if (!due?.length) return 0;

  /** Owner -> the model names whose clock this sweep actually won. */
  const claimed = new Map<string, string[]>();
  for (const row of due) {
    // Advancing the clock IS the claim: only the sweep that still sees the old
    // next_run_at wins the row, so two replicas cannot both build it.
    let claim = supabaseAdmin
      .from("sql_models")
      .update({
        next_run_at: nextModelRunAt(
          row.schedule as SqlModelRow["schedule"],
          new Date(),
          row.cron_expr,
          row.timezone,
        ),
      })
      .eq("id", row.id);
    claim =
      row.next_run_at === null
        ? claim.is("next_run_at", null)
        : claim.eq("next_run_at", row.next_run_at);
    const { data: won } = await claim.select("id");
    if (!won?.length) continue;
    const list = claimed.get(row.user_id) ?? [];
    list.push(row.name);
    claimed.set(row.user_id, list);
  }

  let builds = 0;
  for (const [userId, names] of [...claimed.entries()].slice(0, OWNERS_PER_SWEEP)) {
    try {
      await buildSqlModels({ userId, selected: names, trigger: "schedule" });
      builds++;
    } catch (e) {
      console.warn(`[sql-models] build for ${userId} failed: ${(e as Error).message}`);
    }
  }
  return builds;
}

/**
 * Column edges for each built model: every output column of its SELECT,
 * traced through DuckDB's own parse to the lakehouse columns it reads —
 * aliases, functions, CTEs, subqueries, joins and `SELECT *` included. The
 * upstream may be another model or any lakehouse table, which is what joins
 * a pipeline's column lineage to a model's. A view of the build, never part
 * of it: any failure here is logged and the build's outcome stands.
 */
async function columnLineageRows(
  userId: string,
  built: SqlModel[],
  byName: Map<string, SqlModelRow>,
): Promise<Database["public"]["Tables"]["catalog_lineage"]["Insert"][]> {
  if (!built.length) return [];
  const out: Database["public"]["Tables"]["catalog_lineage"]["Insert"][] = [];
  let c: Awaited<ReturnType<typeof lakehouseConnection>> | null = null;
  try {
    c = await lakehouseConnection();
    const { traceSelectColumns } = await import("@/lib/sqlColumnLineage");
    const columnsCache = new Map<string, string[] | null>();
    const columnsOf = async (schema: string, table: string): Promise<string[] | null> => {
      const k = `${schema}.${table}`.toLowerCase();
      if (!columnsCache.has(k)) {
        const rows = await (
          await c!.run(
            `SELECT column_name FROM duckdb_columns() WHERE database_name = 'lake' AND lower(schema_name) = '${schema.toLowerCase().replace(/'/g, "''")}' AND lower(table_name) = '${table.toLowerCase().replace(/'/g, "''")}' ORDER BY column_index`,
          )
        ).getRows();
        columnsCache.set(k, rows.length ? rows.map((r) => String(r[0])) : null);
      }
      return columnsCache.get(k) ?? null;
    };
    for (const m of built) {
      try {
        const rendered = stripSqlComments(
          renderSql(m.sql, (n) => {
            const up = byName.get(n);
            return up ? quotedTarget(up) : null;
          }),
        ).replace(/;\s*$/, "");
        // The parse needs each base table's columns for `*`; fetch them first,
        // then trace synchronously over the tree.
        for (const t of await selectReferencedTables(c, rendered))
          await columnsOf(t.schema, t.table);
        const ast = JSON.parse(
          String(
            (
              await (
                await c.run(`SELECT json_serialize_sql('${rendered.replace(/'/g, "''")}')`)
              ).getRows()
            )[0][0],
          ),
        );
        const outputs = traceSelectColumns(
          ast,
          (schema, table) => columnsCache.get(`${schema}.${table}`.toLowerCase()) ?? null,
        );
        for (const col of outputs ?? []) {
          for (const src of col.sources) {
            out.push({
              user_id: userId,
              source_id: null,
              upstream_fqn: `${src.schema}.${src.table}`.slice(0, 512),
              downstream_fqn: modelTarget(m),
              upstream_column: src.column.slice(0, 255),
              downstream_column: col.name.slice(0, 255),
              source_system: "sql_model",
              exact: true,
            });
          }
        }
      } catch (e) {
        console.warn(`[sql-models] column lineage skipped for ${m.name}:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.warn("[sql-models] column lineage not recorded:", (e as Error).message);
  } finally {
    c?.closeSync();
  }
  return out.slice(0, 4000);
}
