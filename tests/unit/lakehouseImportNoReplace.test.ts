// "New table → Import dataset" onto the name of a table that already exists.
//
// FOUND IN R102, one door along from R101. The import built with CREATE OR
// REPLACE TABLE. Driven: `analytics.r101_keep2`, holding `7 | still precious`
// → the schema's "New table" (+) → Import dataset → f1_constructor_standings
// → Table name `r101_keep2` → Import. The toasts read "Imported 10 row(s)"
// and "Table analytics.r101_keep2 ready", and the table read back as
// `wins · points · position · constructor · nationality`. The other half of
// the same dialog, Define columns, refuses an existing name.
//
// The import is a server function that drags in the whole lakehouse module,
// so it is pinned by source, as in mcpStartHonesty.test.ts. The refusal's
// behaviour (and the view path sharing the same check) is executed in
// matviewOverwrite.test.ts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lakehouseTableExists } from "@/utils/lakehouse/core.server";

const FNS = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
const CORE = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");

/** The import handler, from its export to the next export. */
const IMPORT = (() => {
  const start = FNS.indexOf("export const importDatasetToLakehouse");
  if (start < 0)
    throw new Error("importDatasetToLakehouse not found: did the module change shape?");
  const rest = FNS.slice(start + 10);
  const end = rest.indexOf("\nexport ");
  return FNS.slice(start, start + 10 + (end < 0 ? rest.length : end));
})();

describe("a new table is new", () => {
  it("asks whether the name is taken", () => {
    expect(IMPORT).toMatch(/if \(await lakehouseTableExists\(data\.schema, data\.table\)\) \{/);
  });

  it("refuses with the name, why, and the way out", () => {
    expect(IMPORT).toMatch(/already exists\. Importing would replace its rows with/);
    expect(IMPORT).toMatch(/Pick a new name, or drop the table first/);
  });

  it("asks before paging a single row out of the store", () => {
    const asked = IMPORT.indexOf("await lakehouseTableExists(");
    const paged = IMPORT.indexOf("await selectAllPages");
    expect(asked).toBeGreaterThan(-1);
    expect(paged).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(paged);
  });

  it("writes with CREATE TABLE, so a race cannot replace a table either", () => {
    expect(IMPORT).toMatch(/`CREATE TABLE \$\{qi\(data\.schema\)\}\.\$\{qi\(data\.table\)\} AS `/);
    expect(IMPORT).not.toMatch(/CREATE OR REPLACE TABLE \$\{/);
  });
});

describe("the import says what the page says about mounts", () => {
  it("refuses a data-lake mount or an Iceberg schema", () => {
    expect(IMPORT).toMatch(
      /if \(target\.lake_source_id \|\| target\.iceberg_catalog_id\) \{\s*throw new Error\("Data-lake mounts are read-only"\);/,
    );
  });
});

describe("one check, shared", () => {
  it("lives in core.server and is what both writers call", () => {
    expect(CORE).toContain("export async function lakehouseTableExists(");
    const mv = readFileSync("src/utils/lakehouse/matviews.server.ts", "utf8");
    expect(mv).toMatch(/await lakehouseTableExists\(input\.schema, input\.table\)/);
    expect(mv).not.toMatch(/async function lakehouseTableExists/);
  });
});

describe("the check itself, run against a fake engine", () => {
  const fake = (count: number) => {
    const seen = { sql: [] as string[], closed: 0 };
    const connect = async () =>
      ({
        run: async (sql: string) => {
          seen.sql.push(sql);
          return { getRows: async () => [[count]] };
        },
        closeSync: () => {
          seen.closed++;
        },
      }) as never;
    return { connect, seen };
  };

  it("says taken when the catalog has the table", async () => {
    const { connect } = fake(1);
    expect(await lakehouseTableExists("analytics", "r101_keep2", connect)).toBe(true);
  });

  it("says free when it does not", async () => {
    const { connect } = fake(0);
    expect(await lakehouseTableExists("analytics", "r101_new", connect)).toBe(false);
  });

  it("asks without case, in the lake catalog, and lets the connection go", async () => {
    const { connect, seen } = fake(0);
    await lakehouseTableExists("Analytics", "Orders", connect);
    expect(seen.sql[0]).toMatch(/table_catalog = 'lake'/);
    expect(seen.sql[0]).toMatch(/lower\(table_schema\) = lower\('Analytics'\)/);
    expect(seen.sql[0]).toMatch(/lower\(table_name\) = lower\('Orders'\)/);
    expect(seen.closed).toBe(1);
  });

  it("quotes a name rather than running it", async () => {
    const { connect, seen } = fake(0);
    await lakehouseTableExists("analytics", "x' OR '1'='1", connect);
    expect(seen.sql[0]).toContain("lower('x'' OR ''1''=''1')");
  });
});
