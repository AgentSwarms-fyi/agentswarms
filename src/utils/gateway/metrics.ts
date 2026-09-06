// The metrics API's dependency-free pieces: the request a client sends to
// /api/v1/metrics/query, checked field by field before anything touches a
// model; how a semantic model is described to a client (names, labels,
// types and vocabulary - never the owner's SQL fragments); the key's model
// allow-list; and the result body. Imported by the server module, the UI
// and the tests, so nothing here may touch the database.
import {
  COMPARE_PERIODS,
  RELATIVE_DATE_OPS,
  TIME_GRAINS,
  type ComparePeriod,
  type FilterOp,
  type SemanticFilter,
  type SemanticModel,
  type SemanticQuery,
  type TimeGrain,
} from "@/lib/semanticLayer";

/** Comparison operators a filter may use, beside the relative-date windows. */
export const COMPARISON_OPS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "in",
  "not_in",
  "contains",
] as const;
export const METRICS_FILTER_OPS = [...COMPARISON_OPS, ...RELATIVE_DATE_OPS] as const;

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_FIELDS = 50;
const MAX_FILTERS = 50;
const MAX_ORDER = 10;
export const MAX_METRICS_LIMIT = 1_000_000;

export type ParsedMetricsQuery = { ok: true; query: SemanticQuery } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function names(v: unknown, field: string, max = MAX_FIELDS): string[] | string {
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list)) return `${field} must be an array of field names`;
  if (list.length > max) return `${field} may name at most ${max} fields`;
  const out: string[] = [];
  for (const [i, n] of list.entries()) {
    if (typeof n !== "string" || !n.trim()) return `${field}[${i}] must be a field name`;
    const t = n.trim();
    if (t.length > 120 || !NAME_RE.test(t)) {
      return `${field}[${i}] "${t.slice(0, 40)}" is not a field name (letters, digits and _)`;
    }
    out.push(t);
  }
  return out;
}

function scalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Check a client's query body. Every refusal names the field and what was
 * expected, because the caller is a program and "invalid request" sends its
 * author to the docs when the message could have said `filters[1].op`.
 * Nothing here decides whether a name exists on the model - the compiler
 * does that, against the model the request is allowed to see.
 */
export function parseMetricsQueryRequest(body: unknown): ParsedMetricsQuery {
  if (!isRecord(body)) return { ok: false, error: "The body must be a JSON object" };
  const fail = (error: string): ParsedMetricsQuery => ({ ok: false, error });

  const model = body.model;
  if (typeof model !== "string" || !model.trim()) {
    return fail('"model" is required: a semantic model name or id from GET /api/v1/metrics');
  }
  if (model.length > 200) return fail('"model" is too long');

  const metrics = names(body.metrics, "metrics");
  if (typeof metrics === "string") return fail(metrics);
  const dimensions = names(body.dimensions, "dimensions");
  if (typeof dimensions === "string") return fail(dimensions);
  if (metrics.length === 0 && dimensions.length === 0) {
    return fail('Name at least one metric in "metrics" (or one dimension in "dimensions")');
  }

  const filters: SemanticFilter[] = [];
  if (body.filters !== undefined && body.filters !== null) {
    if (!Array.isArray(body.filters)) return fail('"filters" must be an array');
    if (body.filters.length > MAX_FILTERS) return fail(`At most ${MAX_FILTERS} filters`);
    for (const [i, f] of body.filters.entries()) {
      if (!isRecord(f)) return fail(`filters[${i}] must be an object with field, op and value`);
      const field = typeof f.field === "string" ? f.field.trim() : "";
      if (!field || !NAME_RE.test(field)) return fail(`filters[${i}].field must be a field name`);
      const op = typeof f.op === "string" ? f.op : "";
      if (!(METRICS_FILTER_OPS as readonly string[]).includes(op)) {
        return fail(
          `filters[${i}].op "${op.slice(0, 30)}" is not one of ${METRICS_FILTER_OPS.join(", ")}`,
        );
      }
      const value = f.value;
      if (op === "in" || op === "not_in") {
        if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
          return fail(`filters[${i}].value must be a non-empty array for op "${op}"`);
        }
        if (!value.every((x) => typeof x === "string" || typeof x === "number")) {
          return fail(`filters[${i}].value must hold strings or numbers`);
        }
        filters.push({ field, op: op as FilterOp, value: value as Array<string | number> });
        continue;
      }
      if (op === "last_n_days") {
        const n = typeof value === "string" ? Number(value) : value;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 36_500) {
          return fail(`filters[${i}].value must be a whole number of days for last_n_days`);
        }
        filters.push({ field, op, value: n });
        continue;
      }
      if ((RELATIVE_DATE_OPS as readonly string[]).includes(op)) {
        filters.push({ field, op: op as FilterOp });
        continue;
      }
      if (!scalar(value)) return fail(`filters[${i}].value must be a string, number or boolean`);
      filters.push({ field, op: op as FilterOp, value });
    }
  }

  let grains: Record<string, TimeGrain> | undefined;
  if (body.grains !== undefined && body.grains !== null) {
    if (!isRecord(body.grains)) return fail('"grains" must be an object of dimension -> grain');
    grains = {};
    for (const [k, g] of Object.entries(body.grains)) {
      if (!NAME_RE.test(k)) return fail(`grains: "${k.slice(0, 40)}" is not a dimension name`);
      if (typeof g !== "string" || !(TIME_GRAINS as readonly string[]).includes(g)) {
        return fail(`grains.${k} must be one of ${TIME_GRAINS.join(", ")}`);
      }
      grains[k] = g as TimeGrain;
    }
    if (Object.keys(grains).length === 0) grains = undefined;
  }

  const orderRaw = body.order_by ?? body.orderBy;
  let orderBy: SemanticQuery["orderBy"];
  if (orderRaw !== undefined && orderRaw !== null) {
    const list = Array.isArray(orderRaw) ? orderRaw : [orderRaw];
    if (list.length > MAX_ORDER) return fail(`At most ${MAX_ORDER} order_by entries`);
    orderBy = [];
    for (const [i, o] of list.entries()) {
      const field =
        typeof o === "string"
          ? o.trim()
          : isRecord(o) && typeof o.field === "string"
            ? o.field.trim()
            : "";
      if (!field || !NAME_RE.test(field)) return fail(`order_by[${i}] must name a field`);
      const dir = isRecord(o) ? o.dir : undefined;
      if (dir !== undefined && dir !== "asc" && dir !== "desc") {
        return fail(`order_by[${i}].dir must be "asc" or "desc"`);
      }
      orderBy.push(dir ? { field, dir } : { field });
    }
  }

  let limit: number | undefined;
  if (body.limit !== undefined && body.limit !== null) {
    const n = typeof body.limit === "string" ? Number(body.limit) : body.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_METRICS_LIMIT) {
      return fail(`"limit" must be a whole number from 1 to ${MAX_METRICS_LIMIT}`);
    }
    limit = n;
  }

  let compare: ComparePeriod | undefined;
  if (body.compare !== undefined && body.compare !== null) {
    if (
      typeof body.compare !== "string" ||
      !(COMPARE_PERIODS as readonly string[]).includes(body.compare)
    ) {
      return fail(`"compare" must be one of ${COMPARE_PERIODS.join(", ")}`);
    }
    compare = body.compare as ComparePeriod;
  }

  let params: Record<string, string | number> | undefined;
  if (body.params !== undefined && body.params !== null) {
    if (!isRecord(body.params)) return fail('"params" must be an object of parameter -> value');
    params = {};
    for (const [k, v] of Object.entries(body.params)) {
      if (!NAME_RE.test(k)) return fail(`params: "${k.slice(0, 40)}" is not a parameter name`);
      if (typeof v !== "string" && typeof v !== "number") {
        return fail(`params.${k} must be a string or a number`);
      }
      params[k] = v;
    }
    if (Object.keys(params).length === 0) params = undefined;
  }

  const query: SemanticQuery = { model: model.trim(), metrics };
  if (dimensions.length) query.dimensions = dimensions;
  if (filters.length) query.filters = filters;
  if (grains) query.grains = grains;
  if (orderBy && orderBy.length) query.orderBy = orderBy;
  if (limit !== undefined) query.limit = limit;
  if (compare) query.compare = compare;
  if (params) query.params = params;
  return { ok: true, query };
}

/** With the metrics scope, an empty allow-list means every model the owner may read. */
export function semanticModelAllowedByKey(
  allow: readonly string[] | null | undefined,
  modelId: string | undefined,
): boolean {
  if (!allow || allow.length === 0) return true;
  return Boolean(modelId) && allow.includes(modelId as string);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request names a model by id or by name. On a name collision between the
 * owner's own model and one shared with them, the owner's wins - the same
 * rule the semantic layer applies everywhere.
 */
export function findSemanticModelByRef(
  models: readonly SemanticModel[],
  ref: string,
  requesterId?: string,
): SemanticModel | undefined {
  const r = ref.trim();
  if (UUID_RE.test(r)) return models.find((m) => m.id?.toLowerCase() === r.toLowerCase());
  const hits = models.filter((m) => m.name === r);
  return hits.find((m) => m.ownerId === requesterId) ?? hits[0];
}

export type ApiModelDescription = {
  object: "semantic_model";
  id: string;
  name: string;
  label?: string;
  description?: string;
  status?: string;
  /** Where the model's rows come from: a platform dataset or lakehouse table, or a connected warehouse. */
  source: "data_table" | "warehouse";
  /** True when the model is shared with the key's owner rather than owned. */
  shared: boolean;
  metrics: Array<{
    name: string;
    label?: string;
    description?: string;
    agg: string;
    format?: string;
    currency?: string;
    synonyms?: string[];
  }>;
  dimensions: Array<{
    name: string;
    label?: string;
    description?: string;
    type?: string;
    synonyms?: string[];
    values?: string[];
  }>;
  parameters: Array<{
    name: string;
    type: string;
    default?: string | number;
    label?: string;
    description?: string;
    required: boolean;
  }>;
  hierarchies: Array<{ name: string; levels: string[] }>;
  /** Grains a time dimension accepts; empty when the model has no time dimension. */
  time_grains: string[];
  /** Period-over-period comparisons; empty when the model has no time dimension. */
  compare: string[];
  filter_ops: string[];
  /** Present when the key's owner sees a restricted share: what the restriction is. */
  access_note?: string;
};

/**
 * What a client is told about a model: the vocabulary it can query with.
 * The owner's SQL fragments, joins and rollup tables stay private - they are
 * the definition, and a client needs the names, not the implementation.
 */
export function describeModelForApi(
  model: SemanticModel,
  opts: { requesterId?: string; accessNote?: string } = {},
): ApiModelDescription {
  const hasTime = model.dimensions.some((d) => d.type === "time");
  const strip = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return strip({
    object: "semantic_model" as const,
    id: model.id ?? "",
    name: model.name,
    label: model.label,
    description: model.description,
    status: model.status,
    source: model.source.kind,
    shared: Boolean(opts.requesterId && model.ownerId && model.ownerId !== opts.requesterId),
    metrics: model.metrics.map((m) =>
      strip({
        name: m.name,
        label: m.label,
        description: m.description,
        agg: m.agg,
        format: m.format,
        currency: m.currency,
        synonyms: m.synonyms?.length ? m.synonyms : undefined,
      }),
    ),
    dimensions: model.dimensions.map((d) =>
      strip({
        name: d.name,
        label: d.label,
        description: d.description,
        type: d.type,
        synonyms: d.synonyms?.length ? d.synonyms : undefined,
        values: d.values?.length ? d.values.slice(0, 50) : undefined,
      }),
    ),
    parameters: (model.parameters ?? []).map((p) =>
      strip({
        name: p.name,
        type: p.type,
        default: p.default,
        label: p.label,
        description: p.description,
        required: p.default === undefined,
      }),
    ),
    hierarchies: (model.hierarchies ?? []).map((h) => ({ name: h.name, levels: [...h.levels] })),
    time_grains: hasTime ? [...TIME_GRAINS] : [],
    compare: hasTime ? [...COMPARE_PERIODS] : [],
    filter_ops: [...METRICS_FILTER_OPS],
    access_note: opts.accessNote,
  });
}

export type MetricsCell = string | number | boolean | null;

export type MetricsResultBody = {
  object: "metrics.result";
  model: string;
  columns: string[];
  rows: Record<string, MetricsCell>[];
  row_count: number;
  /** True when more rows matched than the cap allowed; the rows are the first `row_count`. */
  truncated: boolean;
  /** The compiled SQL, for explainability - the same text the runner and the agent tool show. */
  sql: string;
  access_note?: string;
  rollup?: string;
  resolution_notes?: string[];
};

/** A cell as JSON can carry it: dates as ISO strings, bigints as numbers when exact. */
export function toMetricsCell(v: unknown): MetricsCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return String(v);
}

/**
 * The response body. `cap` is the most rows the caller may receive; the
 * query fetched one more, so "exactly cap rows" and "more than cap rows"
 * are told apart and `truncated` is a fact, not a guess.
 */
export function metricsResultBody(
  res: {
    model: string;
    columns: string[];
    rows: Record<string, unknown>[];
    sql: string;
    access_note?: string;
    rollup?: string;
    resolution_notes?: string[];
  },
  cap: number,
): MetricsResultBody {
  const truncated = res.rows.length > cap;
  const rows = (truncated ? res.rows.slice(0, cap) : res.rows).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toMetricsCell(v)])),
  );
  return {
    object: "metrics.result",
    model: res.model,
    columns: res.columns,
    rows,
    row_count: rows.length,
    truncated,
    sql: res.sql,
    ...(res.access_note ? { access_note: res.access_note } : {}),
    ...(res.rollup ? { rollup: res.rollup } : {}),
    ...(res.resolution_notes?.length ? { resolution_notes: res.resolution_notes } : {}),
  };
}
