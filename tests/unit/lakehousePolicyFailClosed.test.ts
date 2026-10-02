// A lakehouse table's security policy holds when it cannot be read, and when
// the table leaves the lakehouse.
//
// FOUND IN R223, two ways round the same policy:
// - loadPolicies and the tag reads behind it kept `data` and dropped `error`,
//   and `data ?? []` made a failed read "no policy". Every caller then ran a
//   non-owner's SELECT unfiltered and unmasked, let a write copy a policed
//   table, and sent one to Spark or into a Delta Share.
// - Iceberg publish checked only that the caller could see the schema, then
//   copied the raw table, so a grantee could take a policed table whole into
//   a catalog they own.
//
// Behavioural: the real loaders against a client whose reads fail one table
// at a time, and the real publish guard with the schema list stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Resp = { data: unknown[] | null; error: { message: string } | null };

const db = vi.hoisted(() => ({
  responses: {} as Record<string, Resp>,
  schemas: [] as { name: string; user_id: string }[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const resp = db.responses[table] ?? { data: [], error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) b[m] = () => b;
      b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resp).then(res, rej);
      return b;
    },
  },
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  accessibleSchemas: async () => db.schemas,
}));

const { loadPolicies, loadTagPolicies, lakehouseAssetTags } =
  await import("@/utils/lakehouse/policies.server");
const { icebergPublishRefusal } = await import("@/utils/lakehouse/publishGuard.server");

const OWNER = "owner-1";
const READER = "reader-2";
const TABLE = { schema: "sales", table: "orders" };
const POLICY = {
  id: "p1",
  user_id: OWNER,
  schema_name: "sales",
  table_name: "orders",
  row_filter: "region = 'EMEA'",
  masked_columns: ["email"],
  mask_style: "null",
};
const failed = (message: string): Resp => ({ data: null, error: { message } });

beforeEach(() => {
  db.responses = {};
  db.schemas = [];
});

describe("a policy that cannot be read is not 'no policy'", () => {
  it("throws when the table policies cannot be read", async () => {
    db.responses.lakehouse_table_policies = failed("statement timeout");
    await expect(loadPolicies([OWNER], [TABLE])).rejects.toThrow(/statement timeout/);
  });

  it("throws when the tag policies cannot be read", async () => {
    db.responses.lakehouse_tag_policies = failed("connection reset");
    await expect(loadTagPolicies([OWNER])).rejects.toThrow(/connection reset/);
    await expect(loadPolicies([OWNER], [TABLE])).rejects.toThrow(/connection reset/);
  });

  it("throws when the tags a tag policy keys on cannot be read", async () => {
    for (const table of ["data_warehouse_connections", "catalog_sources", "catalog_assets"]) {
      db.responses = {
        data_warehouse_connections: { data: [{ id: "c1" }], error: null },
        catalog_sources: { data: [{ id: "s1" }], error: null },
        [table]: failed(`${table} unavailable`),
      };
      await expect(lakehouseAssetTags([OWNER], [TABLE])).rejects.toThrow(`${table} unavailable`);
    }
  });

  it("still finds the policy when the reads succeed, and none when there is none", async () => {
    db.responses.lakehouse_table_policies = { data: [POLICY], error: null };
    const found = await loadPolicies([OWNER], [TABLE]);
    expect(found.get("sales.orders")?.row_filter).toBe("region = 'EMEA'");
    db.responses.lakehouse_table_policies = { data: [], error: null };
    expect((await loadPolicies([OWNER], [TABLE])).size).toBe(0);
  });
});

describe("publishing a lakehouse table to Iceberg", () => {
  it("lets the owner publish their own table, policy or not", async () => {
    db.schemas = [{ name: "sales", user_id: OWNER }];
    db.responses.lakehouse_table_policies = { data: [POLICY], error: null };
    await expect(icebergPublishRefusal(OWNER, "sales", "orders")).resolves.toBeNull();
  });

  it("refuses a reader a table under the owner's policy", async () => {
    db.schemas = [{ name: "sales", user_id: OWNER }];
    db.responses.lakehouse_table_policies = { data: [POLICY], error: null };
    const refusal = await icebergPublishRefusal(READER, "sales", "orders");
    expect(refusal).toMatch(/has a security policy/);
  });

  it("lets a reader publish a shared table with no policy", async () => {
    db.schemas = [{ name: "sales", user_id: OWNER }];
    await expect(icebergPublishRefusal(READER, "sales", "orders")).resolves.toBeNull();
  });

  it("refuses rather than publishes when the reader's policy cannot be read", async () => {
    db.schemas = [{ name: "sales", user_id: OWNER }];
    db.responses.lakehouse_table_policies = failed("statement timeout");
    await expect(icebergPublishRefusal(READER, "sales", "orders")).rejects.toThrow(
      /statement timeout/,
    );
  });

  it("is what the publish handler asks before it copies anything", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/icebergCatalogs.functions.ts", "utf8");
    const handler = src.slice(src.indexOf("export const icebergPublish = createServerFn"));
    const ask = handler.indexOf("await icebergPublishRefusal(");
    const copy = handler.indexOf("await publishToIceberg(");
    expect(ask).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(ask);
    expect(handler.slice(ask, copy)).toContain(
      "if (refusal) return { ok: false, error: refusal };",
    );
  });

  it("refuses a schema the caller cannot see", async () => {
    db.schemas = [];
    await expect(icebergPublishRefusal(READER, "sales", "orders")).resolves.toMatch(
      /No access to schema "sales"/,
    );
  });
});
