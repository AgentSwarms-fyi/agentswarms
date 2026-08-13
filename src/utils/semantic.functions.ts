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
  JOIN_CARDINALITIES,
  MAX_JOINS,
  RELATIVE_DATE_OPS,
  type SemanticDimension,
  type SemanticMetric,
  type SemanticModel,
  type SemanticQuery,
  type SqlDialect,
} from "@/lib/semanticLayer";
import { runSemanticQuery } from "@/utils/semantic/query.server";
import {
  checkAssertions,
  measureCalendarHealth,
  measureModelHealth,
  sampleDimensionValues,
  type ExecRows,
  type JoinMeasurement,
  type ModelIssue,
  type ModelWarning,
} from "@/lib/semanticMeasure";

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

// Business words that mean this field — shown to agents and resolved by
// metric_query. Short and few: they ride in the system prompt.
const synonymsSchema = z.array(z.string().trim().min(1).max(40)).max(8).optional();

const dimensionSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sql: z.string().min(1),
  type: z.enum(["categorical", "time", "number", "boolean"]).optional(),
  synonyms: synonymsSchema,
  /** Sampled distinct values — written by Validate, capped hard. */
  values: z.array(z.string().max(80)).max(16).optional(),
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
  synonyms: synonymsSchema,
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
  cardinality: z.enum(JOIN_CARDINALITIES).optional(),
});

// Assertion filters must be ABSOLUTE. A relative op ("ytd", "last_month")
// resolves against today, so the pinned value would drift stale on its own —
// and an assertion that cries wolf by itself teaches people to ignore the
// ones that matter.
const ASSERTION_OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains"] as const;
const assertionFilterSchema = z.object({
  field: z.string().min(1),
  op: z
    .string()
    .superRefine((op, ctx) => {
      if ((RELATIVE_DATE_OPS as readonly string[]).includes(op)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Assertions must use absolute filters — "${op}" resolves against today, so the ` +
            `pinned value would go stale by itself. Pin an explicit date range (>= / <) instead.`,
        });
      } else if (!(ASSERTION_OPS as readonly string[]).includes(op)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown filter op "${op}"` });
      }
    })
    // Sound because the refinement above only admits ASSERTION_OPS, which is
    // a subset of FilterOp.
    .transform((op) => op as (typeof ASSERTION_OPS)[number]),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional(),
});

// Exported for tests: assertion rules are behavior (the relative-op refusal
// has a reason attached), and tests must exercise THIS schema, not a copy.
export const assertionSchema = z.object({
  metric: z.string().min(1).max(64),
  filters: z.array(assertionFilterSchema).max(16).optional(),
  expected: z.number().refine(Number.isFinite, "expected must be a finite number"),
  tolerance: z
    .number()
    .nonnegative()
    .refine(Number.isFinite, "tolerance must be finite")
    .optional(),
  label: z.string().max(200).optional(),
});

// A what-if input referenced as {{name}} in dimension/metric fragments.
// `default` is REQUIRED: Validate, assertions and scheduled widget refreshes
// all compile without caller-supplied params, and a parameter that breaks
// every unattended compile is a footgun, not a feature.
export const parameterSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Parameter name must be letters/digits/underscore"),
    type: z.enum(["number", "string"]),
    default: z.union([z.string().max(200), z.number().refine(Number.isFinite)]),
    label: z.string().max(120).optional(),
    description: z.string().max(300).optional(),
  })
  // Storing a default that can never compile would just defer the refusal to
  // the first unattended run — refuse it here, where the author can fix it.
  .refine((p) => p.type !== "number" || typeof p.default === "number", {
    message: "A number parameter needs a numeric default",
  })
  .refine((p) => !(typeof p.default === "string" && p.default.trim() === ""), {
    message: "Parameter default cannot be empty — Validate and refreshes compile with it",
  });

// A fiscal calendar TABLE: one row per day, mapping each day to its period
// per grain via a dense sequence number and the period's start date. Columns
// are strict bare identifiers — they are embedded as SQL structure. Exported
// for tests: the ≥1-grain rule and the exclusivity refine on the model are
// behavior, and tests must exercise THIS schema, not a copy.
const calendarIdent = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Calendar columns must be letters/digits/underscore");
export const calendarSchema = z.object({
  table: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
      "Unsafe calendar table reference",
    ),
  dateColumn: calendarIdent,
  grains: z
    .object({
      fiscal_year: z.object({ seq: calendarIdent, start: calendarIdent }).optional(),
      fiscal_quarter: z.object({ seq: calendarIdent, start: calendarIdent }).optional(),
      fiscal_period: z.object({ seq: calendarIdent, start: calendarIdent }).optional(),
      fiscal_week: z.object({ seq: calendarIdent, start: calendarIdent }).optional(),
    })
    .refine((g) => Object.values(g).some(Boolean), {
      message: "A fiscal calendar must map at least one grain",
    }),
});

// A declared drill path — level names are checked against the model's
// dimensions in validateNames-adjacent logic below, not here (zod can't see
// the sibling arrays).
export const hierarchySchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Hierarchy name must be letters/digits/underscore"),
  levels: z.array(z.string().min(1)).min(2).max(6),
});

const modelSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(64),
    label: z.string().optional(),
    description: z.string().optional(),
    source_kind: z.enum(["data_table", "warehouse"]),
    table_id: z.string().uuid().nullable().optional(),
    connection_id: z.string().uuid().nullable().optional(),
    source_table: z.string().min(1),
    // Owner-trusted fragment (same class as dimension sql); shape-limited only.
    primary_key: z.string().max(200).nullable().optional(),
    fiscal_year_start_month: z.number().int().min(1).max(12).nullable().optional(),
    calendar: calendarSchema.nullable().optional(),
    joins: z.array(joinSchema).max(MAX_JOINS).optional(),
    dimensions: z.array(dimensionSchema),
    metrics: z.array(metricSchema),
    assertions: z.array(assertionSchema).max(50).optional(),
    parameters: z.array(parameterSchema).max(20).optional(),
    hierarchies: z.array(hierarchySchema).max(10).optional(),
  })
  // Two fiscal declarations are two sources of truth for the same year;
  // whichever silently won, some number would answer a different question
  // than the model claims. (Month 1 is the UI's "calendar year" default and
  // carries no fiscal meaning of its own.)
  .refine((m) => !(m.calendar && m.fiscal_year_start_month && m.fiscal_year_start_month !== 1), {
    message:
      "Declare either a fiscal year start month or a fiscal calendar table, not both — " +
      "the calendar table would silently win.",
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

/**
 * A hierarchy that names a dimension the model doesn't have is a drill path
 * into nothing — refused at save, not discovered by an agent mid-drill.
 */
export function validateHierarchies(
  hierarchies: Array<{ name: string; levels: string[] }> | undefined,
  dims: SemanticDimension[],
) {
  const dimNames = new Set(dims.map((d) => d.name));
  for (const h of hierarchies ?? []) {
    const dup = h.levels.find((lvl, i) => h.levels.indexOf(lvl) !== i);
    if (dup) throw new Error(`Hierarchy "${h.name}" repeats level "${dup}".`);
    for (const lvl of h.levels) {
      if (!dimNames.has(lvl)) {
        throw new Error(
          `Hierarchy "${h.name}" references "${lvl}", which is not a dimension on this model ` +
            `(dimensions: ${[...dimNames].join(", ") || "none"}).`,
        );
      }
    }
  }
}

export const semanticListModels = createServerFn({ method: "GET" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => {
    const { sb, userId } = await requireUser(data.accessToken);
    const { data: rows, error } = await sb.from("semantic_models").select("*").order("name");
    if (error) throw new Error(error.message);
    const models = rows ?? [];

    // For SHARED models, attach the viewer's enforced share policy so the UI
    // can say so out loud — a grantee looking at scoped numbers should never
    // have to guess that they are scoped. Enforcement itself lives in
    // runSemanticQuery; this is the disclosure half.
    const sharedIds = models.filter((r) => r.user_id !== userId).map((r) => r.id);
    if (sharedIds.length === 0) return models;
    try {
      const { semanticPoliciesFor } = await import("@/utils/semantic/policy.server");
      const { policyIsRestrictive } = await import("@/lib/semanticPolicy");
      const policies = await semanticPoliciesFor(userId, sharedIds);
      return models.map((r) => {
        const p = policies.get(r.id);
        return policyIsRestrictive(p ?? null)
          ? { ...r, viewer_policy: { row_filters: p!.rowFilters, masked_fields: p!.maskedFields } }
          : r;
      });
    } catch {
      // Disclosure must not take the page down; enforcement does not live here.
      return models;
    }
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
    validateHierarchies(m.hierarchies, m.dimensions);
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
      primary_key: m.primary_key?.trim() ? m.primary_key.trim() : null,
      fiscal_year_start_month: m.fiscal_year_start_month ?? null,
      calendar: (m.calendar ?? null) as never,
      parameters: (m.parameters ?? []) as never,
      hierarchies: (m.hierarchies ?? []) as never,
      joins: (m.joins ?? []) as never,
      dimensions: m.dimensions as never,
      metrics: m.metrics as never,
      assertions: (m.assertions ?? []) as never,
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
    return {
      model: res.model,
      columns: res.columns,
      sql: res.sql,
      rows,
      access_note: res.access_note,
    };
  });

/**
 * Dry-run a model without saving. Two layers, deliberately in this order:
 *
 * 1. COMPILE + RUN each field (LIMIT 1) — catches typo'd columns and, since
 *    fan-out enforcement landed, every metric the compiler now refuses.
 * 2. MEASURE what declarations alone cannot prove: COUNT probes for each
 *    join's real cardinality and the primary key's uniqueness, then the
 *    pinned assertions re-computed against the live backend. Step 1 says
 *    "the SQL runs"; step 2 says "the numbers are still the ones you signed
 *    off" — which is the promise a semantic layer actually makes.
 */
export type ModelValidationReport = {
  ok: boolean;
  issues: ModelIssue[];
  warnings: ModelWarning[];
  measured: JoinMeasurement[];
  checked: number;
  /**
   * Freshly sampled distinct values per LOW-CARDINALITY categorical
   * dimension. The editor merges these into the draft so the next Save
   * persists them — measured from the source, never authored folklore.
   */
  sampledValues: Record<string, string[]>;
};

export const semanticValidateModel = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; model: z.input<typeof modelSchema> }) => d)
  .handler(async ({ data }): Promise<ModelValidationReport> => {
    const { sb, userId } = await requireUser(data.accessToken);
    return validateModelPayload(sb, userId, data.model);
  });

/**
 * The full validation pipeline as a callable: zod + name rules, per-field
 * compile+run probes, join/grain measurement, assertions. Shared by the
 * Validate endpoint and by CERTIFICATION, which refuses to stamp a model this
 * pipeline finds anything wrong with — "certified" must mean "measured clean",
 * not "someone clicked a button".
 */
async function validateModelPayload(
  sb: ReturnType<typeof userClient>,
  userId: string,
  payload: z.input<typeof modelSchema>,
): Promise<ModelValidationReport> {
  const issues: ModelIssue[] = [];
  let m: z.output<typeof modelSchema>;
  try {
    m = modelSchema.parse(payload);
    validateNames(m.dimensions, m.metrics);
    validateHierarchies(m.hierarchies, m.dimensions);
  } catch (e) {
    return {
      ok: false,
      checked: 0,
      warnings: [],
      measured: [],
      sampledValues: {},
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
    primaryKey: m.primary_key ?? undefined,
    fiscalYearStartMonth: m.fiscal_year_start_month ?? undefined,
    calendar: m.calendar ?? undefined,
    parameters: m.parameters ?? [],
    hierarchies: m.hierarchies ?? [],
    joins: m.joins ?? [],
    dimensions: m.dimensions,
    metrics: m.metrics,
  };

  // Resolve the execution backend once (dialect + runner), then probe each
  // field. Warehouse connections are verified as the caller's own.
  let dialect: SqlDialect = "alasql";
  let exec: ExecRows;
  if (m.source_kind === "warehouse") {
    const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
    const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
    try {
      const conn = await loadWarehouseConnectionForUser(
        sb,
        { connectionId: m.connection_id ?? "" },
        userId,
      );
      dialect = conn.config.provider as SqlDialect;
      exec = async (sql) => (await executeWarehouseQuery(conn.config, sql, 10)).rows;
    } catch (e) {
      return {
        ok: false,
        checked: 0,
        warnings: [],
        measured: [],
        sampledValues: {},
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
    const run = await localSqlRunnerForUser(userId);
    exec = async (sql) => (await run(sql)).rows;
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

  // Measure joins + grain against the data, then re-compute assertions.
  const health = await measureModelHealth(exec, model, dialect);
  issues.push(...health.issues);
  checked += health.measured.length;
  // The fiscal calendar table is a declaration too — measured, not trusted.
  const calHealth = await measureCalendarHealth(exec, model, dialect);
  issues.push(...calHealth.issues);
  if (model.calendar) checked += 1;
  const asserted = await checkAssertions(exec, model, m.assertions ?? [], dialect);
  issues.push(...asserted.issues);
  checked += asserted.checked;

  // Refresh sampled values for the agent catalog while we have a live runner.
  const sampledValues = await sampleDimensionValues(exec, model, dialect);

  return {
    ok: issues.length === 0,
    issues,
    warnings: [...health.warnings, ...calHealth.warnings],
    measured: health.measured,
    checked,
    sampledValues,
  };
}

/** Row → the zod payload shape, for re-validating stored/snapshot definitions. */
function rowToModelPayload(row: Record<string, unknown>): z.input<typeof modelSchema> {
  return {
    name: String(row.name ?? ""),
    label: (row.label as string) ?? undefined,
    description: (row.description as string) ?? undefined,
    source_kind: (row.source_kind === "warehouse" ? "warehouse" : "data_table") as
      | "warehouse"
      | "data_table",
    table_id: (row.table_id as string) ?? null,
    connection_id: (row.connection_id as string) ?? null,
    source_table: String(row.source_table ?? ""),
    primary_key: (row.primary_key as string) ?? null,
    fiscal_year_start_month: (row.fiscal_year_start_month as number) ?? null,
    calendar: (row.calendar as z.input<typeof calendarSchema>) ?? null,
    parameters: Array.isArray(row.parameters)
      ? (row.parameters as z.input<typeof parameterSchema>[])
      : [],
    hierarchies: Array.isArray(row.hierarchies)
      ? (row.hierarchies as z.input<typeof hierarchySchema>[])
      : [],
    joins: Array.isArray(row.joins) ? (row.joins as z.input<typeof joinSchema>[]) : [],
    dimensions: Array.isArray(row.dimensions)
      ? (row.dimensions as z.input<typeof dimensionSchema>[])
      : [],
    metrics: Array.isArray(row.metrics) ? (row.metrics as z.input<typeof metricSchema>[]) : [],
    assertions: Array.isArray(row.assertions)
      ? (row.assertions as z.input<typeof assertionSchema>[])
      : [],
  };
}

/**
 * Set a model's certification status.
 *
 * CERTIFYING RE-RUNS THE FULL VALIDATION PIPELINE and refuses on any issue —
 * the badge is a measured claim ("validated clean by U at T"), never an
 * opinion. The certified_by/certified_at stamps are set HERE, server-side; and
 * a DB trigger drops certification whenever the definition later changes, so
 * the stamp always refers to the definition that was actually validated.
 */
export const semanticSetModelStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; id: string; status: string }) => d)
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; status: string } | { ok: false; error: string; issues?: ModelIssue[] }
    > => {
      const { sb, userId } = await requireUser(data.accessToken);
      if (!["draft", "certified", "deprecated"].includes(data.status)) {
        return { ok: false, error: `Unknown status "${data.status}"` };
      }
      const { data: row, error } = await sb
        .from("semantic_models")
        .select("*")
        .eq("id", data.id)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!row) return { ok: false, error: "Model not found" };
      if (row.user_id !== userId) {
        return { ok: false, error: "Only the model's owner can change its status." };
      }

      if (data.status === "certified") {
        const report = await validateModelPayload(sb, userId, rowToModelPayload(row));
        if (!report.ok) {
          return {
            ok: false,
            error: `Cannot certify: ${report.issues.length} validation check(s) fail. Fix them first — a certificate on a failing model is worse than none.`,
            issues: report.issues,
          };
        }
      }

      const { error: upErr } = await sb
        .from("semantic_models")
        .update(
          data.status === "certified"
            ? {
                status: "certified",
                certified_by: userId,
                certified_at: new Date().toISOString(),
              }
            : { status: data.status, certified_by: null, certified_at: null },
        )
        .eq("id", data.id);
      if (upErr) return { ok: false, error: upErr.message };
      return { ok: true, status: data.status };
    },
  );

/** Version history for a model (newest first). Owner-only via RLS. */
export const semanticListVersions = createServerFn({ method: "GET" })
  .inputValidator((d: { accessToken: string; modelId: string }) => d)
  .handler(async ({ data }) => {
    const { sb } = await requireUser(data.accessToken);
    const { data: rows, error } = await sb
      .from("semantic_model_versions")
      .select("id, model_id, changed_by, definition, created_at")
      .eq("model_id", data.modelId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/**
 * Restore a model to a snapshotted definition.
 *
 * The snapshot goes BACK THROUGH zod before it is written — history is
 * trigger-written and RLS-protected, but a restore path that trusts stored
 * bytes more than live input is a downgrade waiting for a reason. The update
 * itself is a normal owner write, so the capture trigger snapshots the
 * pre-restore state: restore is always undoable, including restoring the
 * restore.
 */
export const semanticRestoreVersion = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; versionId: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { sb, userId } = await requireUser(data.accessToken);
    const { data: version, error } = await sb
      .from("semantic_model_versions")
      .select("id, model_id, definition")
      .eq("id", data.versionId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!version) return { ok: false, error: "Version not found" };

    let m: z.output<typeof modelSchema>;
    try {
      m = modelSchema.parse(rowToModelPayload(version.definition as Record<string, unknown>));
      validateNames(m.dimensions, m.metrics);
      validateHierarchies(m.hierarchies, m.dimensions);
    } catch (e) {
      return {
        ok: false,
        error: `This snapshot no longer passes validation and was not restored: ${
          e instanceof Error ? e.message : "invalid definition"
        }`,
      };
    }

    const { error: upErr } = await sb
      .from("semantic_models")
      .update({
        name: m.name,
        label: m.label ?? null,
        description: m.description ?? null,
        source_kind: m.source_kind,
        table_id: m.table_id ?? null,
        connection_id: m.connection_id ?? null,
        source_table: m.source_table,
        primary_key: m.primary_key?.trim() ? m.primary_key.trim() : null,
        fiscal_year_start_month: m.fiscal_year_start_month ?? null,
        calendar: (m.calendar ?? null) as never,
        parameters: (m.parameters ?? []) as never,
        hierarchies: (m.hierarchies ?? []) as never,
        joins: (m.joins ?? []) as never,
        dimensions: m.dimensions as never,
        metrics: m.metrics as never,
        assertions: (m.assertions ?? []) as never,
      })
      .eq("id", version.model_id)
      .eq("user_id", userId);
    if (upErr) return { ok: false, error: upErr.message };
    return { ok: true };
  });

/**
 * Everything that would move if this model changed: metric-backed widgets,
 * agents and swarm nodes allow-listing it, and (owner only) who it is shared
 * with. The scanners are pure (lib/semanticDependents); this fn just feeds
 * them the caller's visible rows.
 */
export const semanticModelDependents = createServerFn({ method: "GET" })
  .inputValidator((d: { accessToken: string; modelId: string }) => d)
  .handler(async ({ data }) => {
    const { sb, userId } = await requireUser(data.accessToken);
    const { data: row, error } = await sb
      .from("semantic_models")
      .select("id, name, user_id")
      .eq("id", data.modelId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Model not found");

    const { scanDashboardsForModel, scanAgentsForModel, scanSwarmsForModel } =
      await import("@/lib/semanticDependents");

    const [dashRes, agentRes, swarmRes] = await Promise.all([
      sb.from("bi_dashboards").select("id, name, widgets"),
      sb.from("agents").select("id, name, tools"),
      sb.from("swarms").select("id, name, nodes, published_nodes"),
    ]);

    const dashboards = scanDashboardsForModel(dashRes.data ?? [], row.name);
    const agents = scanAgentsForModel(agentRes.data ?? [], row.name);
    const swarms = scanSwarmsForModel(swarmRes.data ?? [], row.name);

    // Grants are enumerated for the OWNER only — a grantee must not be able
    // to list who else a model is shared with.
    let sharedWith: Array<{ principal_type: string; principal_id: string }> = [];
    if (row.user_id === userId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: grants } = await supabaseAdmin
        .from("iam_resource_grants")
        .select("principal_type, principal_id")
        .eq("resource_type", "semantic_model")
        .eq("resource_id", row.id);
      sharedWith = grants ?? [];
    }

    return { model: row.name, dashboards, agents, swarms, sharedWith };
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
