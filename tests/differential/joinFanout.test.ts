// Fan-out safety, proven against the real engine — not asserted from theory.
//
// THE MEASUREMENT THAT FORCED THIS FEATURE: orders (A=100, B=50) LEFT JOINed
// to order_items (A has three lines, B has one). Truth: revenue 150, orders 2.
// Before cardinality existed the compiler emitted SUM(orders.amount) over the
// joined result and DuckDB returned 350 and 4 — no error, no caveat, a wrong
// number wearing a right number's clothes.
//
// The contract has two eras. First the declared fan-out made that query
// REFUSE at compile time. Now the compiler goes one better: where the refusal
// used to stand, it builds a MULTI-FACT PLAN — each metric aggregated in its
// own branch at the dimension grain, stitched on a spine — and the same query
// returns 150. The refusal REMAINS for everything the plan cannot prove:
// unqualified columns, bare counts, cross-fact expressions. A model with no
// declared cardinality still compiles exactly as before — breaking every
// existing saved model on upgrade is not an option, which is why Validate
// measures undeclared joins instead (see semanticMeasure tests).
import { describe, expect, it } from "vitest";

import { compileSemanticQuery, qualifiedRefsIn, type SemanticModel } from "@/lib/semanticLayer";
import { rowToModel, type SemanticModelRow } from "@/utils/semantic/query.server";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

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
  ],
};

const items: DuckTable = {
  name: "order_items",
  columns: [
    { name: "order_id", type: "string" },
    { name: "sku", type: "string" },
    { name: "qty", type: "number" },
  ],
  rows: [
    { order_id: "A", sku: "s1", qty: 1 },
    { order_id: "A", sku: "s2", qty: 2 },
    { order_id: "A", sku: "s3", qty: 4 },
    { order_id: "B", sku: "s1", qty: 5 },
  ],
};

const shipments: DuckTable = {
  name: "shipments",
  columns: [
    { name: "order_id", type: "string" },
    { name: "weight", type: "number" },
  ],
  rows: [
    { order_id: "A", weight: 9 },
    { order_id: "B", weight: 1 },
    { order_id: "B", weight: 2 },
  ],
};

/** The fixture model; `declare` toggles the join's cardinality. */
function model(declare: boolean): SemanticModel {
  return {
    name: "m",
    source: { kind: "data_table", table: "orders" },
    primaryKey: "order_id",
    joins: [
      {
        table: "order_items",
        type: "left",
        on: "orders.order_id = order_items.order_id",
        ...(declare ? { cardinality: "one_to_many" as const } : {}),
      },
    ],
    dimensions: [{ name: "region", sql: "orders.region", type: "categorical" }],
    metrics: [
      { name: "revenue", agg: "sum", sql: "orders.amount" },
      { name: "order_count", agg: "count" },
      { name: "distinct_orders", agg: "count_distinct", sql: "orders.order_id" },
      { name: "units", agg: "sum", sql: "order_items.qty" },
      { name: "max_line", agg: "max", sql: "order_items.qty" },
      { name: "bare_sum", agg: "sum", sql: "amount" },
      { name: "mixed", agg: "sum", sql: "order_items.qty * orders.amount" },
      { name: "item_rows", agg: "count", filters: ["order_items.sku IS NOT NULL"] },
      { name: "paid_rows", agg: "count", filters: ["orders.region = 'EMEA'"] },
      {
        name: "trusted_total",
        agg: "custom",
        sql: "SUM(DISTINCT orders.amount)",
      },
      { name: "aov", agg: "derived", sql: "{revenue} / NULLIF({distinct_orders}, 0)" },
      { name: "safe_ratio", agg: "derived", sql: "{units} / NULLIF({distinct_orders}, 0)" },
    ],
  };
}

const q = (metrics: string[], dims: string[] = ["region"]) => ({
  model: "m",
  metrics,
  dimensions: dims,
});

const run = async (m: SemanticModel, metrics: string[]) => {
  const c = compileSemanticQuery(m, q(metrics), { dialect: "duckdb" });
  return (await runLocalSqlDuckDB(c.sql, [orders, items, shipments])).rows;
};

describe("declared one_to_many: the query that used to say 350 now says 150", () => {
  it("sum over a source column RESOLVES via a multi-fact plan and is right", async () => {
    // The exact query the refusal was built for. It no longer refuses — it
    // compiles to a base branch that never sees the fanning join.
    expect(await run(model(true), ["revenue"])).toEqual([{ region: "EMEA", revenue: 150 }]);
  });

  it("base and fact metrics in ONE query are BOTH right", async () => {
    // The chasm poster child at one-join scale: 150 and 12 side by side,
    // where the single pass could only ever get one of them right.
    expect(await run(model(true), ["revenue", "units"])).toEqual([
      { region: "EMEA", revenue: 150, units: 12 },
    ]);
  });

  it("a plain count still refuses — 'count of what' has no provable answer", () => {
    expect(() =>
      compileSemanticQuery(model(true), q(["order_count"]), { dialect: "duckdb" }),
    ).toThrow(/order_count.*ambiguous.*bare count.*count_distinct over order_id/is);
  });

  it("an unqualified sum still refuses as ambiguous rather than guessing the table", () => {
    expect(() => compileSemanticQuery(model(true), q(["bare_sum"]), { dialect: "duckdb" })).toThrow(
      /bare_sum.*ambiguous.*qualify/is,
    );
  });

  it("a mixed source×fact expression aggregates at the FACT's grain", async () => {
    // qty * amount evaluates once per line item, with the order's amount as
    // an attribute of the line: A → (1+2+4)×100, B → 5×50. This is the
    // standard related-table semantics (a price on the parent, a quantity on
    // the line), not double-counting — the metric's own grain is the fact.
    expect(await run(model(true), ["mixed"])).toEqual([{ region: "EMEA", mixed: 950 }]);
  });

  it("a count filtered on SOURCE columns counts SOURCE rows", async () => {
    // The filter anchors the count to the base branch, where a row is an
    // order — 2, not the 4 joined rows the single pass counted.
    expect(await run(model(true), ["paid_rows"])).toEqual([{ region: "EMEA", paid_rows: 2 }]);
  });

  it("a derived metric resolves through its leaves", async () => {
    // revenue (base) / distinct_orders (base): 150 / 2.
    expect(await run(model(true), ["aov"])).toEqual([{ region: "EMEA", aov: 75 }]);
  });

  it("many_to_many resolves exactly like one_to_many", async () => {
    const m2m: SemanticModel = {
      ...model(false),
      joins: [{ ...model(false).joins![0], cardinality: "many_to_many" }],
    };
    expect(await run(m2m, ["revenue"])).toEqual([{ region: "EMEA", revenue: 150 }]);
  });

  it("the plan reaches a model loaded from a DB ROW (jsonb round-trip)", async () => {
    // Cardinality lives inside the joins jsonb; if rowToModel ever narrowed
    // the join shape it would silently drop the declaration — and with it
    // both the plan and the remaining refusals.
    const row = {
      id: "00000000-0000-0000-0000-000000000000",
      user_id: "00000000-0000-0000-0000-000000000000",
      name: "m",
      label: null,
      description: null,
      source_kind: "data_table",
      table_id: null,
      connection_id: null,
      source_table: "orders",
      primary_key: "order_id",
      joins: model(true).joins,
      dimensions: model(true).dimensions,
      metrics: model(true).metrics,
      assertions: [],
      created_at: "",
      updated_at: "",
    } as unknown as SemanticModelRow;
    expect(await run(rowToModel(row), ["revenue"])).toEqual([{ region: "EMEA", revenue: 150 }]);
    expect(() =>
      compileSemanticQuery(rowToModel(row), q(["order_count"]), { dialect: "duckdb" }),
    ).toThrow(/count_distinct over order_id/);
  });
});

describe("declared one_to_many: fan-side and duplicate-insensitive metrics run single-pass, unchanged", () => {
  it("sum over the fanning table's column stays a single pass and correct", async () => {
    const c = compileSemanticQuery(model(true), q(["units"]), { dialect: "duckdb" });
    // No plan, no CTEs — the safe query compiles exactly as it always did.
    expect(c.sql).not.toContain("semantic_spine");
    const res = await runLocalSqlDuckDB(c.sql, [orders, items]);
    expect(res.rows).toEqual([{ region: "EMEA", units: 12 }]);
  });

  it("count_distinct over the source key is allowed and correct", async () => {
    const c = compileSemanticQuery(model(true), q(["distinct_orders"]), { dialect: "duckdb" });
    const res = await runLocalSqlDuckDB(c.sql, [orders, items]);
    expect(res.rows).toEqual([{ region: "EMEA", distinct_orders: 2 }]);
  });

  it("max is duplicate-insensitive and correct", async () => {
    const c = compileSemanticQuery(model(true), q(["max_line"]), { dialect: "duckdb" });
    const res = await runLocalSqlDuckDB(c.sql, [orders, items]);
    expect(res.rows).toEqual([{ region: "EMEA", max_line: 5 }]);
  });

  it("a count filtered on FANNING columns counts matches, not phantoms", async () => {
    const c = compileSemanticQuery(model(true), q(["item_rows"]), { dialect: "duckdb" });
    const res = await runLocalSqlDuckDB(c.sql, [orders, items]);
    expect(res.rows).toEqual([{ region: "EMEA", item_rows: 4 }]);
  });

  it("custom stays the documented owner-trusted escape hatch", async () => {
    const c = compileSemanticQuery(model(true), q(["trusted_total"]), { dialect: "duckdb" });
    const res = await runLocalSqlDuckDB(c.sql, [orders, items]);
    expect(res.rows).toEqual([{ region: "EMEA", trusted_total: 150 }]);
  });

  it("a derived metric over safe leaves passes", async () => {
    const c = compileSemanticQuery(model(true), q(["safe_ratio"]), { dialect: "duckdb" });
    const res = await runLocalSqlDuckDB(c.sql, [orders, items]);
    expect(res.rows).toEqual([{ region: "EMEA", safe_ratio: 6 }]);
  });
});

describe("chasm: two fanning joins, each fact aggregated at its own grain", () => {
  const chasm: SemanticModel = {
    ...model(true),
    joins: [
      ...model(true).joins!,
      {
        table: "shipments",
        type: "left",
        on: "orders.order_id = shipments.order_id",
        cardinality: "one_to_many",
      },
    ],
  };

  it("a fan-side sum is shielded from the OTHER fanning join", async () => {
    // Single-pass, shipments would multiply the item rows (A×1, B×2 →
    // 1+2+4+5+5 = 17). The plan's items branch never joins shipments: 12.
    expect(await run(chasm, ["units"])).toEqual([{ region: "EMEA", units: 12 }]);
  });

  it("three facts in one query, every number at its own grain", async () => {
    const c = compileSemanticQuery(
      chasm,
      { ...q(["revenue", "units"]), metrics: ["revenue", "units"] },
      { dialect: "duckdb" },
    );
    const res = await runLocalSqlDuckDB(c.sql, [orders, items, shipments]);
    expect(res.rows).toEqual([{ region: "EMEA", revenue: 150, units: 12 }]);
  });

  it("count_distinct is still fine across a chasm — and stays single-pass", () => {
    const c = compileSemanticQuery(chasm, q(["distinct_orders"]), { dialect: "duckdb" });
    expect(c.sql).toContain("COUNT(DISTINCT orders.order_id)");
    expect(c.sql).not.toContain("semantic_spine");
  });
});

describe("backwards compatibility: no declared cardinality compiles as before", () => {
  it("the historical (wrong) query still compiles — Validate measures it instead", async () => {
    // This documents the EXACT number the feature exists to kill: 350 vs 150.
    // If this test ever starts failing because the compile refuses, the
    // back-compat contract broke and every pre-cardinality model with it.
    const c = compileSemanticQuery(model(false), q(["revenue", "order_count"]), {
      dialect: "duckdb",
    });
    const res = await runLocalSqlDuckDB(c.sql, [orders, items]);
    expect(res.rows).toEqual([{ region: "EMEA", revenue: 350, order_count: 4 }]);
  });

  it("many_to_one and one_to_one declarations change nothing", () => {
    const safe: SemanticModel = {
      ...model(false),
      joins: [{ ...model(false).joins![0], cardinality: "many_to_one" }],
    };
    const c = compileSemanticQuery(safe, q(["revenue"]), { dialect: "duckdb" });
    expect(c.sql).toContain("SUM(orders.amount)");
  });
});

describe("qualifiedRefsIn — the scanner the checks stand on", () => {
  it("finds qualifiers through functions and arithmetic", () => {
    expect(qualifiedRefsIn("COALESCE(order_items.qty, 0) * Orders.amount").sort()).toEqual([
      "order_items",
      "orders",
    ]);
  });

  it("does not read a dot inside a string literal as a reference", () => {
    expect(qualifiedRefsIn("CASE WHEN note = 'see orders.amount' THEN x END")).toEqual([]);
  });

  it("does not read a dot inside a quoted identifier as a reference", () => {
    expect(qualifiedRefsIn('"orders.amount"')).toEqual([]);
    expect(qualifiedRefsIn("`orders.amount`")).toEqual([]);
  });

  it("does not read a decimal number as a reference", () => {
    expect(qualifiedRefsIn("amount * 0.5")).toEqual([]);
  });

  it("captures both segments of a schema-qualified reference", () => {
    // Classification ignores unknown qualifiers ("analytics"), so the table
    // segment is what matters — and it is captured.
    expect(qualifiedRefsIn("analytics.order_items.qty")).toContain("order_items");
  });
});
