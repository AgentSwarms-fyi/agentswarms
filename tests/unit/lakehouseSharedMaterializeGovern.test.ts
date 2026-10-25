// Materializing or importing a shared resource must carry its governance, not
// strip it (VA-2026-10-25-08, security assessment 2026-10-25).
//
// A materialized view builds `CREATE OR REPLACE TABLE mine.x AS <body>` into a
// schema the owner owns; the body may read a table SHARED with the owner, which
// carries the sharer's row filter and column mask. The refresh ran the raw body,
// so the full, unmasked rows landed in the owner's own schema and could then be
// read freely. The dataset import did the same with a granted dataset's rows.
//
// The matview body now goes through governSelect (the read path's governance),
// and the import applies restrictSharedDataset. The first is shown here on the
// real engine; both call sites are pinned from source.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: async () => {} }));

const { applyTablePolicies } = await import("@/utils/lakehouse/policies.server");

let c: DuckDBConnection;
beforeAll(async () => {
  const db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
  await c.run(
    `CREATE SCHEMA owner; CREATE SCHEMA grantee;
     CREATE TABLE owner.sales AS SELECT * FROM (VALUES
       (1, 'EMEA', 'ana@x.com'), (2, 'AMER', 'bo@x.com'), (3, 'EMEA', 'cy@x.com')
     ) t(id, region, email);`,
  );
});

// The sharer's policy on owner.sales: only EMEA rows, email masked.
const policy = new Map([
  [
    "owner.sales",
    {
      id: "p",
      schema_name: "owner",
      table_name: "sales",
      row_filter: "region = 'EMEA'",
      masked_columns: ["email"],
      mask_style: "null" as const,
    },
  ],
]);
const reader = { id: "grantee-1", email: null };

describe("a matview over a shared, policed table", () => {
  it("ungoverned, the raw body materializes the whole table (what the gap did)", async () => {
    await c.run("CREATE OR REPLACE TABLE grantee.leak AS SELECT * FROM owner.sales");
    const rows = await (await c.run("SELECT id, email FROM grantee.leak ORDER BY id")).getRows();
    expect(rows.length).toBe(3);
    expect(rows[0][1]).toBe("ana@x.com"); // the mask was not applied
  });

  it("governed, it materializes only the rows and columns the owner may see", async () => {
    const rewrite = await applyTablePolicies(c, "SELECT * FROM owner.sales", policy, reader);
    expect(rewrite?.applied).toEqual(["owner.sales"]);
    await c.run(`CREATE OR REPLACE TABLE grantee.mv AS ${rewrite!.sql}`);
    const rows = await (
      await c.run("SELECT id, region, email FROM grantee.mv ORDER BY id")
    ).getRowObjects();
    expect(rows.map((r) => Number(r.id))).toEqual([1, 3]); // only EMEA
    expect(rows.every((r) => r.email === null)).toBe(true); // email masked
  });
});

describe("both materialize paths carry the governance", () => {
  it("the matview build governs its body with governSelect, not the raw SQL", () => {
    const src = readFileSync("src/utils/lakehouse/matviews.server.ts", "utf8");
    expect(src).toContain(
      "const { sql: governed } = await governSelect(c, view.user_id, view.sql, allowed);",
    );
    expect(src).toContain("CREATE OR REPLACE TABLE ${qi(view.schema_name)}.${qi(view.table_name)}");
    // The old ungoverned body is gone.
    expect(src).not.toContain("const body = stripSqlComments(view.sql)");
  });

  it("the dataset import restricts a granted dataset before writing it", () => {
    const src = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
    expect(src).toContain("const sharedGrant = !table.is_sample && table.user_id !== userId;");
    expect(src).toMatch(/if \(sharedGrant\) \{\s*const \{ restrictSharedDataset \} = await import/);
    expect(src).toContain("const restricted = await restrictSharedDataset(");
    expect(src).toContain("rows = restricted.rows as Record<string, unknown>[];");
  });
});
