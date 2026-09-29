// Query variables (R155), as Row Zero's: {{Region}} in a query sheet's SQL is
// the value of the workbook's name Region, so a cell can steer the query.
// Before, a query sheet ran the same SQL whatever the workbook held: to see
// another region, someone who could edit the sheet rewrote its query.
//
// Here: which variables a query has, how each is bound (always a literal,
// never SQL), the rows that come back on DuckDB, how a workbook's names
// become values (a date as its date), and that every read carries them.

import { readFileSync } from "node:fs";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { bindQuery, paramValue, queryVariables } from "@/lib/sheets/sql/queryParams";
import { buildTableRelation, pageSql, type TableConfig } from "@/lib/sheets/sql/tableQuery";
import { workbookParams } from "@/lib/sheets/workbookParams";

const src = (p: string) => readFileSync(p, "utf8");

describe("a query's variables", () => {
  it("are the {{names}} it uses, each once, quoted or not", () => {
    expect(
      queryVariables(
        "SELECT * FROM t WHERE region = {{Region}} AND day >= '{{ Start }}' OR region = {{region}}",
      ),
    ).toEqual(["Region", "Start"]);
    expect(queryVariables("SELECT 1")).toEqual([]);
  });
  it("are bound as literals: text quoted, numbers, TRUE, NULL", () => {
    const b = bindQuery("SELECT {{a}}, {{b}}, {{c}}, {{d}}", {
      a: "EMEA",
      b: 42,
      c: true,
      d: null,
    });
    expect(b).toEqual({ ok: true, sql: "SELECT 'EMEA', 42, TRUE, NULL" });
  });
  it("a text value is never SQL: its quotes are doubled", () => {
    const b = bindQuery("SELECT * FROM t WHERE region = {{r}}", { r: "x' OR '1'='1" });
    expect(b).toEqual({ ok: true, sql: "SELECT * FROM t WHERE region = 'x'' OR ''1''=''1'" });
  });
  it("Row Zero's '{{name}}' reads the same as {{name}}", () => {
    expect(bindQuery("WHERE d >= '{{Start}}'", { start: "2026-03-08" })).toEqual({
      ok: true,
      sql: "WHERE d >= '2026-03-08'",
    });
  });
  it("a name over several cells is a list, for IN", () => {
    expect(bindQuery("IN {{r}}", { r: ["EMEA", "APAC"] })).toEqual({
      ok: true,
      sql: "IN ('EMEA', 'APAC')",
    });
    expect(bindQuery("IN {{r}}", { r: [] })).toEqual({ ok: true, sql: "IN (NULL)" });
  });
  it("one with no value is refused, naming the name to define; blank makes it NULL", () => {
    const b = bindQuery("WHERE r = {{Region}}", {});
    expect(b.ok).toBe(false);
    expect(!b.ok && b.error).toMatch(/\{\{Region\}\} has no value: name a cell Region/);
    expect(bindQuery("WHERE r = {{Region}}", {}, { blank: true })).toEqual({
      ok: true,
      sql: "WHERE r = NULL",
    });
  });
  it("a value that isn't a number is no number: NaN and Infinity are NULL", () => {
    expect(bindQuery("SELECT {{n}}", { n: Number.NaN })).toEqual({ ok: true, sql: "SELECT NULL" });
  });
});

describe("a query sheet with variables, on DuckDB", () => {
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run("CREATE SCHEMA sales");
    await conn.run(`CREATE TABLE sales.orders AS SELECT * FROM (VALUES
      (1, 'EMEA', DATE '2026-03-01', 10.0), (2, 'APAC', DATE '2026-03-09', 20.0),
      (3, 'EMEA', DATE '2026-03-10', 30.0), (4, 'AMER', DATE '2026-03-12', 40.0))
      v(id, region, day, amount)`);
  });
  afterAll(() => conn?.closeSync());
  const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  const sheet = (sql: string): TableConfig => ({
    source: { kind: "query", sql },
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "region", type: "VARCHAR" },
      { name: "day", type: "DATE" },
      { name: "amount", type: "DOUBLE" },
    ],
    calculated: [],
    sort: [],
    filters: [],
    hidden: [],
    widths: {},
  });
  const ids = async (sql: string, params: Record<string, unknown>) => {
    const cfg = sheet(sql);
    const rel = buildTableRelation(cfg, { name: "Q", params: params as never });
    return (await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }))).map((r) => Number(r.id));
  };

  it("the value picks the rows", async () => {
    const q = "SELECT * FROM sales.orders WHERE region = {{Region}} ORDER BY id";
    expect(await ids(q, { Region: "EMEA" })).toEqual([1, 3]);
    expect(await ids(q, { Region: "AMER" })).toEqual([4]);
  });
  it("a value written to break out of its quotes matches nothing", async () => {
    const q = "SELECT * FROM sales.orders WHERE region = {{Region}} ORDER BY id";
    expect(await ids(q, { Region: "EMEA' OR '1'='1" })).toEqual([]);
  });
  it("a list for IN, and a date compared with a DATE column", async () => {
    expect(
      await ids("SELECT * FROM sales.orders WHERE region IN {{Regions}} ORDER BY id", {
        Regions: ["EMEA", "APAC"],
      }),
    ).toEqual([1, 2, 3]);
    expect(
      await ids("SELECT * FROM sales.orders WHERE day >= {{Start}} ORDER BY id", {
        Start: "2026-03-09",
      }),
    ).toEqual([2, 3, 4]);
  });
  it("a variable with no value stops the read with a reason, not an empty sheet", () => {
    expect(() =>
      buildTableRelation(sheet("SELECT * FROM sales.orders WHERE region = {{Region}}"), {
        name: "Q",
        params: {},
      }),
    ).toThrow(/\{\{Region\}\} has no value/);
  });
  it("a lookup into a query sheet binds its variables too", () => {
    const rel = buildTableRelation(
      {
        ...sheet("SELECT * FROM sales.orders"),
        calculated: [{ name: "r", formula: "=XLOOKUP([@id], Q2[id], Q2[region])" }],
      },
      {
        name: "Q",
        params: { Region: "EMEA" },
        others: (n) =>
          n.toLowerCase() === "q2"
            ? { name: "Q2", config: sheet("SELECT * FROM sales.orders WHERE region = {{Region}}") }
            : undefined,
      },
    );
    expect(rel.ctes.join("\n")).toMatch(/WHERE region = 'EMEA'/);
  });
});

describe("the workbook's names as values", () => {
  it("a cell, a date cell as its date, a range as a list; a broken name is left out", () => {
    const engine = new WorkbookEngine(
      [
        {
          id: "s",
          name: "Sheet1",
          grid: {
            cells: {
              "0,1": { i: "EMEA" },
              "1,1": { i: "46089", f: "yyyy-mm-dd" },
              "2,1": { i: "EMEA" },
              "3,1": { i: "APAC" },
              "4,1": { i: "12.5" },
            },
          },
        },
      ],
      undefined,
      {
        names: [
          { name: "Region", ref: "Sheet1!$B$1" },
          { name: "Start", ref: "Sheet1!$B$2" },
          { name: "Regions", ref: "Sheet1!$B$3:$B$5" },
          { name: "Rate", ref: "0.2" },
          { name: "Gone", ref: "#REF!" },
        ],
      },
    );
    const p = workbookParams(engine);
    expect(p.Region).toBe("EMEA");
    expect(p.Start).toBe("2026-03-08");
    expect(p.Regions).toEqual(["EMEA", "APAC", 12.5]);
    expect(p.Rate).toBe(0.2);
    expect("Gone" in p).toBe(false);
  });
  it("blanks are left out of a list, and an error is no value", () => {
    expect(
      paramValue([
        ["a", null],
        ["", "b"],
      ]),
    ).toEqual(["a", "b"]);
    expect(paramValue({ err: "#N/A" } as never)).toBeUndefined();
  });
});

describe("every read carries the values", () => {
  const fns = src("src/utils/sheetsTables.functions.ts");
  it("a page, a filter's values, a download and grid formulas bind them", () => {
    expect(fns.match(/params: queryParamsSchema\.optional\(\)/g)?.length).toBe(5);
    expect(fns.match(/params: data\.params,/g)?.length).toBeGreaterThanOrEqual(4);
    expect(fns).toMatch(
      /workbookTables\(\(n\) => others\.get\(n\.toLowerCase\(\)\), "w", data\.params\)/,
    );
    expect(fns).toMatch(/describeQuery\(caller\.userId, cfg\.source\.sql, data\.params\)/);
    expect(src("src/utils/sheetsPublish.functions.ts")).toMatch(/params: data\.params,/);
  });
  it("the preview binds them, a query's columns are read with them blank, a pivot too", () => {
    expect(fns).toMatch(/const bound = bindQuery\(q\.sql, data\.params\);/);
    expect(src("src/utils/sheets/shared.server.ts")).toMatch(
      /bindQuery\(t\.sql, params, \{ blank: true \}\)/,
    );
    expect(fns).toMatch(/blankParams: true,/);
  });
  it("the workbook sends them, and a change reads its query sheets again", () => {
    const hook = src("src/components/sheets/useWorkbook.ts");
    expect(hook).toMatch(/params: engine \? workbookParams\(engine\) : undefined,/);
    expect(hook).toMatch(
      /if \(!c\.source\.sql \|\| queryVariables\(c\.source\.sql\)\.length\) tableDataChanged\(t\.id\);/,
    );
    const sheet = src("src/components/sheets/TableSheet.tsx");
    expect(sheet).toMatch(/p: config\.source\.kind === "query" \? wb\.queryParamsKey : "",/);
    expect(sheet).toMatch(/params: wbRef\.current\.queryParams,/);
  });
});
