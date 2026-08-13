// Aggregate awareness, EXECUTED against hand-computed truth.
//
// A rollup is the owner's claim that a table holds pre-aggregated truth;
// routing is the compiler cashing that claim only where the answer is
// PROVABLY the one the fact table would give. Every test here runs the same
// query BOTH ways — routed and with rollups stripped — and the differential
// is the point: identical numbers when routing applies, fact-table numbers
// (never rollup guesses) when it must not.
import { describe, expect, it } from "vitest";

import {
  compileSemanticQuery,
  grainServes,
  routeToRollup,
  type SemanticModel,
  type SemanticQuery,
  type SemanticRollup,
} from "@/lib/semanticLayer";
import { measureRollupHealth } from "@/lib/semanticMeasure";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

const sales: DuckTable = {
  name: "sales",
  columns: [
    { name: "id", type: "number" },
    { name: "day", type: "date" },
    { name: "region", type: "string" },
    { name: "channel", type: "string" },
    { name: "amount", type: "number" },
  ],
  rows: [
    { id: 1, day: "2026-01-05", region: "EMEA", channel: "web", amount: 10 },
    { id: 2, day: "2026-01-20", region: "EMEA", channel: "store", amount: 20 },
    { id: 3, day: "2026-01-25", region: "APAC", channel: "web", amount: 40 },
    { id: 4, day: "2026-02-03", region: "EMEA", channel: "web", amount: 5 },
    { id: 5, day: "2026-02-10", region: "APAC", channel: "store", amount: 15 },
    { id: 6, day: "2026-02-15", region: "APAC", channel: "web", amount: 25 },
  ],
};

// A CORRECT month × region rollup of the fact above — the honest case.
// Month sums: Jan 70 (30 EMEA + 40 APAC), Feb 45 (5 EMEA + 40 APAC);
// counts: Jan 3, Feb 3.
const rollupTable: DuckTable = {
  name: "sales_by_mr",
  columns: [
    { name: "m", type: "date" },
    { name: "region", type: "string" },
    { name: "amount_sum", type: "number" },
    { name: "n", type: "number" },
  ],
  rows: [
    { m: "2026-01-01", region: "EMEA", amount_sum: 30, n: 2 },
    { m: "2026-01-01", region: "APAC", amount_sum: 40, n: 1 },
    { m: "2026-02-01", region: "EMEA", amount_sum: 5, n: 1 },
    { m: "2026-02-01", region: "APAC", amount_sum: 40, n: 2 },
  ],
};

const rollup: SemanticRollup = {
  table: "sales_by_mr",
  dimensions: [
    { dimension: "day", column: "m", grain: "month" },
    { dimension: "region", column: "region" },
  ],
  metrics: [
    { metric: "revenue", column: "amount_sum" },
    { metric: "orders", column: "n" },
    // An avg mapping is DECLARABLE in memory but must never route: an avg of
    // partial avgs answers a different question.
    { metric: "avg_sale", column: "amount_sum" },
  ],
};

const model: SemanticModel = {
  name: "m",
  source: { kind: "data_table", table: "sales" },
  primaryKey: "id",
  rollups: [rollup],
  dimensions: [
    { name: "day", sql: "sales.day", type: "time" },
    { name: "region", sql: "sales.region", type: "categorical" },
    { name: "channel", sql: "sales.channel", type: "categorical" },
  ],
  metrics: [
    { name: "revenue", agg: "sum", sql: "sales.amount" },
    { name: "orders", agg: "count", sql: "sales.id" },
    { name: "max_sale", agg: "max", sql: "sales.amount" },
    { name: "avg_sale", agg: "avg", sql: "sales.amount" },
    { name: "rev_per_order", agg: "derived", sql: "{revenue} * 1.0 / {orders}" },
  ],
} as SemanticModel;

const factModel: SemanticModel = { ...model, rollups: undefined };

const compile = (q: Partial<SemanticQuery>, m: SemanticModel = model) =>
  compileSemanticQuery(m, { model: m.name, ...q } as SemanticQuery, { dialect: "duckdb" });

const run = async (q: Partial<SemanticQuery>, m: SemanticModel = model) => {
  const c = compile(q, m);
  const rows = (await runLocalSqlDuckDB(c.sql, [sales, rollupTable])).rows;
  return { c, rows };
};

/** The same query, routed and unrouted, must agree — that IS the feature. */
const differential = async (q: Partial<SemanticQuery>) => {
  const routed = await run(q, model);
  const fact = await run(q, factModel);
  expect(routed.rows).toEqual(fact.rows);
  return routed;
};

describe("routing answers from the rollup, identically to the fact", () => {
  it("a month-grain query routes, discloses itself, and matches the fact", async () => {
    const { c, rows } = await differential({
      metrics: ["revenue"],
      dimensions: ["day"],
      grains: { day: "month" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      { day: "2026-01-01", revenue: 70 },
      { day: "2026-02-01", revenue: 45 },
    ]);
    expect(c.rollup).toBe("sales_by_mr");
    expect(c.sql).toContain("FROM sales_by_mr");
    expect(c.sql).toContain("/* answered by rollup sales_by_mr, declared on model m */");
    expect(c.sql).not.toContain("FROM sales ");
  });

  it("month × region routes with both dimensions", async () => {
    const { c, rows } = await differential({
      metrics: ["revenue"],
      dimensions: ["day", "region"],
      grains: { day: "month" },
      orderBy: [
        { field: "day", dir: "asc" },
        { field: "region", dir: "asc" },
      ],
    });
    expect(c.rollup).toBe("sales_by_mr");
    expect(rows).toEqual([
      { day: "2026-01-01", region: "APAC", revenue: 40 },
      { day: "2026-01-01", region: "EMEA", revenue: 30 },
      { day: "2026-02-01", region: "APAC", revenue: 40 },
      { day: "2026-02-01", region: "EMEA", revenue: 5 },
    ]);
  });

  it("a QUARTER query re-aggregates the month store (grain nesting)", async () => {
    const { c, rows } = await differential({
      metrics: ["revenue"],
      dimensions: ["day"],
      grains: { day: "quarter" },
    });
    expect(c.rollup).toBe("sales_by_mr");
    expect(rows).toEqual([{ day: "2026-01-01", revenue: 115 }]);
  });

  it("a pre-COUNT re-aggregates by summing the partial counts", async () => {
    const { c, rows } = await differential({
      metrics: ["orders"],
      dimensions: ["day"],
      grains: { day: "month" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(c.rollup).toBe("sales_by_mr");
    expect(rows).toEqual([
      { day: "2026-01-01", orders: 3 },
      { day: "2026-02-01", orders: 3 },
    ]);
  });

  it("a derived formula routes when every leaf routes", async () => {
    const { c, rows } = await differential({
      metrics: ["rev_per_order"],
      dimensions: ["day"],
      grains: { day: "month" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(c.rollup).toBe("sales_by_mr");
    expect(rows).toEqual([
      { day: "2026-01-01", rev_per_order: 70 / 3 },
      { day: "2026-02-01", rev_per_order: 15 },
    ]);
  });

  it("a dimension filter applies to the rollup's own columns", async () => {
    const { c, rows } = await differential({
      metrics: ["revenue"],
      dimensions: ["day"],
      grains: { day: "month" },
      filters: [{ field: "region", op: "=", value: "EMEA" }],
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(c.rollup).toBe("sales_by_mr");
    expect(rows).toEqual([
      { day: "2026-01-01", revenue: 30 },
      { day: "2026-02-01", revenue: 5 },
    ]);
  });

  it("period-over-period rides the routed store unchanged", async () => {
    const { c, rows } = await differential({
      metrics: ["revenue"],
      dimensions: ["day"],
      grains: { day: "month" },
      compare: "prior_period",
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(c.rollup).toBe("sales_by_mr");
    expect(rows).toEqual([
      {
        day: "2026-01-01",
        revenue: 70,
        revenue_prev: null,
        revenue_change: null,
        revenue_pct_change: null,
      },
      {
        day: "2026-02-01",
        revenue: 45,
        revenue_prev: 70,
        revenue_change: -25,
        revenue_pct_change: -25 / 70,
      },
    ]);
  });

  it("a query the FACT could only answer through a multi-fact plan routes directly", async () => {
    // Add a fanning join: the single pass would refuse and build branches.
    // The rollup has no joins, so it answers the base metric directly.
    const items: DuckTable = {
      name: "items",
      columns: [
        { name: "sale_id", type: "number" },
        { name: "qty", type: "number" },
      ],
      rows: [
        { sale_id: 1, qty: 2 },
        { sale_id: 1, qty: 3 },
      ],
    };
    const fanned: SemanticModel = {
      ...model,
      name: "fanned",
      joins: [
        {
          table: "items",
          on: "sales.id = items.sale_id",
          type: "left",
          cardinality: "one_to_many",
        },
      ],
    } as SemanticModel;
    const c = compile(
      {
        metrics: ["revenue"],
        dimensions: ["day"],
        grains: { day: "month" },
        orderBy: [{ field: "day", dir: "asc" }],
      },
      fanned,
    );
    expect(c.rollup).toBe("sales_by_mr");
    expect(c.sql).not.toContain("semantic_f0"); // no plan, no branches
    const rows = (await runLocalSqlDuckDB(c.sql, [sales, rollupTable, items])).rows;
    expect(rows).toEqual([
      { day: "2026-01-01", revenue: 70 },
      { day: "2026-02-01", revenue: 45 },
    ]);
  });

  it("with two eligible rollups, the FIRST declared answers", () => {
    const twin: SemanticModel = {
      ...model,
      rollups: [rollup, { ...rollup, table: "sales_by_mr_v2" }],
    } as SemanticModel;
    const c = compile(
      { metrics: ["revenue"], dimensions: ["day"], grains: { day: "month" } },
      twin,
    );
    expect(c.rollup).toBe("sales_by_mr");
  });
});

describe("everything unprovable falls back to the FACT, never to the rollup", () => {
  const expectFact = (c: { sql: string; rollup?: string }) => {
    expect(c.rollup).toBeUndefined();
    expect(c.sql).toContain("FROM sales");
    expect(c.sql).not.toContain("sales_by_mr");
  };

  it("a DAY query cannot be served by a month store", async () => {
    const { c, rows } = await run({
      metrics: ["revenue"],
      dimensions: ["day"],
      grains: { day: "day" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expectFact(c);
    expect(rows).toHaveLength(6);
  });

  it("an UNGRAINED time dimension groups raw values only the fact holds", async () => {
    const { c } = await run({ metrics: ["revenue"], dimensions: ["day"] });
    expectFact(c);
  });

  it("an unmapped metric keeps the whole query on the fact", async () => {
    const { c, rows } = await run({
      metrics: ["revenue", "max_sale"],
      dimensions: ["day"],
      grains: { day: "month" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expectFact(c);
    expect(rows).toEqual([
      { day: "2026-01-01", revenue: 70, max_sale: 40 },
      { day: "2026-02-01", revenue: 45, max_sale: 25 },
    ]);
  });

  it("an AVG never routes, even when someone mapped it", async () => {
    // Fact truth: Jan 70/3 = 23.33…; the avg-of-partial-avgs lie would be 35.
    const { c, rows } = await run({
      metrics: ["avg_sale"],
      dimensions: ["day"],
      grains: { day: "month" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expectFact(c);
    expect(Number(rows[0].avg_sale)).toBeCloseTo(70 / 3, 10);
  });

  it("a filter on a dimension the rollup lacks blends rows — refused", async () => {
    const { c, rows } = await run({
      metrics: ["revenue"],
      dimensions: ["day"],
      grains: { day: "month" },
      filters: [{ field: "channel", op: "=", value: "web" }],
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expectFact(c);
    expect(rows).toEqual([
      { day: "2026-01-01", revenue: 50 },
      { day: "2026-02-01", revenue: 30 },
    ]);
  });

  it("a parameterised metric was baked with SOME value — never routed", () => {
    const par: SemanticModel = {
      ...model,
      name: "par",
      parameters: [{ name: "min_amount", type: "number", default: 5 }],
      metrics: [
        {
          name: "revenue",
          agg: "sum",
          sql: "sales.amount",
          filters: ["sales.amount >= {{min_amount}}"],
        },
      ],
      rollups: [{ ...rollup, metrics: [{ metric: "revenue", column: "amount_sum" }] }],
    } as SemanticModel;
    const c = compile({ metrics: ["revenue"], dimensions: ["day"], grains: { day: "month" } }, par);
    expect(c.rollup).toBeUndefined();
    expect(c.sql).toContain("FROM sales");
  });

  it("count_distinct does not survive partial aggregation — never routed", () => {
    const cd: SemanticModel = {
      ...model,
      name: "cd",
      metrics: [{ name: "regions_n", agg: "count_distinct", sql: "sales.region" }],
      rollups: [{ ...rollup, metrics: [{ metric: "regions_n", column: "n" }] }],
    } as SemanticModel;
    const c = compile(
      { metrics: ["regions_n"], dimensions: ["day"], grains: { day: "month" } },
      cd,
    );
    expect(c.rollup).toBeUndefined();
  });
});

describe("the grain-nesting matrix (unit)", () => {
  it("permits only provable coarsenings", () => {
    expect(grainServes("month", "month")).toBe(true);
    expect(grainServes("month", "quarter")).toBe(true);
    expect(grainServes("month", "year")).toBe(true);
    expect(grainServes("month", "fiscal_year")).toBe(true);
    expect(grainServes("month", "fiscal_quarter")).toBe(true);
    expect(grainServes("day", "week")).toBe(true);
    expect(grainServes("day", "fiscal_period")).toBe(true);
    expect(grainServes("quarter", "year")).toBe(true);

    expect(grainServes("month", "day")).toBe(false);
    expect(grainServes("month", "week")).toBe(false);
    expect(grainServes("month", "fiscal_period")).toBe(false);
    expect(grainServes("week", "month")).toBe(false);
    expect(grainServes("week", "year")).toBe(false);
    expect(grainServes("year", "quarter")).toBe(false);
    expect(grainServes("fiscal_period", "fiscal_year")).toBe(false);
  });
});

describe("routeToRollup is pure and total", () => {
  it("returns null for models without rollups and never throws on unknowns", () => {
    expect(routeToRollup(factModel, { model: "m", metrics: ["revenue"] })).toBeNull();
    // Unknown names are the compiler's authoritative errors, not routing's.
    expect(routeToRollup(model, { model: "m", metrics: ["nope"] })).toBeNull();
    expect(
      routeToRollup(model, { model: "m", metrics: ["revenue"], dimensions: ["nope"] }),
    ).toBeNull();
  });
});

describe("Validate MEASURES the rollup against the fact", () => {
  const execOn = (tables: DuckTable[]) => async (sql: string) =>
    (await runLocalSqlDuckDB(sql, tables)).rows;

  it("a faithful rollup measures clean", async () => {
    const r = await measureRollupHealth(execOn([sales, rollupTable]), model, "duckdb");
    // revenue and orders are checked; the avg mapping is skipped, not
    // half-checked.
    expect(r.checked).toBe(2);
    expect(r.issues).toEqual([]);
  });

  it("a STALE rollup is an issue naming both numbers", async () => {
    const stale: DuckTable = {
      ...rollupTable,
      rows: rollupTable.rows.map((r, i) => (i === 0 ? { ...r, amount_sum: 25 } : r)),
    };
    const r = await measureRollupHealth(execOn([sales, stale]), model, "duckdb");
    expect(r.issues.map((i) => i.error).join(" ")).toMatch(/totals 115 .*but 110 .*stale/s);
  });

  it("a missing rollup table is an issue, not a crash", async () => {
    const r = await measureRollupHealth(execOn([sales]), model, "duckdb");
    expect(r.issues.some((i) => /could not be measured/i.test(i.error))).toBe(true);
  });
});
