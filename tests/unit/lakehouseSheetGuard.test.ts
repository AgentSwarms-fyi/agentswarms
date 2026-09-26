// Tables a Sheets workbook holds its rows in (a file uploaded into a table
// sheet, rows imported from a connection) are changed only by Sheets. The
// Lakehouse reads them like any table and refuses to change them: Sheets
// replaces such a table when the import is refreshed, and the sheet's
// calculated columns, pivots and formulas stand on its columns.
//
// And R126: a three-part name (`lake.schema.table`) was read as schema
// "lake", table "schema", so every check keyed on the schema (read-only
// mounts, other people's schemas, policies, this guard) could be walked past
// by anyone who owned a schema called "lake".
//
// And R127: a sheet's settings were stored as the browser sent them, origin
// included, so a sheet could claim anyone's table and the guard then refused
// that table's owner. A claim now counts only in a schema the sheet's owner
// owns, and a save keeps the stored source and origin.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyStatement } from "@/utils/lakehouse/core.server";
import { tableRefs } from "@/utils/lakehouse/sqlRefs";

// ── The owner lookup, against an in-memory stand-in for sheet_tabs ──

type Row = Record<string, unknown>;
const db: {
  sheet_tabs: Row[];
  lakehouse_schemas: Row[];
  fail: string | null;
  failSchemas: string | null;
} = { sheet_tabs: [], lakehouse_schemas: [], fail: null, failSchemas: null };
const pathOf = (row: Row, path: string): unknown => {
  // "table_config->origin->>kind"
  const [col, ...keys] = path.split(/->>?/);
  let v: unknown = row[col];
  for (const k of keys) v = v && typeof v === "object" ? (v as Row)[k] : undefined;
  return v;
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (name: "sheet_tabs" | "lakehouse_schemas") => {
      const filters: ((r: Row) => boolean)[] = [];
      const fail = name === "sheet_tabs" ? db.fail : db.failSchemas;
      const b = {
        select: () => b,
        eq: (p: string, v: unknown) => (filters.push((r) => pathOf(r, p) === v), b),
        in: (p: string, vs: unknown[]) => (filters.push((r) => vs.includes(pathOf(r, p))), b),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            fail
              ? { data: null, error: { message: fail } }
              : { data: db[name].filter((r) => filters.every((f) => f(r))), error: null },
          ).then(res),
      };
      return b;
    },
  },
}));

const { sheetOwnedRefusal, sheetOwners, sheetOwnedInSchema } =
  await import("@/utils/sheets/owned.server");

const tab = (name: string, origin: string, schema: string, table: string, user_id = "u-ana") => ({
  name,
  kind: "table",
  user_id,
  workbook_id: `wb-${name}`,
  table_config: { source: { kind: "lakehouse", schema, table }, origin: { kind: origin } },
  sheet_workbooks: { name: "Q1 orders" },
});

beforeEach(() => {
  db.fail = null;
  db.failSchemas = null;
  db.lakehouse_schemas = [
    { name: "analytics", user_id: "u-ana" },
    { name: "finance", user_id: "u-fin" },
  ];
  db.sheet_tabs = [
    tab("Uploaded", "upload", "analytics", "orders_jan"),
    tab("Imported", "warehouse", "analytics", "crm_accounts"),
    // Opened over a table the lakehouse already had: the lakehouse's, not the sheet's.
    tab("Opened", "lakehouse", "analytics", "bi_demo_sales"),
    tab("From the catalog", "catalog", "analytics", "revenue_v2"),
  ];
});

describe("which tables Sheets holds", () => {
  it("the ones a sheet uploaded or imported into, not the ones it only opened", async () => {
    const owners = await sheetOwners([
      { schema: "analytics", table: "orders_jan" },
      { schema: "Analytics", table: "CRM_ACCOUNTS" },
      { schema: "analytics", table: "bi_demo_sales" },
      { schema: "analytics", table: "revenue_v2" },
    ]);
    expect([...owners.keys()].sort()).toEqual(["analytics.crm_accounts", "analytics.orders_jan"]);
    expect(owners.get("analytics.orders_jan")).toEqual({
      workbookId: "wb-Uploaded",
      workbook: "Q1 orders",
      sheet: "Uploaded",
    });
  });

  it("a write to one is refused with the sheet it belongs to and a way on", async () => {
    const why = await sheetOwnedRefusal([{ schema: "analytics", table: "orders_jan" }]);
    expect(why).toContain('sheet "Uploaded" in the Sheets workbook "Q1 orders"');
    expect(why).toContain(
      "CREATE TABLE analytics.orders_jan_copy AS SELECT * FROM analytics.orders_jan",
    );
    expect(await sheetOwnedRefusal([{ schema: "analytics", table: "bi_demo_sales" }])).toBeNull();
    expect(await sheetOwnedRefusal([])).toBeNull();
  });

  it("delete the sheet and the table is an ordinary lakehouse table again", async () => {
    db.sheet_tabs = db.sheet_tabs.filter((t) => t.name !== "Uploaded");
    expect(await sheetOwnedRefusal([{ schema: "analytics", table: "orders_jan" }])).toBeNull();
  });

  it("when the sheets cannot be read, the write is refused rather than let through", async () => {
    db.fail = "connection reset";
    await expect(sheetOwnedRefusal([{ schema: "analytics", table: "anything" }])).rejects.toThrow(
      /Could not check which tables Sheets owns: connection reset/,
    );
    await expect(sheetOwnedInSchema("analytics")).rejects.toThrow(/connection reset/);
  });

  it("a claim on a table in someone else's schema holds nothing (R127)", async () => {
    // Ana's sheet says it uploaded Fin's ledger: a forged save, or a copy.
    db.sheet_tabs.push(tab("Forged", "upload", "finance", "ledger", "u-ana"));
    expect(await sheetOwnedRefusal([{ schema: "finance", table: "ledger" }])).toBeNull();
    expect(await sheetOwnedInSchema("finance")).toEqual([]);
    // Fin's own upload into Fin's schema is held as before.
    db.sheet_tabs.push(tab("Ledger", "upload", "finance", "ledger", "u-fin"));
    expect(await sheetOwnedRefusal([{ schema: "finance", table: "ledger" }])).toContain(
      'sheet "Ledger"',
    );
    // A schema no one owns any more (dropped, or never a schema) holds nothing.
    db.sheet_tabs.push(tab("Orphan", "upload", "gone", "t", "u-ana"));
    expect(await sheetOwnedRefusal([{ schema: "gone", table: "t" }])).toBeNull();
  });

  it("when the schemas' owners cannot be read, the write is refused too", async () => {
    db.failSchemas = "timeout";
    await expect(sheetOwnedRefusal([{ schema: "analytics", table: "x" }])).rejects.toThrow(
      /Could not check which tables Sheets owns: timeout/,
    );
  });

  it("a schema holding any of them is named with them", async () => {
    const held = await sheetOwnedInSchema("ANALYTICS");
    expect(held.map((h) => h.table).sort()).toEqual(["crm_accounts", "orders_jan"]);
    expect(await sheetOwnedInSchema("sales")).toEqual([]);
  });
});

// ── Where the guard is asked ──

/** Source with comments removed, for asserting what the code does. */
const code = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

describe("every way the lakehouse writes a table asks first", () => {
  it("statements run through the lakehouse (the SQL editor, Drop, Insert row, workflow SQL)", () => {
    const core = code("src/utils/lakehouse/core.server.ts");
    const a = core.indexOf('if (classified.kind !== "select")');
    const b = core.indexOf("for (let attempt", a);
    const branch = core.slice(a, b);
    expect(branch).toContain("sheetOwnedRefusal(targets)");
    expect(branch).toMatch(/if \(why\) throw new Error\(why\);/);
    // The targets are what the classifier says the statement writes.
    expect(branch).toMatch(
      /classified\.writeSchemas\s*\.map\(\(schema, i\) => \(\{ schema, table: classified\.writeTables\?\.\[i\]/,
    );
  });

  it("dropping a schema, which drops every table in it", () => {
    const f = code("src/utils/lakehouse.functions.ts");
    const fn = f.slice(f.indexOf("export const dropLakehouseSchema"));
    const guard = fn.indexOf("sheetOwnedInSchema(data.name)");
    const drop = fn.indexOf("DROP SCHEMA IF EXISTS");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(drop);
    // Any held table stops it: the refusal is thrown, before the drop.
    expect(fn.slice(guard, drop)).toMatch(/if \(held\.length\) \{[\s\S]*?throw new Error\(/);
  });

  it("an ETL pipeline's lakehouse targets, before the run starts", () => {
    const f = code("src/utils/etl/service.server.ts");
    expect(f).toMatch(/lakehouseNodes\s*\.filter\(\(n\) => n\.kind === "target"\)/);
    expect(f).toMatch(
      /const why = await sheetOwnedRefusal\(sheetTargets\);\s*if \(why\) throw new Error\(why\);/,
    );
  });

  it("an Iceberg import into an existing table", () => {
    const f = code("src/utils/icebergCatalogs.functions.ts");
    const guard = f.indexOf("{ schema: data.target_schema, table: data.target_table }");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(f.indexOf("importFromIceberg({"));
  });

  it("a materialized view's refresh and a SQL model's build, which write whatever holds their name (R128)", () => {
    const mv = code("src/utils/lakehouse/matviews.server.ts");
    const refresh = mv.slice(mv.indexOf("export async function refreshMaterializedView"));
    const g1 = refresh.indexOf(
      "sheetOwnedRefusal([{ schema: view.schema_name, table: view.table_name }])",
    );
    expect(g1).toBeGreaterThan(-1);
    expect(g1).toBeLessThan(refresh.indexOf("CREATE OR REPLACE TABLE"));
    expect(refresh.slice(g1)).toMatch(/^[^;]*;\s*if \(held\) throw new Error\(held\);/);

    const run = code("src/utils/sqlModels/run.server.ts");
    const g2 = run.indexOf("sheetOwnedRefusal([{ schema: model.schema_name, table: model.name }])");
    expect(g2).toBeGreaterThan(-1);
    // Before the DROP of the other shape, which would take the table outright.
    expect(g2).toBeLessThan(run.indexOf("DROP ${kind"));
    expect(run.slice(g2)).toMatch(/^[^;]*;\s*if \(held\) return fail\(held\);/);

    // Batch scoring writes CREATE OR REPLACE TABLE <output> from the sandbox,
    // and allows a name an earlier prediction wrote (a daily schedule).
    const ml = code("src/utils/ml/api.server.ts");
    const start = ml.slice(ml.indexOf("export async function startBatchPrediction"));
    const g3 = start.indexOf("sheetOwnedRefusal([args.output])");
    expect(g3).toBeGreaterThan(-1);
    expect(g3).toBeLessThan(start.indexOf("lakehouseTableExists(args.output.schema"));
    // Refused when held, and refused when the check itself fails.
    expect(start.slice(g3)).toMatch(
      /^[^;]*;\s*if \(held\) return \{ ok: false, error: held \};\s*\} catch \(e\) \{\s*return \{ ok: false, error: \(e as Error\)\.message \};/,
    );
  });

  it("a sheet's settings save keeps where its rows come from (R127)", () => {
    const f = code("src/utils/sheetsTables.functions.ts");
    const fn = f.slice(
      f.indexOf("export const sheetsSaveTableConfig"),
      f.indexOf("export const", f.indexOf("export const sheetsSaveTableConfig") + 10),
    );
    expect(fn).toMatch(/const kept = tableConfigSchema\.safeParse\(stored\.table_config\)/);
    expect(fn).toMatch(
      /const config: TableConfig = \{\s*\.\.\.data\.config,\s*source: kept\.data\.source,\s*origin: kept\.data\.origin,\s*\}/,
    );
    // What is written is that, not what the browser sent.
    expect(fn).toMatch(/\.update\(\{ table_config: config as unknown as Json/);
    expect(fn).not.toMatch(/table_config: data\.config/);
  });

  it("the table's page says who holds it and offers no Drop or Insert row", () => {
    const page = readFileSync("src/routes/_authenticated/lakehouse.tsx", "utf8");
    expect(page).toContain('data-testid="sheet-owner"');
    expect(page).toMatch(/\{detail\.sheet_owner \? \([\s\S]{0,1200}\) : \(\s*<InsertRowDialog/);
    expect(page).toMatch(/\{!detail\.sheet_owner && \(\s*<Button[\s\S]{0,400}Drop table/);
  });
});

// ── R126: three-part names ──

describe("a name with a catalog in front of it", () => {
  it("in the lakehouse's catalog, names the schema and table after it", () => {
    for (const sql of [
      "CREATE TABLE lake.ice_sales.probe AS SELECT 1 AS x",
      'CREATE TABLE "lake"."ice_sales"."probe" AS SELECT 1 AS x',
      "CREATE TABLE LAKE.ice_sales.probe AS SELECT 1 AS x",
      "CREATE TABLE lake . ice_sales . probe AS SELECT 1",
    ]) {
      if (sql.includes("lake . ")) {
        // Spaced out, it is not read as a name at all: refused, not misread.
        expect(() => classifyStatement(sql)).toThrow(/schema-qualified/);
        continue;
      }
      const c = classifyStatement(sql);
      expect(c.writeSchemas, sql).toEqual(["ice_sales"]);
      expect(c.writeTables, sql).toEqual(["probe"]);
    }
    expect(
      classifyStatement("UPDATE lake.analytics.orders_jan SET note = note").writeSchemas,
    ).toEqual(["analytics"]);
    expect(classifyStatement("DROP TABLE lake.analytics.orders_jan").writeTables).toEqual([
      "orders_jan",
    ]);
  });

  it("in any other catalog, is refused", () => {
    expect(() => classifyStatement("DROP TABLE memory.main.t")).toThrow(/not the lakehouse/);
    expect(() => classifyStatement("INSERT INTO system.main.t VALUES (1)")).toThrow(
      /not the lakehouse/,
    );
  });

  it("two parts still mean schema.table", () => {
    const c = classifyStatement("CREATE TABLE analytics.t AS SELECT 1");
    expect([c.writeSchemas, c.writeTables]).toEqual([["analytics"], ["t"]]);
  });

  it("what a write reads: the schema after the lakehouse's catalog, or a name no schema has", () => {
    expect(tableRefs("INSERT INTO mine.t SELECT * FROM lake.theirs.secret")).toContainEqual({
      schema: "theirs",
      table: "secret",
    });
    expect(tableRefs("INSERT INTO mine.t SELECT * FROM memory.main.x")).toContainEqual({
      schema: "memory.main",
      table: "x",
    });
    expect(tableRefs("INSERT INTO mine.t SELECT * FROM theirs.secret")).toContainEqual({
      schema: "theirs",
      table: "secret",
    });
  });
});
