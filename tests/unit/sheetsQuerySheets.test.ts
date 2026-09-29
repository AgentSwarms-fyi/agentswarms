// Query sheets (R154): Row Zero's connected table, for the lakehouse. A table
// sheet's rows can be a SELECT the person writes, run whenever the sheet is
// read, as whoever reads it. Before, a sheet could only open a table that
// already existed; a join, a filter or a total had to be saved as a table
// first (or as a scheduled materialized view) to be seen in a sheet at all.
//
// Here: what a query may be, how it runs under the sheet's own SELECT (on
// DuckDB), that a read never runs SQL sent with it, that a viewer's copy
// carries none, and that every path that reads or saves a sheet asks.

import { readFileSync } from "node:fs";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildTableRelation,
  checkSheetQuery,
  lakehouseInputs,
  pageSql,
  TableQueryError,
  valuesSql,
  type TableConfig,
} from "@/lib/sheets/sql/tableQuery";
import { tableConfigSchema } from "@/utils/sheets/schemas";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
// The lakehouse, for describeQuery: the columns it answers with, and what it was asked.
const lake = vi.hoisted(() => ({
  columns: [] as { name: string; type: string }[],
  asked: [] as string[],
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  runLakehouseStatement: async (_user: string, sql: string) => {
    lake.asked.push(sql);
    return { columns: lake.columns, rows: [] };
  },
}));
const access = await import("@/utils/sheets/access.server");

const src = (p: string) => readFileSync(p, "utf8");

const query = (sql: string): TableConfig => ({
  source: { kind: "query", sql },
  columns: [
    { name: "region", type: "VARCHAR" },
    { name: "revenue", type: "DOUBLE" },
  ],
  calculated: [],
  sort: [],
  filters: [],
  hidden: [],
  widths: {},
  origin: { kind: "lakehouse" },
});

describe("what a query may be", () => {
  it("one SELECT or WITH, trailing semicolons trimmed", () => {
    expect(checkSheetQuery("SELECT 1;;")).toEqual({ ok: true, sql: "SELECT 1" });
    expect(checkSheetQuery("WITH a AS (SELECT 1 AS x) SELECT x FROM a").ok).toBe(true);
    expect(checkSheetQuery("select * from sales.orders -- the lot").ok).toBe(true);
  });
  it("nothing that writes, and no second statement", () => {
    for (const bad of [
      "INSERT INTO sales.orders VALUES (1)",
      "CREATE TABLE x AS SELECT 1",
      "SELECT 1; DROP TABLE sales.orders",
      "COPY (SELECT 1) TO 'out.csv'",
      "ATTACH 'x.db'",
      "WITH d AS (DELETE FROM sales.orders RETURNING *) SELECT * FROM d",
      "",
    ]) {
      expect(checkSheetQuery(bad).ok, bad).toBe(false);
    }
  });
  it("its parentheses match, so it can't close the sheet's own ( … ) and splice in beside it", () => {
    expect(checkSheetQuery("SELECT 1) AS a, (SELECT 2").ok).toBe(false);
    expect(checkSheetQuery("SELECT (1").ok).toBe(false);
    // A parenthesis in a string or a comment is not one.
    expect(checkSheetQuery("SELECT ')' AS p -- (").ok).toBe(true);
  });
  it("at most 20,000 characters, as the saved settings allow", () => {
    expect(checkSheetQuery(`SELECT 1 ${" ".repeat(20_000)}`).ok).toBe(false);
    expect(tableConfigSchema.safeParse(query("SELECT 1")).success).toBe(true);
    expect(tableConfigSchema.safeParse(query(`SELECT '${"x".repeat(20_001)}'`)).success).toBe(
      false,
    );
  });
});

describe("a query sheet on DuckDB", () => {
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run("CREATE SCHEMA sales");
    await conn.run(`CREATE TABLE sales.orders AS SELECT * FROM (VALUES
      (1, 'West', 10.0), (2, 'East', 20.0), (3, 'West', 30.0), (4, 'North', 40.0))
      v(id, region, amount)`);
  });
  afterAll(() => conn?.closeSync());
  const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  const TOTALS =
    "SELECT region, sum(amount) AS revenue FROM sales.orders GROUP BY region ORDER BY region";

  it("its rows are what the query returns, paged and counted like any table sheet", async () => {
    const cfg = query(TOTALS);
    const rel = buildTableRelation(cfg, { name: "Revenue" });
    const got = await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }));
    expect(got.map((r) => [r.region, Number(r.revenue)])).toEqual([
      ["East", 20],
      ["North", 40],
      ["West", 40],
    ]);
    expect(Number(got[0].__total)).toBe(3);
  });
  it("a comment at its end does not swallow the sheet's own SQL", async () => {
    const cfg = query(`${TOTALS} -- by region`);
    const rel = buildTableRelation(cfg, { name: "Revenue" });
    expect((await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }))).length).toBe(3);
  });
  it("its calculated columns, filters and sort work over it", async () => {
    const cfg: TableConfig = {
      ...query(TOTALS),
      calculated: [{ name: "share", formula: "=[@revenue]/SUM([revenue])" }],
      filters: [{ column: "revenue", op: "ge", value: "40" }],
      sort: [{ column: "region", desc: true }],
    };
    const rel = buildTableRelation(cfg, { name: "Revenue" });
    const got = await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }));
    expect(got.map((r) => [r.region, Number(r.share).toFixed(2)])).toEqual([
      ["West", "0.40"],
      ["North", "0.40"],
    ]);
  });
  it("a viewer's share keeps its rows at the query's edge, in a filter's list too", async () => {
    const viewer: Parameters<typeof access.restrictedConfig>[0] = {
      role: "viewer",
      workbookId: "w",
      ownerId: "o",
      hidden: new Set(),
      filters: new Map([["revenue", [{ column: "region", values: ["West"] }]]]),
      viewingAs: null,
    };
    const cfg = access.restrictedConfig(viewer, "Revenue", query(TOTALS));
    const rel = buildTableRelation(cfg, { name: "Revenue" });
    expect((await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }))).map((r) => r.region)).toEqual(
      ["West"],
    );
    expect((await rows(valuesSql(rel, cfg, "region", 10))).map((r) => r.v)).toEqual(["West"]);
  });
  it("a query that stored bad SQL somehow is refused where it runs", () => {
    expect(() =>
      buildTableRelation(query("DELETE FROM sales.orders"), { name: "Revenue" }),
    ).toThrow(TableQueryError);
  });
  it("its lineage is the tables it reads, not its CTEs", () => {
    const cfg = query(
      "WITH w AS (SELECT * FROM sales.orders WHERE region = 'West') SELECT * FROM w JOIN sales.customers c ON c.id = w.id",
    );
    expect(lakehouseInputs(cfg, () => undefined).sort()).toEqual([
      "sales.customers",
      "sales.orders",
    ]);
  });
});

describe("the SQL a read runs is the one saved with the sheet", () => {
  const stored = query("SELECT region, revenue FROM sales.totals");
  it("a read that sends other SQL runs the saved query", () => {
    const sent = query("SELECT * FROM hr.salaries");
    expect(access.savedSource(stored, sent).source).toEqual(stored.source);
  });
  it("a sheet over a table is not turned into a query by a read", () => {
    const table: TableConfig = {
      ...stored,
      source: { kind: "lakehouse", schema: "s", table: "t" },
    };
    expect(access.savedSource(table, query("SELECT * FROM hr.salaries")).source).toEqual(
      table.source,
    );
  });
  it("settings that can't be read run no query at all", () => {
    expect(access.savedSource({ junk: true }, query("SELECT 1")).source).toEqual({
      kind: "query",
      sql: "",
    });
  });
  it("the browser's sort and filters still show at once", () => {
    const sent = { ...query("SELECT 1"), sort: [{ column: "region", desc: true }] };
    expect(access.savedSource(stored, sent).sort).toEqual(sent.sort);
  });
  it("a viewer's copy of the sheet carries no SQL", () => {
    expect(access.viewerConfig(stored).source).toEqual({ kind: "query", sql: "" });
  });
  it("every read and the save-as pass the stored sheet in", () => {
    const fns = src("src/utils/sheetsTables.functions.ts");
    // A page, a filter's value list and a download; nothing else takes settings from a read.
    expect(fns.match(/restrictedConfig\(/g)?.length).toBe(3);
    expect(
      fns.match(
        /restrictedConfig\(\s*access,\s*tab\.name,\s*data\.config as TableConfig,\s*tab\.table_config,?\s*\)/g,
      )?.length,
    ).toBe(3);
    expect(src("src/utils/sheetsPublish.functions.ts")).toMatch(
      /const cfg = savedSource\(tab\.table_config, data\.config as TableConfig\);/,
    );
  });
});

describe("making and changing a query sheet", () => {
  const fns = src("src/utils/sheetsTables.functions.ts");
  const shared = src("src/utils/sheets/shared.server.ts");
  it("is for the owner and editors, runs the query as them first, and is audited", () => {
    const add = fns.slice(
      fns.indexOf("export const sheetsAddQueryTab"),
      fns.indexOf("export const sheetsSetTableQuery"),
    );
    expect(add).toMatch(/requireAccess\(caller\.userId, data\.workbook_id, "edit"\)/);
    expect(add).toMatch(/columns = await describeQuery\(caller\.userId, q\.sql\)/);
    expect(add).toMatch(/source: \{ kind: "query", sql: q\.sql \}/);
    expect(add).toMatch(/action: "sheets\.query\.create"/);
  });
  it("a change keeps to a query sheet, saves the editor's settings with it, and is versioned", () => {
    const set = fns.slice(fns.indexOf("export const sheetsSetTableQuery"));
    expect(set).toMatch(/stored\.data\.source\.kind !== "query"/);
    expect(set).toMatch(/origin: stored\.data\.origin/);
    expect(set).toMatch(/\.eq\("version", data\.base_version\)/);
    expect(set).toMatch(/action: "sheets\.query\.update"/);
  });
  it("a query's columns each need a name of their own, and none may be __row", async () => {
    const { describeQuery } = await import("@/utils/sheets/shared.server");
    lake.columns = [
      { name: "id", type: "INTEGER" },
      { name: "ID", type: "INTEGER" },
    ];
    await expect(describeQuery("u", "SELECT 1")).rejects.toThrow(/Two columns are named "ID"/);
    lake.columns = [{ name: "__row", type: "BIGINT" }];
    await expect(describeQuery("u", "SELECT 1")).rejects.toThrow(/can't be named __row/);
    lake.columns = [];
    await expect(describeQuery("u", "SELECT 1")).rejects.toThrow(/returns no columns/);
    lake.columns = [{ name: "region", type: "VARCHAR" }];
    await expect(describeQuery("u", "SELECT 1")).resolves.toEqual(lake.columns);
    // Refused before the lakehouse is asked.
    await expect(describeQuery("u", "DROP TABLE sales.orders")).rejects.toThrow(/read-only/);
    expect(lake.asked.every((sql) => sql.startsWith("SELECT * FROM (SELECT 1\n) AS __query"))).toBe(
      true,
    );
    expect(shared).toMatch(
      /runLakehouseStatement\(userId, `SELECT \* FROM \(\$\{q\.sql\}\\n\) AS __query LIMIT 0`/,
    );
  });
  it("the dialog offers a lakehouse query, and the sheet an Edit query to its editors", () => {
    const dlg = src("src/components/sheets/OpenTableDialog.tsx");
    expect(dlg).toMatch(/\{ id: "query", label: "Lakehouse query", icon: Code2 \}/);
    expect(dlg).toMatch(/r = await addQueryFn\(/);
    const sheet = src("src/components/sheets/TableSheet.tsx");
    expect(sheet).toMatch(/config\.source\.kind === "query" && !wb\.readOnly && \(/);
  });
});
