// A semantic model must not be locked to the engine it was authored on.
//
// Dimension/metric `sql` fragments are authored by the model owner or by
// "Generate with AI" and inserted VERBATIM into the compiled query. The AI
// prompt quotes local columns in backticks (AlaSQL's style), so every saved
// model over a local dataset produced `` `Order Date` `` — which DuckDB
// rejects with "Parser Error: syntax error at or near". The dialect option
// could not save it, because the dialect never reached the stored fragment.
//
// That is the whole promise of a semantic layer failing: define the metric
// once, query it anywhere. These tests pin the fix.

import { describe, expect, it } from "vitest";

import {
  compileSemanticQuery,
  normaliseIdentQuotes,
  type SemanticModel,
} from "@/lib/semanticLayer";
import { runLocalSqlDuckDB } from "@/utils/data/duckdb.server";

describe("normaliseIdentQuotes", () => {
  it("rewrites backticks to ANSI quotes for duckdb/postgres", () => {
    expect(normaliseIdentQuotes("`Order Date`", "duckdb")).toBe('"Order Date"');
    expect(normaliseIdentQuotes("SUM(`Sales`)", "postgres")).toBe('SUM("Sales")');
  });

  it("rewrites ANSI quotes to backticks for alasql/bigquery", () => {
    // The reverse direction matters just as much: a model authored against a
    // warehouse must still run on the default local engine.
    expect(normaliseIdentQuotes('"Order Date"', "alasql")).toBe("`Order Date`");
    expect(normaliseIdentQuotes('SUM("Sales")', "bigquery")).toBe("SUM(`Sales`)");
  });

  it("leaves an already-correct fragment untouched", () => {
    expect(normaliseIdentQuotes('"Order Date"', "duckdb")).toBe('"Order Date"');
    expect(normaliseIdentQuotes("`Order Date`", "alasql")).toBe("`Order Date`");
    expect(normaliseIdentQuotes("plain_column", "duckdb")).toBe("plain_column");
  });

  it("does NOT touch quote characters inside string literals", () => {
    // The failure mode of a naive regex: rewriting a value into an identifier
    // changes what the query MEANS rather than just failing to parse.
    expect(normaliseIdentQuotes("status = 'a `b` c'", "duckdb")).toBe("status = 'a `b` c'");
    expect(normaliseIdentQuotes(`note = 'say "hi"'`, "alasql")).toBe(`note = 'say "hi"'`);
  });

  it("handles an escaped quote inside a literal", () => {
    // '' ends nothing — the literal continues, so the backtick after it is
    // still literal text.
    expect(normaliseIdentQuotes("x = 'it''s `fine`'", "duckdb")).toBe("x = 'it''s `fine`'");
  });

  it("escapes a target quote appearing inside an identifier", () => {
    expect(normaliseIdentQuotes('`we"ird`', "duckdb")).toBe('"we""ird"');
  });

  it("leaves an unbalanced quote alone rather than guessing", () => {
    expect(normaliseIdentQuotes("`Order Date", "duckdb")).toBe("`Order Date");
  });
});

/** A model exactly as the Semantic Layer screen saves it for a local dataset. */
const backtickModel: SemanticModel = {
  name: "saas",
  source: { kind: "data_table", table: "saas_sales" },
  dimensions: [
    { name: "order_date", sql: "`Order Date`", type: "time" },
    { name: "region", sql: "`Region`", type: "categorical" },
  ],
  metrics: [{ name: "revenue", agg: "sum", sql: "`Sales`" }],
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
      { "Order Date": "2026-03-04", Region: "West", Sales: 10 },
      { "Order Date": "2026-03-19", Region: "West", Sales: 5 },
      { "Order Date": "2026-04-02", Region: "East", Sales: 7 },
    ],
  },
];

describe("compileSemanticQuery — a backtick-authored model on DuckDB", () => {
  it("emits no backticks", () => {
    const { sql } = compileSemanticQuery(
      backtickModel,
      { model: "saas", metrics: ["revenue"], dimensions: ["region"] },
      { dialect: "duckdb" },
    );
    expect(sql).not.toContain("`");
  });

  it("actually executes, grouped by a plain dimension", async () => {
    const { sql } = compileSemanticQuery(
      backtickModel,
      {
        model: "saas",
        metrics: ["revenue"],
        dimensions: ["region"],
        orderBy: [{ field: "region", dir: "asc" }],
      },
      { dialect: "duckdb" },
    );
    const { rows } = await runLocalSqlDuckDB(sql, tables);
    expect(rows).toEqual([
      { region: "East", revenue: 7 },
      { region: "West", revenue: 15 },
    ]);
  });

  it("executes with a time grain — the path that was fully broken", async () => {
    // truncateExpr wraps the stored fragment, so a backtick landed INSIDE
    // DATE_TRUNC/TRY_CAST. This is the case the user hit.
    const { sql } = compileSemanticQuery(
      backtickModel,
      {
        model: "saas",
        metrics: ["revenue"],
        dimensions: ["order_date"],
        grains: { order_date: "month" },
        orderBy: [{ field: "order_date", dir: "asc" }],
      },
      { dialect: "duckdb" },
    );
    const { rows } = await runLocalSqlDuckDB(sql, tables);
    expect(rows).toEqual([
      { order_date: "2026-03-01", revenue: 15 },
      { order_date: "2026-04-01", revenue: 7 },
    ]);
  });

  it("normalises a filtered measure's CASE WHEN condition", async () => {
    // `filters` is embedded as verbatim as `sql` is, and was missed by the
    // first pass of this fix — a backtick simply moved inside the CASE.
    const filtered: SemanticModel = {
      ...backtickModel,
      metrics: [
        { name: "west_revenue", agg: "sum", sql: "`Sales`", filters: ["`Region` = 'West'"] },
      ],
    };
    const { sql } = compileSemanticQuery(
      filtered,
      { model: "saas", metrics: ["west_revenue"] },
      { dialect: "duckdb" },
    );
    expect(sql).not.toContain("`");
    const { rows } = await runLocalSqlDuckDB(sql, tables);
    expect(rows).toEqual([{ west_revenue: 15 }]);
  });

  it("normalises a JOIN's ON condition too", () => {
    const joined: SemanticModel = {
      ...backtickModel,
      joins: [{ table: "regions", type: "left", on: "saas_sales.`Region` = regions.`code`" }],
    };
    const { sql } = compileSemanticQuery(
      joined,
      { model: "saas", metrics: ["revenue"] },
      { dialect: "duckdb" },
    );
    expect(sql).toContain('saas_sales."Region" = regions."code"');
  });

  it("still compiles to backticks for the default local engine", () => {
    const { sql } = compileSemanticQuery(
      backtickModel,
      { model: "saas", metrics: ["revenue"], dimensions: ["region"] },
      { dialect: "alasql" },
    );
    expect(sql).toContain("`Region`");
    expect(sql).not.toContain('"Region"');
  });
});
