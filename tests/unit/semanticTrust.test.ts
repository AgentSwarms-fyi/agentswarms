// Tier-2 trust: share policies, certification surface, versions, dependents.
//
// The headline test is a DIFFERENTIAL: the same governed query, compiled once
// as the OWNER and once as a GRANTEE whose share carries a row filter, run on
// the real engine — and the numbers must differ. Before this feature, sharing
// "revenue" shared GLOBAL revenue; that hole stays closed only while this
// test can tell the two results apart.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  applicableGrants,
  applyAccessPolicy,
  describePolicy,
  maskCatalogModel,
  policyFromGrants,
  policyIsRestrictive,
  type SemanticAccessPolicy,
} from "@/lib/semanticPolicy";
import {
  compileSemanticQuery,
  formatSemanticCatalog,
  type SemanticModel,
} from "@/lib/semanticLayer";
import { diffSemanticDefinitions } from "@/lib/semanticDiff";
import {
  configReferencesModel,
  scanAgentsForModel,
  scanDashboardsForModel,
  scanSwarmsForModel,
} from "@/lib/semanticDependents";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";
import type { Json } from "@/integrations/supabase/types";

const orders: DuckTable = {
  name: "orders",
  columns: [
    { name: "order_id", type: "string" },
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
  ],
  rows: [
    { order_id: "A", region: "EMEA", amount: 100 },
    { order_id: "B", region: "EMEA", amount: 50 },
    { order_id: "C", region: "APAC", amount: 70 },
  ],
};

const model: SemanticModel = {
  id: "m-1",
  ownerId: "owner-1",
  name: "orders_model",
  source: { kind: "data_table", table: "orders" },
  primaryKey: "order_id",
  dimensions: [
    { name: "region", sql: "region", type: "categorical" },
    { name: "order_id", sql: "order_id", type: "categorical" },
  ],
  metrics: [
    { name: "revenue", agg: "sum", sql: "amount" },
    { name: "orders_n", agg: "count_distinct", sql: "order_id" },
  ],
};

const q = { model: "orders_model", metrics: ["revenue"], dimensions: [] as string[] };

describe("share row filters — the differential that keeps the hole closed", () => {
  it("a grantee's compiled query returns DIFFERENT numbers from the owner's", async () => {
    const owner = compileSemanticQuery(model, q, { dialect: "duckdb" });
    const ownerRows = (await runLocalSqlDuckDB(owner.sql, [orders])).rows;
    expect(ownerRows).toEqual([{ revenue: 220 }]);

    const policy: SemanticAccessPolicy = {
      rowFilters: [{ column: "region", values: ["APAC"] }],
      maskedFields: [],
    };
    const grantee = compileSemanticQuery(model, applyAccessPolicy(model, q, policy), {
      dialect: "duckdb",
    });
    const granteeRows = (await runLocalSqlDuckDB(grantee.sql, [orders])).rows;
    expect(granteeRows).toEqual([{ revenue: 70 }]);
    // The point of the whole feature, stated as an inequality:
    expect(granteeRows).not.toEqual(ownerRows);
  });

  it("the filter rides INSIDE the compiled SQL, not a post-hoc row scrub", () => {
    const policy: SemanticAccessPolicy = {
      rowFilters: [{ column: "region", values: ["APAC"] }],
      maskedFields: [],
    };
    const { sql } = compileSemanticQuery(model, applyAccessPolicy(model, q, policy), {
      dialect: "duckdb",
    });
    expect(sql).toMatch(/WHERE .*region IN \('APAC'\)/);
  });

  it("FAILS CLOSED when the grant filters by a dimension the model no longer has", () => {
    const policy: SemanticAccessPolicy = {
      rowFilters: [{ column: "territory", values: ["EU"] }],
      maskedFields: [],
    };
    expect(() => applyAccessPolicy(model, q, policy)).toThrow(
      /filtered by "territory".*not a dimension.*no longer agree/s,
    );
  });

  it("an unsatisfiable (empty-values) filter yields zero rows, not all rows", async () => {
    const policy: SemanticAccessPolicy = {
      rowFilters: [{ column: "region", values: [] }],
      maskedFields: [],
    };
    const { sql } = compileSemanticQuery(model, applyAccessPolicy(model, q, policy), {
      dialect: "duckdb",
    });
    const rows = (await runLocalSqlDuckDB(sql, [orders])).rows;
    // SUM over no rows is NULL — what matters is that no data leaked.
    expect(rows).toEqual([{ revenue: null }]);
  });

  it("numeric-looking values are coerced so numeric dimensions compare cleanly", () => {
    const policy: SemanticAccessPolicy = {
      rowFilters: [{ column: "region", values: ["7", "EMEA"] }],
      maskedFields: [],
    };
    const applied = applyAccessPolicy(model, q, policy);
    expect(applied.filters?.at(-1)).toEqual({ field: "region", op: "in", value: [7, "EMEA"] });
  });

  it("grant filters are matched case-insensitively but compile with the canonical name", () => {
    const policy: SemanticAccessPolicy = {
      rowFilters: [{ column: "REGION", values: ["APAC"] }],
      maskedFields: [],
    };
    const applied = applyAccessPolicy(model, q, policy);
    expect(applied.filters?.at(-1)).toMatchObject({ field: "region" });
  });
});

describe("share field masks", () => {
  const masked: SemanticAccessPolicy = { rowFilters: null, maskedFields: ["revenue"] };

  it("a masked metric is refused wherever it appears", () => {
    for (const query of [
      { model: "m", metrics: ["revenue"] },
      {
        model: "m",
        metrics: ["orders_n"],
        filters: [{ field: "revenue", op: ">" as const, value: 1 }],
      },
      { model: "m", metrics: ["orders_n"], orderBy: [{ field: "revenue" }] },
    ]) {
      expect(() => applyAccessPolicy(model, query, masked)).toThrow(
        /"revenue" is not included in your access/,
      );
    }
  });

  it("unmasked fields still run", () => {
    const applied = applyAccessPolicy(model, { model: "m", metrics: ["orders_n"] }, masked);
    expect(applied.metrics).toEqual(["orders_n"]);
  });

  it("the catalog never advertises a name the query path would refuse", () => {
    const shown = maskCatalogModel(model, ["revenue"]);
    expect(shown.metrics.map((m) => m.name)).toEqual(["orders_n"]);
    expect(shown.dimensions.length).toBe(model.dimensions.length);
  });
});

describe("grant applicability and merge", () => {
  const grants = [
    { principal_type: "user", principal_id: "u1", row_filter: null, column_mask: [] },
    {
      principal_type: "group",
      principal_id: "g1",
      row_filter: { column: "region", values: ["EMEA"] } as unknown as Json,
      column_mask: ["revenue"],
    },
  ];

  it("matches by user id and by group membership", () => {
    expect(applicableGrants(grants, "u1", [])).toHaveLength(1);
    expect(applicableGrants(grants, "someone", ["g1"])).toHaveLength(1);
    expect(applicableGrants(grants, "u1", ["g1"])).toHaveLength(2);
    expect(applicableGrants(grants, "someone", ["g9"])).toHaveLength(0);
  });

  it("an unrestricted grant wins over a filtered one (permissive union, as dashboards)", () => {
    const policy = policyFromGrants(applicableGrants(grants, "u1", ["g1"]));
    expect(policy.rowFilters).toBeNull();
    expect(policy.maskedFields).toEqual([]);
    expect(policyIsRestrictive(policy)).toBe(false);
  });

  it("a filtered-only membership stays filtered", () => {
    const policy = policyFromGrants(applicableGrants(grants, "someone", ["g1"]));
    expect(policy.rowFilters).toEqual([{ column: "region", values: ["EMEA"] }]);
    expect(policy.maskedFields).toEqual(["revenue"]);
    expect(policyIsRestrictive(policy)).toBe(true);
    expect(describePolicy(policy)).toMatch(/region ∈ \[EMEA\].*hidden fields: revenue/s);
  });
});

describe("catalog certification markers", () => {
  it("certified and deprecated models are labelled; notes are disclosed", () => {
    const text = formatSemanticCatalog(
      [
        { ...model, name: "a", status: "certified" },
        { ...model, name: "b", status: "deprecated" },
        { ...model, name: "c" },
      ],
      { notes: new Map([["c", "restricted share — rows limited to region ∈ [APAC]"]]) },
    );
    expect(text).toMatch(/MODEL a.*\[certified\]/);
    expect(text).toMatch(/MODEL b.*\[DEPRECATED — prefer another model\]/);
    // ` {2}` rather than two literal spaces: the indent is load-bearing here
    // (it is what marks the line as a detail under MODEL c), and two adjacent
    // spaces in a regex are impossible to count by eye and trivial to lose to
    // a reformat. Written as a quantifier the intent survives both.
    expect(text).toMatch(/MODEL c\n {2}restricted share — rows limited to region ∈ \[APAC\]/);
  });
});

describe("diffSemanticDefinitions", () => {
  const before = {
    name: "m",
    source_table: "orders",
    primary_key: "order_id",
    metrics: [
      { name: "revenue", agg: "sum", sql: "amount" },
      { name: "dropped", agg: "count" },
    ],
    dimensions: [{ name: "region", sql: "region" }],
    joins: [{ table: "items", on: "a = b", cardinality: "many_to_one" }],
    assertions: [],
  } as unknown as Json;
  const after = {
    name: "m",
    source_table: "orders",
    primary_key: "id",
    metrics: [
      { name: "revenue", agg: "sum", sql: "amount", filters: ["status = 'paid'"] },
      { name: "added_m", agg: "min", sql: "x" },
    ],
    dimensions: [{ name: "region", sql: "region" }],
    joins: [{ table: "items", on: "a = b", cardinality: "one_to_many" }],
    assertions: [],
  } as unknown as Json;

  it("reports adds, removes and per-field changes with before/after", () => {
    const d = diffSemanticDefinitions(before, after);
    expect(d.metrics.added).toEqual(["added_m"]);
    expect(d.metrics.removed).toEqual(["dropped"]);
    expect(d.metrics.changed).toEqual([
      {
        name: "revenue",
        changes: [{ field: "filters", before: "—", after: "[\"status = 'paid'\"]" }],
      },
    ]);
    expect(d.joins.changed[0]).toMatchObject({
      changes: [{ field: "cardinality", before: "many_to_one", after: "one_to_many" }],
    });
    expect(d.model).toEqual([{ field: "primary_key", before: "order_id", after: "id" }]);
    expect(d.identical).toBe(false);
  });

  it("identical definitions say so", () => {
    expect(diffSemanticDefinitions(before, before).identical).toBe(true);
  });
});

describe("dependents scanners — real storage shapes", () => {
  it("finds semantic widgets in dashboards and names them", () => {
    const dashboards = [
      {
        id: "d1",
        name: "Revenue board",
        widgets: [
          {
            id: "w1",
            kind: "chart",
            title: "Rev by region",
            source: { kind: "semantic", model: "orders_model", metrics: ["revenue"] },
          },
          { id: "w2", kind: "chart", title: "Raw SQL", source: { kind: "local" }, sql: "SELECT 1" },
        ] as unknown as Json,
      },
      { id: "d2", name: "Other", widgets: [] as unknown as Json },
    ];
    expect(scanDashboardsForModel(dashboards, "orders_model")).toEqual([
      { dashboardId: "d1", dashboardName: "Revenue board", widgets: ["Rev by region"] },
    ]);
    expect(scanDashboardsForModel(dashboards, "another_model")).toEqual([]);
  });

  it("finds the AGENT storage shape (toolConfigs.metric_query.model_names)", () => {
    const tools = {
      enabled: ["metric_query"],
      toolConfigs: { metric_query: { model_names: ["orders_model", "hr"] } },
    } as unknown as Json;
    expect(configReferencesModel(tools, "orders_model")).toBe(true);
    expect(configReferencesModel(tools, "nope")).toBe(false);
    expect(scanAgentsForModel([{ id: "a1", name: "Analyst", tools }], "orders_model")).toEqual([
      { id: "a1", name: "Analyst" },
    ]);
  });

  it("finds the SWARM NODE storage shape (metric_model_names) in draft and published graphs", () => {
    const node = { id: "n1", data: { tool_configs: { metric_model_names: ["orders_model"] } } };
    const swarms = [
      { id: "s1", name: "Draft user", nodes: [node] as unknown as Json, published_nodes: null },
      {
        id: "s2",
        name: "Published user",
        nodes: [] as unknown as Json,
        published_nodes: [node] as unknown as Json,
      },
    ];
    expect(scanSwarmsForModel(swarms, "orders_model").map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("a bare model_names OUTSIDE metric_query does not count", () => {
    const tools = { some_other_tool: { model_names: ["orders_model"] } } as unknown as Json;
    expect(configReferencesModel(tools, "orders_model")).toBe(false);
  });
});

describe("wiring (source guards)", () => {
  const query = readFileSync("src/utils/semantic/query.server.ts", "utf8");
  const metric = readFileSync("src/utils/tools/metric.server.ts", "utf8");
  const iam = readFileSync("src/utils/iam.functions.ts", "utf8");
  const fns = readFileSync("src/utils/semantic.functions.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20260820000000_semantic_trust.sql", "utf8");

  it("runSemanticQuery enforces the policy for non-owners at the single choke point", () => {
    expect(query).toMatch(/const requesterId = opts\.scopeUserId \?\? opts\.userId;/);
    expect(query).toMatch(/if \(requesterId && requesterId !== ownerId\) \{/);
    expect(query).toMatch(/semanticPolicyFor\(requesterId, row\.id\)/);
    // Pin the EXACT reachable sequence, not mere presence — `&& false` on the
    // condition once survived a guard that only checked the line existed.
    expect(query).toMatch(
      /if \(policyIsRestrictive\(policy\)\) \{\s*query = applyAccessPolicy\(model, query, policy\);/,
    );
    // Both engine branches must compile the REWRITTEN query, never the input.
    expect(query, "a branch still compiles opts.query, bypassing the policy").not.toMatch(
      /compileSemanticQuery\(model, opts\.query/,
    );
  });

  it("metric_query discloses a scoped share to the agent", () => {
    expect(metric).toMatch(/restricted share/);
    expect(metric).toMatch(/maskCatalogModel\(m, p!\.maskedFields\)/);
    expect(metric).toMatch(/this data is a restricted share/);
  });

  it("semantic_model joined the restrictable grant types", () => {
    expect(iam).toMatch(
      /RESTRICTABLE = new Set\(\["bi_dashboard", "data_table", "semantic_model"\]\)/,
    );
  });

  it("certification re-runs the validation pipeline before stamping", () => {
    expect(fns).toMatch(
      /if \(data\.status === "certified"\) \{\s*const report = await validateModelPayload\(/,
    );
    expect(fns).toMatch(/certified_by: userId,\s*certified_at: new Date\(\)\.toISOString\(\)/);
  });

  it("restore re-validates the snapshot before writing it", () => {
    expect(fns).toMatch(/modelSchema\.parse\(rowToModelPayload\(version\.definition/);
  });

  it("the migration carries the decertify trigger, version capture, RLS and retention", () => {
    expect(migration).toMatch(/NEW\.status := 'draft';/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.semantic_model_versions/);
    expect(migration).toMatch(/semantic_model_capture_version/);
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/LIMIT 50/);
    // No INSERT policy: history is trigger-written, not client-writable.
    expect(migration).not.toMatch(/FOR INSERT/i);
  });
});
