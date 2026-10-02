// The metrics API: gateway keys reaching the semantic layer. Pinned here:
// the request parser (every refusal names its field, each rule with a
// negative case), how a model is described to a client (vocabulary, never
// SQL), the key's allow-list and the name resolution, the result body's
// truncation and cell coercion, and the wiring - the routes authenticate
// and check the scope first, the query runs as the key's OWNER through
// runSemanticQuery and audits metric.query like the agent tool, the scope
// and column exist in the migration and the trigger, the cap is a setting,
// and the docs say so.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SemanticModel } from "@/lib/semanticLayer";
import {
  COMPARISON_OPS,
  MAX_METRICS_LIMIT,
  METRICS_FILTER_OPS,
  describeModelForApi,
  findSemanticModelByRef,
  metricsResultBody,
  parseMetricsQueryRequest,
  semanticModelAllowedByKey,
  toMetricsCell,
} from "@/utils/gateway/metrics";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const parse = (body: unknown) => parseMetricsQueryRequest(body);
const refused = (body: unknown): string => {
  const r = parse(body);
  if (r.ok) throw new Error("expected a refusal, got " + JSON.stringify(r.query));
  return r.error;
};

describe("the query request", () => {
  it("accepts the full shape and drops what was not given", () => {
    const r = parse({
      model: "revenue",
      metrics: ["net_revenue", "orders"],
      dimensions: ["region", "order_date"],
      filters: [
        { field: "region", op: "in", value: ["EMEA", "APAC"] },
        { field: "order_date", op: "last_n_days", value: "90" },
        { field: "order_date", op: "this_month" },
        { field: "net_revenue", op: ">", value: 100 },
      ],
      grains: { order_date: "month" },
      order_by: [{ field: "order_date", dir: "desc" }, "region"],
      limit: "500",
      compare: "yoy",
      params: { min_amount: 10, currency: "EUR" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query).toEqual({
      model: "revenue",
      metrics: ["net_revenue", "orders"],
      dimensions: ["region", "order_date"],
      filters: [
        { field: "region", op: "in", value: ["EMEA", "APAC"] },
        { field: "order_date", op: "last_n_days", value: 90 },
        { field: "order_date", op: "this_month" },
        { field: "net_revenue", op: ">", value: 100 },
      ],
      grains: { order_date: "month" },
      orderBy: [{ field: "order_date", dir: "desc" }, { field: "region" }],
      limit: 500,
      compare: "yoy",
      params: { min_amount: 10, currency: "EUR" },
    });
    // orderBy is the semantic layer's spelling; a client may use it too.
    const alt = parse({ model: "m", metrics: ["x"], orderBy: [{ field: "x" }] });
    expect(alt.ok && alt.query.orderBy).toEqual([{ field: "x" }]);
    // A lone dimension is a valid question (a distinct list).
    expect(parse({ model: "m", dimensions: "region" }).ok).toBe(true);
    const bare = parse({ model: " m ", metrics: ["x"] });
    expect(bare.ok && bare.query).toEqual({ model: "m", metrics: ["x"] });
  });

  it("refuses each mistake by name", () => {
    expect(refused("nope")).toContain("JSON object");
    expect(refused({})).toContain('"model" is required');
    expect(refused({ model: "m" })).toContain("at least one metric");
    expect(refused({ model: "m", metrics: ["ok", "not ok"] })).toContain("metrics[1]");
    expect(refused({ model: "m", metrics: ["x"], dimensions: [3] })).toContain("dimensions[0]");
    expect(refused({ model: "m", metrics: ["x"], filters: "region = 1" })).toContain(
      '"filters" must be an array',
    );
    expect(
      refused({ model: "m", metrics: ["x"], filters: [{ field: "r", op: "like" }] }),
    ).toContain('filters[0].op "like" is not one of');
    expect(
      refused({ model: "m", metrics: ["x"], filters: [{ field: "r", op: "in", value: "EMEA" }] }),
    ).toContain("filters[0].value must be a non-empty array");
    expect(
      refused({
        model: "m",
        metrics: ["x"],
        filters: [{ field: "d", op: "last_n_days", value: "soon" }],
      }),
    ).toContain("whole number of days");
    expect(
      refused({ model: "m", metrics: ["x"], filters: [{ field: "r", op: "=", value: { a: 1 } }] }),
    ).toContain("filters[0].value must be a string, number or boolean");
    expect(refused({ model: "m", metrics: ["x"], grains: { d: "fortnight" } })).toContain(
      "grains.d must be one of",
    );
    expect(
      refused({ model: "m", metrics: ["x"], order_by: [{ field: "x", dir: "down" }] }),
    ).toContain('order_by[0].dir must be "asc" or "desc"');
    expect(refused({ model: "m", metrics: ["x"], limit: 0 })).toContain(
      '"limit" must be a whole number',
    );
    expect(refused({ model: "m", metrics: ["x"], limit: MAX_METRICS_LIMIT + 1 })).toContain(
      '"limit"',
    );
    expect(refused({ model: "m", metrics: ["x"], compare: "wow" })).toContain(
      '"compare" must be one of',
    );
    expect(refused({ model: "m", metrics: ["x"], params: { p: true } })).toContain(
      "params.p must be",
    );
    expect(refused({ model: "m", metrics: ["x"], params: { "bad name": 1 } })).toContain(
      'params: "bad name"',
    );
    // A name that could carry SQL is refused as a name, whatever it holds.
    expect(refused({ model: "m", metrics: ["revenue; drop table"] })).toContain("not a field name");
  });

  it("knows the comparison ops and the relative windows, and nothing else", () => {
    expect([...COMPARISON_OPS]).toEqual([
      "=",
      "!=",
      ">",
      ">=",
      "<",
      "<=",
      "in",
      "not_in",
      "contains",
    ]);
    expect(METRICS_FILTER_OPS).toContain("last_n_days");
    expect(METRICS_FILTER_OPS).toContain("fiscal_ytd");
    expect(METRICS_FILTER_OPS).not.toContain("like");
  });
});

const model = (over: Partial<SemanticModel> = {}): SemanticModel => ({
  id: "11111111-2222-4333-8444-555555555555",
  ownerId: "owner",
  name: "revenue",
  label: "Revenue",
  description: "Net revenue by order",
  status: "certified",
  source: { kind: "data_table", table: "orders" },
  parameters: [
    { name: "min_amount", type: "number", default: 0 },
    { name: "currency", type: "string", label: "Currency" },
  ],
  hierarchies: [{ name: "geo", levels: ["region", "country"] }],
  dimensions: [
    {
      name: "region",
      sql: "region",
      type: "categorical",
      synonyms: ["market"],
      values: ["EMEA", "APAC"],
    },
    { name: "order_date", sql: "created_at", type: "time" },
  ],
  metrics: [
    {
      name: "net_revenue",
      sql: "SUM(net) - SUM(refunds)",
      agg: "custom",
      format: "currency",
      currency: "USD",
    },
    { name: "orders", agg: "count" },
  ],
  ...over,
});

describe("a model described to a client", () => {
  it("carries the vocabulary and never the SQL, and says when a time dimension unlocks grains", () => {
    const d = describeModelForApi(model(), { requesterId: "owner" });
    expect(d.object).toBe("semantic_model");
    expect(d.name).toBe("revenue");
    expect(d.shared).toBe(false);
    expect(d.source).toBe("data_table");
    expect(d.metrics).toEqual([
      { name: "net_revenue", agg: "custom", format: "currency", currency: "USD" },
      { name: "orders", agg: "count" },
    ]);
    expect(d.dimensions[0]).toEqual({
      name: "region",
      type: "categorical",
      synonyms: ["market"],
      values: ["EMEA", "APAC"],
    });
    expect(d.parameters).toEqual([
      { name: "min_amount", type: "number", default: 0, required: false },
      { name: "currency", type: "string", label: "Currency", required: true },
    ]);
    expect(d.hierarchies).toEqual([{ name: "geo", levels: ["region", "country"] }]);
    expect(d.time_grains).toContain("month");
    expect(d.compare).toEqual(["prior_period", "mom", "yoy"]);
    expect(JSON.stringify(d)).not.toContain("SUM(");
    expect(JSON.stringify(d)).not.toContain("created_at");
    expect("access_note" in d).toBe(false);

    const noTime = describeModelForApi(
      model({ dimensions: [{ name: "region", sql: "region", type: "categorical" }] }),
    );
    expect(noTime.time_grains).toEqual([]);
    expect(noTime.compare).toEqual([]);
  });

  it("marks a shared model and carries the restriction it was listed with", () => {
    const d = describeModelForApi(model({ ownerId: "someone-else" }), {
      requesterId: "owner",
      accessNote: "rows limited to region ∈ [EMEA]",
    });
    expect(d.shared).toBe(true);
    expect(d.access_note).toBe("rows limited to region ∈ [EMEA]");
  });

  it("an empty allow-list allows every model; a non-empty one allows only what it names", () => {
    expect(semanticModelAllowedByKey([], "a")).toBe(true);
    expect(semanticModelAllowedByKey(undefined, "a")).toBe(true);
    expect(semanticModelAllowedByKey(["a"], "a")).toBe(true);
    expect(semanticModelAllowedByKey(["a"], "b")).toBe(false);
    expect(semanticModelAllowedByKey(["a"], undefined)).toBe(false);
  });

  it("resolves a request's model by id or name, the owner's own first on a collision", () => {
    const own = model();
    const shared = model({ id: "22222222-2222-4333-8444-555555555555", ownerId: "other" });
    expect(findSemanticModelByRef([shared, own], "revenue", "owner")).toBe(own);
    expect(findSemanticModelByRef([shared, own], "revenue", "other")).toBe(shared);
    expect(findSemanticModelByRef([shared, own], shared.id as string, "owner")).toBe(shared);
    expect(findSemanticModelByRef([shared, own], "REVENUE".toUpperCase(), "owner")).toBeUndefined();
  });
});

describe("the result body", () => {
  it("cuts at the cap and says so, and carries cells JSON can hold", () => {
    const rows = [
      { region: "EMEA", net_revenue: 10n, at: new Date("2026-01-02T00:00:00Z") },
      { region: "APAC", net_revenue: 2, at: null },
      { region: "LATAM", net_revenue: 3, at: undefined },
    ];
    const cut = metricsResultBody(
      { model: "revenue", columns: ["region", "net_revenue", "at"], rows, sql: "SELECT 1" },
      2,
    );
    expect(cut.object).toBe("metrics.result");
    expect(cut.truncated).toBe(true);
    expect(cut.row_count).toBe(2);
    expect(cut.rows).toEqual([
      { region: "EMEA", net_revenue: 10, at: "2026-01-02T00:00:00.000Z" },
      { region: "APAC", net_revenue: 2, at: null },
    ]);
    expect("access_note" in cut).toBe(false);
    const whole = metricsResultBody(
      {
        model: "revenue",
        columns: ["region"],
        rows: rows.slice(0, 2),
        sql: "SELECT 1",
        access_note: "scoped",
        rollup: "monthly_rev",
        resolution_notes: ["turnover resolved to net_revenue"],
      },
      2,
    );
    expect(whole.truncated).toBe(false);
    expect(whole.row_count).toBe(2);
    expect(whole.access_note).toBe("scoped");
    expect(whole.rollup).toBe("monthly_rev");
    expect(whole.resolution_notes).toEqual(["turnover resolved to net_revenue"]);
    expect(toMetricsCell(2n ** 60n)).toBe((2n ** 60n).toString());
    expect(toMetricsCell({ a: 1 })).toBe("[object Object]");
  });
});

describe("the wiring", () => {
  it("the routes authenticate, check the scope, then run; and the query runs as the key's owner", () => {
    for (const f of ["src/routes/api/v1.metrics.ts", "src/routes/api/v1.metrics.query.ts"]) {
      expect(existsSync(path.join(REPO, f)), f).toBe(true);
      const src = rd(f);
      expect(src).toContain("await authenticateGatewayKey(request)");
      expect(src).toContain("gatewayFail(auth.status, auth.code, auth.error)");
      expect(src).toContain("requireMetricsScope(auth.key, request)");
    }
    expect(rd("src/routes/api/v1.metrics.ts")).toContain('createFileRoute("/api/v1/metrics")');
    expect(rd("src/routes/api/v1.metrics.query.ts")).toContain(
      'createFileRoute("/api/v1/metrics/query")',
    );
    const server = flat(rd("src/utils/gateway/metrics.server.ts"));
    expect(server).toContain('if (key.scopes.includes("metrics")) return null;');
    expect(server).toContain('action: "gateway.access.denied"');
    expect(server).toContain('resolveGrantedResourceIds(supabaseAdmin, userId, "semantic_model")');
    expect(server).toContain("maskCatalogModel(m, p.maskedFields)");
    expect(server).toContain("scopeUserId: owner, grantedModelIds: grantedIds,");
    // The compiled LIMIT is the cap plus one, under the compiler's ceiling.
    expect(server).toContain("const fetchRows = Math.min(cap + 1, MAX_LIMIT);");
    expect(server).toContain("query: { ...parsed.query, model: model.name, limit: fetchRows },");
    expect(server).toContain("maxRows: fetchRows,");
    expect(server).toContain('action: "metric.query"');
    expect(server).toContain('via: "gateway"');
    expect(server).toContain("result_digest: resultDigest(res.columns, res.rows)");
    expect(server).toContain('gatewayFail( 403, "model_not_allowed"');
  });

  it("the scope, the allow-list column and the audit trigger exist, and the key functions keep the list honest", () => {
    expect(rd("src/utils/gateway/keys.ts")).toContain(
      'export const GATEWAY_KEY_SCOPES = ["agents", "models", "metrics"] as const;',
    );
    const mig = rd("supabase/migrations/20260868000000_gateway_metrics.sql");
    expect(mig).toContain("CHECK (scopes <@ ARRAY['agents', 'models', 'metrics']::text[]");
    expect(mig).toContain(
      "ADD COLUMN IF NOT EXISTS semantic_model_ids uuid[] NOT NULL DEFAULT '{}'",
    );
    expect(flat(mig)).toContain(
      "UPDATE OF name, scopes, agent_ids, model_allow, fallback_models, semantic_model_ids, rate_limit_per_min, is_active, expires_at, revoked_at ON public.gateway_keys",
    );
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS gateway_metrics_max_rows integer");
    expect(rd("src/utils/gateway/api.server.ts")).toContain("semantic_model_ids: string[];");
    const fns = flat(rd("src/utils/gatewayKeys.functions.ts"));
    // Named models are filtered against what the owner may read, on create and on update.
    expect(fns).toContain("const semanticModelIds = await accessibleSemanticModelIds(");
    expect(fns).toContain("patch.semantic_model_ids = await accessibleSemanticModelIds(");
    expect(fns).toContain("export const gatewaySemanticModelsList = createServerFn");
    const card = flat(rd("src/components/gateway/GatewayApiCard.tsx"));
    expect(card).toContain(
      'metrics: "Metrics (the semantic layer: GET /metrics, POST /metrics/query)"',
    );
    expect(card).toContain('scopes.includes("metrics") ? semanticModelIds : []');
    expect(card).toContain("Semantic models this key may query");
  });

  it("the row cap is a setting first, env second, then a default, and the docs say the same thing", () => {
    expect(rd("src/utils/notebookRuntime/config.server.ts")).toContain(
      'positive(data?.gateway_metrics_max_rows) ?? envInt("AI_GATEWAY_METRICS_MAX_ROWS") ?? 10000',
    );
    expect(rd("src/utils/notebookRuntimeAdmin.functions.ts")).toContain(
      "gateway_metrics_max_rows: z.number().int().min(1).max(100_000_000).optional()",
    );
    expect(rd("src/components/admin/RuntimeTab.tsx")).toContain(
      'set("gateway_metrics_max_rows", n)',
    );
    expect(rd(".env.example")).toContain("AI_GATEWAY_METRICS_MAX_ROWS=");
    expect(rd("docs/SCALE_AND_LIMITS.md")).toContain("`AI_GATEWAY_METRICS_MAX_ROWS`");
    for (const f of ["docs/AI_GATEWAY.md", "src/routes/docs.gateway.tsx"]) {
      const doc = flat(rd(f));
      expect(doc, f).toContain("/metrics/query");
      expect(doc, f).toContain("metric.query");
      expect(doc, f).toContain("access_note");
      expect(doc, f).toContain("AI_GATEWAY_METRICS_MAX_ROWS");
    }
    for (const f of ["docs/SEMANTIC_LAYER.md", "src/routes/docs.semantics.tsx"]) {
      expect(flat(rd(f)), f).toContain("/api/v1/metrics/query");
    }
    expect(rd("README.md")).toContain("`/api/v1/metrics`");
  });
});
