// R512 UI test: a time dimension filtered to a year, quarter or month.
//
// The analyst's governed step asked for daily sales with
// order_date = '2023'. The filter compared the DAY label with '2023', so it
// matched nothing: 0 rows, no error, "the total cannot be determined". The
// same filter on the ungrained column made DuckDB refuse to read '2023' as a
// date. Both now compile to the range of days the value names, over the raw
// column, and run on the real engine here.
import { describe, expect, it } from "vitest";

import {
  compileSemanticQuery,
  partialDateRange,
  type SemanticModel,
  type SemanticQuery,
} from "@/lib/semanticLayer";
import { runLocalSqlDuckDB } from "@/utils/data/duckdb.server";

describe("partialDateRange", () => {
  it("reads years, quarters and months as half-open ranges", () => {
    expect(partialDateRange("2023")).toEqual({ start: "2023-01-01", end: "2024-01-01" });
    expect(partialDateRange(2023)).toEqual({ start: "2023-01-01", end: "2024-01-01" });
    expect(partialDateRange("2023-Q2")).toEqual({ start: "2023-04-01", end: "2023-07-01" });
    expect(partialDateRange("2023q4")).toEqual({ start: "2023-10-01", end: "2024-01-01" });
    expect(partialDateRange("2023-07")).toEqual({ start: "2023-07-01", end: "2023-08-01" });
    expect(partialDateRange("2023-12")).toEqual({ start: "2023-12-01", end: "2024-01-01" });
  });

  it("is null for a whole date and for anything that is not a period", () => {
    for (const v of ["2023-07-15", "2023-13", "20231", "23", "West", 2023.5, "", null]) {
      expect(partialDateRange(v)).toBeNull();
    }
  });
});

// Dates as the saas sample stores them: month/day/year text, parsed by the
// model's dimension SQL, the shape the analyst's step compiled.
const model: SemanticModel = {
  name: "saas",
  source: { kind: "data_table", table: "saas_sales" },
  dimensions: [
    {
      name: "order_date",
      sql: "TRY_CAST(strptime(\"Order Date\", '%m/%d/%Y') AS DATE)",
      type: "time",
    },
    { name: "region", sql: '"Region"', type: "categorical" },
  ],
  metrics: [{ name: "total_sales", agg: "sum", sql: '"Sales"' }],
};

const tables = [
  {
    name: "saas_sales",
    columns: [
      { name: "Order Date", type: "string" as const },
      { name: "Region", type: "string" as const },
      { name: "Sales", type: "number" as const },
    ],
    rows: [
      { "Order Date": "12/31/2022", Region: "EMEA", Sales: 1 },
      { "Order Date": "1/2/2023", Region: "EMEA", Sales: 10 },
      { "Order Date": "4/15/2023", Region: "AMER", Sales: 20 },
      { "Order Date": "7/4/2023", Region: "APJ", Sales: 40 },
      { "Order Date": "12/31/2023", Region: "EMEA", Sales: 80 },
      { "Order Date": "1/1/2024", Region: "AMER", Sales: 100 },
    ],
  },
];

const run = async (q: Omit<SemanticQuery, "model">) => {
  const { sql } = compileSemanticQuery(model, { model: "saas", ...q }, { dialect: "duckdb" });
  return (await runLocalSqlDuckDB(sql, tables)).rows;
};

const total = (rows: Record<string, unknown>[]) =>
  rows.reduce((s, r) => s + Number(r.total_sales), 0);

describe("a time dimension filtered to a period", () => {
  it("returns the year's days when grouped by day (was 0 rows)", async () => {
    const rows = await run({
      metrics: ["total_sales"],
      dimensions: ["order_date"],
      grains: { order_date: "day" },
      filters: [{ field: "order_date", op: "=", value: "2023" }],
      orderBy: [{ field: "order_date", dir: "asc" }],
    });
    expect(rows.map((r) => r.order_date)).toEqual([
      "2023-01-02",
      "2023-04-15",
      "2023-07-04",
      "2023-12-31",
    ]);
    expect(total(rows)).toBe(150);
  });

  it("runs on the ungrained column (DuckDB refused '2023' as a date)", async () => {
    expect(
      await run({
        metrics: ["total_sales"],
        filters: [{ field: "order_date", op: "=", value: 2023 }],
      }),
    ).toEqual([{ total_sales: 150 }]);
  });

  it("reads quarters, months, comparisons and lists", async () => {
    const sum = async (
      op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_in",
      value: unknown,
    ) =>
      total(
        await run({
          metrics: ["total_sales"],
          filters: [{ field: "order_date", op, value: value as string }],
        }),
      );
    expect(await sum("=", "2023-Q2")).toBe(20);
    expect(await sum("=", "2023-07")).toBe(40);
    expect(await sum("!=", "2023")).toBe(101);
    expect(await sum(">=", "2023")).toBe(250);
    expect(await sum(">", "2023")).toBe(100);
    expect(await sum("<", "2023")).toBe(1);
    expect(await sum("<=", "2023")).toBe(151);
    expect(await sum("in", ["2022", "2023-Q1"])).toBe(11);
    expect(await sum("not_in", ["2022", "2023-Q1"])).toBe(240);
  });

  it("compares a whole date as before", async () => {
    const rows = await run({
      metrics: ["total_sales"],
      dimensions: ["order_date"],
      grains: { order_date: "day" },
      filters: [{ field: "order_date", op: "=", value: "2023-04-15" }],
    });
    expect(rows).toEqual([{ order_date: "2023-04-15", total_sales: 20 }]);
  });

  it("leaves a fiscal grain's number alone, and a categorical 4-digit value", () => {
    // Under fiscal_year, 2026 is the fiscal year the query groups by.
    const fiscal = compileSemanticQuery(
      model,
      {
        model: "saas",
        metrics: ["total_sales"],
        dimensions: ["order_date"],
        grains: { order_date: "fiscal_year" },
        filters: [{ field: "order_date", op: "=", value: 2026 }],
      },
      { dialect: "duckdb" },
    ).sql;
    expect(fiscal).not.toContain("'2026-01-01'");
    const region = compileSemanticQuery(
      model,
      {
        model: "saas",
        metrics: ["total_sales"],
        filters: [{ field: "region", op: "=", value: "2023" }],
      },
      { dialect: "duckdb" },
    ).sql;
    expect(region).toContain(`"Region" = '2023'`);
  });
});
