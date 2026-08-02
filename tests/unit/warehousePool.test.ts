// Connection pooling for the wire-protocol drivers.
//
// A pool is a cache of AUTHENTICATED SESSIONS. Every failure mode here is the
// same shape: handing a caller a session that belongs to someone else, or one
// authenticated with a credential that is no longer valid. So most of this
// file is about the pool KEY.
//
// `pg.Pool` and `mysql.createPool` are both lazy — they open no socket until
// the first query — so the registry can be exercised for real, with no
// database, by comparing the objects getPool hands back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  closeAllPools,
  getPool,
  poolKey,
  poolingEnabled,
  warehousePoolStats,
  type PoolConnConfig,
} from "@/utils/warehouse/pool.server";

const base: PoolConnConfig = {
  host: "db.example.com",
  port: "5432",
  database: "analytics",
  username: "reader",
  password: "s3cret",
  ssl: "require",
};

beforeEach(() => {
  delete process.env.WAREHOUSE_POOL;
  delete process.env.WAREHOUSE_POOL_MAX_KEYS;
});

afterEach(async () => {
  await closeAllPools();
  delete process.env.WAREHOUSE_POOL;
  delete process.env.WAREHOUSE_POOL_MAX_KEYS;
});

describe("the pool key separates one credential set from another", () => {
  // Each of these is a distinct way to end up authenticated as the wrong
  // principal, so each gets its own case rather than a loop that reports
  // "something differed".
  const cases: [string, Partial<PoolConnConfig>][] = [
    ["host", { host: "other.example.com" }],
    ["port", { port: "5433" }],
    ["database", { database: "other_db" }],
    ["username", { username: "writer" }],
    ["password", { password: "rotated" }],
    ["ssl mode", { ssl: "disable" }],
  ];

  for (const [field, patch] of cases) {
    it(`changes when ${field} changes`, () => {
      expect(poolKey("postgres", { ...base, ...patch })).not.toBe(poolKey("postgres", base));
    });
  }

  it("changes when the wire family changes", () => {
    // Same credentials against a Postgres and a MySQL pool are different
    // objects with different drivers; sharing a key would hand a caller the
    // wrong driver entirely.
    expect(poolKey("mysql", base)).not.toBe(poolKey("postgres", base));
  });

  it("is stable for the same inputs", () => {
    expect(poolKey("postgres", { ...base })).toBe(poolKey("postgres", base));
  });

  it("cannot be confused by a field containing the separator", () => {
    // Joining on "|" is only ambiguous when a FIELD CONTAINS "|" — then the
    // boundary between two fields becomes unrecoverable and two different
    // principals hash identically. Length-prefixing is what fixes it.
    //
    // The first version of this test used ("ab","c") vs ("a","bc"), which the
    // plain join separates perfectly well. It passed against the unprefixed
    // implementation — a guard that never exercised the bug it named.
    const a = poolKey("postgres", { ...base, username: "alice|admin", password: "pw" });
    const b = poolKey("postgres", { ...base, username: "alice", password: "admin|pw" });
    expect(a).not.toBe(b);
  });

  it("never contains the password, or any input, in the clear", () => {
    // The key is a map key and shows up in stats and debugging. A raw
    // concatenation would put the password there.
    const key = poolKey("postgres", base);
    for (const secret of [base.password, base.username, base.host, base.database]) {
      expect(key).not.toContain(secret);
    }
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the registry hands back the right pool", () => {
  it("reuses one pool for the same credentials", async () => {
    const a = await getPool("postgres", base);
    const b = await getPool("postgres", base);
    expect(a).not.toBeNull();
    expect(b).toBe(a); // the same object, not merely an equal one
    expect(warehousePoolStats().pools).toBe(1);
  });

  it("NEVER shares a pool across two tenants on the same database", async () => {
    // The failure this prevents: tenant B queries the warehouse and gets a
    // session authenticated as tenant A.
    //
    // Varies the USERNAME ALONE. An earlier version changed the username and
    // the password together, so dropping either one from the key still left
    // the other distinguishing them and the test passed regardless.
    const a = await getPool("postgres", base);
    const b = await getPool("postgres", { ...base, username: "other_tenant" });
    expect(b).not.toBe(a);
    expect(warehousePoolStats().pools).toBe(2);
  });

  it("does not reuse a pool after the password is rotated", async () => {
    // Otherwise a revoked credential keeps working for as long as the process
    // lives — the pool is holding a session opened with the old one.
    const before = await getPool("postgres", base);
    const after = await getPool("postgres", { ...base, password: "rotated" });
    expect(after).not.toBe(before);
  });

  it("evicts the least-recently-used pool past the cap", async () => {
    process.env.WAREHOUSE_POOL_MAX_KEYS = "2";
    const first = await getPool("postgres", { ...base, database: "one" });
    await getPool("postgres", { ...base, database: "two" });
    await getPool("postgres", { ...base, database: "three" });

    expect(warehousePoolStats().pools).toBe(2);
    // `one` was the oldest, so it went; asking again builds a NEW pool rather
    // than returning the evicted object.
    const again = await getPool("postgres", { ...base, database: "one" });
    expect(again).not.toBe(first);
  });
});

describe("pooling can be turned off", () => {
  it("is on by default", () => {
    expect(poolingEnabled()).toBe(true);
  });

  it("returns null so the caller falls back to a per-query connection", async () => {
    for (const off of ["off", "0", "false", "no"]) {
      process.env.WAREHOUSE_POOL = off;
      expect(poolingEnabled(), `WAREHOUSE_POOL=${off}`).toBe(false);
      expect(await getPool("postgres", base)).toBeNull();
    }
  });
});

describe("the driver keeps one result shape for both paths", () => {
  const src = readFileSync("src/utils/warehouse/drivers.server.ts", "utf8");

  it("shapes pooled and unpooled Postgres results through one function", () => {
    // Two copies of the row-shaping means the pooled path can quietly return
    // a different answer, which is exactly what the benchmark's equality check
    // caught during development.
    expect((src.match(/shapePgResult\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("shapes pooled and unpooled MySQL results through one function", () => {
    expect((src.match(/shapeMySqlResult\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("an idle client error cannot take the process down", () => {
  const src = readFileSync("src/utils/warehouse/pool.server.ts", "utf8");

  it("listens for 'error' on the Postgres pool", () => {
    // `pg` emits 'error' on an IDLE client when the server closes the socket —
    // a restart, a failover, an idle-session timeout. An 'error' event with no
    // listener is an unhandled exception in Node: without this, pooling turns
    // a routine database restart into an app outage.
    const pg = src.slice(src.indexOf("async function createPgPool"));
    expect(pg.slice(0, pg.indexOf("async function createMySqlPool"))).toContain('pool.on("error"');
  });

  it("does NOT add a dead listener to the MySQL pool", () => {
    // The asymmetry is real and was verified in mysql2's source: it attaches
    // its own once('error') to each pooled connection (lib/pool_connection.js)
    // and the Pool object emits nothing. A listener here would be dead code
    // that reads as protection — worse than none. This guards against someone
    // "fixing" the apparent inconsistency.
    const my = src.slice(src.indexOf("async function createMySqlPool"));
    expect(my.slice(0, my.indexOf("export async function getPool"))).not.toContain('.on("error"');
  });

  it("does not hold the process open with its sweep timer", () => {
    // A bare setInterval keeps Node alive for ever; the CLI scripts and the
    // test runner would both hang on exit.
    expect(src).toMatch(/unref\?\.\(\)/);
  });
});
