// What an ETL pipeline's lakehouse nodes may read and write.
//
// FOUND IN R225: a pipeline's lakehouse nodes run in a sandbox holding
// engine-level catalog and storage credentials, and the server checked only
// each node's own `schema` field. A source in query mode ran its SQL as
// written, so a node naming the author's schema could query any schema in the
// lake; and a schema shared with the author was read, and written, past its
// owner's row filter and masks, which nothing in the sandbox applies.
//
// Behavioural: the real guard, real DuckDB in memory parsing the queries (the
// same table walk the SQL editor uses), and the owners' policies stubbed.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { readFileSync } from "node:fs";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ policies: [] as Record<string, unknown>[] }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const data = table === "lakehouse_table_policies" ? db.policies : [];
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
      return b;
    },
  },
}));

const { lakehouseNodesRefusal } = await import("@/utils/lakehouse/pipelineGuard.server");

const AUTHOR = "author-1";
const OWNER = "owner-2";
// The author's own schema, and one an owner shared with them. "private" is
// another user's and was never shared.
const allowed = [
  { name: "mine", user_id: AUTHOR },
  { name: "shared", user_id: OWNER },
] as never[];
const POLICY = {
  id: "p1",
  user_id: OWNER,
  schema_name: "shared",
  table_name: "orders",
  row_filter: "region = 'EMEA'",
  masked_columns: ["email"],
  mask_style: "null",
};

let db1: DuckDBInstance;
const connect = async (): Promise<DuckDBConnection> => db1.connect();
beforeAll(async () => {
  db1 = await DuckDBInstance.create(":memory:");
  const c = await db1.connect();
  await c.run(
    `CREATE SCHEMA mine; CREATE SCHEMA shared; CREATE SCHEMA private;
     CREATE TABLE mine.t AS SELECT 1 AS id;
     CREATE TABLE shared.orders AS SELECT 1 AS id, 'EMEA' AS region, 'a@x' AS email;
     CREATE TABLE shared.open AS SELECT 1 AS id;
     CREATE TABLE private.salaries AS SELECT 100 AS amount;`,
  );
  c.closeSync();
});
beforeEach(() => {
  db.policies = [];
});

const refuse = (nodes: Parameters<typeof lakehouseNodesRefusal>[2]) =>
  lakehouseNodesRefusal(AUTHOR, allowed, nodes, connect);

describe("a lakehouse source's query", () => {
  it("cannot read a schema nobody shared with the author, whatever schema the node names", async () => {
    const why = await refuse([
      {
        label: "Src",
        kind: "source",
        schema: "mine",
        mode: "query",
        query: "SELECT * FROM private.salaries",
      },
    ]);
    expect(why).toMatch(/No access to schema "private"/);
  });

  it("cannot reach files through a table function", async () => {
    const why = await refuse([
      {
        label: "Src",
        kind: "source",
        schema: "mine",
        mode: "query",
        query: "SELECT * FROM read_parquet('s3://lake/private/salaries/*.parquet')",
      },
    ]);
    expect(why).toMatch(/read_parquet\(\) is not available here/);
  });

  it("runs over the author's own and shared schemas", async () => {
    const why = await refuse([
      {
        label: "Src",
        kind: "source",
        schema: "mine",
        mode: "query",
        query: "SELECT * FROM mine.t JOIN shared.open USING (id)",
      },
    ]);
    expect(why).toBeNull();
  });
});

describe("a shared table under its owner's policy", () => {
  // Since the sandbox gateway the app runs a source's read through the
  // owner's policy (sandboxLake.server → governSelect), so a source may name
  // a policed table and gets the rows and values its owner allows.
  it("may be a source, in table mode and in a query: the read is served through the policy", async () => {
    db.policies = [POLICY];
    const table = await refuse([
      { label: "Orders", kind: "source", schema: "shared", mode: "table", table: "orders" },
    ]);
    expect(table).toBeNull();
    const query = await refuse([
      {
        label: "Q",
        kind: "source",
        schema: "mine",
        mode: "query",
        query: "SELECT email FROM shared.orders",
      },
    ]);
    expect(query).toBeNull();
  });

  it("is refused to a target, since only its owner may write it", async () => {
    db.policies = [POLICY];
    const why = await refuse([
      { label: "Out", kind: "target", schema: "shared", mode: "table", table: "orders" },
    ]);
    expect(why).toMatch(/read-only for anyone else/);
  });

  it("is the owner's to read whole, and a shared table with no policy is anyone's", async () => {
    db.policies = [POLICY];
    const owner = await lakehouseNodesRefusal(
      OWNER,
      allowed,
      [{ label: "Orders", kind: "source", schema: "shared", mode: "table", table: "orders" }],
      connect,
    );
    expect(owner).toBeNull();
    const open = await refuse([
      { label: "Open", kind: "source", schema: "shared", mode: "table", table: "open" },
    ]);
    expect(open).toBeNull();
  });
});

describe("the pipeline's run and preview environment", () => {
  it("asks the guard before declaring the run's lakehouse access", () => {
    const src = readFileSync("src/utils/etl/service.server.ts", "utf8");
    const ask = src.indexOf("await lakehouseNodesRefusal(");
    const declare = src.indexOf("lake = etlLakeManifest(", ask);
    expect(ask).toBeGreaterThan(-1);
    expect(declare).toBeGreaterThan(ask);
    expect(src.slice(ask, declare)).toContain("if (refusal) throw new Error(refusal);");
  });
});
