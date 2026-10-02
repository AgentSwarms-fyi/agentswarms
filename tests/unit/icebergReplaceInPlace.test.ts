// An Iceberg replace over a table with the same columns: one commit (R182).
//
// FOUND IN R182. A replace dropped the old table, created it again and
// refilled it: for 0.9 s a reader of the catalog found no table and for
// 1.7 s an empty one (r181.swap_target, from the catalog's own log). A swap
// by renames narrowed that to the gap between two renames, 1.5 s on the
// development catalog. When the old table already has the new data's
// columns, the replace is its rows deleted and the new ones inserted in one
// transaction: driven, the catalog logged ONE commit, carrying a delete
// snapshot and an append snapshot, and no rename or drop.
//
// Run here against a fake engine that answers DESCRIBE with the columns the
// test gives the old table, or fails it for a table that does not exist.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sameColumns } from "@/utils/lakehouse/iceberg";

const SOURCE: [string, string][] = [
  ["order_id", "BIGINT"],
  ["region", "VARCHAR"],
  ["net_usd", "DOUBLE"],
];

const state = {
  statements: [] as string[],
  current: null as [string, string][] | null,
  failWhen: null as ((sql: string) => boolean) | null,
};

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/secrets.server", () => ({ resolveSecretRefs: async () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/lakehouse/core.server", () => ({
  icebergExtensionAvailable: () => true,
  lakehouseConnection: async () => ({
    run: async (sql: string) => {
      if (sql.includes("duckdb_columns()")) return { getRows: async () => SOURCE };
      state.statements.push(sql);
      if (sql.startsWith("DESCRIBE ")) {
        if (!state.current)
          throw new Error("Catalog Error: Table with name swap_target does not exist!");
        const rows = state.current;
        return { getRows: async () => rows.map(([n, t]) => [n, t, "YES", null, null, null]) };
      }
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

const publish = (mode: "create" | "replace" = "replace") =>
  publishToIceberg({
    row: ROW,
    namespace: "r181",
    table: "swap_target",
    sourceSchema: "analytics",
    sourceTable: "stg_revenue",
    mode,
    userId: "owner",
  });

const writes = () =>
  state.statements.filter(
    (s) => !s.startsWith("ATTACH ") && !s.startsWith("DESCRIBE ") && !s.startsWith("SELECT count"),
  );

beforeEach(() => {
  state.statements = [];
  state.current = null;
  state.failWhen = null;
});

describe("the old table has the new data's columns", () => {
  it("replaces its rows in one transaction, and nothing else", async () => {
    state.current = SOURCE;
    await expect(publish()).resolves.toEqual({ rows: 836 });
    expect(writes()).toEqual([
      'BEGIN TRANSACTION; DELETE FROM "ice_cat1"."r181"."swap_target"; ' +
        'INSERT INTO "ice_cat1"."r181"."swap_target" ("order_id", "region", "net_usd") ' +
        'SELECT "order_id", "region", "net_usd" FROM "lake"."analytics"."stg_revenue"; COMMIT;',
    ]);
  });

  it("leaves the old rows when the write fails, and says so", async () => {
    state.current = SOURCE;
    state.failWhen = (sql) => sql.startsWith("BEGIN TRANSACTION; DELETE");
    await expect(publish()).rejects.toThrow(
      /Forbidden \(HTTP code 403\)\. r181\.swap_target was not replaced; it keeps its old rows\./,
    );
    expect(writes().slice(1)).toEqual(["ROLLBACK;"]);
  });
});

describe("anything else takes the staged swap", () => {
  const swapped = () => writes().some((s) => /^BEGIN TRANSACTION; ALTER TABLE IF EXISTS /.test(s));
  const overwrote = () => writes().some((s) => /DELETE FROM /.test(s));

  it("a table that is not there yet", async () => {
    await publish();
    expect(overwrote()).toBe(false);
    expect(swapped()).toBe(true);
  });

  it("a column of another type, another name, or in another place", async () => {
    for (const current of [
      [
        ["order_id", "INTEGER"],
        ["region", "VARCHAR"],
        ["net_usd", "DOUBLE"],
      ],
      [
        ["order_id", "BIGINT"],
        ["area", "VARCHAR"],
        ["net_usd", "DOUBLE"],
      ],
      [
        ["region", "VARCHAR"],
        ["order_id", "BIGINT"],
        ["net_usd", "DOUBLE"],
      ],
      [
        ["order_id", "BIGINT"],
        ["region", "VARCHAR"],
      ],
    ] as [string, string][][]) {
      state.statements = [];
      state.current = current;
      await publish();
      expect(overwrote()).toBe(false);
      expect(swapped()).toBe(true);
    }
  });
});

describe("a create", () => {
  it("does not look at the old table, since it refuses one", async () => {
    state.current = SOURCE;
    await publish("create");
    expect(state.statements.some((s) => s.startsWith("DESCRIBE "))).toBe(false);
    expect(writes().some((s) => s.includes("DELETE FROM"))).toBe(false);
  });
});

describe("sameColumns", () => {
  const cols = (...pairs: [string, string][]) => pairs.map(([name, type]) => ({ name, type }));
  it("needs the same names, types and order, and at least one column", () => {
    expect(sameColumns(cols(["a", "INTEGER"]), cols(["a", "INTEGER"]))).toBe(true);
    expect(sameColumns(cols(["a", "INTEGER"]), cols(["A", "INTEGER"]))).toBe(false);
    expect(sameColumns(cols(["a", "INTEGER"]), cols(["a", "BIGINT"]))).toBe(false);
    expect(
      sameColumns(cols(["a", "INTEGER"], ["b", "DATE"]), cols(["b", "DATE"], ["a", "INTEGER"])),
    ).toBe(false);
    expect(sameColumns(cols(["a", "INTEGER"]), cols(["a", "INTEGER"], ["b", "DATE"]))).toBe(false);
    expect(sameColumns([], [])).toBe(false);
  });
});
