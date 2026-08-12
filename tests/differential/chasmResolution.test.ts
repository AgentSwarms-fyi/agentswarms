// The multi-fact plan, EXECUTED against hand-computed truth on DuckDB.
//
// A chasm schema — one source, two fanning facts — is where every naive
// semantic layer quietly multiplies numbers: joined in one pass, items rows
// repeat per shipment and vice versa, so every SUM reads a lottery ticket.
// The plan compiles each fact in its own branch at the requested grain and
// stitches the aggregates on a dimension spine. Every expected value in this
// file is worked out from the fixture BY HAND, never from the code under
// test; the fixture deliberately includes a source row with NO rows in one
// fact (missing groups must surface as NULL, not vanish, not read 0) and a
// NULL dimension value (the spine join must be NULL-safe or that group loses
// its facts silently).
import { describe, expect, it } from "vitest";

import { compileSemanticQuery, type SemanticModel, type SemanticQuery } from "@/lib/semanticLayer";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

// region NULL on order 5 exercises the NULL-safe spine join.
const orders: DuckTable = {
  name: "orders",
  columns: [
    { name: "id", type: "number" },
    { name: "region", type: "string" },
    { name: "customer_id", type: "number" },
    { name: "amount", type: "number" },
  ],
  rows: [
    { id: 1, region: "EMEA", customer_id: 1, amount: 100 },
    { id: 2, region: "EMEA", customer_id: 2, amount: 50 },
    { id: 3, region: "APAC", customer_id: 1, amount: 70 },
    { id: 4, region: "AMER", customer_id: 3, amount: 10 },
    { id: 5, region: null, customer_id: 2, amount: 40 },
  ],
};

const items: DuckTable = {
  name: "items",
  columns: [
    { name: "order_id", type: "number" },
    { name: "qty", type: "number" },
  ],
  rows: [
    { order_id: 1, qty: 2 },
    { order_id: 1, qty: 3 },
    { order_id: 1, qty: 1 },
    { order_id: 2, qty: 5 },
    { order_id: 3, qty: 4 },
    { order_id: 5, qty: 6 },
  ],
};

const shipments: DuckTable = {
  name: "shipments",
  columns: [
    { name: "order_id", type: "number" },
    { name: "weight", type: "number" },
  ],
  rows: [
    { order_id: 1, weight: 9 },
    { order_id: 2, weight: 1 },
    { order_id: 2, weight: 2 },
    { order_id: 4, weight: 7 },
  ],
};

const customers: DuckTable = {
  name: "customers",
  columns: [
    { name: "id", type: "number" },
    { name: "tier", type: "string" },
  ],
  rows: [
    { id: 1, tier: "gold" },
    { id: 2, tier: "silver" },
    { id: 3, tier: "gold" },
  ],
};

const model: SemanticModel = {
  name: "m",
  source: { kind: "data_table", table: "orders" },
  primaryKey: "id",
  joins: [
    {
      table: "customers",
      on: "orders.customer_id = customers.id",
      type: "left",
      cardinality: "many_to_one",
    },
    { table: "items", on: "orders.id = items.order_id", type: "left", cardinality: "one_to_many" },
    {
      table: "shipments",
      on: "orders.id = shipments.order_id",
      type: "left",
      cardinality: "one_to_many",
    },
  ],
  dimensions: [
    { name: "region", sql: "orders.region", type: "categorical" },
    { name: "tier", sql: "customers.tier", type: "categorical" },
    { name: "item_qty_dim", sql: "items.qty", type: "number" },
  ],
  metrics: [
    { name: "total_amount", agg: "sum", sql: "orders.amount" },
    { name: "total_qty", agg: "sum", sql: "items.qty" },
    { name: "total_weight", agg: "sum", sql: "shipments.weight" },
    { name: "order_n", agg: "count_distinct", sql: "orders.id" },
    { name: "cross_fact", agg: "sum", sql: "items.qty * shipments.weight" },
    { name: "qty_per_amount", agg: "derived", sql: "{total_qty} * 1.0 / {total_amount}" },
    // Unqualified on purpose: binds inside the FULL join scope, like today.
    { name: "bare_max", agg: "max", sql: "qty" },
    {
      name: "both_facts_custom",
      agg: "custom",
      sql: "SUM(DISTINCT items.qty) + SUM(DISTINCT shipments.weight)",
    },
  ],
} as SemanticModel;

const compile = (q: Partial<SemanticQuery>) =>
  compileSemanticQuery(model, { model: "m", ...q } as SemanticQuery, { dialect: "duckdb" });

const exec = async (q: Partial<SemanticQuery>) =>
  (await runLocalSqlDuckDB(compile(q).sql, [orders, items, shipments, customers])).rows;

describe("three facts, one query, every number at its own grain", () => {
  it("matches the hand-computed table, including NULL region and missing facts", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_qty", "total_weight"],
      dimensions: ["region"],
      orderBy: [{ field: "total_amount", dir: "desc" }],
    });
    // By hand: EMEA amount 150 qty 2+3+1+5=11 weight 9+1+2=12;
    //          APAC 70 / 4 / none; AMER 10 / none / 7; NULL 40 / 6 / none.
    expect(rows).toEqual([
      { region: "EMEA", total_amount: 150, total_qty: 11, total_weight: 12 },
      { region: "APAC", total_amount: 70, total_qty: 4, total_weight: null },
      { region: null, total_amount: 40, total_qty: 6, total_weight: null },
      { region: "AMER", total_amount: 10, total_qty: null, total_weight: 7 },
    ]);
  });

  it("a LOOKUP dimension rides every branch and the spine", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_qty"],
      dimensions: ["tier"],
      orderBy: [{ field: "tier", dir: "asc" }],
    });
    // gold: orders 1,3,4 → amount 180, qty 6+4=10; silver: orders 2,5 →
    // amount 90, qty 5+6=11.
    expect(rows).toEqual([
      { tier: "gold", total_amount: 180, total_qty: 10 },
      { tier: "silver", total_amount: 90, total_qty: 11 },
    ]);
  });

  it("a dimension FILTER scopes every branch identically", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_weight"],
      dimensions: ["region"],
      filters: [{ field: "region", op: "in", value: ["EMEA", "AMER"] }],
      orderBy: [{ field: "region", dir: "asc" }],
    });
    expect(rows).toEqual([
      { region: "AMER", total_amount: 10, total_weight: 7 },
      { region: "EMEA", total_amount: 150, total_weight: 12 },
    ]);
  });

  it("a metric FILTER is the plan's HAVING — applied over the stitched columns", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_qty"],
      dimensions: ["region"],
      filters: [{ field: "total_amount", op: ">", value: 50 }],
      orderBy: [{ field: "region", dir: "asc" }],
    });
    expect(rows).toEqual([
      { region: "APAC", total_amount: 70, total_qty: 4 },
      { region: "EMEA", total_amount: 150, total_qty: 11 },
    ]);
  });

  it("a GRAND TOTAL cross-joins one aggregate row per branch", async () => {
    const rows = await exec({ metrics: ["total_amount", "total_qty", "total_weight"] });
    expect(rows).toEqual([{ total_amount: 270, total_qty: 21, total_weight: 19 }]);
  });

  it("a derived metric spanning two branches computes over their columns", async () => {
    const rows = await exec({
      metrics: ["qty_per_amount"],
      dimensions: ["region"],
      filters: [{ field: "region", op: "=", value: "EMEA" }],
    });
    // 11 / 150 — the leaves are computed in their branches even though
    // neither leaf was requested.
    expect(rows).toEqual([{ region: "EMEA", qty_per_amount: 11 / 150 }]);
  });

  it("count_distinct keeps its single-pass scope inside the plan and stays right", async () => {
    const rows = await exec({
      metrics: ["total_qty", "order_n"],
      dimensions: ["region"],
      filters: [{ field: "region", op: "=", value: "EMEA" }],
    });
    expect(rows).toEqual([{ region: "EMEA", total_qty: 11, order_n: 2 }]);
  });

  it("a custom metric reading BOTH facts keeps its full single-pass scope", async () => {
    // The owner-trusted escape hatch must see the same joined result it sees
    // today — the plan gives it its own branch with EVERY join ("*"), so
    // resolution never changes what an already-legal metric computes.
    const rows = await exec({
      metrics: ["total_amount", "both_facts_custom"],
      dimensions: ["region"],
      filters: [{ field: "region", op: "=", value: "EMEA" }],
    });
    // DISTINCT qty over EMEA {2,3,1,5} = 11; DISTINCT weight {9,1,2} = 12.
    expect(rows).toEqual([{ region: "EMEA", total_amount: 150, both_facts_custom: 23 }]);
  });

  it("an unqualified duplicate-insensitive metric keeps its single-pass binding", async () => {
    // max(qty) is legal today in the full joined scope, where the engine
    // binds qty to items. The plan must give it that same scope ("*") — a
    // base branch would not even have the column.
    const rows = await exec({
      metrics: ["total_amount", "bare_max"],
      dimensions: ["region"],
      filters: [{ field: "region", op: "=", value: "EMEA" }],
    });
    expect(rows).toEqual([{ region: "EMEA", total_amount: 150, bare_max: 5 }]);
  });

  it("ORDER BY a metric and LIMIT apply after the stitch", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_weight"],
      dimensions: ["region"],
      orderBy: [{ field: "total_weight", dir: "desc" }],
      limit: 2,
    });
    expect(rows).toEqual([
      { region: "EMEA", total_amount: 150, total_weight: 12 },
      { region: "AMER", total_amount: 10, total_weight: 7 },
    ]);
  });
});

describe("the envelope — what still refuses, and why", () => {
  it("a metric across two facts has no grain to aggregate at", () => {
    expect(() => compile({ metrics: ["cross_fact"], dimensions: ["region"] })).toThrow(
      /cross_fact.*"items" and "shipments".*no single grain.*derived metric/is,
    );
  });

  it("a dimension from a fanning table cannot group the other facts", () => {
    expect(() => compile({ metrics: ["total_amount"], dimensions: ["item_qty_dim"] })).toThrow(
      /item_qty_dim.*fanning join "items".*deduplication/is,
    );
  });

  it("period-over-period over a multi-fact plan refuses, naming both causes", () => {
    expect(() =>
      compile({
        metrics: ["total_amount", "total_qty"],
        dimensions: ["region"],
        compare: "prior_period",
        grains: {},
      }),
    ).toThrow(/multi-fact plan.*not supported yet/is);
  });

  it("an INNER fanning join is a row filter the plan cannot keep", () => {
    const inner: SemanticModel = {
      ...model,
      joins: model.joins!.map((j) => (j.table === "items" ? { ...j, type: "inner" as const } : j)),
    };
    expect(() =>
      compileSemanticQuery(
        inner,
        { model: "m", metrics: ["total_amount", "total_qty"], dimensions: ["region"] },
        { dialect: "duckdb" },
      ),
    ).toThrow(/INNER and fans out.*Make it LEFT/is);
  });

  it("a lookup chained THROUGH a fanning join cannot stand alone in a branch", () => {
    const chained: SemanticModel = {
      ...model,
      joins: [
        ...model.joins!,
        {
          table: "customers",
          alias: "item_owner",
          on: "item_owner.id = items.order_id",
          type: "left",
          cardinality: "many_to_one",
        },
      ],
    };
    expect(() =>
      compileSemanticQuery(
        chained,
        { model: "m", metrics: ["total_amount", "total_qty"], dimensions: ["region"] },
        { dialect: "duckdb" },
      ),
    ).toThrow(/item_owner.*chained through the fanning join "items"/is);
  });

  it("AlaSQL refuses — the plan needs CTEs", () => {
    expect(() =>
      compileSemanticQuery(
        model,
        { model: "m", metrics: ["total_amount", "total_qty"], dimensions: ["region"] },
        { dialect: "alasql" },
      ),
    ).toThrow(/AlaSQL engine has no CTEs/is);
  });

  it("a metric filter on a metric the query does not return refuses", () => {
    expect(() =>
      compile({
        metrics: ["total_amount", "total_qty"],
        dimensions: ["region"],
        filters: [{ field: "total_weight", op: ">", value: 5 }],
      }),
    ).toThrow(/only filter on metrics the query returns.*total_weight/is);
  });

  it("the refusal carries BOTH stories: the original error and why no plan applied", () => {
    try {
      compileSemanticQuery(
        model,
        {
          model: "m",
          metrics: ["total_amount", "total_qty"],
          dimensions: ["region"],
          compare: "prior_period",
        },
        { dialect: "duckdb" },
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/double-count/); // the original fan-out refusal
      expect(msg).toMatch(/multi-fact plan could not resolve/); // and the reason
    }
  });
});

describe("plan shape — claims about the SQL itself", () => {
  it("each branch joins ONLY its own fact; the spine joins none", () => {
    const c = compile({
      metrics: ["total_amount", "total_qty", "total_weight"],
      dimensions: ["region"],
    });
    // The spine and the base branch never mention a fact table.
    const spine = c.sql.match(/semantic_spine AS \((.*?)\)/)?.[1] ?? "";
    expect(spine).toContain("DISTINCT");
    expect(spine).not.toContain("items");
    expect(spine).not.toContain("shipments");
    // One LEFT JOIN per branch, all NULL-safe.
    expect(c.sql.match(/IS NOT DISTINCT FROM/g)?.length).toBe(3);
  });

  it("the time-grain expression is identical in spine and branches", () => {
    const timeModel: SemanticModel = {
      ...model,
      dimensions: [...model.dimensions, { name: "day", sql: "orders.day", type: "time" }],
    } as SemanticModel;
    const c = compileSemanticQuery(
      timeModel,
      {
        model: "m",
        metrics: ["total_amount", "total_qty"],
        dimensions: ["day"],
        grains: { day: "month" },
      },
      { dialect: "duckdb" },
    );
    // The truncation must appear once per branch plus once in the spine —
    // if the spine computed a different expression the join keys would
    // never match and every group would silently lose its facts.
    const truncs = c.sql.match(/DATE_TRUNC\('month'/g) ?? [];
    expect(truncs.length).toBeGreaterThanOrEqual(3);
  });
});
