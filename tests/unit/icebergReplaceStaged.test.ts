// An Iceberg "replace": never without a table, never an empty one.
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
// FOUND IN R182. The staged copy then went into the old name by a drop, a
// create and an insert. The catalog's log for one replace of
// r181.swap_target: dropped 13:54:39.456, created 13:54:40.375, filled
// 13:54:42.076. A reader found no table for 0.9 s and an empty one for
// 1.7 s. The staged table is now renamed into the name, and the old one
// renamed aside, in one transaction.
//
// Run here against a fake engine that fails the statements the test names,
// so it sees what had already happened when one failed. The staging and
// retired tables are named afresh for each publish (a fixed name would be a
// table somebody could own).
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
      // The source's columns (R181): the publish creates the table from them.
      if (sql.includes("duckdb_columns()")) {
        return {
          getRows: async () => [
            ["id", "INTEGER"],
            ["note", "VARCHAR"],
          ],
        };
      }
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

// Anything that removes the owner's table by its own name.
const droppedTheTable = () =>
  state.statements.some((s) => /DROP TABLE IF EXISTS .*"r107"\."r107_pub";/.test(s));

const STAGING = /"(r107_pub__publishing_[0-9a-f]{8})"/;
const RETIRED = /"(r107_pub__replaced_[0-9a-f]{8})"/;
const nameOf = (re: RegExp, statements: string[]) =>
  statements.map((s) => re.exec(s)?.[1]).find(Boolean);
const SWAP = (sql: string) => sql.startsWith("BEGIN TRANSACTION;");

beforeEach(() => {
  state.statements = [];
  state.failWhen = null;
  state.warnings = [];
  vi.spyOn(console, "warn").mockImplementation((m: string) => {
    state.warnings.push(String(m));
  });
});

describe("a replace swaps the new table in by name", () => {
  it("renames the old table aside and the staged one into its name, in one transaction", async () => {
    await publish("replace");
    const swap = state.statements.find(SWAP) ?? "";
    const staging = nameOf(STAGING, state.statements);
    const retired = nameOf(RETIRED, state.statements);
    expect(swap).toMatch(
      new RegExp(
        `^BEGIN TRANSACTION; ALTER TABLE IF EXISTS .*"r107"\\."r107_pub" RENAME TO "${retired}"; ` +
          `ALTER TABLE .*"r107"\\."${staging}" RENAME TO "r107_pub"; COMMIT;$`,
      ),
    );
  });

  it("never drops, recreates or refills the table under the owner's name", async () => {
    await publish("replace");
    expect(droppedTheTable()).toBe(false);
    expect(state.statements.some((s) => /^CREATE TABLE .*"r107"\."r107_pub" \(/.test(s))).toBe(
      false,
    );
    expect(state.statements.some((s) => /^INSERT INTO .*"r107"\."r107_pub" \(/.test(s))).toBe(
      false,
    );
  });

  it("stages the new data before the swap, and drops the old table only after it", async () => {
    await publish("replace");
    const filled = state.statements.findIndex(
      (s) => s.startsWith("INSERT INTO") && STAGING.test(s) && s.includes('"analytics"'),
    );
    const swapped = state.statements.findIndex(SWAP);
    const retired = nameOf(RETIRED, state.statements);
    const droppedOld = state.statements.findIndex((s) =>
      new RegExp(`^DROP TABLE IF EXISTS .*"r107"\\."${retired}";$`).test(s),
    );
    expect(filled).toBeGreaterThan(-1);
    expect(swapped).toBeGreaterThan(filled);
    expect(droppedOld).toBeGreaterThan(swapped);
  });
});

describe("a replace that cannot be written leaves the old table", () => {
  it("fails on the staged write, before the swap", async () => {
    // R107's whole bug: the DROP ran first, and then this failed.
    state.failWhen = (sql) => sql.startsWith("CREATE TABLE") && STAGING.test(sql);
    await expect(publish("replace")).rejects.toThrow(/INTERVAL is not a valid Iceberg Type/);
    expect(state.statements.some(SWAP)).toBe(false);
    expect(droppedTheTable()).toBe(false);
  });

  it("removes its own staging table when the staged write fails", async () => {
    for (const step of ["CREATE TABLE", "INSERT INTO"]) {
      state.statements = [];
      state.failWhen = (sql) => sql.startsWith(step) && STAGING.test(sql);
      await expect(publish("replace")).rejects.toThrow();
      const staging = nameOf(STAGING, state.statements);
      expect(state.statements.at(-1)).toMatch(
        new RegExp(`^DROP TABLE IF EXISTS .*"r107"\\."${staging}";$`),
      );
    }
  });
});

describe("a swap that fails", () => {
  it("rolls back, puts the old table back if it had moved, then removes the staging table", async () => {
    state.failWhen = SWAP;
    await expect(publish("replace")).rejects.toThrow(
      /r107\.r107_pub was not replaced, and is as it was\./,
    );
    const staging = nameOf(STAGING, state.statements);
    const retired = nameOf(RETIRED, state.statements);
    const after = state.statements.slice(state.statements.findIndex(SWAP) + 1);
    expect(after).toEqual([
      "ROLLBACK;",
      expect.stringMatching(
        new RegExp(`^ALTER TABLE IF EXISTS .*"r107"\\."${retired}" RENAME TO "r107_pub";$`),
      ),
      expect.stringMatching(new RegExp(`^DROP TABLE IF EXISTS .*"r107"\\."${staging}";$`)),
    ]);
    expect(droppedTheTable()).toBe(false);
  });

  it("says where the old table is when it cannot be put back", async () => {
    state.failWhen = (sql) => SWAP(sql) || (RETIRED.test(sql) && sql.startsWith("ALTER TABLE"));
    const error = await publish("replace").then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toMatch(
      /If r107\.r107_pub is missing, the old table is at r107\.r107_pub__replaced_[0-9a-f]{8}\./,
    );
    // It cannot promise what it could not check.
    expect(error).not.toMatch(/as it was/);
  });
});

describe("after the swap", () => {
  it("does not fail a publish that landed because the old table's removal failed", async () => {
    state.failWhen = (sql) => sql.startsWith("DROP TABLE IF EXISTS") && RETIRED.test(sql);
    await expect(publish("replace")).resolves.toEqual({ rows: 1 });
    expect(
      state.warnings.some((w) => /could not drop r107\.r107_pub__replaced_[0-9a-f]{8}/.test(w)),
    ).toBe(true);
  });
});

describe("a replace drops nothing it was not asked to", () => {
  it("drops only the tables it made or moved, under this publish's own names", async () => {
    await publish("replace");
    const own = [nameOf(STAGING, state.statements), nameOf(RETIRED, state.statements)];
    for (const s of state.statements) {
      const drop = /^DROP TABLE IF EXISTS .*\."([^"]+)";$/.exec(s);
      if (drop) expect(own).toContain(drop[1]);
    }
  });

  it("names its staging and retired tables afresh for each publish", async () => {
    await publish("replace");
    const first = [nameOf(STAGING, state.statements), nameOf(RETIRED, state.statements)];
    state.statements = [];
    await publish("replace");
    const second = [nameOf(STAGING, state.statements), nameOf(RETIRED, state.statements)];
    expect(first.every(Boolean)).toBe(true);
    expect(second.every(Boolean)).toBe(true);
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });
});

describe("create is unchanged", () => {
  it("never drops anything", async () => {
    await publish("create");
    expect(state.statements.some((s) => s.startsWith("DROP TABLE"))).toBe(false);
  });
});
