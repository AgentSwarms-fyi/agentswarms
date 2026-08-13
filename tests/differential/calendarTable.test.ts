// Calendar-table fiscal periods, EXECUTED against hand-computed truth.
//
// A 4-4-5 calendar cannot be computed from a date — neighbouring periods have
// DIFFERENT lengths, so "previous period" is not a fixed interval and month
// arithmetic answers a different question. The fixture is a miniature 4-4-5:
// two fiscal years of three periods each, 4/4/5 DAYS long, so every boundary
// case (unequal neighbours, the year boundary, a period with no rows, the
// calendar's edge) is small enough to work out BY HAND. The calendar maps
// each day to its period's dense sequence number and start date; comparisons
// step the sequence, buckets are the start dates.
import { describe, expect, it } from "vitest";

import {
  compileSemanticQuery,
  relativeDateRange,
  type SemanticModel,
  type SemanticQuery,
} from "@/lib/semanticLayer";
import { measureCalendarHealth } from "@/lib/semanticMeasure";
import { calendarSchema } from "@/utils/semantic.functions";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

// FY1: P1 = Jan 1–4, P2 = Jan 5–8, P3 = Jan 9–13 (4-4-5 in days).
// FY2: P4 = Jan 14–17, P5 = Jan 18–21, P6 = Jan 22–26.
const fcalRows: Array<{
  d: string;
  fy_seq: number;
  fy_start: string;
  fp_seq: number;
  fp_start: string;
}> = [];
const addPeriod = (
  fySeq: number,
  fyStart: string,
  fpSeq: number,
  fpStart: string,
  days: string[],
) => {
  for (const d of days) {
    fcalRows.push({ d, fy_seq: fySeq, fy_start: fyStart, fp_seq: fpSeq, fp_start: fpStart });
  }
};
addPeriod(1, "2025-01-01", 1, "2025-01-01", [
  "2025-01-01",
  "2025-01-02",
  "2025-01-03",
  "2025-01-04",
]);
addPeriod(1, "2025-01-01", 2, "2025-01-05", [
  "2025-01-05",
  "2025-01-06",
  "2025-01-07",
  "2025-01-08",
]);
addPeriod(1, "2025-01-01", 3, "2025-01-09", [
  "2025-01-09",
  "2025-01-10",
  "2025-01-11",
  "2025-01-12",
  "2025-01-13",
]);
addPeriod(2, "2025-01-14", 4, "2025-01-14", [
  "2025-01-14",
  "2025-01-15",
  "2025-01-16",
  "2025-01-17",
]);
addPeriod(2, "2025-01-14", 5, "2025-01-18", [
  "2025-01-18",
  "2025-01-19",
  "2025-01-20",
  "2025-01-21",
]);
addPeriod(2, "2025-01-14", 6, "2025-01-22", [
  "2025-01-22",
  "2025-01-23",
  "2025-01-24",
  "2025-01-25",
  "2025-01-26",
]);

const fcal: DuckTable = {
  name: "fcal",
  columns: [
    { name: "d", type: "date" },
    { name: "fy_seq", type: "number" },
    { name: "fy_start", type: "date" },
    { name: "fp_seq", type: "number" },
    { name: "fp_start", type: "date" },
  ],
  rows: fcalRows,
};

// Hand-computed period sums: P1 = 30, P2 = 40, P3 = 20, P4 = 100 (the year
// boundary — its predecessor P3 is a 5-day period, its own length is 4),
// P5 = NO ROWS, P6 = 7. FY1 = 90, FY2 = 107.
const sales: DuckTable = {
  name: "sales",
  columns: [
    { name: "id", type: "number" },
    { name: "day", type: "date" },
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
  ],
  rows: [
    { id: 1, day: "2025-01-02", region: "EMEA", amount: 10 },
    { id: 2, day: "2025-01-03", region: "EMEA", amount: 20 },
    { id: 3, day: "2025-01-06", region: "APAC", amount: 40 },
    { id: 4, day: "2025-01-10", region: "EMEA", amount: 5 },
    { id: 5, day: "2025-01-13", region: "APAC", amount: 15 },
    { id: 6, day: "2025-01-15", region: "EMEA", amount: 100 },
    { id: 7, day: "2025-01-25", region: "EMEA", amount: 7 },
  ],
};

const model: SemanticModel = {
  name: "cal",
  source: { kind: "data_table", table: "sales" },
  primaryKey: "id",
  calendar: {
    table: "fcal",
    dateColumn: "d",
    grains: {
      fiscal_year: { seq: "fy_seq", start: "fy_start" },
      fiscal_period: { seq: "fp_seq", start: "fp_start" },
    },
  },
  dimensions: [
    { name: "day", sql: "sales.day", type: "time" },
    { name: "region", sql: "sales.region", type: "categorical" },
  ],
  metrics: [{ name: "amount", agg: "sum", sql: "sales.amount" }],
} as SemanticModel;

const compile = (q: Partial<SemanticQuery>, m: SemanticModel = model, now?: Date) =>
  compileSemanticQuery(m, { model: m.name, ...q } as SemanticQuery, { dialect: "duckdb", now });

const exec = async (q: Partial<SemanticQuery>, m: SemanticModel = model, now?: Date) =>
  (await runLocalSqlDuckDB(compile(q, m, now).sql, [sales, fcal])).rows;

describe("bucketing by the calendar table", () => {
  it("groups by fiscal period START DATES, unequal lengths and all", async () => {
    const rows = await exec({
      metrics: ["amount"],
      dimensions: ["day"],
      grains: { day: "fiscal_period" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      { day: "2025-01-01", amount: 30 },
      { day: "2025-01-05", amount: 40 },
      { day: "2025-01-09", amount: 20 },
      { day: "2025-01-14", amount: 100 },
      { day: "2025-01-22", amount: 7 },
    ]);
  });

  it("fiscal_year buckets by the year's start date from the table", async () => {
    const rows = await exec({
      metrics: ["amount"],
      dimensions: ["day"],
      grains: { day: "fiscal_year" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      { day: "2025-01-01", amount: 90 },
      { day: "2025-01-14", amount: 107 },
    ]);
  });

  it("a duplicate calendar day CANNOT multiply fact rows (grouped join)", async () => {
    // The dirty row claims Jan 2 belongs to P2. MIN() keeps the day mapped to
    // exactly one period (the smaller seq — P1), and the sum stays 30: wrong
    // labels are Validate's to report, row multiplication is impossible.
    const dirty: DuckTable = {
      ...fcal,
      rows: [
        ...fcalRows,
        { d: "2025-01-02", fy_seq: 1, fy_start: "2025-01-01", fp_seq: 2, fp_start: "2025-01-05" },
      ],
    };
    const c = compile({
      metrics: ["amount"],
      dimensions: ["day"],
      grains: { day: "fiscal_period" },
      orderBy: [{ field: "day", dir: "asc" }],
    });
    const rows = (await runLocalSqlDuckDB(c.sql, [sales, dirty])).rows;
    expect(rows).toEqual([
      { day: "2025-01-01", amount: 30 },
      { day: "2025-01-05", amount: 40 },
      { day: "2025-01-09", amount: 20 },
      { day: "2025-01-14", amount: 100 },
      { day: "2025-01-22", amount: 7 },
    ]);
  });

  it("an absolute filter on an unselected grained dim rides the calendar join", async () => {
    const rows = await exec({
      metrics: ["amount"],
      dimensions: [],
      grains: { day: "fiscal_period" },
      filters: [{ field: "day", op: ">=", value: "2025-01-14" }],
    });
    expect(rows).toEqual([{ amount: 107 }]);
  });
});

describe("period-over-period stepped by SEQUENCE, not by interval", () => {
  it("compares across unequal period lengths and the year boundary", async () => {
    const rows = await exec({
      metrics: ["amount"],
      dimensions: ["day"],
      grains: { day: "fiscal_period" },
      compare: "prior_period",
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      // P1: the calendar's first period — no predecessor.
      {
        day: "2025-01-01",
        amount: 30,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
      {
        day: "2025-01-05",
        amount: 40,
        amount_prev: 30,
        amount_change: 10,
        amount_pct_change: 10 / 30,
      },
      {
        day: "2025-01-09",
        amount: 20,
        amount_prev: 40,
        amount_change: -20,
        amount_pct_change: -0.5,
      },
      // P4 vs P3: a 4-day period against a 5-DAY predecessor across the year
      // boundary — the comparison month arithmetic cannot express.
      { day: "2025-01-14", amount: 100, amount_prev: 20, amount_change: 80, amount_pct_change: 4 },
      // P6's predecessor P5 has NO rows: an honest NULL, not a zero.
      {
        day: "2025-01-22",
        amount: 7,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
    ]);
  });

  it("an axis filter narrows the CURRENT side only; the stitch still finds the predecessor", async () => {
    // The window starts at P3, but P3's comparison against P2 (outside the
    // window) must survive — the prior side skips axis filters and the
    // equality stitch keeps exactly the buckets the current side has.
    const rows = await exec({
      metrics: ["amount"],
      dimensions: ["day"],
      grains: { day: "fiscal_period" },
      compare: "prior_period",
      filters: [{ field: "day", op: ">=", value: "2025-01-09" }],
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      {
        day: "2025-01-09",
        amount: 20,
        amount_prev: 40,
        amount_change: -20,
        amount_pct_change: -0.5,
      },
      { day: "2025-01-14", amount: 100, amount_prev: 20, amount_change: 80, amount_pct_change: 4 },
      {
        day: "2025-01-22",
        amount: 7,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
    ]);
  });

  it("a RELATIVE window on the axis still finds last year's predecessor", async () => {
    // "This fiscal year, vs previous period": the year's FIRST period must
    // compare against the LAST period of the previous fiscal year — a row the
    // window itself excludes. Relative windows compile against the RAW date
    // column, which a sequence step cannot shift, so the prior side SKIPS the
    // axis filter and the stitch keeps only the buckets the current side has.
    const rows = await exec(
      {
        metrics: ["amount"],
        dimensions: ["day"],
        grains: { day: "fiscal_period" },
        compare: "prior_period",
        filters: [{ field: "day", op: "this_fiscal_year" }],
        orderBy: [{ field: "day", dir: "asc" }],
      },
      model,
      new Date("2025-01-16T12:00:00Z"), // inside FY2
    );
    expect(rows).toEqual([
      // P4 vs P3 — across the fiscal year boundary, P3 outside the window.
      { day: "2025-01-14", amount: 100, amount_prev: 20, amount_change: 80, amount_pct_change: 4 },
      // P6 vs P5 — in-window predecessor with no rows stays honestly NULL.
      {
        day: "2025-01-22",
        amount: 7,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
    ]);
  });

  it("a NON-axis filter applies to BOTH sides", async () => {
    // EMEA only: P1 = 30, P2 = 0 rows, P3 = 5, P4 = 100, P6 = 7. P3's
    // predecessor P2 has no EMEA rows → NULL, not APAC's 40.
    const rows = await exec({
      metrics: ["amount"],
      dimensions: ["day"],
      grains: { day: "fiscal_period" },
      compare: "prior_period",
      filters: [{ field: "region", op: "=", value: "EMEA" }],
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      {
        day: "2025-01-01",
        amount: 30,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
      {
        day: "2025-01-09",
        amount: 5,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
      { day: "2025-01-14", amount: 100, amount_prev: 5, amount_change: 95, amount_pct_change: 19 },
      {
        day: "2025-01-22",
        amount: 7,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
    ]);
  });

  it("yoy on the fiscal_quarter grain steps FOUR sequences (structural)", () => {
    // The fixture maps no quarters worth executing, but the constant is
    // load-bearing: +4 is the one provable quarters-per-year step.
    const quarterly: SemanticModel = {
      ...model,
      name: "quarterly",
      calendar: {
        table: "fcal",
        dateColumn: "d",
        grains: { fiscal_quarter: { seq: "fp_seq", start: "fp_start" } },
      },
    } as SemanticModel;
    const c = compile(
      {
        metrics: ["amount"],
        dimensions: ["day"],
        grains: { day: "fiscal_quarter" },
        compare: "yoy",
      },
      quarterly,
    );
    expect(c.sql).toContain(".semantic_seq = semantic_cal__day.fp_seq + 4");
  });

  it("yoy on the fiscal_year grain steps one year of the calendar", async () => {
    const rows = await exec({
      metrics: ["amount"],
      dimensions: ["day"],
      grains: { day: "fiscal_year" },
      compare: "yoy",
      orderBy: [{ field: "day", dir: "asc" }],
    });
    expect(rows).toEqual([
      {
        day: "2025-01-01",
        amount: 90,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
      },
      {
        day: "2025-01-14",
        amount: 107,
        amount_prev: 90,
        amount_change: 17,
        amount_pct_change: 17 / 90,
      },
    ]);
  });
});

describe("relative fiscal windows resolved against the table", () => {
  const now = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it("this_fiscal_period is the days the CALENDAR assigns to today's period", async () => {
    const rows = await exec(
      { metrics: ["amount"], filters: [{ field: "day", op: "this_fiscal_period" }] },
      model,
      now("2025-01-16"),
    );
    expect(rows).toEqual([{ amount: 100 }]);
  });

  it("last_fiscal_period steps one sequence back — into the 5-day period", async () => {
    const rows = await exec(
      { metrics: ["amount"], filters: [{ field: "day", op: "last_fiscal_period" }] },
      model,
      now("2025-01-16"),
    );
    expect(rows).toEqual([{ amount: 20 }]);
  });

  it("fiscal_ytd runs from the table's year start through today", async () => {
    const rows = await exec(
      { metrics: ["amount"], filters: [{ field: "day", op: "fiscal_ytd" }] },
      model,
      now("2025-01-16"),
    );
    expect(rows).toEqual([{ amount: 100 }]);
  });

  it("this_fiscal_year covers the table's year, whatever its shape", async () => {
    const rows = await exec(
      { metrics: ["amount"], filters: [{ field: "day", op: "this_fiscal_year" }] },
      model,
      now("2025-01-10"),
    );
    expect(rows).toEqual([{ amount: 90 }]);
  });

  it("a `now` outside the calendar yields an honest EMPTY window, not everything", async () => {
    const rows = await exec(
      { metrics: ["amount"], filters: [{ field: "day", op: "this_fiscal_year" }] },
      model,
      now("2030-06-01"),
    );
    expect(rows).toEqual([{ amount: null }]);
  });
});

describe("the multi-fact plan carries the calendar", () => {
  const items: DuckTable = {
    name: "items",
    columns: [
      { name: "sale_id", type: "number" },
      { name: "qty", type: "number" },
    ],
    rows: [
      { sale_id: 1, qty: 2 },
      { sale_id: 1, qty: 3 },
      { sale_id: 6, qty: 4 },
    ],
  };
  const chasmModel: SemanticModel = {
    ...model,
    name: "calchasm",
    joins: [
      {
        table: "items",
        on: "sales.id = items.sale_id",
        type: "left",
        cardinality: "one_to_many",
      },
    ],
    metrics: [
      { name: "amount", agg: "sum", sql: "sales.amount" },
      { name: "qty", agg: "sum", sql: "items.qty" },
    ],
  } as SemanticModel;

  it("period comparison ACROSS the plan steps the sequence in every branch", async () => {
    const c = compile(
      {
        metrics: ["amount", "qty"],
        dimensions: ["day"],
        grains: { day: "fiscal_period" },
        compare: "prior_period",
        orderBy: [{ field: "day", dir: "asc" }],
      },
      chasmModel,
    );
    const rows = (await runLocalSqlDuckDB(c.sql, [sales, fcal, items])).rows;
    expect(rows).toEqual([
      {
        day: "2025-01-01",
        amount: 30,
        qty: 5,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
        qty_prev: null,
        qty_change: null,
        qty_pct_change: null,
      },
      {
        day: "2025-01-05",
        amount: 40,
        qty: null,
        amount_prev: 30,
        amount_change: 10,
        amount_pct_change: 10 / 30,
        qty_prev: 5,
        qty_change: null,
        qty_pct_change: null,
      },
      {
        day: "2025-01-09",
        amount: 20,
        qty: null,
        amount_prev: 40,
        amount_change: -20,
        amount_pct_change: -0.5,
        qty_prev: null,
        qty_change: null,
        qty_pct_change: null,
      },
      {
        day: "2025-01-14",
        amount: 100,
        qty: 4,
        amount_prev: 20,
        amount_change: 80,
        amount_pct_change: 4,
        qty_prev: null,
        qty_change: null,
        qty_pct_change: null,
      },
      {
        day: "2025-01-22",
        amount: 7,
        qty: null,
        amount_prev: null,
        amount_change: null,
        amount_pct_change: null,
        qty_prev: null,
        qty_change: null,
        qty_pct_change: null,
      },
    ]);
  });
});

describe("Validate MEASURES the calendar, not trusts it", () => {
  const execOn = (tables: DuckTable[]) => async (sql: string) =>
    (await runLocalSqlDuckDB(sql, tables)).rows;
  const during = new Date("2025-01-20T12:00:00Z");

  it("a clean calendar measures clean", async () => {
    const r = await measureCalendarHealth(execOn([fcal]), model, "duckdb", during);
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("duplicate day rows are an issue (labels arbitrary, rows never multiply)", async () => {
    const dirty: DuckTable = {
      ...fcal,
      rows: [
        ...fcalRows,
        { d: "2025-01-02", fy_seq: 1, fy_start: "2025-01-01", fp_seq: 2, fp_start: "2025-01-05" },
      ],
    };
    const r = await measureCalendarHealth(execOn([dirty]), model, "duckdb", during);
    expect(r.issues.map((i) => i.error).join(" ")).toMatch(/duplicate day rows/);
  });

  it("a coverage gap is a warning — facts on missing days bucket NULL", async () => {
    const gappy: DuckTable = { ...fcal, rows: fcalRows.filter((r) => r.d !== "2025-01-11") };
    const r = await measureCalendarHealth(execOn([gappy]), model, "duckdb", during);
    expect(r.issues).toEqual([]);
    expect(r.warnings.map((w) => w.note).join(" ")).toMatch(/25 of the 26 days/);
  });

  it("a calendar that ends before today warns that relative windows go empty", async () => {
    const r = await measureCalendarHealth(
      execOn([fcal]),
      model,
      "duckdb",
      new Date("2025-03-01T12:00:00Z"),
    );
    expect(r.warnings.map((w) => w.note).join(" ")).toMatch(/before today.*windows/s);
  });

  it("a sequence with two start dates is an issue", async () => {
    const conflicted: DuckTable = {
      ...fcal,
      rows: [
        ...fcalRows,
        { d: "2025-01-27", fy_seq: 2, fy_start: "2025-01-14", fp_seq: 6, fp_start: "2025-01-23" },
      ],
    };
    const r = await measureCalendarHealth(execOn([conflicted]), model, "duckdb", during);
    expect(r.issues.map((i) => i.error).join(" ")).toMatch(/more than one start date/);
  });

  it("consecutive sequences whose starts do not increase are an issue", async () => {
    // Swap P1 and P2's start dates: seq order no longer matches time order,
    // so "previous period" would pair the wrong periods.
    const misordered: DuckTable = {
      ...fcal,
      rows: fcalRows.map((r) =>
        r.fp_seq === 1
          ? { ...r, fp_start: "2025-01-05" }
          : r.fp_seq === 2
            ? { ...r, fp_start: "2025-01-01" }
            : r,
      ),
    };
    const r = await measureCalendarHealth(execOn([misordered]), model, "duckdb", during);
    expect(r.issues.map((i) => i.error).join(" ")).toMatch(/do not.*increase/s);
  });

  it("an empty calendar is an issue, not a silent pass", async () => {
    const empty: DuckTable = { ...fcal, rows: [] };
    const r = await measureCalendarHealth(execOn([empty]), model, "duckdb", during);
    expect(r.issues.map((i) => i.error).join(" ")).toMatch(/empty/);
  });
});

describe("the save-time schema", () => {
  const base = {
    table: "fcal",
    dateColumn: "d",
    grains: { fiscal_period: { seq: "fp_seq", start: "fp_start" } },
  };

  it("accepts a well-formed declaration", () => {
    expect(calendarSchema.safeParse(base).success).toBe(true);
  });

  it("refuses a calendar with no grains mapped", () => {
    const r = calendarSchema.safeParse({ ...base, grains: {} });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? "" : r.error.issues)).toMatch(/at least one grain/);
  });

  it("refuses non-identifier columns — they become SQL structure", () => {
    const r = calendarSchema.safeParse({
      ...base,
      grains: { fiscal_period: { seq: "fp_seq; DROP TABLE x", start: "fp_start" } },
    });
    expect(r.success).toBe(false);
  });

  it("refuses an unsafe table reference", () => {
    const r = calendarSchema.safeParse({ ...base, table: "fcal WHERE 1=1" });
    expect(r.success).toBe(false);
  });
});

describe("the envelope — what refuses, and why", () => {
  it("fiscal_period without a calendar table refuses with the fix", () => {
    const noCal = { ...model, name: "nocal", calendar: undefined } as SemanticModel;
    expect(() =>
      compile(
        { metrics: ["amount"], dimensions: ["day"], grains: { day: "fiscal_period" } },
        noCal,
      ),
    ).toThrow(/needs a fiscal calendar table/);
  });

  it("this_fiscal_period without a calendar refuses (filters too)", () => {
    const noCal = { ...model, name: "nocal", calendar: undefined } as SemanticModel;
    expect(() =>
      compile(
        { metrics: ["amount"], filters: [{ field: "day", op: "this_fiscal_period" }] },
        noCal,
      ),
    ).toThrow(/needs a fiscal calendar table/);
    expect(() => relativeDateRange("this_fiscal_period")).toThrow(/fiscal calendar table/);
  });

  it("a grain the calendar does not define refuses naming the defined ones", () => {
    expect(() =>
      compile({ metrics: ["amount"], dimensions: ["day"], grains: { day: "fiscal_week" } }),
    ).toThrow(/does not define "fiscal_week".*fiscal_year, fiscal_period/s);
  });

  it("yoy cannot step fiscal periods — no provable periods-per-year", () => {
    expect(() =>
      compile({
        metrics: ["amount"],
        dimensions: ["day"],
        grains: { day: "fiscal_period" },
        compare: "yoy",
      }),
    ).toThrow(/no fixed number/);
  });

  it("mom has no meaning on a calendar grain", () => {
    expect(() =>
      compile({
        metrics: ["amount"],
        dimensions: ["day"],
        grains: { day: "fiscal_period" },
        compare: "mom",
      }),
    ).toThrow(/no meaning on a fiscal calendar/);
  });

  it("declaring BOTH a start month and a calendar table refuses", () => {
    const both = { ...model, name: "both", fiscalYearStartMonth: 7 } as SemanticModel;
    expect(() => compile({ metrics: ["amount"] }, both)).toThrow(/remove one/);
  });

  it("a model with a start month only keeps the month-math fiscal grains", async () => {
    const monthly = {
      ...model,
      name: "monthly",
      calendar: undefined,
      fiscalYearStartMonth: 7,
    } as SemanticModel;
    // Jan 2025 sits in FY2025 for a July-start year (Jul 2024–Jun 2025).
    const rows = await exec(
      {
        metrics: ["amount"],
        dimensions: ["day"],
        grains: { day: "fiscal_year" },
        orderBy: [{ field: "day", dir: "asc" }],
      },
      monthly,
    );
    expect(rows).toEqual([{ day: 2025, amount: 197 }]);
  });
});
