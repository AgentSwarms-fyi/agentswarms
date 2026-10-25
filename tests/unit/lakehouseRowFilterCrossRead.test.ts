// A lakehouse row filter may only test its own table's columns — never read
// another schema (VA-2026-10-25-01, security assessment 2026-10-25).
//
// A row filter is pasted into `WHERE (…)` of the subquery that stands in for a
// policed or shared table, and that subquery runs on the one engine every
// tenant's schema is attached to. So a filter like
// `n IN (SELECT salary FROM victim.payroll)` — valid SQL over the sharer's own
// table — makes the shared output depend on another tenant's rows, which a
// recipient reads back through which rows survive; `IN (SELECT * FROM
// read_csv('…'))` reaches the filesystem the same way. The save-time checks
// only ran the filter, and a cross-read filter runs fine.
//
// Real DuckDB, in memory: two schemas on one engine, the exploit shown to work
// unguarded, then refused through the enforcement path and the save-time check.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: async () => {} }));

const { applyTablePolicies, assertSafeRowFilter, bindFilterPlaceholders } =
  await import("@/utils/lakehouse/policies.server");

let c: DuckDBConnection;
beforeAll(async () => {
  const db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
  await c.run(
    `CREATE SCHEMA mine; CREATE SCHEMA victim;
     CREATE TABLE mine.t AS SELECT * FROM (VALUES (1000),(2000),(3000)) v(n);
     CREATE TABLE victim.payroll AS SELECT * FROM (VALUES (2000)) v(salary);`,
  );
});

const reader = { id: "reader-9", email: null };
const policyWith = (filter: string) =>
  new Map([
    [
      "mine.t",
      {
        id: "p",
        schema_name: "mine",
        table_name: "t",
        row_filter: filter,
        masked_columns: [],
        mask_style: "null" as const,
      },
    ],
  ]);

const CROSS_READS = [
  "n IN (SELECT salary FROM victim.payroll)",
  "n = (SELECT max(salary) FROM victim.payroll)",
  "EXISTS (SELECT 1 FROM victim.payroll WHERE salary = n)",
  "n > ANY (SELECT salary FROM victim.payroll)",
  "n IN (SELECT * FROM read_csv('/etc/passwd'))",
  // A subquery with NO table of its own: caught by the subquery node itself,
  // not by any table reference. A scalar subquery can read an engine setting
  // (`current_setting(...)`) or a literal probe, so the subquery is refused
  // whether or not it names a table.
  "n IN (SELECT 1)",
  "n = (SELECT 2)",
];
const ORDINARY = [
  "n > 1500",
  "n IN (1000, 3000)",
  "lower(CAST(n AS VARCHAR)) LIKE '2%' AND n BETWEEN 1 AND 9999",
  "CASE WHEN n > 0 THEN true ELSE false END",
];

describe("the exploit, unguarded, really reads the other schema", () => {
  it("a cross-schema subquery filter leaks which rows match", async () => {
    // This is what the filter does on the engine before the guard refuses it.
    const rows = await (
      await c.run("SELECT n FROM mine.t WHERE (n IN (SELECT salary FROM victim.payroll))")
    ).getRows();
    expect(rows.map((r) => Number(r[0]))).toEqual([2000]);
  });
});

describe("assertSafeRowFilter", () => {
  for (const f of CROSS_READS) {
    it(`refuses: ${f}`, async () => {
      await expect(assertSafeRowFilter(c, "mine", "t", f)).rejects.toThrow(
        /only test the table's own columns/,
      );
    });
  }
  for (const f of ORDINARY) {
    it(`allows: ${f}`, async () => {
      await expect(assertSafeRowFilter(c, "mine", "t", f)).resolves.toBeUndefined();
    });
  }
  it("binds @user_id before checking, so a reader-scoped filter is allowed", async () => {
    const bound = bindFilterPlaceholders("n = @user_id OR n > 0", reader);
    await expect(assertSafeRowFilter(c, "mine", "t", bound)).resolves.toBeUndefined();
  });
  it("parses without the table existing, for a tag rule with no tables yet", async () => {
    await expect(assertSafeRowFilter(c, "lake_probe", "t", "n > 5")).resolves.toBeUndefined();
    await expect(
      assertSafeRowFilter(c, "lake_probe", "t", "n IN (SELECT x FROM other.t)"),
    ).rejects.toThrow(/own columns/);
  });
});

describe("the enforcement path refuses a stored cross-read filter", () => {
  it("applyTablePolicies throws rather than running it", async () => {
    await expect(
      applyTablePolicies(
        c,
        "SELECT n FROM mine.t",
        policyWith("n IN (SELECT salary FROM victim.payroll)"),
        reader,
      ),
    ).rejects.toThrow(/own columns/);
  });

  it("still applies an ordinary filter", async () => {
    const rewrite = await applyTablePolicies(
      c,
      "SELECT n FROM mine.t",
      policyWith("n > 1500"),
      reader,
    );
    expect(rewrite?.applied).toEqual(["mine.t"]);
    const rows = await (await c.run(rewrite!.sql)).getRows();
    expect(rows.map((r) => Number(r[0])).sort((a, b) => a - b)).toEqual([2000, 3000]);
  });
});

describe("every path that stores or applies a filter calls the guard", () => {
  // The guard only helps where it is wired in, so pin the call at each site: a
  // later edit that drops one re-opens that path.
  it("serve time, in applyTablePolicies", () => {
    const src = readFileSync("src/utils/lakehouse/policies.server.ts", "utf8");
    expect(src).toMatch(/if \(policy\.row_filter\?\.trim\(\)\) \{\s*await assertSafeRowFilter\(/);
  });

  it("save time, on a delta share's table", () => {
    const src = readFileSync("src/utils/lakehouse/shares.functions.ts", "utf8");
    expect(src).toContain("await assertSafeRowFilter(c, data.schema, data.table, bound);");
  });

  it("save time, on a table policy and a tag policy", () => {
    const src = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
    // The table policy, against the real table.
    expect(src).toContain("await assertSafeRowFilter(c, data.schema, data.table, bound);");
    // The tag policy, which parses without a table so it runs with none tagged.
    expect(src).toContain('await assertSafeRowFilter(c, "lake_probe", "t", bound);');
  });
});
