// Building a visual from fields instead of SQL (R499).
//
// Picking a table used to write `SELECT * … LIMIT 50` and leave the GROUP BY
// to the author; a chart over that preview summed fifty arbitrary rows. These
// pin the query the Fields mode writes instead — aggregations, date grains
// (including text dates like 11/9/2024), filters, sorting and top N, quoting
// that cannot be broken out of — and how its columns land on a chart.
import { describe, expect, it } from "vitest";

import { aggregationPlan } from "@/lib/biAggregate";
import {
  assignChartFields,
  autoChartType,
  autoTitle,
  buildFieldSql,
  detectDateFormat,
  inferFields,
  measureDisplayName,
  quoteIdent,
  ROWS_FIELD,
  stringLiteral,
  type FieldInfo,
  type FieldQuery,
} from "@/lib/biFieldQuery";
import { suggestNarratives } from "@/lib/biInsights";
import { measureSeries, measuresAsSpokes, scaleSpokes } from "@/components/bi/biChartData";

const SALES: FieldInfo[] = [
  { name: "Region", kind: "text" },
  { name: "Order Date", kind: "date", dateFormat: "mdy" },
  { name: "Sales", kind: "number" },
  { name: "Profit", kind: "number" },
  { name: "Customer", kind: "text" },
];
const q = (p: Partial<FieldQuery>): FieldQuery => ({
  table: "saas_sales",
  dims: [],
  measures: [],
  filters: [],
  ...p,
});

describe("reading a table's fields", () => {
  it("tells dates, numbers and text apart from a sample", () => {
    const rows = [
      {
        Region: "EMEA",
        "Order Date": "11/9/2024",
        Sales: 10.5,
        "Customer ID": 1001,
        at: "2026-01-02",
      },
      {
        Region: "AMER",
        "Order Date": "3/14/2025",
        Sales: 3,
        "Customer ID": 1002,
        at: "2026-01-03",
      },
    ];
    const f = inferFields(Object.keys(rows[0]), rows, { Region: "string" });
    expect(f).toEqual([
      { name: "Region", kind: "text" },
      { name: "Order Date", kind: "date", dateFormat: "mdy" },
      { name: "Sales", kind: "number" },
      // An id is a label even when it is a number.
      { name: "Customer ID", kind: "text" },
      { name: "at", kind: "date", dateFormat: "iso" },
    ]);
    const ids = inferFields(
      ["orderId", "Invoice Number", "zip_code", "Units"],
      [{ orderId: 7, "Invoice Number": 5, zip_code: 94107, Units: 3 }],
    );
    expect(ids.map((f) => f.kind)).toEqual(["text", "text", "text", "number"]);
    // …even when the dataset declares it a number (the sample's Row ID and
    // Date Key are stored as integers).
    const declared = inferFields(
      ["Row ID", "Date Key", "Quantity"],
      [{ "Row ID": 1, "Date Key": 20241109, Quantity: 2 }],
      { "Row ID": "number", "Date Key": "number", Quantity: "number" },
    );
    expect(declared.map((f) => f.kind)).toEqual(["text", "text", "number"]);
  });

  it("reads day-first dates when the data says so", () => {
    expect(detectDateFormat(["13/4/2026", "1/5/2026"])).toBe("dmy");
    expect(detectDateFormat(["4/13/2026", "1/5/2026"])).toBe("mdy");
    expect(detectDateFormat(["EMEA", "AMER"])).toBeNull();
  });
});

describe("the query fields write", () => {
  it("groups and sums — the whole table, not a sample", () => {
    const out = buildFieldSql(
      q({ dims: [{ field: "Region" }], measures: [{ field: "Sales", agg: "sum" }] }),
      SALES,
      "duckdb",
    );
    expect(out.sql).toBe(
      [
        'SELECT "Region" AS "region",',
        '       SUM("Sales") AS "sales"',
        'FROM "saas_sales"',
        'GROUP BY "Region"',
        'ORDER BY "sales" DESC',
        "LIMIT 1000",
      ].join("\n"),
    );
    expect(out.dims).toEqual(["region"]);
    expect(out.measures).toEqual(["sales"]);
    expect(out.labels).toEqual({ region: "Region", sales: "Sales (Sum)" });
  });

  it("buckets a text date by month and orders by time", () => {
    const out = buildFieldSql(
      q({
        dims: [{ field: "Order Date", grain: "month" }],
        measures: [
          { field: "Sales", agg: "sum" },
          { field: "Customer", agg: "count_distinct" },
          { field: ROWS_FIELD, agg: "count" },
        ],
      }),
      SALES,
      "duckdb",
    );
    expect(out.sql).toContain(
      `STRFTIME(TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y'), '%Y-%m') AS "order_date_month"`,
    );
    expect(out.sql).toContain('COUNT(DISTINCT "Customer") AS "distinct_customer"');
    expect(out.sql).toContain('COUNT(*) AS "rows"');
    expect(out.sql).toContain('ORDER BY "order_date_month" ASC');
    expect(out.labels.order_date_month).toBe("Order Date (Month)");
  });

  it("filters, sorts smallest first and keeps the top N", () => {
    const out = buildFieldSql(
      q({
        dims: [{ field: "Customer" }],
        measures: [{ field: "Profit", agg: "avg" }],
        filters: [
          { field: "Region", op: "in", values: ["EMEA", "O'Brien & Co"] },
          { field: "Sales", op: "between", values: ["10", "500"] },
        ],
        sort: "value_asc",
        limit: 5,
      }),
      SALES,
      "duckdb",
    );
    expect(out.sql).toContain(`WHERE "Region" IN ('EMEA', 'O''Brien & Co')`);
    expect(out.sql).toContain('AND "Sales" BETWEEN 10 AND 500');
    expect(out.sql).toContain('ORDER BY "avg_profit" ASC');
    expect(out.sql).toMatch(/LIMIT 5$/);
  });

  it("refuses what it cannot write instead of writing something else", () => {
    expect(() => buildFieldSql(q({}), SALES, "duckdb")).toThrow("Add a field");
    expect(() =>
      buildFieldSql(q({ measures: [{ field: "Region", agg: "sum" }] }), SALES, "duckdb"),
    ).toThrow("not a number");
    expect(() =>
      buildFieldSql(q({ measures: [{ field: "Nope", agg: "sum" }] }), SALES, "duckdb"),
    ).toThrow("no field called Nope");
    expect(() =>
      buildFieldSql(
        q({
          measures: [{ field: "Sales" }],
          filters: [{ field: "Sales", op: "gt", values: ["1; DROP"] }],
        }),
        SALES,
        "duckdb",
      ),
    ).toThrow("needs a number");
  });

  it("quotes values the way each engine reads them", () => {
    expect(stringLiteral("O'Brien \\ Co", "duckdb")).toBe("'O''Brien \\ Co'");
    expect(stringLiteral("O'Brien \\ Co", "postgres")).toBe("'O''Brien \\ Co'");
    expect(stringLiteral("O'Brien \\ Co", "mysql")).toBe("'O''Brien \\\\ Co'");
    // '' would be two literals here; Spark would join them into "OBrien".
    expect(stringLiteral("O'Brien \\ Co", "databricks")).toBe("'O\\'Brien \\\\ Co'");
    expect(stringLiteral("O'Brien \\ Co", "bigquery")).toBe("'O\\'Brien \\\\ Co'");
    // A trailing backslash cannot escape the closing quote — on any engine
    // where a backslash escapes.
    expect(stringLiteral("x\\", "bigquery")).toBe("'x\\\\'");
    expect(stringLiteral("x\\", "snowflake")).toBe("'x\\\\'");
    expect(stringLiteral("x\\", "redshift")).toBe("'x\\\\'");
  });

  it("reads a date filter in the column's own format, or ISO, and nothing else", () => {
    const where = (v: string) =>
      buildFieldSql(
        q({
          measures: [{ field: "Sales" }],
          filters: [{ field: "Order Date", op: "gte", values: [v] }],
        }),
        SALES,
        "duckdb",
      ).sql.split("\n")[2];
    expect(where("1/31/2025")).toBe(
      `WHERE TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y') >= STRPTIME('1/31/2025', '%m/%d/%Y')`,
    );
    expect(where("2025-01-31")).toContain(">= CAST('2025-01-31' AS TIMESTAMP)");
    expect(() => where("last week")).toThrow("needs a date like 2025-01-31");
  });

  it("counts an empty string as empty, in the engine's own text type", () => {
    const where = (dialect: "duckdb" | "mysql") =>
      buildFieldSql(
        q({
          measures: [{ field: "Sales" }],
          filters: [{ field: "Region", op: "not_empty", values: [] }],
        }),
        SALES,
        dialect,
      ).sql.split("\n")[2];
    expect(where("duckdb")).toBe(`WHERE "Region" IS NOT NULL AND CAST("Region" AS VARCHAR) <> ''`);
    expect(where("mysql")).toBe("WHERE `Region` IS NOT NULL AND CAST(`Region` AS CHAR) <> ''");
  });

  it("quotes names so they cannot break out, in each dialect", () => {
    expect(quoteIdent('a"b', "duckdb")).toBe('"a""b"');
    expect(quoteIdent("a`b", "mysql")).toBe("`a``b`");
    const out = buildFieldSql(
      q({ table: "analytics.sales", measures: [{ field: "Sales", agg: "max" }] }),
      SALES,
      "bigquery",
    );
    expect(out.sql).toBe("SELECT MAX(`Sales`) AS `max_sales`\nFROM `analytics`.`sales`");
  });

  it("uses a calculated field as written when it aggregates by itself", () => {
    const fields: FieldInfo[] = [
      ...SALES,
      {
        name: "Margin %",
        kind: "number",
        calc: { expr: '100 * SUM("Profit") / SUM("Sales")', aggregated: true },
      },
    ];
    const out = buildFieldSql(
      q({ dims: [{ field: "Region" }], measures: [{ field: "Margin %" }] }),
      fields,
      "duckdb",
    );
    expect(out.sql).toContain('(100 * SUM("Profit") / SUM("Sales")) AS "margin"');
    expect(() =>
      buildFieldSql(
        q({ dims: [{ field: "Margin %" }], measures: [{ field: "Sales" }] }),
        fields,
        "duckdb",
      ),
    ).toThrow("only be a value");
  });

  it("takes the latest N periods of a time series and draws them oldest first", () => {
    const out = buildFieldSql(
      q({
        dims: [{ field: "Order Date", grain: "month" }],
        measures: [{ field: "Sales" }],
        limit: 12,
      }),
      SALES,
      "postgres",
    );
    expect(out.sql).toBe(
      [
        "SELECT *",
        "FROM (",
        `  SELECT DATE_TRUNC('month', "Order Date") AS "order_date_month",`,
        '         SUM("Sales") AS "sales"',
        '  FROM "saas_sales"',
        `  GROUP BY DATE_TRUNC('month', "Order Date")`,
        '  ORDER BY "order_date_month" DESC',
        "  LIMIT 12",
        ") latest",
        'ORDER BY "order_date_month" ASC',
      ].join("\n"),
    );
    // Ranked by value, the top 12 are the 12 biggest months — no wrapper.
    expect(
      buildFieldSql(
        q({
          dims: [{ field: "Order Date", grain: "month" }],
          measures: [{ field: "Sales" }],
          limit: 12,
          sort: "value_desc",
        }),
        SALES,
        "postgres",
      ).sql,
    ).toMatch(/^SELECT DATE_TRUNC[\s\S]*ORDER BY "sales" DESC\nLIMIT 12$/);
  });

  it("leaves other engines their own date truncation", () => {
    const out = buildFieldSql(
      q({ dims: [{ field: "Order Date", grain: "quarter" }], measures: [{ field: "Sales" }] }),
      SALES,
      "postgres",
    );
    expect(out.sql).toContain(`DATE_TRUNC('quarter', "Order Date") AS "order_date_quarter"`);
  });
});

describe("which chart, and its fields", () => {
  it("picks the visual the fields read best as", () => {
    expect(autoChartType(q({ measures: [{ field: "Sales" }] }), SALES)).toBe("kpi");
    expect(
      autoChartType(
        q({ dims: [{ field: "Order Date", grain: "month" }], measures: [{ field: "Sales" }] }),
        SALES,
      ),
    ).toBe("line");
    expect(
      autoChartType(q({ dims: [{ field: "Region" }], measures: [{ field: "Sales" }] }), SALES),
    ).toBe("bar");
    expect(
      autoChartType(
        q({ dims: [{ field: "Region" }, { field: "Customer" }], measures: [{ field: "Sales" }] }),
        SALES,
      ),
    ).toBe("scolumn");
    expect(autoChartType(q({ dims: [{ field: "Region" }] }), SALES)).toBe("table");
  });

  it("fills the chart's fields from the query's columns", () => {
    const out = { dims: ["region"], measures: ["sales", "profit"], labels: {} };
    expect(assignChartFields("bar", out)).toEqual({
      xField: "region",
      yField: "sales",
      extraMeasures: ["profit"],
    });
    // A stacked column stacks a series, never measures that overlap.
    expect(assignChartFields("scolumn", out)).toEqual({ xField: "region", yField: "sales" });
    expect(assignChartFields("combo", out)).toEqual({
      xField: "region",
      yField: "sales",
      lineField: "profit",
    });
    expect(
      assignChartFields(
        "kpi",
        { dims: ["m"], measures: ["sales"], labels: { sales: "Sales (Sum)" } },
        ["date"],
      ),
    ).toEqual({ valueField: "sales", dateField: "m", label: "Sales (Sum)" });
    expect(
      assignChartFields("insight", { dims: ["region"], measures: ["sales"], labels: {} }, ["text"]),
    ).toEqual({
      valueField: "sales",
      categoryField: "region",
    });
  });

  it("names a measure column in words, for legends and radar spokes", () => {
    expect(measureDisplayName("sales")).toBe("Sales");
    expect(measureDisplayName("avg_profit")).toBe("Average profit");
    expect(measureDisplayName("distinct_customer")).toBe("Distinct customer");
    expect(measureDisplayName("rows")).toBe("Rows");
    expect(measureDisplayName("unitPrice")).toBe("Unit Price");
    // A prefix alone is not an aggregation.
    expect(measureDisplayName("max_")).toBe("Max");
  });

  it("names the visual from its fields", () => {
    expect(
      autoTitle(
        q({
          dims: [{ field: "Order Date", grain: "month" }],
          measures: [{ field: "Sales" }, { field: "Profit" }],
        }),
        SALES,
      ),
    ).toBe("Sales and Profit by month");
    expect(
      autoTitle(
        q({
          dims: [
            { field: "Region" },
            { field: "Customer" },
            { field: "Order Date", grain: "year" },
          ],
          measures: [
            { field: "Sales", agg: "sum" },
            { field: "Profit", agg: "avg" },
            { field: "Customer", agg: "count_distinct" },
            { field: ROWS_FIELD, agg: "count" },
          ],
        }),
        SALES,
      ),
    ).toBe("Sales, Average Profit, Distinct Customer and Rows by Region, Customer and year");
    expect(
      autoTitle(
        q({
          dims: [{ field: "Region" }],
          measures: [
            { field: "Sales", agg: "avg" },
            { field: "Profit", agg: "avg" },
          ],
        }),
        SALES,
      ),
    ).toBe("Average Sales and Profit by Region");
  });
});

describe("several measures in one chart", () => {
  const rows = [
    { month: "2026-01", sales: 10, profit: 2 },
    { month: "2026-02", sales: 12, profit: 3 },
  ];

  it("draws each measure as its own series", () => {
    expect(measureSeries(rows, "month", ["sales", "profit", "missing"])).toEqual({
      data: rows,
      series: ["sales", "profit"],
    });
  });

  it("turns measures into radar spokes, one polygon per category", () => {
    const r = measuresAsSpokes(
      [
        { player: "A", pace: 80, shot: 70 },
        { player: "B", pace: 60, shot: 90 },
      ],
      "player",
      ["pace", "shot"],
    );
    expect(r.series).toEqual(["A", "B"]);
    expect(r.data).toEqual([
      { __spoke: "pace", A: 80, B: 60 },
      { __spoke: "shot", A: 70, B: 90 },
    ]);
  });

  it("puts each spoke on its own scale, keeping the actual value", () => {
    const { data, series } = measuresAsSpokes(
      [
        { seg: "SMB", sales: 240, qty: 4, profit: -2 },
        { seg: "Ent", sales: 120, qty: 2, profit: 8 },
      ],
      "seg",
      ["sales", "qty", "profit"],
    );
    const scaled = scaleSpokes(data, series);
    // Sales 240 vs 120 and quantity 4 vs 2 draw the same shape; a loss sits
    // at the centre, the tooltip value still -2.
    expect(scaled.map((r) => [r.__spoke, r.SMB, r.Ent])).toEqual([
      ["sales", 100, 50],
      ["qty", 100, 50],
      ["profit", 0, 100],
    ]);
    expect(scaled[2]["__raw:SMB"]).toBe(-2);
  });

  it("keeps the extra measures through the SQL aggregation", () => {
    expect(
      aggregationPlan({
        type: "line",
        xField: "month",
        yField: "sales",
        extraMeasures: ["profit"],
      }),
    ).toEqual({
      dims: ["month"],
      measures: [
        { field: "sales", agg: "sum" },
        { field: "profit", agg: "sum" },
      ],
    });
  });
});

describe("suggested narratives", () => {
  it("offers only the sentences these rows support", () => {
    const monthly = Array.from({ length: 10 }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}`,
      sales: 100 + i * 10,
    }));
    const s = suggestNarratives(["month", "sales"], monthly, (n) => String(Math.round(n)));
    expect(s.map((x) => x.spec.kind)).toEqual(["change", "forecast", "anomaly"]);
    expect(s[0].text).toBe("Sales for Oct 2026 increased by 5.6% (+10) from 180 to 190.");
    const regions = suggestNarratives(
      ["region", "sales"],
      [
        { region: "EMEA", sales: 3 },
        { region: "AMER", sales: 1 },
      ],
      String,
    );
    expect(regions.map((x) => x.spec.kind)).toEqual(["top", "bottom"]);
    expect(suggestNarratives(["region"], [{ region: "x" }], String)).toEqual([]);
  });

  it("stays a narrative whatever visual it is suggested beside", () => {
    // The builder hands over its whole chart spec as the format; only the
    // number format may be taken from it, never its type or fields.
    const beside = {
      type: "kpi",
      valueField: "sales",
      dateField: "region",
      format: "currency",
      currency: "EUR",
    } as unknown as Parameters<typeof suggestNarratives>[3];
    const s = suggestNarratives(
      ["region", "sales"],
      [
        { region: "EMEA", sales: 3 },
        { region: "AMER", sales: 1 },
      ],
      String,
      beside,
    );
    expect(s[0].spec).toEqual({
      type: "insight",
      kind: "top",
      valueField: "sales",
      categoryField: "region",
      dateField: undefined,
      format: "currency",
      currency: "EUR",
    });
  });
});
