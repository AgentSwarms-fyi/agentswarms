// The query Fields mode writes, run on the engine local datasets run on (R499).
//
// The unit tests pin the SQL's text; this runs it. The sample table stores its
// dates as unpadded text (11/9/2024), so a month bucket that parses them wrong
// would group every row under NULL and still "work". These check the buckets,
// the labels, the filters with quotes in them, and the top N against DuckDB.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFieldSql, type FieldInfo, type FieldQuery, ROWS_FIELD } from "@/lib/biFieldQuery";

const FIELDS: FieldInfo[] = [
  { name: "Order Date", kind: "date", dateFormat: "mdy" },
  { name: "Region", kind: "text" },
  { name: "Customer", kind: "text" },
  { name: "Sales", kind: "number" },
  { name: "Profit", kind: "number" },
  {
    name: "Margin %",
    kind: "number",
    calc: { expr: '100 * SUM("Profit") / SUM("Sales")', aggregated: true },
  },
];

let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(`CREATE TABLE "saas_sales" ("Order Date" VARCHAR, "Region" VARCHAR,
    "Customer" VARCHAR, "Sales" DOUBLE, "Profit" DOUBLE)`);
  await conn.run(`INSERT INTO "saas_sales" VALUES
    ('11/9/2024',  'EMEA', 'Acme',          100, 10),
    ('11/30/2024', 'EMEA', 'O''Brien & Co', 50,  20),
    ('12/1/2024',  'AMER', 'Acme',          200, 30),
    ('1/2/2025',   'APJ',  'Zenith',        400, -40),
    ('3/31/2025',  'AMER', 'Zenith',        25,  5)`);
}, 120_000);

afterAll(() => conn?.closeSync());

async function run(p: Partial<FieldQuery>) {
  const q: FieldQuery = { table: "saas_sales", dims: [], measures: [], filters: [], ...p };
  const { sql } = buildFieldSql(q, FIELDS, "duckdb");
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJson();
}

describe("Fields mode on DuckDB", () => {
  it("buckets unpadded m/d/yyyy text dates by month, oldest first", async () => {
    expect(
      await run({
        dims: [{ field: "Order Date", grain: "month" }],
        measures: [
          { field: "Sales", agg: "sum" },
          { field: ROWS_FIELD, agg: "count" },
        ],
      }),
    ).toEqual([
      { order_date_month: "2024-11", sales: 150, rows: "2" },
      { order_date_month: "2024-12", sales: 200, rows: "1" },
      { order_date_month: "2025-01", sales: 400, rows: "1" },
      { order_date_month: "2025-03", sales: 25, rows: "1" },
    ]);
  });

  it("keeps the latest N periods of a time series, oldest first", async () => {
    const rows = await run({
      dims: [{ field: "Order Date", grain: "month" }],
      measures: [{ field: "Sales", agg: "sum" }],
      limit: 2,
    });
    expect(rows).toEqual([
      { order_date_month: "2025-01", sales: 400 },
      { order_date_month: "2025-03", sales: 25 },
    ]);
    // Newest first, when asked for, is the same two the other way round.
    const desc = await run({
      dims: [{ field: "Order Date", grain: "month" }],
      measures: [{ field: "Sales", agg: "sum" }],
      sort: "label_desc",
      limit: 2,
    });
    expect(desc.map((r) => r.order_date_month)).toEqual(["2025-03", "2025-01"]);
  });

  it("labels quarters and weeks the way the KPI reads them", async () => {
    const quarters = await run({
      dims: [{ field: "Order Date", grain: "quarter" }],
      measures: [{ field: "Sales", agg: "sum" }],
    });
    expect(quarters.map((r) => r.order_date_quarter)).toEqual(["2024-Q4", "2025-Q1"]);
    const weeks = await run({
      dims: [{ field: "Order Date", grain: "week" }],
      measures: [{ field: "Sales", agg: "sum" }],
    });
    expect(weeks[0].order_date_week).toBe("2024-W45");
    expect(weeks.every((r) => /^\d{4}-W\d{2}$/.test(String(r.order_date_week)))).toBe(true);
  });

  it("filters on a value with a quote in it, and keeps the top N", async () => {
    expect(
      await run({
        dims: [{ field: "Customer" }],
        measures: [{ field: "Sales", agg: "sum" }],
        filters: [{ field: "Customer", op: "in", values: ["O'Brien & Co", "Zenith"] }],
        limit: 1,
      }),
    ).toEqual([{ customer: "Zenith", sales: 425 }]);
    expect(
      await run({
        dims: [{ field: "Region" }],
        measures: [{ field: "Profit", agg: "sum" }],
        filters: [{ field: "Sales", op: "between", values: ["40", "250"] }],
        sort: "label_asc",
      }),
    ).toEqual([
      { region: "AMER", profit: 30 },
      { region: "EMEA", profit: 30 },
    ]);
  });

  it("runs a calculated field and counts distinct values", async () => {
    const rows = await run({
      dims: [{ field: "Region" }],
      measures: [{ field: "Margin %" }, { field: "Customer", agg: "count_distinct" }],
      sort: "value_asc",
    });
    // AMER: 100 × (30 + 5) / (200 + 25) = 15.56 — profit over sales, not an
    // average of each row's margin.
    expect(
      rows.map((r) => [r.region, Number(Number(r.margin).toFixed(2)), r.distinct_customer]),
    ).toEqual([
      ["APJ", -10, "1"],
      ["AMER", 15.56, "2"],
      ["EMEA", 20, "2"],
    ]);
  });

  it("filters dates by their own value, not their text", async () => {
    // "11/30/2024" > "1/2/2025" as text; as dates it is the other way round.
    expect(
      await run({
        measures: [{ field: "Sales", agg: "sum" }],
        filters: [{ field: "Order Date", op: "gte", values: ["2025-01-01"] }],
      }),
    ).toEqual([{ sales: 425 }]);
    // …and a date typed the way the column writes it means the same day.
    expect(
      await run({
        measures: [{ field: "Sales", agg: "sum" }],
        filters: [{ field: "Order Date", op: "lt", values: ["12/1/2024"] }],
      }),
    ).toEqual([{ sales: 150 }]);
  });

  it("treats an empty string as empty", async () => {
    await conn.run(`INSERT INTO "saas_sales" VALUES ('2/2/2025', '', 'Blank', 1, 1)`);
    try {
      expect(
        await run({
          dims: [{ field: "Region" }],
          measures: [{ field: ROWS_FIELD, agg: "count" }],
          filters: [{ field: "Region", op: "not_empty", values: [] }],
          sort: "label_asc",
        }),
      ).toEqual([
        { region: "AMER", rows: "2" },
        { region: "APJ", rows: "1" },
        { region: "EMEA", rows: "2" },
      ]);
    } finally {
      await conn.run(`DELETE FROM "saas_sales" WHERE "Customer" = 'Blank'`);
    }
  });
});
