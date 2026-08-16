// Importing a dbt project into the semantic layer.
//
// The failure this guards is not "the import crashed" — it is "the import
// looked like it worked". A manifest is large and messy, and the tempting
// shape is to filter out everything awkward and announce a clean number. The
// user then cannot tell "dbt has 18 models and I took 12" from "dbt has 12".
//
// So most of these tests are about what does NOT get imported, and whether the
// result says so.
import { describe, expect, it } from "vitest";

import {
  collidingNames,
  dbtAggToMetricAgg,
  dbtFieldType,
  dbtRelation,
  describeImport,
  parseDbtManifest,
} from "@/lib/dbtManifest";

const CONN = "conn-snowflake";

/** A node shaped like the ones dbt actually writes. */
const model = (over: Record<string, unknown> = {}) => ({
  resource_type: "model",
  name: "orders",
  database: "prod",
  schema: "analytics",
  alias: "orders",
  description: "One row per order",
  config: { materialized: "table" },
  columns: {
    order_id: { name: "order_id", data_type: "integer", description: "PK" },
    amount: { name: "amount", data_type: "numeric(18,2)" },
    created_at: { name: "created_at", data_type: "timestamp with time zone" },
    status: { name: "status", data_type: "varchar(50)" },
  },
  ...over,
});

const manifest = (over: Record<string, unknown> = {}) => ({
  metadata: {
    dbt_version: "1.8.3",
    project_name: "jaffle_shop",
    adapter_type: "snowflake",
    generated_at: "2026-08-16T10:00:00Z",
  },
  nodes: { "model.jaffle_shop.orders": model() },
  ...over,
});

const run = (m: unknown) => parseDbtManifest(m, { connectionId: CONN });

describe("the file has to actually be a manifest", () => {
  it("names what was expected, and where to look", () => {
    // Picking run_results.json or catalog.json out of the same directory is
    // the common mistake; "invalid file" would not help.
    expect(() => run({ results: [] })).toThrow(/manifest/i);
    expect(() => run({ results: [] })).toThrow(/target\/manifest\.json/);
  });

  it("rejects a non-object outright", () => {
    expect(() => run("{}")).toThrow();
    expect(() => run(null)).toThrow();
  });
});

describe("a documented model becomes a semantic model", () => {
  const r = run(manifest());

  it("imports it once, with the project's own description", () => {
    expect(r.models).toHaveLength(1);
    expect(r.models[0].name).toBe("orders");
    expect(r.models[0].description).toBe("One row per order");
  });

  it("points at the warehouse connection it was imported against", () => {
    // A dbt model is a table in the project's target warehouse. Importing it
    // against the wrong connection compiles and then fails to run.
    expect(r.models[0].source).toEqual({
      kind: "warehouse",
      connectionId: CONN,
      table: "prod.analytics.orders",
    });
  });

  it("turns every documented column into a dimension", () => {
    expect(r.models[0].dimensions.map((d) => d.name)).toEqual([
      "order_id",
      "amount",
      "created_at",
      "status",
    ]);
    expect(r.models[0].dimensions[0].description).toBe("PK");
  });

  it("arrives as a draft, never certified", () => {
    // Certification means the validation pipeline ran clean against the live
    // source. Nothing has run yet.
    expect(r.models[0].status).toBe("draft");
  });

  it("reports the manifest's own provenance", () => {
    expect(r.project).toEqual({
      name: "jaffle_shop",
      dbtVersion: "1.8.3",
      adapter: "snowflake",
      generatedAt: "2026-08-16T10:00:00Z",
    });
  });
});

describe("column types are mapped, never guessed", () => {
  it("reads the families dbt emits, including parameterised ones", () => {
    expect(dbtFieldType("integer")).toBe("number");
    expect(dbtFieldType("numeric(18,2)")).toBe("number");
    expect(dbtFieldType("timestamp with time zone")).toBe("time");
    expect(dbtFieldType("DATE")).toBe("time");
    expect(dbtFieldType("varchar(255)")).toBe("categorical");
    expect(dbtFieldType("boolean")).toBe("boolean");
  });

  it("leaves an absent data_type UNSET", () => {
    // `data_type` is only populated after `dbt docs generate` against a live
    // warehouse, so most manifests carry none. Defaulting those to
    // "categorical" would label every numeric column as groupable.
    expect(dbtFieldType(undefined)).toBeUndefined();
    expect(dbtFieldType("")).toBeUndefined();
    const r = run(
      manifest({
        nodes: {
          "model.p.m": model({ columns: { amount: { name: "amount" } } }),
        },
      }),
    );
    expect(r.models[0].dimensions[0].type).toBeUndefined();
  });

  it("leaves a type it does not recognise unset rather than picking one", () => {
    expect(dbtFieldType("geography")).toBeUndefined();
    expect(dbtFieldType("array<string>")).toBeUndefined();
  });
});

describe("aggregations with no equivalent are refused, not coerced", () => {
  it("maps the ones that exist", () => {
    expect(dbtAggToMetricAgg("sum")).toBe("sum");
    expect(dbtAggToMetricAgg("average")).toBe("avg");
    expect(dbtAggToMetricAgg("count_distinct")).toBe("count_distinct");
    expect(dbtAggToMetricAgg("MAX")).toBe("max");
  });

  it("returns null for the ones that do not", () => {
    // Coercing percentile to avg would produce a governed metric that is
    // confidently the wrong number — the exact failure a semantic layer exists
    // to prevent.
    expect(dbtAggToMetricAgg("percentile")).toBeNull();
    expect(dbtAggToMetricAgg("median")).toBeNull();
    expect(dbtAggToMetricAgg(undefined)).toBeNull();
  });

  it("names the metric it could not take, and why", () => {
    const r = run(
      manifest({
        nodes: {
          "model.p.orders": model({
            columns: {
              amount: {
                name: "amount",
                meta: { metrics: { p95_amount: { type: "percentile" } } },
              },
            },
          }),
        },
      }),
    );
    const skip = r.skipped.find((s) => s.ref === "orders.p95_amount");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/percentile/);
    expect(r.models[0].metrics).toHaveLength(0);
  });
});

describe("models with nothing behind them are skipped and named", () => {
  it("skips an ephemeral model, because dbt never builds a table for it", () => {
    // The worst kind of import: one that looks successful and then fails in
    // the warehouse with "relation does not exist".
    const r = run(
      manifest({
        nodes: {
          "model.p.stg": model({ name: "stg_orders", config: { materialized: "ephemeral" } }),
        },
      }),
    );
    expect(r.models).toHaveLength(0);
    expect(r.skipped).toContainEqual({
      kind: "model",
      ref: "stg_orders",
      reason: "Materialized as ephemeral, so dbt never creates a table for it.",
    });
  });

  it("skips a model with no documented columns, and says how to fix it", () => {
    // dbt only lists columns that appear in schema.yml. An undocumented
    // project yields empty shells, and the count would say it worked.
    const r = run(manifest({ nodes: { "model.p.m": model({ columns: {} }) } }));
    expect(r.models).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/schema\.yml/);
  });

  it("still counts a skipped model in the denominator", () => {
    const r = run(manifest({ nodes: { "model.p.m": model({ columns: {} }) } }));
    expect(r.counts.models).toBe(1);
    expect(r.models).toHaveLength(0);
  });
});

describe("MetricFlow measures land on their model", () => {
  const r = run(
    manifest({
      semantic_models: {
        "semantic_model.p.orders": {
          name: "orders",
          model: "ref('orders')",
          measures: [
            { name: "revenue", agg: "sum", expr: "amount", description: "Gross revenue" },
            { name: "order_count", agg: "count" },
            { name: "median_amount", agg: "median", expr: "amount" },
          ],
        },
      },
    }),
  );

  it("imports the measures it can express", () => {
    expect(r.models[0].metrics.map((m) => m.name)).toEqual(["revenue", "order_count"]);
    expect(r.models[0].metrics[0]).toMatchObject({ agg: "sum", sql: "amount" });
  });

  it("skips the one it cannot, by name", () => {
    expect(r.skipped.map((s) => s.ref)).toContain("orders.median_amount");
  });

  it("reports how many semantic models the manifest held", () => {
    expect(r.counts.semanticModels).toBe(1);
  });

  it("cannot place measures whose model is not a ref()", () => {
    const bad = run(
      manifest({
        semantic_models: {
          "semantic_model.p.x": {
            name: "x",
            model: "orders",
            measures: [{ name: "a", agg: "sum" }],
          },
        },
      }),
    );
    expect(bad.skipped.some((s) => /ref\(\)/.test(s.reason))).toBe(true);
  });
});

describe("a dbt filter is not silently dropped", () => {
  it("imports the metric but says the number will be wider", () => {
    // Translating dbt's structured filters into SQL fragments risks getting an
    // operator subtly wrong. Importing unfiltered and SAYING so is the honest
    // trade; importing unfiltered in silence is not.
    const r = run(
      manifest({
        nodes: {
          "model.p.orders": model({
            columns: {
              amount: {
                name: "amount",
                meta: {
                  metrics: {
                    paid_revenue: {
                      type: "sum",
                      filters: [{ field: "status", operator: "=", value: "paid" }],
                    },
                  },
                },
              },
            },
          }),
        },
      }),
    );
    expect(r.models[0].metrics[0].name).toBe("paid_revenue");
    expect(r.models[0].metrics[0].filters).toBeUndefined();
    expect(r.skipped.some((s) => /wider than dbt/.test(s.reason))).toBe(true);
  });
});

describe("the grain is picked up, because fan-out refusal needs it", () => {
  it("reads a column marked primary_key", () => {
    const r = run(
      manifest({
        nodes: {
          "model.p.orders": model({
            columns: { order_id: { name: "order_id", meta: { primary_key: true } } },
          }),
        },
      }),
    );
    expect(r.models[0].primaryKey).toBe("order_id");
  });

  it("reads a model-level primary_key too", () => {
    const r = run(
      manifest({ nodes: { "model.p.orders": model({ meta: { primary_key: "order_id" } }) } }),
    );
    expect(r.models[0].primaryKey).toBe("order_id");
  });

  it("leaves it unset when dbt says nothing", () => {
    // Guessing "the first column ending in _id" would hand the fan-out check a
    // grain nobody declared, and it would report against the wrong key.
    expect(run(manifest()).models[0].primaryKey).toBeUndefined();
  });
});

describe("identifiers this layer cannot alias are refused", () => {
  it("skips a column that would need quoting", () => {
    const r = run(
      manifest({
        nodes: {
          "model.p.orders": model({
            columns: { ok: { name: "ok" }, "Order Date": { name: "Order Date" } },
          }),
        },
      }),
    );
    expect(r.models[0].dimensions.map((d) => d.name)).toEqual(["ok"]);
    expect(r.skipped.some((s) => s.ref === "orders.Order Date")).toBe(true);
  });

  it("keeps schema.table when only the database is unusable", () => {
    // Dropping the database is safe: a two-part reference resolves in the
    // session's current database, which is where dbt put the table.
    expect(dbtRelation({ name: "orders", database: "my-db", schema: "analytics" })).toBe(
      "analytics.orders",
    );
  });

  it("drops to the bare name when the SCHEMA is unusable, never database.table", () => {
    // The dangerous case, and the one an independent filter gets wrong.
    // `prod.orders` reads as schema `prod`, table `orders` on every dialect
    // here — a reference that resolves silently, to the wrong table.
    expect(dbtRelation({ name: "orders", database: "prod", schema: "my-schema" })).toBe("orders");
    expect(dbtRelation({ name: "orders", database: "prod" })).toBe("orders");
  });

  it("qualifies fully when everything is usable", () => {
    expect(dbtRelation({ name: "orders", database: "prod", schema: "analytics" })).toBe(
      "prod.analytics.orders",
    );
  });

  it("prefers the alias, which is what dbt actually built", () => {
    expect(dbtRelation({ name: "orders", alias: "orders_v2", schema: "analytics" })).toBe(
      "analytics.orders_v2",
    );
  });

  it("refuses a relation it cannot build at all", () => {
    expect(dbtRelation({ name: "1bad" })).toBeNull();
  });
});

describe("the summary states the denominator", () => {
  it("says 'N of M' whenever anything was skipped", () => {
    // "Imported 12 models" reads as completeness. "12 of 18" is the same fact
    // without the implication.
    const r = run(
      manifest({
        nodes: {
          "model.p.a": model({ name: "a" }),
          "model.p.b": model({ name: "b", columns: {} }),
        },
      }),
    );
    expect(describeImport(r)).toMatch(/1 of 2 models/);
    expect(describeImport(r)).toMatch(/skipped/);
  });

  it("drops the denominator only when nothing was skipped", () => {
    const r = run(manifest());
    expect(describeImport(r)).toMatch(/^1 model · 0 metrics$/);
  });
});

describe("collisions with existing models are surfaced, not resolved", () => {
  it("finds a name that already exists, case-insensitively", () => {
    const r = run(manifest());
    expect(collidingNames(r, ["Orders", "customers"])).toEqual(new Set(["orders"]));
  });

  it("returns nothing when the layer is empty", () => {
    expect(collidingNames(run(manifest()), [])).toEqual(new Set());
  });
});

describe("legacy dbt metrics are reported rather than lost", () => {
  it("names a pre-1.6 metric node and what to do about it", () => {
    const r = run(manifest({ metrics: { "metric.p.revenue": { name: "revenue" } } }));
    const s = r.skipped.find((x) => x.ref === "revenue");
    expect(s?.reason).toMatch(/Legacy dbt metric/);
    expect(r.counts.metrics).toBe(1);
  });
});
