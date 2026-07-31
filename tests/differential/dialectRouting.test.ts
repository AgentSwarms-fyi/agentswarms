// Compiled SQL must be executable by the engine that will receive it.
//
// This guards a whole class of bug rather than a single case. Several call
// sites compile SQL with a dialect and then hand it to the local engine; if
// the dialect and the engine disagree, nothing fails at build time and
// everything fails at runtime. It happened for real: two call sites hard-coded
// "alasql" while routing through runLocalSqlForUser, so every BI widget using
// aggregate pushdown or incremental refresh, and every governed metric over a
// local dataset, would have broken the moment LOCAL_ENGINE=duckdb was set —
// AlaSQL's backtick identifiers are a parser error in DuckDB, and its
// YEAR()/MONTH() grain expressions are a binder error over text columns.
//
// So: compile with each local dialect and actually run the result.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildDirectQuerySql } from "@/lib/biDirectQuery";
import { aggregationPlan } from "@/lib/biAggregate";
import {
  compileSemanticQuery,
  truncateExpr,
  type SemanticModel,
  type SqlDialect,
  type TimeGrain,
} from "@/lib/semanticLayer";
import { runLocalSqlDuckDB } from "@/utils/data/duckdb.server";
import { alasqlEngine } from "./engines";
import { freshTables } from "./fixtures";

/** The dialects a LOCAL engine can be asked to run. */
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

/**
 * A source-level guard for the actual regression.
 *
 * The execution tests below prove both dialects COMPILE to runnable SQL. They
 * cannot catch a call site that compiles with the wrong one — that needs a
 * database to reach, and the failure is silent until the flag flips. Reading
 * the source is unusual in a test, but it is the only cheap check for "this
 * decision must never be hard-coded", and it is exactly how the bug got in.
 */
describe("local call sites resolve the dialect from the engine", () => {
  it.each([
    "src/utils/bi/refresh.server.ts",
    "src/utils/semantic/query.server.ts",
    "src/utils/bi/prep.server.ts",
  ])("%s does not hard-code a local dialect", (file) => {
    const src = readFileSync(file, "utf8");
    // Matches `dialect: "alasql"` and a bare `, "alasql",` argument.
    const hardCoded = src.match(/dialect:\s*"alasql"|,\s*"alasql",/g);
    expect(
      hardCoded,
      `${file} hard-codes the alasql dialect. It must call localEngineName() — the ` +
        `compiled SQL has to match whichever engine runLocalSqlForUser will use.`,
    ).toBeNull();
  });
});

const model: SemanticModel = {
  name: "m",
  source: { kind: "data_table", table: "orders" },
  dimensions: [
    { name: "region", sql: "region", type: "string" },
    { name: "day", sql: "day", type: "time" },
  ],
  metrics: [
    { name: "revenue", agg: "sum", sql: "amount" },
    { name: "orders_count", agg: "count", sql: "id" },
  ],
} as SemanticModel;

describe.each(LOCAL_DIALECTS)(
  "semantic SQL compiled for $dialect runs on $dialect",
  ({ dialect, run }) => {
    it("metric with a dimension", async () => {
      const compiled = compileSemanticQuery(
        model,
        { model: "m", metrics: ["revenue"], dimensions: ["region"] },
        { dialect },
      );
      await expect(run(compiled.sql)).resolves.toBeDefined();
    });

    it("two metrics, ordered and limited", async () => {
      const compiled = compileSemanticQuery(
        model,
        {
          model: "m",
          metrics: ["revenue", "orders_count"],
          dimensions: ["region"],
          orderBy: [{ field: "revenue", dir: "desc" }],
          limit: 5,
        },
        { dialect },
      );
      await expect(run(compiled.sql)).resolves.toBeDefined();
    });

    it("a filter with a string value", async () => {
      const compiled = compileSemanticQuery(
        model,
        {
          model: "m",
          metrics: ["revenue"],
          dimensions: ["region"],
          filters: [{ field: "region", op: "=", value: "EMEA" }],
        },
        { dialect },
      );
      await expect(run(compiled.sql)).resolves.toBeDefined();
    });

    // AlaSQL refuses the week grain by design, so it is excluded there.
    const grains: TimeGrain[] =
      dialect === "alasql"
        ? ["day", "month", "quarter", "year"]
        : ["day", "week", "month", "quarter", "year"];
    it.each(grains)("the %s time grain", async (grain) => {
      const compiled = compileSemanticQuery(
        model,
        { model: "m", metrics: ["revenue"], dimensions: ["day"], grains: { day: grain } },
        { dialect },
      );
      await expect(run(compiled.sql)).resolves.toBeDefined();
    });

    it("truncateExpr alone is executable", async () => {
      const expr = truncateExpr(dialect === "alasql" ? "`day`" : '"day"', "month", dialect);
      await expect(run(`SELECT ${expr} AS b FROM orders`)).resolves.toBeDefined();
    });
  },
);

describe.each(LOCAL_DIALECTS)(
  "widget SQL wrapped for $dialect runs on $dialect",
  ({ dialect, run }) => {
    const base = "SELECT region, amount FROM orders";
    const columns = ["region", "amount"];

    it("aggregate pushdown", async () => {
      const plan = aggregationPlan(
        { type: "bar", xField: "region", yField: "amount" },
        {
          preserve: [],
        },
      );
      expect(plan).toBeTruthy();
      const sql = buildDirectQuerySql({
        baseSql: base,
        columns,
        agg: plan ?? undefined,
        dialect,
        rowCap: 500,
      });
      await expect(run(sql)).resolves.toBeDefined();
    });

    it("an incremental window", async () => {
      const sql = buildDirectQuerySql({
        baseSql: "SELECT day, amount FROM orders",
        columns: ["day", "amount"],
        filters: [{ column: "day", kind: "daterange", from: "2026-03-01" }],
        dialect,
        rowCap: 500,
      });
      await expect(run(sql)).resolves.toBeDefined();
    });

    it("pushdown plus a filter", async () => {
      const plan = aggregationPlan(
        { type: "bar", xField: "region", yField: "amount" },
        {
          preserve: ["region"],
        },
      );
      const sql = buildDirectQuerySql({
        baseSql: base,
        columns,
        filters: [{ column: "region", kind: "select", values: ["EMEA", "APAC"] }],
        agg: plan ?? undefined,
        dialect,
        rowCap: 500,
      });
      await expect(run(sql)).resolves.toBeDefined();
    });
  },
);
