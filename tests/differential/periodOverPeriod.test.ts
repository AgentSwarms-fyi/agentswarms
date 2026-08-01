// Period-over-period (YoY / MoM / prior period), executed on the real engine.
//
// The comparison is a date-shifted SELF-JOIN, not LAG. That is a correctness
// decision, not a style one: LAG compares by POSITION, so a series with a gap
// — a month in which nothing happened, which is normal data — makes LAG line
// each period up against the wrong predecessor and report a change that never
// occurred. A join on the shifted date has no such failure mode; a missing
// predecessor simply produces NULL. The gap case is asserted below, because it
// is the one that separates the two designs.
import { describe, expect, it } from "vitest";

import {
  COMPARE_PERIODS,
  compileSemanticQuery,
  type ComparePeriod,
  type SemanticModel,
  type SqlDialect,
} from "@/lib/semanticLayer";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

const model: SemanticModel = {
  name: "m",
  source: { kind: "data_table", table: "sales" },
  dimensions: [
    { name: "region", sql: "region", type: "string" },
    { name: "day", sql: "day", type: "time" },
  ],
  metrics: [{ name: "revenue", agg: "sum", sql: "amount" }],
} as SemanticModel;

/**
 * Two years of monthly data with a DELIBERATE HOLE at 2026-02.
 *
 * A NULL region is included too: the join between a period and its predecessor
 * must be null-safe, or that group loses its comparison while every other group
 * keeps one — a result that looks complete and is not.
 */
const rows = [
  { region: "EMEA", day: "2025-01-10", amount: 100 },
  { region: "EMEA", day: "2025-02-10", amount: 200 },
  { region: "EMEA", day: "2025-03-10", amount: 300 },
  { region: "EMEA", day: "2026-01-10", amount: 150 },
  // no EMEA 2026-02 — the gap
  { region: "EMEA", day: "2026-03-10", amount: 600 },
  { region: null, day: "2025-01-11", amount: 10 },
  { region: null, day: "2026-01-11", amount: 25 },
];

function table(): DuckTable {
  return {
    name: "sales",
    columns: [
      { name: "region", type: "string" },
      { name: "day", type: "date" },
      { name: "amount", type: "number" },
    ],
    rows: rows.map((r) => ({ ...r })),
  };
}

const run = async (sql: string) => (await runLocalSqlDuckDB(sql, [table()])).rows;

const monthly = (compare: ComparePeriod, extra: Record<string, unknown> = {}) =>
  compileSemanticQuery(
    model,
    {
      model: "m",
      metrics: ["revenue"],
      dimensions: ["day"],
      grains: { day: "month" },
      orderBy: [{ field: "day", dir: "asc" }],
      compare,
      ...extra,
    },
    { dialect: "duckdb" },
  );

describe("year over year on real DuckDB", () => {
  it("lines each month up with the same month a year earlier", async () => {
    const out = (await run(monthly("yoy").sql)) as Record<string, unknown>[];
    const byMonth = new Map(out.map((r) => [String(r.day), r]));

    // 2026-01 total is 150 + 25 = 175; a year earlier 100 + 10 = 110.
    expect(Number(byMonth.get("2026-01-01")!.revenue)).toBe(175);
    expect(Number(byMonth.get("2026-01-01")!.revenue_prev)).toBe(110);
    expect(Number(byMonth.get("2026-01-01")!.revenue_change)).toBe(65);
    expect(Number(byMonth.get("2026-01-01")!.revenue_pct_change)).toBeCloseTo(65 / 110, 10);

    // 2026-03 is 600 against 300 — a clean doubling.
    expect(Number(byMonth.get("2026-03-01")!.revenue_prev)).toBe(300);
    expect(Number(byMonth.get("2026-03-01")!.revenue_pct_change)).toBeCloseTo(1, 10);
  });

  it("THE GAP CASE: a month whose predecessor exists is unaffected by a hole elsewhere", async () => {
    // 2026-03 must compare against 2025-03 (=300). Under a LAG-based design the
    // missing 2026-02 shifts the window and 2026-03 would be compared against
    // 2025-02 (=200) instead — a plausible-looking 200% that never happened.
    const out = (await run(monthly("yoy").sql)) as Record<string, unknown>[];
    const march = out.find((r) => String(r.day) === "2026-03-01")!;
    expect(Number(march.revenue_prev)).toBe(300);
    expect(Number(march.revenue_prev)).not.toBe(200);
  });

  it("gives the earliest period a NULL comparison rather than dropping it", async () => {
    const out = (await run(monthly("yoy").sql)) as Record<string, unknown>[];
    const first = out.find((r) => String(r.day) === "2025-01-01")!;
    // Present (a LEFT JOIN, not an INNER one) but with nothing to compare to.
    expect(first).toBeDefined();
    expect(first.revenue_prev).toBeNull();
    expect(first.revenue_pct_change).toBeNull();
  });

  it("compares a NULL dimension group instead of silently losing it", async () => {
    const compiled = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["revenue"],
        dimensions: ["day", "region"],
        grains: { day: "month" },
        compare: "yoy",
      },
      { dialect: "duckdb" },
    );
    const out = (await run(compiled.sql)) as Record<string, unknown>[];
    // The region-less rows: 25 in 2026-01 against 10 in 2025-01. A plain `=`
    // join would leave revenue_prev NULL here.
    const nullRegion = out.find((r) => r.region === null && String(r.day) === "2026-01-01")!;
    expect(nullRegion).toBeDefined();
    expect(Number(nullRegion.revenue_prev)).toBe(10);
  });
});

describe("the other comparison periods", () => {
  it("prior_period at a month grain steps back one month", async () => {
    const out = (await run(monthly("prior_period").sql)) as Record<string, unknown>[];
    const feb2025 = out.find((r) => String(r.day) === "2025-02-01")!;
    expect(Number(feb2025.revenue)).toBe(200);
    expect(Number(feb2025.revenue_prev)).toBe(110); // Jan 2025: 100 + 10
  });

  it("prior_period across the gap has no predecessor to invent", async () => {
    const out = (await run(monthly("prior_period").sql)) as Record<string, unknown>[];
    // 2026-03's previous MONTH is 2026-02, which has no rows at all.
    const march = out.find((r) => String(r.day) === "2026-03-01")!;
    expect(march.revenue_prev).toBeNull();
    expect(march.revenue_pct_change).toBeNull();
  });

  it("mom steps back one month whatever the grain", async () => {
    const compiled = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["revenue"],
        dimensions: ["day"],
        grains: { day: "day" },
        compare: "mom",
      },
      { dialect: "duckdb" },
    );
    // 2025-02-10 against 2025-01-10: 200 vs 100.
    const out = (await run(compiled.sql)) as Record<string, unknown>[];
    const d = out.find((r) => String(r.day) === "2025-02-10")!;
    expect(Number(d.revenue_prev)).toBe(100);
  });

  it.each(COMPARE_PERIODS)("%s produces runnable SQL", async (compare) => {
    await expect(run(monthly(compare).sql)).resolves.toBeDefined();
  });
});

describe("a filter moves with the comparison window", () => {
  it("does not compare against rows its own filter excluded", async () => {
    // Filtered to 2026 only. The prior-period side must still see 2025, or
    // every comparison would be NULL — the bug this shifted-filter design
    // exists to prevent.
    const compiled = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["revenue"],
        dimensions: ["day"],
        grains: { day: "month" },
        filters: [{ field: "day", op: ">=", value: "2026-01-01" }],
        compare: "yoy",
      },
      { dialect: "duckdb" },
    );
    const out = (await run(compiled.sql)) as Record<string, unknown>[];
    expect(out.every((r) => String(r.day) >= "2026-01-01")).toBe(true);
    const jan = out.find((r) => String(r.day) === "2026-01-01")!;
    expect(Number(jan.revenue_prev)).toBe(110);
  });
});

describe("zero and missing denominators", () => {
  it("reports NULL, not infinity, when the earlier period was zero", async () => {
    const zeroTable: DuckTable = {
      name: "sales",
      columns: [
        { name: "region", type: "string" },
        { name: "day", type: "date" },
        { name: "amount", type: "number" },
      ],
      rows: [
        { region: "EMEA", day: "2025-01-10", amount: 0 },
        { region: "EMEA", day: "2026-01-10", amount: 500 },
      ],
    };
    const out = (await runLocalSqlDuckDB(monthly("yoy").sql, [zeroTable])).rows;
    const row = out.find((r) => String(r.day) === "2026-01-01")!;
    expect(Number(row.revenue_prev)).toBe(0);
    expect(Number(row.revenue_change)).toBe(500);
    // 500/0 is not a number a dashboard should print.
    expect(row.revenue_pct_change).toBeNull();
  });
});

describe("what a comparison refuses to compile", () => {
  const compile = (q: Record<string, unknown>, dialect: SqlDialect = "duckdb") =>
    compileSemanticQuery(
      model,
      { model: "m", metrics: ["revenue"], ...q } as Parameters<typeof compileSemanticQuery>[1],
      { dialect },
    );

  it("refuses on AlaSQL rather than emitting SQL it cannot run", () => {
    expect(() =>
      compile({ dimensions: ["day"], grains: { day: "month" }, compare: "yoy" }, "alasql"),
    ).toThrow(/AlaSQL/i);
  });

  it("refuses without a grained time dimension", () => {
    expect(() => compile({ dimensions: ["region"], compare: "yoy" })).toThrow(/time dimension/i);
  });

  it("refuses when the time dimension has no grain — there is no period to step", () => {
    expect(() => compile({ dimensions: ["day"], compare: "yoy" })).toThrow(/grain/i);
  });

  it("refuses two grained time dimensions rather than picking an axis", () => {
    const twoTime = {
      ...model,
      dimensions: [...model.dimensions, { name: "shipped", sql: "day", type: "time" as const }],
    };
    expect(() =>
      compileSemanticQuery(
        twoTime,
        {
          model: "m",
          metrics: ["revenue"],
          dimensions: ["day", "shipped"],
          grains: { day: "month", shipped: "month" },
          compare: "yoy",
        },
        { dialect: "duckdb" },
      ),
    ).toThrow(/exactly one/i);
  });

  it("refuses with no metric to compare", () => {
    expect(() =>
      compileSemanticQuery(
        model,
        { model: "m", metrics: [], dimensions: ["day"], grains: { day: "month" }, compare: "yoy" },
        { dialect: "duckdb" },
      ),
    ).toThrow(/at least one metric/i);
  });

  it("refuses an unknown comparison", () => {
    expect(() =>
      compile({ dimensions: ["day"], grains: { day: "month" }, compare: "next_week" }),
    ).toThrow(/Unknown comparison/i);
  });
});

describe("the emitted SQL per dialect", () => {
  const sqlFor = (dialect: SqlDialect) =>
    compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["revenue"],
        dimensions: ["day"],
        grains: { day: "month" },
        compare: "yoy",
      },
      { dialect },
    ).sql;

  it.each([
    ["duckdb", /INTERVAL 1 YEAR/],
    ["postgres", /INTERVAL '1 year'/],
    ["snowflake", /DATEADD\(year, 1,/],
    ["bigquery", /DATE_ADD\(DATE\(/],
    ["mysql", /DATE_ADD\(/],
    ["azure_synapse", /DATEADD\(year, 1,/],
    ["redshift", /INTERVAL '1 year'/],
    ["databricks", /INTERVAL 1 YEAR/],
  ] as const)("%s shifts the axis with its own date arithmetic", (dialect, re) => {
    expect(sqlFor(dialect)).toMatch(re);
  });

  it("uses MySQL's <=> for the null-safe join and ANSI elsewhere", () => {
    expect(sqlFor("mysql")).toContain("<=>");
    expect(sqlFor("postgres")).toContain("IS NOT DISTINCT FROM");
    expect(sqlFor("duckdb")).toContain("IS NOT DISTINCT FROM");
  });

  it("normalises a quarter grain to three months rather than trusting INTERVAL QUARTER", () => {
    const sql = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["revenue"],
        dimensions: ["day"],
        grains: { day: "quarter" },
        compare: "prior_period",
      },
      { dialect: "duckdb" },
    ).sql;
    expect(sql).toContain("INTERVAL 3 MONTH");
    expect(sql).not.toMatch(/INTERVAL \d+ QUARTER/);
  });

  it("normalises a week grain to seven days", () => {
    const sql = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["revenue"],
        dimensions: ["day"],
        grains: { day: "week" },
        compare: "prior_period",
      },
      { dialect: "duckdb" },
    ).sql;
    expect(sql).toContain("INTERVAL 7 DAY");
  });

  it("names the comparison columns predictably", () => {
    const compiled = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["revenue"],
        dimensions: ["day"],
        grains: { day: "month" },
        compare: "yoy",
      },
      { dialect: "duckdb" },
    );
    expect(compiled.columns).toEqual([
      "day",
      "revenue",
      "revenue_prev",
      "revenue_change",
      "revenue_pct_change",
    ]);
  });
});
