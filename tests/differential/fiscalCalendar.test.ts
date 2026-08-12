// Fiscal calendars and query parameters, EXECUTED — not just compiled.
//
// The fiscal bucket trick (shift the date forward, read the calendar
// year/quarter of the shifted date) is exactly the kind of arithmetic that
// looks right in SQL text and is off by one fiscal year at the boundary. So
// every bucket here is computed by hand from the row's date and the July
// start, and DuckDB must reproduce the whole table. Same for parameters: a
// substitution bug that still produces runnable SQL only shows up in the
// NUMBERS, so the default and the override must disagree by a hand-computed
// amount.
//
// `now` is pinned everywhere, as in relativeDates.test.ts, so windows are
// facts rather than functions of the day the suite runs.
import { describe, expect, it } from "vitest";

import { compileSemanticQuery, relativeDateRange, type SemanticModel } from "@/lib/semanticLayer";
import type { LoadedTable } from "@/utils/tools/sql.server";
import { runLocalSqlDuckDB } from "@/utils/data/duckdb.server";
import { freshTables } from "./fixtures";

/** Rows chosen to straddle every FY2026 boundary for a July-start year. */
const fyEvents: LoadedTable = {
  name: "fy_events",
  columns: [
    { name: "id", type: "number" },
    { name: "day", type: "date" },
    { name: "amount", type: "number" },
  ],
  rows: [
    { id: 1, day: "2025-06-30", amount: 10 }, // last day of FY2025 (Q4)
    { id: 2, day: "2025-07-01", amount: 20 }, // first day of FY2026 Q1
    { id: 3, day: "2025-09-30", amount: 30 }, // last day of FY2026 Q1
    { id: 4, day: "2025-10-01", amount: 40 }, // FY2026 Q2
    { id: 5, day: "2026-01-01", amount: 50 }, // calendar new year, still FY2026 (Q3)
    { id: 6, day: "2026-04-01", amount: 60 }, // FY2026 Q4
    { id: 7, day: "2026-06-30", amount: 70 }, // last day of FY2026 (Q4)
    { id: 8, day: "2026-07-01", amount: 80 }, // first day of FY2027 Q1
  ],
};

const julyModel: SemanticModel = {
  name: "fy",
  source: { kind: "data_table", table: "fy_events" },
  fiscalYearStartMonth: 7,
  dimensions: [{ name: "day", sql: "day", type: "time" }],
  metrics: [{ name: "total", agg: "sum", sql: "amount" }],
} as SemanticModel;

const run = async (sql: string, tables: LoadedTable[] = [fyEvents]) =>
  (await runLocalSqlDuckDB(sql, tables)).rows as Record<string, unknown>[];

describe("fiscal windows (July start) — worked out by hand, not from the code", () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const fy = { fiscalStartMonth: 7 };

  it("mid-July: the fiscal year just began", () => {
    expect(relativeDateRange("this_fiscal_year", { now: at("2025-07-15"), ...fy })).toEqual({
      start: "2025-07-01",
      end: "2026-07-01",
    });
    expect(relativeDateRange("last_fiscal_year", { now: at("2025-07-15"), ...fy })).toEqual({
      start: "2024-07-01",
      end: "2025-07-01",
    });
    // Two weeks into the year, YTD is two weeks — not twelve months.
    expect(relativeDateRange("fiscal_ytd", { now: at("2025-07-15"), ...fy })).toEqual({
      start: "2025-07-01",
      end: "2025-07-16",
    });
    expect(relativeDateRange("this_fiscal_quarter", { now: at("2025-07-15"), ...fy })).toEqual({
      start: "2025-07-01",
      end: "2025-10-01",
    });
    // The previous fiscal quarter belongs to the PREVIOUS fiscal year.
    expect(relativeDateRange("last_fiscal_quarter", { now: at("2025-07-15"), ...fy })).toEqual({
      start: "2025-04-01",
      end: "2025-07-01",
    });
  });

  it("the calendar new year does not reset a July fiscal year", () => {
    // January 2026 sits in the MIDDLE of FY2026 — the classic off-by-one.
    expect(relativeDateRange("this_fiscal_year", { now: at("2026-01-05"), ...fy })).toEqual({
      start: "2025-07-01",
      end: "2026-07-01",
    });
    expect(relativeDateRange("this_fiscal_quarter", { now: at("2026-01-05"), ...fy })).toEqual({
      start: "2026-01-01",
      end: "2026-04-01",
    });
    expect(relativeDateRange("last_fiscal_quarter", { now: at("2026-01-05"), ...fy })).toEqual({
      start: "2025-10-01",
      end: "2026-01-01",
    });
  });

  it("the last day of the fiscal year is still inside it, and fiscal_ytd covers it all", () => {
    expect(relativeDateRange("this_fiscal_year", { now: at("2026-06-30"), ...fy })).toEqual({
      start: "2025-07-01",
      end: "2026-07-01",
    });
    // Tomorrow is the year boundary, so to-date == the whole year.
    expect(relativeDateRange("fiscal_ytd", { now: at("2026-06-30"), ...fy })).toEqual({
      start: "2025-07-01",
      end: "2026-07-01",
    });
  });

  it("the first day of a new fiscal year starts a fresh window", () => {
    expect(relativeDateRange("this_fiscal_year", { now: at("2026-07-01"), ...fy })).toEqual({
      start: "2026-07-01",
      end: "2027-07-01",
    });
    expect(relativeDateRange("fiscal_ytd", { now: at("2026-07-01"), ...fy })).toEqual({
      start: "2026-07-01",
      end: "2026-07-02",
    });
  });

  it("refuses a start month outside 1–12 instead of computing nonsense", () => {
    for (const bad of [0, 13, 6.5]) {
      expect(() =>
        relativeDateRange("this_fiscal_year", { now: at("2026-01-05"), fiscalStartMonth: bad }),
      ).toThrow(/1–12/);
    }
  });
});

describe("fiscal buckets on DuckDB (July start)", () => {
  it("assigns every row the hand-computed fiscal year", async () => {
    const compiled = compileSemanticQuery(
      julyModel,
      {
        model: "fy",
        metrics: ["total"],
        dimensions: ["day"],
        grains: { day: "fiscal_year" },
        orderBy: [{ field: "day", dir: "asc" }],
      },
      { dialect: "duckdb" },
    );
    const rows = await run(compiled.sql);
    // FY named by the calendar year it ENDS in: 2025-06-30 is FY2025; the
    // whole Jul-2025..Jun-2026 span is FY2026; 2026-07-01 opens FY2027.
    expect(rows.map((r) => [Number(r.day), Number(r.total)])).toEqual([
      [2025, 10],
      [2026, 270],
      [2027, 80],
    ]);
  });

  it("assigns every row the hand-computed fiscal quarter (sortable numbers)", async () => {
    const compiled = compileSemanticQuery(
      julyModel,
      {
        model: "fy",
        metrics: ["total"],
        dimensions: ["day"],
        grains: { day: "fiscal_quarter" },
        orderBy: [{ field: "day", dir: "asc" }],
      },
      { dialect: "duckdb" },
    );
    const rows = await run(compiled.sql);
    expect(rows.map((r) => [Number(r.day), Number(r.total)])).toEqual([
      [20254, 10], // FY2025 Q4
      [20261, 50], // FY2026 Q1 = 20 + 30
      [20262, 40],
      [20263, 50],
      [20264, 130], // = 60 + 70
      [20271, 80], // FY2027 Q1
    ]);
  });

  it("a January fiscal year IS the calendar year — buckets must coincide", async () => {
    // Differential invariant on the shared fixture: fiscal_year with no
    // fiscal start configured must equal the plain year grain, row for row.
    const base = {
      name: "m",
      source: { kind: "data_table", table: "orders" },
      dimensions: [{ name: "day", sql: "day", type: "time" }],
      metrics: [{ name: "orders_count", agg: "count", sql: "id" }],
    } as SemanticModel;
    const q = (grain: "year" | "fiscal_year") =>
      compileSemanticQuery(
        base,
        {
          model: "m",
          metrics: ["orders_count"],
          dimensions: ["day"],
          grains: { day: grain },
          orderBy: [{ field: "day", dir: "asc" }],
        },
        { dialect: "duckdb" },
      );
    const [year, fiscal] = await Promise.all([
      run(q("year").sql, freshTables()),
      run(q("fiscal_year").sql, freshTables()),
    ]);
    // The representations differ by design — `year` buckets as an ISO
    // first-of-year label, `fiscal_year` as a plain number — but the year
    // NAMED and the count under it must coincide exactly.
    expect(fiscal.map((r) => [Number(r.day), Number(r.orders_count)])).toEqual(
      year.map((r) => [Number(String(r.day).slice(0, 4)), Number(r.orders_count)]),
    );
  });

  it("period-over-period along fiscal quarters lines each bucket up with its predecessor", async () => {
    const compiled = compileSemanticQuery(
      julyModel,
      {
        model: "fy",
        metrics: ["total"],
        dimensions: ["day"],
        grains: { day: "fiscal_quarter" },
        compare: "prior_period",
        orderBy: [{ field: "day", dir: "asc" }],
      },
      { dialect: "duckdb" },
    );
    const rows = await run(compiled.sql);
    const prev = (r: Record<string, unknown>) =>
      r.total_prev === null || r.total_prev === undefined ? null : Number(r.total_prev);
    // Each quarter's _prev must be the previous quarter's total — including
    // across the fiscal YEAR boundary (20261's predecessor is 20254).
    expect(rows.map((r) => [Number(r.day), Number(r.total), prev(r)])).toEqual([
      [20254, 10, null],
      [20261, 50, 10],
      [20262, 40, 50],
      [20263, 50, 40],
      [20264, 130, 50],
      [20271, 80, 130],
    ]);
  });

  it("refuses fiscal grains on the AlaSQL engine instead of degrading", () => {
    expect(() =>
      compileSemanticQuery(
        julyModel,
        { model: "fy", metrics: ["total"], dimensions: ["day"], grains: { day: "fiscal_year" } },
        { dialect: "alasql" },
      ),
    ).toThrow(/AlaSQL/);
  });

  it("fiscal WINDOW filters still work on AlaSQL — they compile to a literal range", () => {
    // Windows need no date arithmetic in SQL (the boundaries are computed
    // here), so the alasql refusal must be scoped to GRAINS only.
    const compiled = compileSemanticQuery(
      julyModel,
      {
        model: "fy",
        metrics: ["total"],
        filters: [{ field: "day", op: "fiscal_ytd", value: undefined }],
      },
      { dialect: "alasql", now: new Date("2026-01-05T12:00:00Z") },
    );
    expect(compiled.sql).toContain("'2025-07-01'");
    expect(compiled.sql).toContain("'2026-01-06'");
  });

  it("a fiscal window filter selects exactly the hand-picked rows", async () => {
    // this_fiscal_quarter at 2026-01-05 (July start) = 2026-01-01..2026-04-01
    // → only id 5. Its neighbours on both sides must stay out.
    const compiled = compileSemanticQuery(
      julyModel,
      {
        model: "fy",
        dimensions: ["day"],
        filters: [{ field: "day", op: "this_fiscal_quarter", value: undefined }],
        orderBy: [{ field: "day", dir: "asc" }],
      },
      { dialect: "duckdb", now: new Date("2026-01-05T12:00:00Z") },
    );
    const rows = await run(compiled.sql);
    expect(rows.map((r) => String(r.day))).toEqual(["2026-01-01"]);
  });
});

describe("query parameters change the numbers, not just the SQL", () => {
  const paramModel: SemanticModel = {
    name: "p",
    source: { kind: "data_table", table: "orders" },
    parameters: [
      { name: "min_amount", type: "number", default: 0 },
      { name: "target_region", type: "string", default: "EMEA" },
    ],
    dimensions: [{ name: "region", sql: "region", type: "categorical" }],
    metrics: [
      {
        name: "big_sales",
        agg: "sum",
        sql: "CASE WHEN amount >= {{min_amount}} THEN amount ELSE 0 END",
      },
      {
        name: "region_sales",
        agg: "sum",
        sql: "CASE WHEN region = {{target_region}} THEN amount ELSE 0 END",
      },
    ],
  } as SemanticModel;

  it("computes with the default when the caller sends nothing", async () => {
    const compiled = compileSemanticQuery(
      paramModel,
      { model: "p", metrics: ["big_sales"] },
      { dialect: "duckdb" },
    );
    const rows = await run(compiled.sql, freshTables());
    // amounts ≥ 0: 100 + 250.5 + 0 + 75 + 310 + 310 + 12.25 (NULL and −40 out)
    expect(Number(rows[0].big_sales)).toBeCloseTo(1057.75, 6);
  });

  it("an override produces a DIFFERENT hand-computed number", async () => {
    const compiled = compileSemanticQuery(
      paramModel,
      { model: "p", metrics: ["big_sales"], params: { min_amount: 100 } },
      { dialect: "duckdb" },
    );
    const rows = await run(compiled.sql, freshTables());
    // amounts ≥ 100: 100 + 250.5 + 310 + 310
    expect(Number(rows[0].big_sales)).toBeCloseTo(970.5, 6);
  });

  it("string parameters are escaped literals — a quote executes, it does not inject", async () => {
    const compiled = compileSemanticQuery(
      paramModel,
      { model: "p", metrics: ["region_sales"], params: { target_region: "O'Brien" } },
      { dialect: "duckdb" },
    );
    // The doubled quote is the escaping; the query still runs and matches nothing.
    expect(compiled.sql).toContain("'O''Brien'");
    const rows = await run(compiled.sql, freshTables());
    expect(Number(rows[0].region_sales)).toBe(0);
  });

  it("the string default computes the EMEA total", async () => {
    const compiled = compileSemanticQuery(
      paramModel,
      { model: "p", metrics: ["region_sales"] },
      { dialect: "duckdb" },
    );
    const rows = await run(compiled.sql, freshTables());
    expect(Number(rows[0].region_sales)).toBeCloseTo(350.5, 6); // 100 + 250.5
  });
});
