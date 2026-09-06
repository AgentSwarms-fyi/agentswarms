// Server functions behind Data & BI -> SQL Models: define models, build them,
// and read the build log.
//
// Every write goes through the service role with an explicit user_id pin, the
// same idiom the rest of the platform uses; the audit trigger on the table
// records every change under the owner's name, and a build audits its own row.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  buildPlan,
  refNames,
  validateModelName,
  validateModelSql,
  validateTest,
  type SqlModelTest,
} from "@/lib/sqlModels";
import {
  buildSqlModels,
  loadModels,
  nextModelRunAt,
  type ModelResult,
  type SqlModelRow,
} from "@/utils/sqlModels/run.server";

/** One build, as the runs list returns it. */
export type SqlModelRunRow = {
  id: string;
  trigger: "manual" | "schedule" | "api";
  status: "running" | "success" | "partial" | "error";
  selected: string[];
  models: ModelResult[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
};

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

const testSchema = z.object({
  kind: z.enum(["not_null", "unique", "accepted_values", "range", "row_count_min"]),
  column: z.string().trim().max(200).nullable(),
  severity: z.enum(["error", "warn"]),
  values: z.array(z.string().max(500)).max(500).optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  count: z.number().int().min(0).optional(),
});

export const sqlModelsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          models: SqlModelRow[];
          schemas: { name: string; writable: boolean }[];
          /** name -> what it depends on, so the page can draw the graph. */
          deps: Record<string, string[]>;
          /** Names a ref points at that no model provides. */
          missing: Record<string, string[]>;
        }
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const models = await loadModels(caller.userId);
      const names = new Set(models.map((m) => m.name));

      const { accessibleSchemas } = await import("@/utils/lakehouse/core.server");
      const schemas = (await accessibleSchemas(caller.userId)).map((s) => ({
        name: s.name,
        // A mount is read-only, so it can be read by a model and never written.
        writable: s.user_id === caller.userId && !s.lake_source_id && !s.iceberg_catalog_id,
      }));

      const deps: Record<string, string[]> = {};
      const missing: Record<string, string[]> = {};
      for (const m of models) {
        const refs = refNames(m.sql);
        deps[m.name] = refs.filter((r) => names.has(r));
        const gone = refs.filter((r) => !names.has(r));
        if (gone.length) missing[m.name] = gone;
      }
      return { ok: true, models, schemas, deps, missing };
    },
  );

/**
 * Create or update a model.
 *
 * The graph is validated with the CANDIDATE row in place, not after saving it:
 * a model that would close a cycle is refused while the project still builds,
 * rather than saved and discovered at the next build when nothing runs.
 */
export const sqlModelSave = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid().nullable().optional(),
        name: z.string().trim().min(1).max(63),
        description: z.string().trim().max(2000).nullable().optional(),
        schema_name: z.string().trim().min(1).max(200),
        sql: z.string().min(1).max(200_000),
        materialization: z.enum(["table", "view"]),
        tests: z.array(testSchema).max(50),
        tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
        is_active: z.boolean().optional(),
        schedule: z.enum(["manual", "hourly", "daily", "weekly", "cron"]),
        cron_expr: z.string().trim().max(200).nullable().optional(),
        timezone: z.string().trim().max(80).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; id: string }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;

    const nameError = validateModelName(data.name);
    if (nameError) return { ok: false, error: nameError };
    const sqlError = validateModelSql(data.sql);
    if (sqlError) return { ok: false, error: sqlError };
    for (const t of data.tests as SqlModelTest[]) {
      const e = validateTest(t);
      if (e) return { ok: false, error: e };
    }
    if (data.schedule === "cron") {
      const { validateCron } = await import("@/lib/cron");
      try {
        validateCron(data.cron_expr ?? "", data.timezone ?? null);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }

    // The target schema must be one the caller owns and can write. Checked
    // here so a bad target is a sentence in the editor rather than a build
    // that fails every night.
    const { accessibleSchemas } = await import("@/utils/lakehouse/core.server");
    const schema = (await accessibleSchemas(caller.userId)).find(
      (s) => s.name === data.schema_name,
    );
    if (!schema) return { ok: false, error: `No access to schema "${data.schema_name}"` };
    if (schema.user_id !== caller.userId) {
      return { ok: false, error: "A model can only be built into a schema you own" };
    }
    if (schema.lake_source_id || schema.iceberg_catalog_id) {
      return { ok: false, error: "Data-lake mounts are read-only" };
    }

    // A materialized view already owns (schema, table) globally, and a model
    // writing the same target would fight it every sweep. Refuse the collision
    // by name instead of letting two schedules overwrite each other.
    const { data: clash } = await supabaseAdmin
      .from("lakehouse_materialized_views")
      .select("id")
      .eq("schema_name", data.schema_name)
      .eq("table_name", data.name)
      .maybeSingle();
    if (clash) {
      return {
        ok: false,
        error: `${data.schema_name}.${data.name} is already a materialized view. Delete it, or give the model another name.`,
      };
    }

    const existing = await loadModels(caller.userId);
    const candidate = {
      id: data.id ?? "new",
      name: data.name,
      schema_name: data.schema_name,
      sql: data.sql,
      materialization: data.materialization,
      tests: data.tests as SqlModelTest[],
      is_active: data.is_active ?? true,
    };
    const others = existing.filter((m) => m.id !== data.id);
    if (others.some((m) => m.name === data.name)) {
      return { ok: false, error: `You already have a model called ${data.name}` };
    }
    try {
      buildPlan([...others, candidate]);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    const patch = {
      user_id: caller.userId,
      name: data.name,
      description: data.description ?? null,
      schema_name: data.schema_name,
      sql: data.sql,
      materialization: data.materialization,
      tests: data.tests as unknown as Json,
      tags: data.tags ?? [],
      is_active: data.is_active ?? true,
      schedule: data.schedule,
      cron_expr: data.schedule === "cron" ? (data.cron_expr ?? null) : null,
      timezone: data.timezone ?? "UTC",
      next_run_at: nextModelRunAt(data.schedule, new Date(), data.cron_expr, data.timezone),
      updated_at: new Date().toISOString(),
    };
    const q = data.id
      ? supabaseAdmin
          .from("sql_models")
          .update(patch)
          .eq("id", data.id)
          .eq("user_id", caller.userId)
      : supabaseAdmin.from("sql_models").insert(patch);
    const { data: row, error } = await q.select("id").maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: "Model not found" };
    return { ok: true, id: row.id as string };
  });

/**
 * Delete a model's definition. The table it built is left where it is.
 *
 * Dropping it would delete data the owner may still be reading from a
 * dashboard, an agent or another tool, and a definition is not the data. The
 * Lakehouse page is where a table is dropped, deliberately.
 */
export const sqlModelDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; dependants: string[] }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const models = await loadModels(caller.userId);
    const target = models.find((m) => m.id === data.id);
    if (!target) return { ok: false, error: "Model not found" };
    // Say what breaks rather than refusing: the owner may be deleting exactly
    // because they are about to rewrite the dependants.
    const dependants = models
      .filter((m) => m.id !== data.id && refNames(m.sql).includes(target.name))
      .map((m) => m.name);
    const { error } = await supabaseAdmin
      .from("sql_models")
      .delete()
      .eq("id", data.id)
      .eq("user_id", caller.userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true, dependants };
  });

/** Build now: the named models with their ancestors, or everything active. */
export const sqlModelsBuild = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        selected: z.array(z.string().trim().min(1).max(63)).max(200).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      Fail | { ok: true; runId: string; status: string; models: ModelResult[]; error?: string }
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const res = await buildSqlModels({
        userId: caller.userId,
        selected: data.selected,
        trigger: "manual",
      });
      return { ok: true, ...res };
    },
  );

export const sqlModelRunsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; runs: SqlModelRunRow[] }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: runs, error } = await supabaseAdmin
      .from("sql_model_runs")
      .select("*")
      .eq("user_id", caller.userId)
      .order("started_at", { ascending: false })
      .limit(data.limit ?? 25);
    if (error) return { ok: false, error: error.message };
    return { ok: true, runs: (runs ?? []) as unknown as SqlModelRunRow[] };
  });

/**
 * Run a model's SQL without materialising it, and show the first rows.
 *
 * The refs resolve against the tables that exist NOW, so a preview of a model
 * whose upstream has never been built says so plainly instead of returning an
 * empty grid that looks like a correct answer.
 */
export const sqlModelPreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        sql: z.string().min(1).max(200_000),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          columns: { name: string; type: string }[];
          rows: Json[][];
          rendered: string;
          refs: string[];
        }
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const sqlError = validateModelSql(data.sql);
      if (sqlError) return { ok: false, error: sqlError };

      const models = await loadModels(caller.userId);
      const { quotedTarget, renderSql } = await import("@/lib/sqlModels");
      const targets = new Map(models.map((m) => [m.name, quotedTarget(m)]));
      let rendered: string;
      try {
        rendered = renderSql(data.sql, (n) => targets.get(n) ?? null);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      try {
        const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
        const res = await runLakehouseStatement(caller.userId, rendered, {
          rowCap: data.limit ?? 50,
          auditVia: "sql-model-preview",
          useCache: false,
        });
        return {
          ok: true,
          columns: res.columns,
          rows: res.rows as unknown as Json[][],
          rendered,
          refs: refNames(data.sql),
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/** Pause or resume a model without editing it. */
export const sqlModelToggle = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        is_active: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: row, error } = await supabaseAdmin
      .from("sql_models")
      .update({ is_active: data.is_active, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", caller.userId)
      .select("id, name")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: "Model not found" };
    auditEvent({
      userId: caller.userId,
      action: data.is_active ? "sql_model.resume" : "sql_model.pause",
      resourceType: "sql_model",
      resourceId: row.id as string,
      resourceName: row.name as string,
      detail: { is_active: data.is_active },
    });
    return { ok: true };
  });
