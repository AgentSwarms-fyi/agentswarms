// SUMMARIZE reads every row and column, so a reader's SUMMARIZE goes through
// the owner's policy like any SELECT.
//
// FOUND IN R224: the lakehouse names the tables a statement reads, to load
// the owners' policies for them, and named none for anything starting with
// DESCRIBE, SUMMARIZE or SHOW. For DESCRIBE and SHOW that is right: they
// return a shape, not rows. SUMMARIZE returns min, max, distinct counts and
// quartiles of every column, so a reader's `SUMMARIZE theirs.t` loaded no
// policy and ran over the rows the filter hides and the values the masks
// hide: a masked email column's min and max are two real addresses.
//
// Real DuckDB, in memory: the table walk the lakehouse uses, then the policy
// rewrite it hands those tables to, run, with what comes back read.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: async () => {} }));

const { selectReferencedTables } = await import("@/utils/lakehouse/core.server");
const { applyTablePolicies } = await import("@/utils/lakehouse/policies.server");
const { planSparkQuery } = await import("@/utils/lakehouse/sparkQuery.server");

let c: DuckDBConnection;
beforeAll(async () => {
  const db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
  await c.run(
    `CREATE SCHEMA sales;
     CREATE TABLE sales.orders AS SELECT * FROM (VALUES
       (1, 'EMEA', 'ana@example.com'), (2, 'AMER', 'bo@example.com'), (3, 'AMER', 'cy@example.com')
     ) t(id, region, email)`,
  );
});

const policy = new Map([
  [
    "sales.orders",
    {
      id: "p1",
      schema_name: "sales",
      table_name: "orders",
      row_filter: "region = 'EMEA'",
      masked_columns: ["email"],
      mask_style: "null" as const,
    },
  ],
]);
const reader = { id: "reader-2", email: null };

/** SUMMARIZE's row for one column: its min, max and count. */
async function summary(sql: string, column: string) {
  const rows = await (await c.run(sql)).getRowObjects();
  const row = rows.find((r) => r.column_name === column)!;
  return { min: row.min, max: row.max, count: Number(row.count) };
}

describe("the tables a statement reads", () => {
  it("include SUMMARIZE's, bare or over a query", async () => {
    const t = [{ schema: "sales", table: "orders" }];
    expect(await selectReferencedTables(c, "SUMMARIZE sales.orders")).toEqual(t);
    expect(await selectReferencedTables(c, "summarize SELECT * FROM sales.orders;")).toEqual(t);
    expect(await selectReferencedTables(c, "SELECT * FROM (SUMMARIZE sales.orders)")).toEqual(t);
  });

  it("are none for DESCRIBE and SHOW, which return a shape and no rows", async () => {
    expect(await selectReferencedTables(c, "DESCRIBE sales.orders")).toEqual([]);
    expect(await selectReferencedTables(c, "SHOW TABLES")).toEqual([]);
  });
});

describe("a reader's SUMMARIZE of a policed table", () => {
  it("unpoliced, it reports what the policy hides (what R224's reader got)", async () => {
    const email = await summary("SUMMARIZE sales.orders", "email");
    expect(email).toEqual({ min: "ana@example.com", max: "cy@example.com", count: 3 });
  });

  it("through the policy, it sees only the rows and values the reader may", async () => {
    const rewrite = await applyTablePolicies(c, "SUMMARIZE sales.orders", policy, reader);
    expect(rewrite?.applied).toEqual(["sales.orders"]);
    const email = await summary(rewrite!.sql, "email");
    expect(email.min).toBeNull();
    expect(email.max).toBeNull();
    const id = await summary(rewrite!.sql, "id");
    expect(id.count).toBe(1);
  });
});

describe("the lakehouse", () => {
  it("refuses a statement whose policy rewrite replaced nothing, rather than running it", () => {
    const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    expect(core).toMatch(
      /if \(!rewrite\) \{\s*throw new Error\(\s*"A security policy covers a table this statement reads, but it could not be applied — refused",?\s*\);\s*\}/,
    );
  });

  it("sends no SUMMARIZE to Spark, which has none", async () => {
    await expect(planSparkQuery("u1", "SUMMARIZE sales.orders")).rejects.toThrow(
      /Spark SQL has no such statement/,
    );
  });
});
