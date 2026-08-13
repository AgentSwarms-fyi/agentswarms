// Server-side semantic query executor: load a governed model, compile the
// structured query to SQL (src/lib/semanticLayer), and run it against the
// right backend (local AlaSQL datasets or a warehouse connection).
//
// Owner-scoping: pass scopeUserId on headless/service-role paths (agent tools)
// so models — and the warehouse connections they reference — are restricted to
// that owner, never another tenant. On user-JWT paths RLS already does this.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  compileSemanticQuery,
  type SemanticDimension,
  type SemanticJoin,
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
    ownerId: row.user_id,
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    status: (["draft", "certified", "deprecated"].includes(row.status)
      ? row.status
      : undefined) as SemanticModel["status"],
    source,
    // The fan-out compile guard reads primaryKey and each join's cardinality;
    // dropping either here would silently disarm it for every DB-loaded model.
    primaryKey: row.primary_key ?? undefined,
    fiscalYearStartMonth: row.fiscal_year_start_month ?? undefined,
    calendar: (row.calendar as unknown as SemanticModel["calendar"]) ?? undefined,
    rollups: Array.isArray(row.rollups)
      ? (row.rollups as unknown as SemanticModel["rollups"])
      : undefined,
    parameters: Array.isArray(row.parameters)
      ? (row.parameters as unknown as SemanticModel["parameters"])
      : [],
    hierarchies: Array.isArray(row.hierarchies)
      ? (row.hierarchies as unknown as SemanticModel["hierarchies"])
      : [],
    joins: Array.isArray(row.joins) ? (row.joins as unknown as SemanticJoin[]) : [],
    dimensions: Array.isArray(row.dimensions)
      ? (row.dimensions as unknown as SemanticDimension[])
      : [],
    metrics: Array.isArray(row.metrics) ? (row.metrics as unknown as SemanticMetric[]) : [],
  };
}

/**
 * Scope models to what a caller may read. On user-JWT clients pass nothing —
 * RLS already returns own + IAM-shared models. On service-role (headless)
 * clients pass `ownerId` (+ `grantedIds` resolved from IAM) so we restrict to
 * the owner's own models plus any shared to them, mirroring RLS.
 */
export type ModelScope = { requesterId?: string; ownerId?: string; grantedIds?: string[] };

function applyScope<Q extends { eq: (c: string, v: string) => Q; or: (f: string) => Q }>(
  q: Q,
  scope?: ModelScope,
): Q {
  if (!scope?.ownerId) return q;
  const granted = (scope.grantedIds ?? []).filter((x) => UUID_RE.test(x));
  return granted.length
    ? q.or(`user_id.eq.${scope.ownerId},id.in.(${granted.join(",")})`)
    : q.eq("user_id", scope.ownerId);
}

export async function listSemanticModels(sb: Sb, scope?: ModelScope): Promise<SemanticModel[]> {
  const { data, error } = await applyScope(sb.from("semantic_models").select("*"), scope).order(
    "name",
  );
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToModel);
}

export async function loadSemanticModel(
  sb: Sb,
  ref: string,
  scope?: ModelScope,
): Promise<{ model: SemanticModel; row: SemanticModelRow } | null> {
  let q = sb.from("semantic_models").select("*");
  q = UUID_RE.test(ref) ? q.eq("id", ref) : q.eq("name", ref);
  const { data, error } = await applyScope(q, scope).limit(10);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  // On a name collision (own + a shared model with the same name) prefer own.
  const row = rows.find((r) => r.user_id === scope?.requesterId) ?? rows[0];
  if (!row) return null;
  return { model: rowToModel(row), row };
}

export type SemanticResult = {
  model: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /** The compiled SQL — surfaced for explainability/trust. */
  sql: string;
  /**
   * Present when the requester is a GRANTEE whose share carries restrictions:
   * a human-readable description of the enforced scope. Surfaced so a scoped
   * view is never mistaken for the global truth.
   */
  access_note?: string;
  /** Synonym resolutions applied to the request, e.g. `"turnover" resolved
   *  to "revenue" via synonym` — disclosed so the mapping is visible. */
  resolution_notes?: string[];
  /** Present when a declared ROLLUP answered instead of the fact table —
   *  the same fact the compiled SQL's leading comment states. */
  rollup?: string;
};

export async function runSemanticQuery(opts: {
  sb: Sb;
  /** The requester (used to prefer their own model on a name collision). */
  userId: string;
  /** When set (headless/service-role), gate models to this owner + their grants. */
  scopeUserId?: string;
  /** IAM-granted model ids for the scope user (headless paths). */
  grantedModelIds?: string[];
  query: SemanticQuery;
  maxRows?: number;
}): Promise<SemanticResult> {
  const loaded = await loadSemanticModel(opts.sb, opts.query.model, {
    requesterId: opts.userId,
    ownerId: opts.scopeUserId,
    grantedIds: opts.grantedModelIds,
  });
  if (!loaded) throw new Error(`Semantic model "${opts.query.model}" not found`);
  const { model, row } = loaded;
  // A metric IS the access boundary: once a caller may read the model, its
  // underlying data query runs AS THE MODEL OWNER — so a shared metric returns
  // the owner's data (not the grantee's, which would be wrong/empty).
  const ownerId = row.user_id;

  // A GRANTEE's share may carry a row filter and a field mask. Both are
  // enforced HERE — the single choke point every consumer flows through
  // (metric_query, the runner UI, BI widget refresh) — by rewriting the query
  // BEFORE compilation, so the restriction lands inside the compiled SQL
  // itself rather than being filtered after the owner's data came back.
  const requesterId = opts.scopeUserId ?? opts.userId;
  let query = opts.query;
  let accessNote: string | undefined;

  // Resolve business-vocabulary synonyms to canonical field names BEFORE
  // policy and compilation, so "turnover" maps to "revenue" here — once, for
  // every consumer — and a synonym of a MASKED field is still refused by the
  // policy check below (which sees the canonical name).
  const resolutionNotes: string[] = [];
  {
    const { resolveFieldName } = await import("@/lib/semanticLayer");
    const mapName = (n: string): string => {
      const r = resolveFieldName(model, n);
      if (r.note) resolutionNotes.push(r.note);
      return r.name;
    };
    query = {
      ...query,
      metrics: (query.metrics ?? []).map(mapName),
      dimensions: (query.dimensions ?? []).map(mapName),
      filters: (query.filters ?? []).map((f) => ({ ...f, field: mapName(f.field) })),
      orderBy: (query.orderBy ?? []).map((o) => ({ ...o, field: mapName(o.field) })),
      grains: query.grains
        ? Object.fromEntries(Object.entries(query.grains).map(([k, v]) => [mapName(k), v]))
        : undefined,
    };
  }
  if (requesterId && requesterId !== ownerId) {
    const { semanticPolicyFor } = await import("@/utils/semantic/policy.server");
    const { applyAccessPolicy, describePolicy, policyIsRestrictive } =
      await import("@/lib/semanticPolicy");
    const policy = await semanticPolicyFor(requesterId, row.id);
    if (policyIsRestrictive(policy)) {
      query = applyAccessPolicy(model, query, policy);
      accessNote = describePolicy(policy);
    }
  }

  if (model.source.kind === "warehouse") {
    if (!model.source.connectionId) {
      throw new Error(`Model "${model.name}" is a warehouse model but has no connection`);
    }
    // The connection belongs to the model owner. Verify + load with the service
    // role (a grantee's JWT can't read another user's connection under RLS).
    const { data: own } = await supabaseAdmin
      .from("data_warehouse_connections")
      .select("id")
      .eq("id", model.source.connectionId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!own) throw new Error("The model's warehouse connection is unavailable");
    const conn = await loadWarehouseConnection(
      supabaseAdmin,
      { connectionId: model.source.connectionId },
      ownerId,
    );
    const compiled = compileSemanticQuery(model, query, {
      dialect: conn.config.provider as SqlDialect,
    });
    const res = await executeWarehouseQuery(conn.config, compiled.sql, opts.maxRows ?? 1000);
    return {
      model: model.name,
      columns: compiled.columns,
      rows: res.rows,
      sql: compiled.sql,
      ...(compiled.rollup ? { rollup: compiled.rollup } : {}),
      ...(accessNote ? { access_note: accessNote } : {}),
      ...(resolutionNotes.length > 0 ? { resolution_notes: resolutionNotes } : {}),
    };
  }

  // Local datasets (AlaSQL over the OWNER's user_data_tables + samples).
  // Compile for whichever engine runLocalSqlForUser will use. Hard-coding
  // "alasql" emitted backtick identifiers and YEAR()/MONTH() over text
  // columns, both of which DuckDB rejects outright.
  const { localEngineName } = await import("@/utils/data/localEngine.server");
  const compiled = compileSemanticQuery(model, query, { dialect: await localEngineName() });
  const res = await runLocalSqlForUser(ownerId, compiled.sql);
  return {
    model: model.name,
    columns: compiled.columns,
    rows: res.rows,
    sql: compiled.sql,
    ...(compiled.rollup ? { rollup: compiled.rollup } : {}),
    ...(accessNote ? { access_note: accessNote } : {}),
    ...(resolutionNotes.length > 0 ? { resolution_notes: resolutionNotes } : {}),
  };
}
