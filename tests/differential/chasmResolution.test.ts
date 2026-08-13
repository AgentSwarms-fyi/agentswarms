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
    { name: "day", type: "date" },
  ],
  rows: [
    { id: 1, region: "EMEA", customer_id: 1, amount: 100, day: "2026-01-10" },
    { id: 2, region: "EMEA", customer_id: 2, amount: 50, day: "2026-01-20" },
    { id: 3, region: "APAC", customer_id: 1, amount: 70, day: "2026-02-05" },
    { id: 4, region: "AMER", customer_id: 3, amount: 10, day: "2026-02-15" },
    { id: 5, region: null, customer_id: 2, amount: 40, day: "2026-02-25" },
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
    { name: "day", sql: "orders.day", type: "time" },
    // Buckets several fact rows of one order into ONE value — the case where
    // primary-key deduplication is the difference between right and 3×.
    {
      name: "item_bucket",
      sql: "CASE WHEN items.qty > 3 THEN 'big' ELSE 'small' END",
      type: "categorical",
    },
    {
      name: "ship_bucket",
      sql: "CASE WHEN shipments.weight > 5 THEN 'heavy' ELSE 'light' END",
      type: "categorical",
    },
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

  it("a fact-side dimension without a primary key stays refused, naming the fix", () => {
    const noPk: SemanticModel = { ...model, primaryKey: undefined } as SemanticModel;
    expect(() =>
      compileSemanticQuery(
        noPk,
        { model: "m", metrics: ["total_amount"], dimensions: ["item_bucket"] },
        { dialect: "duckdb" },
      ),
    ).toThrow(/fanning join "items".*primary-key deduplication.*declare the model's primary key/is);
  });

  it("dimensions from TWO facts stay refused — no shared row identity", () => {
    expect(() =>
      compile({ metrics: ["total_amount"], dimensions: ["item_bucket", "ship_bucket"] }),
    ).toThrow(/"items" and "shipments".*no shared row identity/is);
  });

  it("a metric from the OTHER fact cannot be grouped by this fact's dimension", () => {
    expect(() => compile({ metrics: ["total_weight"], dimensions: ["item_bucket"] })).toThrow(
      /total_weight.*"shipments".*no key to deduplicate/is,
    );
  });

  it("compare still demands exactly one grained time axis, plan or no plan", () => {
    expect(() =>
      compile({
        metrics: ["total_amount", "total_qty"],
        dimensions: ["region"],
        compare: "prior_period",
        grains: {},
      }),
    ).toThrow(/exactly one time dimension with a grain/is);
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
    const inner: SemanticModel = {
      ...model,
      joins: model.joins!.map((j) => (j.table === "items" ? { ...j, type: "inner" as const } : j)),
    };
    try {
      compileSemanticQuery(
        inner,
        { model: "m", metrics: ["total_amount", "total_qty"], dimensions: ["region"] },
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

describe("primary-key deduplication: base metrics grouped by a fact-side dimension", () => {
  it("each order counts ONCE per bucket, however many fact rows land there", async () => {
    // Order 1 has THREE items in the 'small' bucket — the naive fanned sum
    // says small = 300; the key collapses it to one row per (order, bucket).
    // By hand: big ← o2(50)+o3(70)+o5(40)=160; small ← o1(100) AND o4(10):
    // o4 has no items, so items.qty is NULL and the CASE's ELSE catches it —
    // NULL > 3 is NULL, not false-into-a-NULL-bucket. Fact metric at its own
    // grain: big qty 5+4+6=15, small 2+3+1=6 (o4's NULL qty adds nothing).
    // Distinct orders: big {2,3,5}=3, small {1,4}=2.
    const rows = await exec({
      metrics: ["total_amount", "total_qty", "order_n"],
      dimensions: ["item_bucket"],
      orderBy: [{ field: "total_amount", dir: "desc" }],
    });
    expect(rows).toEqual([
      { item_bucket: "big", total_amount: 160, total_qty: 15, order_n: 3 },
      { item_bucket: "small", total_amount: 110, total_qty: 6, order_n: 2 },
    ]);
  });

  it("a filter on the fact-side dimension scopes the deduplicated branch too", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_qty"],
      dimensions: ["item_bucket"],
      filters: [{ field: "item_bucket", op: "=", value: "big" }],
    });
    expect(rows).toEqual([{ item_bucket: "big", total_amount: 160, total_qty: 15 }]);
  });

  it("deduplication composes with period-over-period", async () => {
    // big by month: Jan ← o2(50); Feb ← o3(70)+o5(40)=110, prev 50.
    const rows = await exec({
      metrics: ["total_amount"],
      dimensions: ["day", "item_bucket"],
      grains: { day: "month" },
      compare: "prior_period",
      filters: [{ field: "item_bucket", op: "=", value: "big" }],
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      {
        day: "2026-01-01",
        item_bucket: "big",
        total_amount: 50,
        total_amount_prev: null,
        total_amount_change: null,
        total_amount_pct_change: null,
      },
      {
        day: "2026-02-01",
        item_bucket: "big",
        total_amount: 110,
        total_amount_prev: 50,
        total_amount_change: 60,
        total_amount_pct_change: 1.2,
      },
    ]);
  });

  it("a filtered measure keeps its filter inside the deduplicated aggregate", async () => {
    // amount for EMEA orders only, attributed per bucket: o1 (EMEA, small)
    // and o2 (EMEA, big) — the region condition rides as a flag column.
    const emeaModel: SemanticModel = {
      ...model,
      metrics: [
        ...model.metrics,
        {
          name: "emea_amount",
          agg: "sum",
          sql: "orders.amount",
          filters: ["orders.region = 'EMEA'"],
        },
      ],
    } as SemanticModel;
    const c = compileSemanticQuery(
      emeaModel,
      {
        model: "m",
        metrics: ["emea_amount"],
        dimensions: ["item_bucket"],
        orderBy: [{ field: "item_bucket", dir: "asc" }],
      },
      { dialect: "duckdb" },
    );
    const rows = (await runLocalSqlDuckDB(c.sql, [orders, items, shipments, customers])).rows;
    // o4 (no items) lands in 'small' via the CASE's ELSE and is not EMEA,
    // so it contributes nothing there.
    expect(rows).toEqual([
      { item_bucket: "big", emea_amount: 50 },
      { item_bucket: "small", emea_amount: 100 },
    ]);
  });
});

describe("sharp edges with purpose-built micro-fixtures", () => {
  it("two orders with IDENTICAL values still count twice — the key is load-bearing", async () => {
    // Without the pk in the DISTINCT, these two rows collapse into one and
    // the sum silently halves.
    const o2x: DuckTable = {
      name: "orders",
      columns: [
        { name: "id", type: "number" },
        { name: "amount", type: "number" },
      ],
      rows: [
        { id: 1, amount: 50 },
        { id: 2, amount: 50 },
      ],
    };
    const it2: DuckTable = {
      name: "items",
      columns: [
        { name: "order_id", type: "number" },
        { name: "qty", type: "number" },
      ],
      rows: [
        // Order 1 relates to the SAME bucket twice: the DISTINCT must
        // collapse that (one row per order per bucket) while the key keeps
        // order 2's identical values apart.
        { order_id: 1, qty: 9 },
        { order_id: 1, qty: 9 },
        { order_id: 2, qty: 9 },
      ],
    };
    const m2: SemanticModel = {
      name: "m2",
      source: { kind: "data_table", table: "orders" },
      primaryKey: "id",
      joins: [
        {
          table: "items",
          on: "orders.id = items.order_id",
          type: "left",
          cardinality: "one_to_many",
        },
      ],
      dimensions: [{ name: "qty_bucket", sql: "items.qty", type: "number" }],
      metrics: [{ name: "amt", agg: "sum", sql: "orders.amount" }],
    } as SemanticModel;
    const c = compileSemanticQuery(
      m2,
      { model: "m2", metrics: ["amt"], dimensions: ["qty_bucket"] },
      { dialect: "duckdb" },
    );
    const rows = (await runLocalSqlDuckDB(c.sql, [o2x, it2])).rows;
    expect(rows).toEqual([{ qty_bucket: 9, amt: 100 }]);
  });

  it("the plan comparison keeps the divide-by-zero guard (structural)", () => {
    // DuckDB tolerates x/0; Snowflake and Postgres do not. The guard's
    // absence is invisible to a local run, so it is pinned structurally.
    const mG: SemanticModel = {
      name: "mg",
      source: { kind: "data_table", table: "orders" },
      joins: [
        {
          table: "items",
          on: "orders.id = items.order_id",
          type: "left",
          cardinality: "one_to_many",
        },
      ],
      dimensions: [{ name: "day", sql: "orders.day", type: "time" }],
      metrics: [
        { name: "amt", agg: "sum", sql: "orders.amount" },
        { name: "qty", agg: "sum", sql: "items.qty" },
      ],
    } as SemanticModel;
    const c = compileSemanticQuery(
      mG,
      {
        model: "mg",
        metrics: ["amt"],
        dimensions: ["day"],
        grains: { day: "month" },
        compare: "prior_period",
      },
      { dialect: "duckdb" },
    );
    expect(c.sql).toContain("= 0 THEN NULL");
    expect(c.sql).toContain("semantic_cur");
    expect(c.sql).toContain("semantic_prev");
    expect(c.sql).toContain("semantic_p");
  });

  it("a NULL dimension group finds ITS OWN prior period across the plan", async () => {
    // Both months have a NULL-region group; the cur/prev stitch must be
    // NULL-safe or February's NULL group silently loses its comparison.
    const oN: DuckTable = {
      name: "orders",
      columns: [
        { name: "id", type: "number" },
        { name: "region", type: "string" },
        { name: "amount", type: "number" },
        { name: "day", type: "date" },
      ],
      rows: [
        { id: 1, region: null, amount: 10, day: "2026-01-05" },
        { id: 2, region: null, amount: 20, day: "2026-02-05" },
      ],
    };
    const iN: DuckTable = {
      name: "items",
      columns: [
        { name: "order_id", type: "number" },
        { name: "qty", type: "number" },
      ],
      rows: [{ order_id: 1, qty: 3 }],
    };
    const mN: SemanticModel = {
      name: "mn",
      source: { kind: "data_table", table: "orders" },
      primaryKey: "id",
      joins: [
        {
          table: "items",
          on: "orders.id = items.order_id",
          type: "left",
          cardinality: "one_to_many",
        },
      ],
      dimensions: [
        { name: "region", sql: "orders.region", type: "categorical" },
        { name: "day", sql: "orders.day", type: "time" },
      ],
      metrics: [
        { name: "amt", agg: "sum", sql: "orders.amount" },
        { name: "qty", agg: "sum", sql: "items.qty" },
      ],
    } as SemanticModel;
    const c = compileSemanticQuery(
      mN,
      {
        model: "mn",
        metrics: ["amt"],
        dimensions: ["day", "region"],
        grains: { day: "month" },
        compare: "prior_period",
        orderBy: [{ field: "day", dir: "asc" }],
      },
      { dialect: "duckdb" },
    );
    const rows = (await runLocalSqlDuckDB(c.sql, [oN, iN])).rows;
    expect(rows).toEqual([
      {
        day: "2026-01-01",
        region: null,
        amt: 10,
        amt_prev: null,
        amt_change: null,
        amt_pct_change: null,
      },
      {
        day: "2026-02-01",
        region: null,
        amt: 20,
        amt_prev: 10,
        amt_change: 10,
        amt_pct_change: 1,
      },
    ]);
  });
});

describe("period-over-period ACROSS the plan", () => {
  it("each month's _prev is last month's value, per fact, hand-computed", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_qty", "total_weight"],
      dimensions: ["day"],
      grains: { day: "month" },
      compare: "prior_period",
      orderBy: [{ field: "day", dir: "asc" }],
    });
    // By hand: Jan (o1,o2) amount 150, qty 2+3+1+5=11, weight 9+1+2=12;
    //          Feb (o3,o4,o5) amount 120, qty 4+6=10, weight 7.
    // January has no predecessor — NULL comparisons, not zero.
    expect(rows).toEqual([
      {
        day: "2026-01-01",
        total_amount: 150,
        total_qty: 11,
        total_weight: 12,
        total_amount_prev: null,
        total_amount_change: null,
        total_amount_pct_change: null,
        total_qty_prev: null,
        total_qty_change: null,
        total_qty_pct_change: null,
        total_weight_prev: null,
        total_weight_change: null,
        total_weight_pct_change: null,
      },
      {
        day: "2026-02-01",
        total_amount: 120,
        total_qty: 10,
        total_weight: 7,
        total_amount_prev: 150,
        total_amount_change: -30,
        total_amount_pct_change: -30 / 150,
        total_qty_prev: 11,
        total_qty_change: -1,
        total_qty_pct_change: -1 / 11,
        total_weight_prev: 12,
        total_weight_change: -5,
        total_weight_pct_change: -5 / 12,
      },
    ]);
  });

  it("a derived metric compares too — its _prev comes from the prior plan's columns", async () => {
    const rows = await exec({
      metrics: ["qty_per_amount"],
      dimensions: ["day"],
      grains: { day: "month" },
      compare: "prior_period",
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      {
        day: "2026-01-01",
        qty_per_amount: 11 / 150,
        qty_per_amount_prev: null,
        qty_per_amount_change: null,
        qty_per_amount_pct_change: null,
      },
      {
        day: "2026-02-01",
        qty_per_amount: 10 / 120,
        qty_per_amount_prev: 11 / 150,
        qty_per_amount_change: 10 / 120 - 11 / 150,
        qty_per_amount_pct_change: (10 / 120 - 11 / 150) / (11 / 150),
      },
    ]);
  });

  it("a second grouping dimension rides along and lines up with ITS prior bucket", async () => {
    const rows = await exec({
      metrics: ["total_amount", "total_qty"],
      dimensions: ["day", "region"],
      grains: { day: "month" },
      compare: "prior_period",
      filters: [{ field: "region", op: "=", value: "EMEA" }],
      orderBy: [{ field: "day", dir: "asc" }],
    });
    // EMEA exists only in January — its February row does not exist, and
    // January's EMEA has no EMEA predecessor.
    expect(rows).toEqual([
      {
        day: "2026-01-01",
        region: "EMEA",
        total_amount: 150,
        total_qty: 11,
        total_amount_prev: null,
        total_amount_change: null,
        total_amount_pct_change: null,
        total_qty_prev: null,
        total_qty_change: null,
        total_qty_pct_change: null,
      },
    ]);
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
    const c = compileSemanticQuery(
      model,
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
