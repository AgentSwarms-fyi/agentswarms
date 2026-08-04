// The SQL prompt has to name the engine that will actually run the SQL.
//
// 92686b1 (2026-08-02) replaced the in-browser AlaSQL with DuckDB-Wasm. The
// prompt's localEngine default stayed "alasql", so for three days every
// browser Visual BI query was generated for the wrong engine: the model was
// told to quote identifiers in backticks, and DuckDB answers that with
//   Catalog Error: Scalar Function with name `__postfix does not exist!
// Any question touching a column with a space in its name produced no chart,
// fell through to the plain agent, and said nothing anywhere about why.
//
// Measured in the running app, not inferred:
//   [VisualBI] turn produced no rows for "total sales by region as a bar chart"
//   {"status":"error","error":"Catalog Error: Scalar Function with name
//    `__postfix does not exist!","sql":"SELECT `Region`, SUM(`Sales`) ..."}
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildSqlPrompt } from "@/lib/biAgent";

const base = {
  question: "total sales by region",
  plan: { intent: "aggregate" } as never,
  datasets: [],
  semantics: new Map(),
  metrics: [],
  schema: "saas_sales(Region text, Sales numeric, `Order Date` date)",
};

describe("the local engine prompt defaults to what actually runs", () => {
  it("describes DuckDB when nothing is specified", () => {
    // Both local paths are DuckDB: lib/sqlEngine in the browser and
    // utils/data/localEngine.server on the server.
    const { systemPrompt } = buildSqlPrompt(base);
    expect(systemPrompt).toMatch(/DuckDB engine/);
    expect(systemPrompt).toMatch(/DOUBLE QUOTES/);
  });

  it("forbids the backticks that produced the error", () => {
    const { systemPrompt } = buildSqlPrompt(base);
    expect(systemPrompt).toMatch(/Backticks are a syntax error in DuckDB/);
    expect(systemPrompt, "still telling the model to use backticks").not.toMatch(
      /Wrap identifiers with spaces or special chars in backticks/,
    );
  });

  it("still supports AlaSQL when a caller asks for it explicitly", () => {
    // localEngineName() can still return "alasql" server-side. Opt-in, not
    // the default — the default is the thing that was wrong.
    const { systemPrompt } = buildSqlPrompt({ ...base, localEngine: "alasql" });
    expect(systemPrompt).toMatch(/AlaSQL engine/);
    expect(systemPrompt).toMatch(/backticks/);
  });

  it("a warehouse dialect still wins over the local engine", () => {
    const { systemPrompt } = buildSqlPrompt({ ...base, dialect: "Snowflake" });
    expect(systemPrompt).toMatch(/for Snowflake/);
    expect(systemPrompt).not.toMatch(/DuckDB engine/);
  });
});

describe("the prompt is keyed off the executor that will run it", () => {
  const SRC = readFileSync("src/lib/biAgent.ts", "utf8");

  it("names the engine from the same test the executor uses", () => {
    // runBiTurn picks its executor with `args.execute ? ... : runQuery`. The
    // engine named in the prompt has to be chosen by that same condition, or
    // the two drift apart again the next time an engine is swapped.
    expect(SRC).toMatch(/localEngine: args\.execute \? args\.localEngine : "duckdb"/);
    expect(SRC).toMatch(/args\.execute\s*\n?\s*\? await args\.execute\(turn\.sql\)/);
  });

  it("does not still claim the browser runs AlaSQL", () => {
    // The comment asserting AlaSQL ran in production is what made the wrong
    // default look considered rather than stale.
    expect(SRC).not.toMatch(/runQuery` in lib\/sqlEngine is an in-browser AlaSQL instance/);
    expect(SRC).not.toMatch(/runs SQL through the existing browser AlaSQL engine/);
  });

  it("sqlEngine really is DuckDB, so the default is not a guess", () => {
    // If this ever flips back, the default above is wrong again and this test
    // is the thing that should notice.
    const ENGINE = readFileSync("src/lib/sqlEngine.ts", "utf8").slice(0, 400);
    expect(ENGINE).toMatch(/backed by DuckDB/i);
  });
});
