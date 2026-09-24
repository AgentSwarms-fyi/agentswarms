// An Iceberg "replace" that could leave the catalog with no table.
//
// FOUND IN R107. The extension has no CREATE OR REPLACE for Iceberg tables,
// so publishing with "Replace it (drop, then create)" ran exactly that: a
// DROP, then a CREATE. Driven: analytics.r107_src published as
// local_rest / r107 / r107_pub ("Published 1 row(s) to r107.r107_pub";
// publishing it again with Refuse answered "Table with name "r107_pub" already
// exists"). Then analytics.r107_bad, which has an INTERVAL column, published
// over it with Replace: "Column type INTERVAL is not a valid Iceberg Type."
// Mounting namespace r107 afterwards answered "Mounted 0 tables". The
// replace had dropped the published table and put nothing in its place.
//
// Run here against a fake engine that fails the statements the test names,
// so it sees what had already happened when one failed. The staging table
// is named afresh for each publish (a fixed `<table>__publishing` would be a
// table somebody could own, and the replace began by dropping it).
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  statements: [] as string[],
  failWhen: null as ((sql: string) => boolean) | null,
  warnings: [] as string[],
};

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/secrets.server", () => ({ resolveSecretRefs: async () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/lakehouse/core.server", () => ({
  icebergExtensionAvailable: () => true,
  lakehouseConnection: async () => ({
    run: async (sql: string) => {
      state.statements.push(sql);
      if (state.failWhen?.(sql)) {
        throw new Error("Invalid Input Error: Column type INTERVAL is not a valid Iceberg Type.");
      }
      return { getRows: async () => [[1]] };
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
    namespace: "r107",
    table: "r107_pub",
    sourceSchema: "analytics",
    sourceTable: "r107_bad",
    mode,
    userId: "owner",
  });

const droppedTheTable = () =>
  state.statements.some((s) => /^DROP TABLE IF EXISTS .*"r107"\."r107_pub";$/.test(s));

const STAGING = /"(r107_pub__publishing_[0-9a-f]{8})"/;
const stagingOf = (statements: string[]) =>
  statements.map((s) => STAGING.exec(s)?.[1]).find(Boolean);

beforeEach(() => {
  state.statements = [];
  state.failWhen = null;
  state.warnings = [];
  vi.spyOn(console, "warn").mockImplementation((m: string) => {
    state.warnings.push(String(m));
  });
});

describe("a replace that cannot be written leaves the old table", () => {
  it("fails on the staged write, before anything is dropped", async () => {
    // The whole bug: the DROP ran first, and then this failed.
    state.failWhen = (sql) => sql.startsWith("CREATE TABLE") && STAGING.test(sql);
    await expect(publish("replace")).rejects.toThrow(/INTERVAL is not a valid Iceberg Type/);
    expect(droppedTheTable()).toBe(false);
  });

  it("removes its own staging table when the staged write fails", async () => {
    state.failWhen = (sql) => sql.startsWith("CREATE TABLE") && STAGING.test(sql);
    await expect(publish("replace")).rejects.toThrow();
    const staging = stagingOf(state.statements);
    expect(state.statements.at(-1)).toMatch(
      new RegExp(`^DROP TABLE IF EXISTS .*"r107"\\."${staging}";$`),
    );
  });

  it("removes its own staging table when the catalog refuses to drop the old one", async () => {
    // Driven: the catalog's store was locked and answered HTTP 500 to the
    // DELETE. The old table stood, and a stray staging copy would have too.
    state.failWhen = (sql) => /^DROP TABLE IF EXISTS .*"r107"\."r107_pub";$/.test(sql);
    await expect(publish("replace")).rejects.toThrow();
    const staging = stagingOf(state.statements);
    expect(state.statements.at(-1)).toMatch(
      new RegExp(`^DROP TABLE IF EXISTS .*"r107"\\."${staging}";$`),
    );
  });

  it("stages the new data before it drops the old table", async () => {
    await publish("replace");
    const staged = state.statements.findIndex(
      (s) => s.startsWith("CREATE TABLE") && STAGING.test(s) && s.includes('"analytics"'),
    );
    const dropped = state.statements.findIndex((s) =>
      /^DROP TABLE IF EXISTS .*"r107"\."r107_pub";$/.test(s),
    );
    expect(staged).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(staged);
  });

  it("says where the new data is if the copy into the old name fails", async () => {
    state.failWhen = (sql) =>
      /^CREATE TABLE .*"r107"\."r107_pub" AS SELECT \* FROM .*"r107_pub__publishing_[0-9a-f]{8}";$/.test(
        sql,
      );
    await expect(publish("replace")).rejects.toThrow(
      /The old r107\.r107_pub had already been dropped; the new data is in r107\.r107_pub__publishing_[0-9a-f]{8}\./,
    );
  });

  it("does not fail a publish that landed because the staging cleanup failed", async () => {
    state.failWhen = (sql) => sql.startsWith("DROP TABLE IF EXISTS") && STAGING.test(sql);
    await expect(publish("replace")).resolves.toEqual({ rows: 1 });
    expect(
      state.warnings.some((w) => /could not drop r107\.r107_pub__publishing_[0-9a-f]{8}/.test(w)),
    ).toBe(true);
  });
});

describe("a replace drops nothing it was not asked to", () => {
  it("drops only the named table and the staging table it created", async () => {
    await publish("replace");
    const created = new Set<string>();
    for (const s of state.statements) {
      const make = /^CREATE TABLE .*\."([^"]+)" AS /.exec(s);
      if (make) created.add(make[1]);
      const drop = /^DROP TABLE IF EXISTS .*\."([^"]+)";$/.exec(s);
      if (drop) expect(drop[1] === "r107_pub" || created.has(drop[1])).toBe(true);
    }
  });

  it("stages each publish under a name of its own", async () => {
    await publish("replace");
    const first = stagingOf(state.statements);
    state.statements = [];
    await publish("replace");
    const second = stagingOf(state.statements);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe("create is unchanged", () => {
  it("never drops anything", async () => {
    await publish("create");
    expect(state.statements.some((s) => s.startsWith("DROP TABLE"))).toBe(false);
  });
});
