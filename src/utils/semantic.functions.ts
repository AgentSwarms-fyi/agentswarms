// Server functions for the Semantic Layer UI: CRUD on semantic models, a live
// query runner, and a picker of local dataset sources (with columns) to help
// author dimensions/metrics. All run under the caller's JWT, so RLS scopes
// everything to what they own/were granted.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import {
  isValidFieldName,
  MAX_JOINS,
  type SemanticDimension,
  type SemanticMetric,
  type SemanticQuery,
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
  agg: z.enum(["sum", "avg", "count", "count_distinct", "min", "max", "custom"]),
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
