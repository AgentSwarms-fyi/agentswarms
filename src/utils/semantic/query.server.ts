// Server-side semantic query executor: load a governed model, compile the
// structured query to SQL (src/lib/semanticLayer), and run it against the
// right backend (local AlaSQL datasets or a warehouse connection).
//
// Owner-scoping: pass scopeUserId on headless/service-role paths (agent tools)
// so models — and the warehouse connections they reference — are restricted to
// that owner, never another tenant. On user-JWT paths RLS already does this.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  compileSemanticQuery,
  type SemanticDimension,
  type SemanticMetric,
  type SemanticModel,
  type SemanticQuery,
  type SemanticSource,
  type SqlDialect,
} from "@/lib/semanticLayer";
import { runLocalSqlForUser } from "@/utils/bi/refresh.server";
import { loadWarehouseConnection } from "@/utils/warehouse/connections.server";
import { executeWarehouseQuery } from "@/utils/warehouse/drivers.server";

type Sb = SupabaseClient<Database>;
export type SemanticModelRow = Database["public"]["Tables"]["semantic_models"]["Row"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rowToModel(row: SemanticModelRow): SemanticModel {
  const source: SemanticSource =
    row.source_kind === "warehouse"
      ? { kind: "warehouse", connectionId: row.connection_id ?? "", table: row.source_table }
      : { kind: "data_table", table: row.source_table };
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    source,
    dimensions: Array.isArray(row.dimensions)
      ? (row.dimensions as unknown as SemanticDimension[])
      : [],
    metrics: Array.isArray(row.metrics) ? (row.metrics as unknown as SemanticMetric[]) : [],
  };
}

export async function listSemanticModels(sb: Sb, ownerId?: string): Promise<SemanticModel[]> {
  let q = sb.from("semantic_models").select("*").order("name");
  if (ownerId) q = q.eq("user_id", ownerId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToModel);
}

export async function loadSemanticModel(
  sb: Sb,
  ref: string,
  ownerId?: string,
): Promise<{ model: SemanticModel; row: SemanticModelRow } | null> {
  let q = sb.from("semantic_models").select("*");
  q = UUID_RE.test(ref) ? q.eq("id", ref) : q.eq("name", ref);
  if (ownerId) q = q.eq("user_id", ownerId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { model: rowToModel(data), row: data };
}

export type SemanticResult = {
  model: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /** The compiled SQL — surfaced for explainability/trust. */
  sql: string;
};

export async function runSemanticQuery(opts: {
  sb: Sb;
  /** Owner id used to run local datasets + verify warehouse ownership. */
  userId: string;
  /** When set (headless/service-role), restrict models to this owner. */
  scopeUserId?: string;
  query: SemanticQuery;
  maxRows?: number;
}): Promise<SemanticResult> {
  const loaded = await loadSemanticModel(opts.sb, opts.query.model, opts.scopeUserId);
  if (!loaded) throw new Error(`Semantic model "${opts.query.model}" not found`);
  const { model } = loaded;

  if (model.source.kind === "warehouse") {
    if (!model.source.connectionId) {
      throw new Error(`Model "${model.name}" is a warehouse model but has no connection`);
    }
    // Defense-in-depth: on scoped (service-role) paths, verify the connection
    // belongs to the owner before loading it — RLS won't protect us there.
    if (opts.scopeUserId) {
      const { data: own } = await opts.sb
        .from("data_warehouse_connections")
        .select("id")
        .eq("id", model.source.connectionId)
        .eq("user_id", opts.scopeUserId)
        .maybeSingle();
      if (!own) throw new Error("Warehouse connection is not accessible");
    }
    const conn = await loadWarehouseConnection(
      opts.sb,
      { connectionId: model.source.connectionId },
      opts.userId,
    );
    const compiled = compileSemanticQuery(model, opts.query, {
      dialect: conn.config.provider as SqlDialect,
    });
    const res = await executeWarehouseQuery(conn.config, compiled.sql, opts.maxRows ?? 1000);
    return { model: model.name, columns: compiled.columns, rows: res.rows, sql: compiled.sql };
  }

  // Local datasets (AlaSQL over the owner's user_data_tables + samples).
  const compiled = compileSemanticQuery(model, opts.query, { dialect: "alasql" });
  const res = await runLocalSqlForUser(opts.userId, compiled.sql);
  return { model: model.name, columns: compiled.columns, rows: res.rows, sql: compiled.sql };
}
