// "Save as view" on the name of a table that was never a view.
//
// FOUND IN R101. A materialized view is built with CREATE OR REPLACE TABLE,
// and saving one asked nothing about what was already at its name. Driven:
// Lakehouse → `CREATE TABLE analytics.r101_keep AS SELECT 1 AS id, 'precious
// row' AS note` → read back `1 | precious row`; then `SELECT 42 AS answer` →
// Save as view → analytics / r101_keep / Manual → Save and build. The toast
// read "Built analytics.r101_keep — 1 row(s)", and the table read back as
// `answer | 42`. The row and both of its columns were gone, with no question
// asked. Data Prep's "save to lakehouse" goes through the same function.
//
// Run here against a fake catalog and a fake engine, so the test sees every
// statement that would have reached the lakehouse.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  viewRow: null as { id: string } | null,
  viewErr: null as { message: string } | null,
  tableExists: false,
  statements: [] as string[],
  upserts: 0,
};

// Which tables Sheets holds has its own suite (lakehouseSheetGuard.test.ts);
// here none is.
vi.mock("@/utils/sheets/owned.server", () => ({ sheetOwnedRefusal: async () => null }));

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: state.viewRow, error: state.viewErr }),
      upsert: () => {
        state.upserts++;
        return {
          select: () => ({
            single: async () => ({
              data: {
                id: "view-1",
                user_id: "owner",
                schema_name: "analytics",
                table_name: "r101_keep",
                sql: "SELECT 42 AS answer",
                schedule: "manual",
              },
              error: null,
            }),
          }),
        };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
      table,
    };
    return b;
  };
  return { supabaseAdmin: { from: (t: string) => chain(t) } };
});

vi.mock("@/utils/lakehouse/core.server", () => ({
  accessibleSchemas: async () => [
    { name: "analytics", user_id: "owner", lake_source_id: null, iceberg_catalog_id: null },
  ],
  assertSchemasAllowed: () => {},
  classifyStatement: () => ({ kind: "select" }),
  lakehouseEnabled: () => true,
  // Since R102 the check lives in core.server, shared with the dataset
  // import; the fake answers from the test's state and records the ask.
  lakehouseTableExists: async (schema: string, table: string) => {
    state.statements.push(`EXISTS? ${schema}.${table}`);
    return state.tableExists;
  },
  selectReferencedSchemas: async () => [],
  stripSqlComments: (s: string) => s,
  lakehouseConnection: async () => ({
    run: async (sql: string) => {
      state.statements.push(sql);
      const n = sql.includes("information_schema.tables") ? (state.tableExists ? 1 : 0) : 1;
      return { getRows: async () => [[n]] };
    },
    closeSync: () => {},
  }),
}));

const { saveMatviewForUser } = await import("@/utils/lakehouse/matviews.server");

const INPUT = {
  schema: "analytics",
  table: "r101_keep",
  sql: "SELECT 42 AS answer",
  schedule: "manual" as const,
};

const replaced = () => state.statements.some((s) => s.startsWith("CREATE OR REPLACE TABLE"));

beforeEach(() => {
  state.viewRow = null;
  state.viewErr = null;
  state.tableExists = false;
  state.statements = [];
  state.upserts = 0;
});

describe("a table that was never a view is not replaced", () => {
  it("refuses, naming the table and why", async () => {
    // The whole bug: this built, and the table's rows were gone.
    state.tableExists = true;
    await expect(saveMatviewForUser("owner", INPUT, "save")).rejects.toThrow(
      /analytics\.r101_keep is an existing table, not a materialized view/,
    );
  });

  it("sends nothing that could replace it, and records no view", async () => {
    state.tableExists = true;
    await saveMatviewForUser("owner", INPUT, "save").catch(() => {});
    expect(replaced()).toBe(false);
    expect(state.upserts).toBe(0);
  });

  it("asks the catalog about the exact target before writing", async () => {
    state.tableExists = true;
    await saveMatviewForUser("owner", INPUT, "save").catch(() => {});
    expect(state.statements).toEqual(["EXISTS? analytics.r101_keep"]);
  });

  it("and the catalog is asked without case, as DuckDB resolves the name", () => {
    const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    const fn = core.slice(core.indexOf("export async function lakehouseTableExists("));
    expect(fn.slice(0, 900)).toMatch(/lower\(table_name\) = lower\(\$\{sq\(table\)\}\)/);
    expect(fn.slice(0, 900)).toMatch(/lower\(table_schema\) = lower\(\$\{sq\(schema\)\}\)/);
  });

  it("refuses when it cannot tell whether the name is a view", async () => {
    state.viewErr = { message: "connection reset" };
    await expect(saveMatviewForUser("owner", INPUT, "save")).rejects.toThrow(
      /Could not check whether analytics\.r101_keep is a view: connection reset/,
    );
    expect(replaced()).toBe(false);
  });
});

describe("what a view is for still works", () => {
  it("builds a new view at a free name", async () => {
    const res = await saveMatviewForUser("owner", INPUT, "save");
    expect(res.error).toBeUndefined();
    expect(replaced()).toBe(true);
    expect(state.upserts).toBe(1);
  });

  it("redefines a view that is already a view, even though its table exists", async () => {
    state.viewRow = { id: "view-1" };
    state.tableExists = true;
    const res = await saveMatviewForUser("owner", INPUT, "save");
    expect(res.error).toBeUndefined();
    expect(replaced()).toBe(true);
  });
});
