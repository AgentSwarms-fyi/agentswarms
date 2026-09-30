// Publishing to Iceberg creates the table from the source's columns, then
// inserts its rows (R181).
//
// FOUND IN R181. Publish was a CREATE TABLE AS. On an image built on
// 2026-09-30, both publishes driven that day (local_rest / r181 /
// swap_target and local_rest / r107 / r181_probe, from
// analytics.stg_revenue) answered `IO Error: Failed to create directory
// "data": Permission denied`, and the catalog saw only a lookup. Probed
// in the container with the same extension build: a CREATE TABLE AS writes
// to a relative `data/` whenever the ducklake extension is loaded (loaded,
// attached or in USE, the same), and to the table's own s3:// location
// otherwise; a CREATE TABLE with columns followed by an INSERT writes to the
// s3:// location either way. The engine always loads ducklake.
//
// Run here against a fake engine that records the statements.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { icebergPublishSql, icebergSourceColumnsSql } from "@/utils/lakehouse/iceberg";

const state = {
  statements: [] as string[],
  columnReads: [] as string[],
  columns: [] as [string, string][],
  failWhen: null as ((sql: string) => boolean) | null,
};

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/secrets.server", () => ({ resolveSecretRefs: async () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/lakehouse/core.server", () => ({
  icebergExtensionAvailable: () => true,
  lakehouseConnection: async () => ({
    run: async (sql: string) => {
      if (sql.includes("duckdb_columns()")) {
        state.columnReads.push(sql);
        return { getRows: async () => state.columns };
      }
      state.statements.push(sql);
      if (state.failWhen?.(sql)) throw new Error("HTTP Error: Forbidden (HTTP code 403)");
      return { getRows: async () => [[836]] };
    },
    closeSync: () => {},
  }),
}));

const { publishToIceberg } = await import("@/utils/lakehouse/iceberg.server");

const ROW = {
  id: "cat-1",
  user_id: "owner",
  name: "local_rest",
  endpoint: "http://iceberg:8181",
  warehouse: "s3://iceberg/",
  auth_type: "none",
  token_secret: null,
  client_id_secret: null,
  client_secret_secret: null,
  oauth2_server_uri: null,
  storage: "s3",
} as never;

const publish = (mode: "create" | "replace") =>
  publishToIceberg({
    row: ROW,
    namespace: "r181",
    table: "swap_target",
    sourceSchema: "analytics",
    sourceTable: "stg_revenue",
    mode,
    userId: "owner",
  });

beforeEach(() => {
  state.statements = [];
  state.columnReads = [];
  state.columns = [
    ["order_id", "BIGINT"],
    ["region", "VARCHAR"],
    ["net_usd", "DECIMAL(18,2)"],
  ];
  state.failWhen = null;
});

describe("a publish never asks the extension for a CREATE TABLE AS", () => {
  it("creates the table from the columns, then inserts, in both modes", async () => {
    for (const mode of ["create", "replace"] as const) {
      state.statements = [];
      await expect(publish(mode)).resolves.toEqual({ rows: 836 });
      expect(state.statements.some((s) => /^CREATE TABLE [^(]* AS /.test(s))).toBe(false);
      const target = state.statements.findIndex((s) =>
        /^CREATE TABLE .*"r181"\."swap_target" \("order_id" BIGINT, "region" VARCHAR, "net_usd" DECIMAL\(18,2\)\);$/.test(
          s,
        ),
      );
      expect(target).toBeGreaterThan(-1);
      expect(state.statements[target + 1]).toMatch(
        /^INSERT INTO .*"r181"\."swap_target" \("order_id", "region", "net_usd"\) SELECT "order_id", "region", "net_usd" FROM /,
      );
    }
  });

  it("reads the columns of the lakehouse table it publishes, in their order", async () => {
    await publish("create");
    expect(state.columnReads).toEqual([icebergSourceColumnsSql("analytics", "stg_revenue")]);
    expect(state.columnReads[0]).toContain("database_name = 'lake'");
    expect(state.columnReads[0]).toContain("schema_name = 'analytics'");
    expect(state.columnReads[0]).toContain("table_name = 'stg_revenue'");
    expect(state.columnReads[0]).toMatch(/ORDER BY column_index$/);
  });

  it("refuses a source with no columns before it touches the catalog", async () => {
    state.columns = [];
    await expect(publish("create")).rejects.toThrow(/analytics\.stg_revenue has no columns/);
    // Only the catalog's attach ran: nothing was created, filled or dropped.
    expect(state.statements.filter((s) => !s.startsWith("ATTACH "))).toEqual([]);
  });
});

describe("a create whose rows do not go in", () => {
  it("removes the empty table it made, and says why", async () => {
    state.failWhen = (sql) => sql.startsWith("INSERT INTO");
    await expect(publish("create")).rejects.toThrow(/Forbidden/);
    expect(state.statements.at(-1)).toMatch(/^DROP TABLE IF EXISTS .*"r181"\."swap_target";$/);
  });

  it("drops nothing when the create itself was refused", async () => {
    // The name may be someone's table: a create refuses an existing one.
    state.failWhen = (sql) => sql.startsWith("CREATE TABLE");
    await expect(publish("create")).rejects.toThrow();
    expect(state.statements.some((s) => s.startsWith("DROP TABLE"))).toBe(false);
  });
});

describe("the plan", () => {
  it("quotes column names and passes the engine's types through", () => {
    const plan = icebergPublishSql({
      alias: "ice_x",
      namespace: "ns",
      table: "t",
      sourceSchema: "s",
      sourceTable: "src",
      mode: "create",
      columns: [
        { name: 'odd "name"', type: "STRUCT(k INTEGER)" },
        { name: "tags", type: "VARCHAR[]" },
      ],
    });
    expect(plan[1]).toBe(
      `CREATE TABLE "ice_x"."ns"."t" ("odd ""name""" STRUCT(k INTEGER), "tags" VARCHAR[]);`,
    );
    expect(plan[2]).toBe(
      `INSERT INTO "ice_x"."ns"."t" ("odd ""name""", "tags") SELECT "odd ""name""", "tags" FROM "lake"."s"."src";`,
    );
  });
});
