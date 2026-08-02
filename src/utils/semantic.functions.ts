// Server functions for the Semantic Layer UI: CRUD on semantic models, a live
// query runner, and a picker of local dataset sources (with columns) to help
// author dimensions/metrics. All run under the caller's JWT, so RLS scopes
// everything to what they own/were granted.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import {
  compileSemanticQuery,
  isValidFieldName,
  MAX_JOINS,
  type SemanticDimension,
  type SemanticMetric,
  type SemanticModel,
  type SemanticQuery,
  type SqlDialect,
} from "@/lib/semanticLayer";
import { runSemanticQuery } from "@/utils/semantic/query.server";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return { sb, userId: data.user.id };
}

const dimensionSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sql: z.string().min(1),
  type: z.enum(["categorical", "time", "number", "boolean"]).optional(),
});
const metricSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  agg: z.enum(["sum", "avg", "count", "count_distinct", "min", "max", "custom", "derived"]),
  sql: z.string().optional(),
  filters: z.array(z.string()).optional(),
  format: z.enum(["number", "currency", "percent"]).optional(),
  currency: z.string().optional(),
});

// Structural parts are validated STRICTLY here as well as at compile time —
// table refs and aliases become the query's shape. The ON condition is an
// owner-trusted fragment (the same trust class as dimension SQL), so it only
// gets shape limits, and the compiler wraps it in parentheses.
const joinSchema = z.object({
  table: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, "Unsafe join table reference"),
  alias: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Alias must be letters/digits/underscore")
    .optional(),
  type: z.enum(["left", "inner"]).optional(),
  on: z.string().min(1).max(500),
});

const modelSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(64),
  label: z.string().optional(),
  description: z.string().optional(),
  source_kind: z.enum(["data_table", "warehouse"]),
  table_id: z.string().uuid().nullable().optional(),
  connection_id: z.string().uuid().nullable().optional(),
  source_table: z.string().min(1),
  joins: z.array(joinSchema).max(MAX_JOINS).optional(),
  dimensions: z.array(dimensionSchema),
  metrics: z.array(metricSchema),
});

function validateNames(dims: SemanticDimension[], metrics: SemanticMetric[]) {
  const seen = new Set<string>();
  for (const f of [...dims, ...metrics]) {
    if (!isValidFieldName(f.name)) {
      throw new Error(
        `Invalid field name "${f.name}" — use letters, digits, underscore; no spaces.`,
      );
    }
    if (seen.has(f.name)) throw new Error(`Duplicate field name "${f.name}"`);
    seen.add(f.name);
  }
}

export const semanticListModels = createServerFn({ method: "GET" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => {
    const { sb } = await requireUser(data.accessToken);
    const { data: rows, error } = await sb.from("semantic_models").select("*").order("name");
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const semanticUpsertModel = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; model: z.input<typeof modelSchema> }) => d)
  .handler(async ({ data }) => {
    const { sb, userId } = await requireUser(data.accessToken);
    const m = modelSchema.parse(data.model);
    if (!isValidFieldName(m.name)) {
      throw new Error(`Model name "${m.name}" must be letters/digits/underscore, no spaces.`);
    }
    validateNames(m.dimensions, m.metrics);
    if (m.source_kind === "warehouse" && !m.connection_id) {
      throw new Error("Warehouse models need a connection.");
    }
    const row = {
      user_id: userId,
      name: m.name,
      label: m.label ?? null,
      description: m.description ?? null,
      source_kind: m.source_kind,
      table_id: m.table_id ?? null,
      connection_id: m.connection_id ?? null,
      source_table: m.source_table,
      joins: (m.joins ?? []) as never,
      dimensions: m.dimensions as never,
      metrics: m.metrics as never,
    };
    if (m.id) {
      const { data: up, error } = await sb
        .from("semantic_models")
        .update(row as never)
        .eq("id", m.id)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { id: up.id };
    }
    const { data: ins, error } = await sb
      .from("semantic_models")
      .insert(row as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: ins.id };
  });

export const semanticDeleteModel = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; id: string }) => d)
  .handler(async ({ data }) => {
    const { sb } = await requireUser(data.accessToken);
    const { error } = await sb.from("semantic_models").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

type Cell = string | number | boolean | null;

export const semanticRunQuery = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; query: SemanticQuery }) => d)
  .handler(async ({ data }) => {
    const { sb, userId } = await requireUser(data.accessToken);
    const res = await runSemanticQuery({ sb, userId, query: data.query, maxRows: 1000 });
    // Coerce cells to serializable primitives (Dates → strings, etc.).
    const rows: Record<string, Cell>[] = res.rows.map((r) => {
      const out: Record<string, Cell> = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] =
          v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? (v as Cell)
            : v === undefined
              ? null
              : String(v);
      }
      return out;
    });
    return { model: res.model, columns: res.columns, sql: res.sql, rows };
  });

/**
 * Dry-run a model without saving: compile every metric and dimension, then
 * probe the real backend with a LIMIT 1 query per field.
 *
 * A typo'd column used to surface as a raw engine error at query time (or,
 * worse, on a dashboard refresh hours later). This turns authoring into a
 * checkable loop — each field is reported independently so one bad metric
 * doesn't hide the rest.
 */
export const semanticValidateModel = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; model: z.input<typeof modelSchema> }) => d)
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      issues: Array<{ kind: "dimension" | "metric" | "model"; name: string; error: string }>;
      checked: number;
    }> => {
      const { sb, userId } = await requireUser(data.accessToken);
      const issues: Array<{ kind: "dimension" | "metric" | "model"; name: string; error: string }> =
        [];
      let m: z.output<typeof modelSchema>;
      try {
        m = modelSchema.parse(data.model);
        validateNames(m.dimensions, m.metrics);
      } catch (e) {
        return {
          ok: false,
          checked: 0,
          issues: [
            { kind: "model", name: "", error: e instanceof Error ? e.message : "Invalid model" },
          ],
        };
      }

      const model: SemanticModel = {
        name: m.name,
        source:
          m.source_kind === "warehouse"
            ? { kind: "warehouse", connectionId: m.connection_id ?? "", table: m.source_table }
            : { kind: "data_table", table: m.source_table },
        joins: m.joins ?? [],
        dimensions: m.dimensions,
        metrics: m.metrics,
      };

      // Resolve the execution backend once (dialect + runner), then probe each
      // field. Warehouse connections are verified as the caller's own.
      let dialect: SqlDialect = "alasql";
      let exec: (sql: string) => Promise<unknown>;
      if (m.source_kind === "warehouse") {
        const { loadWarehouseConnectionForUser } =
          await import("@/utils/warehouse/connections.server");
        const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
        try {
          const conn = await loadWarehouseConnectionForUser(
            sb,
            { connectionId: m.connection_id ?? "" },
            userId,
          );
          dialect = conn.config.provider as SqlDialect;
          exec = (sql) => executeWarehouseQuery(conn.config, sql, 1);
        } catch (e) {
          return {
            ok: false,
            checked: 0,
            issues: [
              {
                kind: "model",
                name: "",
                error: e instanceof Error ? e.message : "Warehouse connection unavailable",
              },
            ],
          };
        }
      } else {
        // THE DIALECT MUST MATCH THE ENGINE THAT WILL RUN IT. `dialect` is
        // initialised to "alasql" above and the warehouse branch overwrites
        // it; this branch did not, so a local model was compiled as AlaSQL and
        // executed on DuckDB. Every field failed with a parser error —
        // `SELECT 'Order ID' AS 'order_id'`, where AlaSQL's quoting makes a
        // string literal out of a column name and an invalid alias out of the
        // rest. Validation of every local semantic model was broken from the
        // moment the local engine became DuckDB. The query path
        // (semantic/query.server) already resolved this correctly; only
        // validation was left behind.
        const { localEngineName } = await import("@/utils/data/localEngine.server");
        dialect = await localEngineName();

        // Loads the caller's datasets ONCE for the whole probe loop below.
        // runLocalSqlForUser reloads every one of them per call, and this
        // validates one query per dimension and per metric — so a 19-field
        // model meant nineteen full reloads and a Validate button that never
        // came back.
        const { localSqlRunnerForUser } = await import("@/utils/bi/refresh.server");
        exec = await localSqlRunnerForUser(userId);
      }

      let checked = 0;
      const probe = async (kind: "dimension" | "metric", name: string) => {
        checked++;
        try {
          const { sql } = compileSemanticQuery(
            model,
            kind === "metric"
              ? { model: m.name, metrics: [name], limit: 1 }
              : { model: m.name, metrics: [], dimensions: [name], limit: 1 },
            { dialect },
          );
          await exec(sql);
        } catch (e) {
          issues.push({
            kind,
            name,
            error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
          });
        }
      };
      for (const d of m.dimensions) await probe("dimension", d.name);
      for (const met of m.metrics) await probe("metric", met.name);

      return { ok: issues.length === 0, issues, checked };
    },
  );

/** Local datasets (with columns) to author models against. */
export const semanticListLocalSources = createServerFn({ method: "GET" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => {
    const { sb } = await requireUser(data.accessToken);
    const { data: rows, error } = await sb
      .from("user_data_tables")
      .select("id, name, columns, is_sample")
      .order("name");
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      is_sample: !!r.is_sample,
      columns: Array.isArray(r.columns)
        ? (r.columns as Array<{ name?: string; type?: string }>)
            .map((c) => ({ name: String(c?.name ?? ""), type: String(c?.type ?? "string") }))
            .filter((c) => c.name)
        : [],
    }));
  });
