// Relative date filters ("this month", "last 30 days") on both local engines.
//
// These compile to a plain half-open range rather than to CURRENT_DATE
// arithmetic, so there is no date-function matrix per dialect — but that is a
// claim about SQL text, and SQL text that looks right is exactly what the
// backtick bug looked like. So every case here is COMPILED for a dialect and
// then EXECUTED on the engine that dialect targets, and the two engines must
// return the same rows.
//
// `now` is pinned. A window derived from the real clock would make this suite
// pass or fail depending on the day it ran, and would stop testing anything at
// all once the fixture dates aged out.
import { describe, expect, it } from "vitest";

import {
  compileSemanticQuery,
  relativeDateRange,
  RELATIVE_DATE_OPS,
  type RelativeDateOp,
  type SemanticModel,
  type SqlDialect,
} from "@/lib/semanticLayer";
import { runLocalSqlDuckDB } from "@/utils/data/duckdb.server";
import { alasqlEngine } from "./engines";
import { freshTables } from "./fixtures";

const LOCAL_DIALECTS: { dialect: SqlDialect; run: (sql: string) => Promise<unknown[]> }[] = [
  {
    dialect: "alasql",
    run: async (sql) => {
      const res = alasqlEngine.run(sql, freshTables());
      if (!res.ok) throw new Error(res.error);
      return res.rows;
    },
  },
  {
    dialect: "duckdb",
    run: async (sql) => (await runLocalSqlDuckDB(sql, freshTables())).rows,
  },
];

const model: SemanticModel = {
  name: "m",
  source: { kind: "data_table", table: "orders" },
  dimensions: [
    { name: "region", sql: "region", type: "string" },
    { name: "day", sql: "day", type: "time" },
  ],
  metrics: [{ name: "orders_count", agg: "count", sql: "id" }],
} as SemanticModel;

// Mid-March, chosen so every window lands somewhere interesting against the
// fixture's Jan–May dates rather than covering all of them or none.
const NOW = new Date("2026-03-15T12:00:00Z");

/**
 * The `orders` ids each window should return, worked out from the fixture by
 * hand rather than from the code under test.
 *
 * fixture days: 1:01-15 2:02-01 3:02-14 4:03-02 5:03-19 6:04-01 7:04-20
 *               8:05-05 9:05-30
 */
const EXPECTED: Record<RelativeDateOp, number[]> = {
  // 2026-02-14 .. 2026-03-16 — 30 days ending today, today included.
  last_n_days: [3, 4],
  // 2026-03-01 .. 2026-04-01
  this_month: [4, 5],
  // 2026-02-01 .. 2026-03-01
  last_month: [2, 3],
  // 2026-01-01 .. 2026-04-01
  this_quarter: [1, 2, 3, 4, 5],
  // 2025-10-01 .. 2026-01-01 — nothing; an empty window must still be a valid
  // query rather than an error.
  last_quarter: [],
  // 2026-01-01 .. 2026-03-16 — to DATE, so 03-19 is excluded.
  ytd: [1, 2, 3, 4],
};

describe.each(LOCAL_DIALECTS)("relative date filters on $dialect", ({ dialect, run }) => {
  it.each(RELATIVE_DATE_OPS)("%s selects exactly the rows in its window", async (op) => {
    const compiled = compileSemanticQuery(
      model,
      {
        model: "m",
        dimensions: ["day"],
        filters: [{ field: "day", op, value: op === "last_n_days" ? 30 : undefined }],
        orderBy: [{ field: "day", dir: "asc" }],
      },
      { dialect, now: NOW },
    );
    const rows = (await run(compiled.sql)) as Record<string, unknown>[];
    const days = rows.map((r) => String(r.day));
    const expectedDays = EXPECTED[op].map(
      (id) =>
        freshTables()
          .find((t) => t.name === "orders")!
          .rows.find((r) => r.id === id)!.day,
    );
    expect(days).toEqual(expectedDays);
  });

  it("filters on the raw date even when the dimension is grained", async () => {
    // Grained to month, the dimension's expression becomes a bucket LABEL. A
    // filter built on that instead of the column compares a window of days
    // against a month label.
    //
    // `last_n_days` is the case that discriminates, and `this_month` is not:
    // a month window and a month label coincide, so on DuckDB (whose label is
    // an ISO first-of-month) the bug returns the right answer by luck. The
    // 30-day window 02-14..03-16 covers ids 3 (02-14) and 4 (03-02) — two
    // different months, so the correct result has TWO buckets. Filtering on
    // the label instead drops id 3 (its label 02-01 is before 02-14) and
    // pulls in id 5 (label 03-01), collapsing to one bucket.
    const compiled = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["orders_count"],
        dimensions: ["day"],
        grains: { day: "month" },
        filters: [{ field: "day", op: "last_n_days", value: 30 }],
        orderBy: [{ field: "day", dir: "asc" }],
      },
      { dialect, now: NOW },
    );
    const rows = (await run(compiled.sql)) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.orders_count))).toEqual([1, 1]);
  });

  it("counts an aggregate over the window", async () => {
    const compiled = compileSemanticQuery(
      model,
      {
        model: "m",
        metrics: ["orders_count"],
        filters: [{ field: "day", op: "last_n_days", value: 30 }],
      },
      { dialect, now: NOW },
    );
    const rows = (await run(compiled.sql)) as Record<string, unknown>[];
    expect(Number(rows[0].orders_count)).toBe(2);
  });
});

describe("both engines agree, row for row", () => {
  it.each(RELATIVE_DATE_OPS)("%s", async (op) => {
    const results = await Promise.all(
      LOCAL_DIALECTS.map(async ({ dialect, run }) => {
        const compiled = compileSemanticQuery(
          model,
          {
            model: "m",
            dimensions: ["day"],
            filters: [{ field: "day", op, value: op === "last_n_days" ? 30 : undefined }],
            orderBy: [{ field: "day", dir: "asc" }],
          },
          { dialect, now: NOW },
        );
        return ((await run(compiled.sql)) as Record<string, unknown>[]).map((r) => String(r.day));
      }),
    );
    expect(results[0]).toEqual(results[1]);
  });
});

describe("the window boundaries", () => {
  const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it("is half-open, so a timestamp late on the last day is still included", () => {
    // The reason for `< end` rather than `<= lastDay`.
    const { start, end } = relativeDateRange("this_month", { now: at("2026-03-15") });
    expect(start).toBe("2026-03-01");
    expect(end).toBe("2026-04-01");
    expect("2026-03-31T23:59:59" >= start && "2026-03-31T23:59:59" < end).toBe(true);
  });

  it("rolls a month back across a year boundary", () => {
    expect(relativeDateRange("last_month", { now: at("2026-01-09") })).toEqual({
      start: "2025-12-01",
      end: "2026-01-01",
    });
  });

  it("rolls a quarter back across a year boundary", () => {
    expect(relativeDateRange("last_quarter", { now: at("2026-02-09") })).toEqual({
      start: "2025-10-01",
      end: "2026-01-01",
    });
  });

  it.each([
    ["2026-01-01", "2026-01-01", "2026-04-01"],
    ["2026-03-31", "2026-01-01", "2026-04-01"],
    ["2026-04-01", "2026-04-01", "2026-07-01"],
    ["2026-12-31", "2026-10-01", "2027-01-01"],
  ])("this_quarter at %s is %s..%s", (now, start, end) => {
    expect(relativeDateRange("this_quarter", { now: at(now) })).toEqual({ start, end });
  });

  it("counts last_n_days inclusive of today, so n=1 is today alone", () => {
    expect(relativeDateRange("last_n_days", { n: 1, now: at("2026-03-15") })).toEqual({
      start: "2026-03-15",
      end: "2026-03-16",
    });
  });

  it("spans a leap day without losing one", () => {
    // 2028 is a leap year; Feb has 29 days, so 29 days back from Mar 1 is Feb 2.
    expect(relativeDateRange("last_n_days", { n: 29, now: at("2028-03-01") })).toEqual({
      start: "2028-02-02",
      end: "2028-03-02",
    });
  });

  it("runs ytd to today, not to the end of the year", () => {
    expect(relativeDateRange("ytd", { now: at("2026-03-15") })).toEqual({
      start: "2026-01-01",
      end: "2026-03-16",
    });
  });

  it.each([0, -1, 3651, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a nonsensical n (%s)",
    (n) => {
      expect(() => relativeDateRange("last_n_days", { n, now: at("2026-03-15") })).toThrow();
    },
  );

  it("refuses last_n_days with no n at all", () => {
    expect(() => relativeDateRange("last_n_days", { now: at("2026-03-15") })).toThrow();
  });
});

describe("what a relative filter refuses to compile", () => {
  it("rejects a non-time dimension rather than returning nothing", () => {
    // A string column compared against a date window would return zero rows and
    // look like a legitimately empty result.
    expect(() =>
      compileSemanticQuery(
        model,
        { model: "m", metrics: ["orders_count"], filters: [{ field: "region", op: "this_month" }] },
        { dialect: "duckdb", now: NOW },
      ),
    ).toThrow(/time dimension/i);
  });

  it("rejects a relative window on a metric", () => {
    expect(() =>
      compileSemanticQuery(
        model,
        {
          model: "m",
          metrics: ["orders_count"],
          filters: [{ field: "orders_count", op: "this_month" }],
        },
        { dialect: "duckdb", now: NOW },
      ),
    ).toThrow(/time dimension/i);
  });
});

describe("the emitted SQL", () => {
  it("uses BigQuery's DATE constructor, which will not compare DATE to STRING", () => {
    const compiled = compileSemanticQuery(
      model,
      { model: "m", metrics: ["orders_count"], filters: [{ field: "day", op: "this_month" }] },
      { dialect: "bigquery", now: NOW },
    );
    expect(compiled.sql).toContain("DATE '2026-03-01'");
    expect(compiled.sql).toContain("DATE '2026-04-01'");
  });

  it("uses a bare string literal everywhere else", () => {
    const compiled = compileSemanticQuery(
      model,
      { model: "m", metrics: ["orders_count"], filters: [{ field: "day", op: "this_month" }] },
      { dialect: "postgres", now: NOW },
    );
    expect(compiled.sql).toContain("'2026-03-01'");
    expect(compiled.sql).not.toContain("DATE '");
  });

  it("emits no CURRENT_DATE or INTERVAL — AlaSQL has neither", () => {
    for (const dialect of ["alasql", "duckdb"] as SqlDialect[]) {
      const compiled = compileSemanticQuery(
        model,
        {
          model: "m",
          metrics: ["orders_count"],
          filters: [{ field: "day", op: "last_n_days", value: 7 }],
        },
        { dialect, now: NOW },
      );
      expect(compiled.sql).not.toMatch(/CURRENT_DATE|INTERVAL|NOW\(\)/i);
    }
  });
});
