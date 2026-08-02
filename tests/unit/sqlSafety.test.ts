// The read-only guard for local SQL engines.
//
// This is a security boundary: everything downstream (AlaSQL in the browser,
// AlaSQL on the refresh path) will execute whatever gets past it, including
// DDL and DML. It previously existed in two copies with different holes — one
// blocked stacked statements but had no keyword denylist, the other the
// reverse. These tests pin both halves.
import { describe, expect, it } from "vitest";

import {
  checkLocalReadOnlySql,
  checkWarehouseReadOnlySql,
  isLocalReadOnlySql,
} from "@/lib/sqlSafety";

describe("accepts legitimate read-only queries", () => {
  for (const sql of [
    "SELECT * FROM orders",
    "select id from orders where region = 'EMEA'",
    "  SELECT 1  ",
    "SELECT * FROM orders;",
    "SELECT * FROM orders;;  ",
    "WITH t AS (SELECT 1 AS a) SELECT a FROM t",
    "-- a leading comment\nSELECT 1",
    "/* block */ SELECT 1",
  ]) {
    it(`accepts: ${sql.replace(/\n/g, "\\n")}`, () => {
      expect(isLocalReadOnlySql(sql)).toBe(true);
    });
  }

  it("returns the statement with trailing semicolons trimmed", () => {
    const v = checkLocalReadOnlySql("SELECT 1;;  ");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.sql).toBe("SELECT 1");
  });
});

describe("rejects writes and DDL", () => {
  for (const sql of [
    "INSERT INTO orders VALUES (1)",
    "UPDATE orders SET amount = 0",
    "DELETE FROM orders",
    "DROP TABLE orders",
    "ALTER TABLE orders ADD COLUMN x int",
    "CREATE TABLE evil (id int)",
    "TRUNCATE TABLE orders",
    "REPLACE INTO orders VALUES (1)",
    "ATTACH DATABASE 'x' AS y",
    "PRAGMA table_info(orders)",
    "GRANT ALL ON orders TO public",
    "EXEC sp_who",
  ]) {
    it(`rejects: ${sql}`, () => {
      expect(isLocalReadOnlySql(sql)).toBe(false);
    });
  }
});

describe("rejects statement stacking", () => {
  for (const sql of [
    "SELECT 1; DROP TABLE orders",
    "SELECT 1; SELECT 2",
    "SELECT 1;DELETE FROM orders",
    // Comment-hidden second statement: stripping comments must happen BEFORE
    // the semicolon check, or this smuggles a write past the guard.
    "SELECT 1 --x\n; DROP TABLE orders",
    "SELECT 1 /* x */ ; DROP TABLE orders",
  ]) {
    it(`rejects: ${sql.replace(/\n/g, "\\n")}`, () => {
      expect(isLocalReadOnlySql(sql)).toBe(false);
    });
  }
});

describe("rejects a mutating verb hidden behind a read-only prefix", () => {
  for (const sql of [
    "WITH x AS (SELECT 1) DELETE FROM orders",
    "SELECT * FROM (DELETE FROM orders RETURNING *) z",
  ]) {
    it(`rejects: ${sql}`, () => {
      expect(isLocalReadOnlySql(sql)).toBe(false);
    });
  }
});

describe("string literals are not mistaken for SQL", () => {
  // The denylist inspects structure only. Without literal stripping these are
  // rejected for containing a keyword inside quoted text — wrong, and the kind
  // of false positive that tempts someone to weaken the guard.
  for (const sql of [
    "SELECT id FROM orders WHERE note = 'please update the record'",
    "SELECT 'DROP TABLE orders' AS warning",
    "SELECT id FROM t WHERE msg = 'it''s a delete request'",
    "SELECT id FROM t WHERE label = 'create'",
  ]) {
    it(`accepts: ${sql}`, () => {
      expect(isLocalReadOnlySql(sql)).toBe(true);
    });
  }

  it("still rejects a real write that also contains a literal", () => {
    expect(isLocalReadOnlySql("DELETE FROM t WHERE note = 'select me'")).toBe(false);
  });
});

describe("rejects nonsense", () => {
  for (const sql of [
    "",
    "   ",
    "-- only a comment",
    "/* only a block comment */",
    "EXPLAIN SELECT 1",
  ]) {
    it(`rejects: ${JSON.stringify(sql)}`, () => {
      expect(isLocalReadOnlySql(sql)).toBe(false);
    });
  }

  it("explains why it refused", () => {
    const v = checkLocalReadOnlySql("DROP TABLE orders");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/read-only/i);
  });
});

// ── The warehouse guard, and the drift between the two ──────────────────────
//
// utils/warehouse/drivers.server had its own hand-rolled copy of this check
// for a long time. It had the leading-verb test and the stacked-statement
// test but NO mutation denylist, and this file's own header said the two
// should be kept "in sync in spirit" — which is not a mechanism.
//
// The gap was reachable and it wrote to production data: a DATA-MODIFYING CTE
// begins with WITH and contains no semicolon, so a leading-verb check waves it
// through. PostgreSQL and the five wire-compatible forks this project supports
// (CockroachDB, TimescaleDB, AlloyDB, Greenplum, YugabyteDB) all run them, and
// T-SQL's `WITH cte AS (SELECT …) DELETE FROM cte` covers SQL Server and Azure
// SQL. It is reachable from the SQL workbench and from BI direct-query, and a
// SHARED connection runs as its OWNER — so a grantee with read access could
// have deleted from the granting tenant's warehouse.
describe("the warehouse guard refuses what the local one refuses", () => {
  const MUTATIONS = [
    "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
    "WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i",
    "WITH u AS (UPDATE t SET x = 1 RETURNING *) SELECT * FROM u",
    "WITH cte AS (SELECT * FROM t) DELETE FROM cte",
    "SELECT 1; DROP TABLE users",
    "DROP TABLE users",
  ];

  for (const sql of MUTATIONS) {
    it(`refuses ${sql.slice(0, 46)}…`, () => {
      expect(checkWarehouseReadOnlySql(sql).ok, "warehouse guard allowed it").toBe(false);
      expect(checkLocalReadOnlySql(sql).ok, "local guard allowed it").toBe(false);
    });
  }

  it("still allows the read-only verbs a warehouse needs", () => {
    for (const sql of ["SHOW TABLES", "DESCRIBE orders", "EXPLAIN SELECT 1", "SELECT 1"]) {
      expect(checkWarehouseReadOnlySql(sql).ok, sql).toBe(true);
    }
  });

  it("differs from the local guard ONLY in the leading verb", () => {
    // The one legitimate difference, pinned. If someone adds a second
    // difference, that is drift, and drift here is how the denylist went
    // missing from one copy for as long as it did.
    const onlyWarehouse = ["SHOW TABLES", "DESCRIBE orders", "DESC orders", "EXPLAIN SELECT 1"];
    for (const sql of onlyWarehouse) {
      expect(checkWarehouseReadOnlySql(sql).ok, sql).toBe(true);
      expect(checkLocalReadOnlySql(sql).ok, sql).toBe(false);
    }
    // Everything else must agree, in both directions.
    const shared = [
      "SELECT * FROM t",
      "WITH a AS (SELECT 1) SELECT * FROM a",
      "SELECT note FROM t WHERE note = 'please update me'",
      "",
      "   ",
      "INSERT INTO t VALUES (1)",
      "SELECT 1; SELECT 2",
      ...MUTATIONS,
    ];
    for (const sql of shared) {
      expect(checkWarehouseReadOnlySql(sql).ok, `guards disagree on ${JSON.stringify(sql)}`).toBe(
        checkLocalReadOnlySql(sql).ok,
      );
    }
  });
});

describe("a column named after a keyword is not a mutation", () => {
  // Both guards refused these. A read-only query against a column called
  // "update" is ordinary, and a false positive on a security check is what
  // eventually persuades someone to weaken it.
  for (const sql of [
    'SELECT "update" FROM t',
    "SELECT `delete` FROM t",
    'SELECT t."drop" AS d FROM t WHERE t."create" > 1',
  ]) {
    it(`allows ${sql}`, () => {
      expect(checkLocalReadOnlySql(sql).ok, "local").toBe(true);
      expect(checkWarehouseReadOnlySql(sql).ok, "warehouse").toBe(true);
    });
  }

  it("does not let a quoted identifier hide a real statement", () => {
    // The stripping must not become a way to smuggle one past.
    expect(checkLocalReadOnlySql('SELECT "a" ; DROP TABLE t').ok).toBe(false);
    expect(checkWarehouseReadOnlySql('SELECT "a" ; DROP TABLE t').ok).toBe(false);
  });
});

describe("the driver's own entry point enforces it", () => {
  // The tests above exercise checkWarehouseReadOnlySql. The function the
  // driver actually calls is assertReadOnlySql, and for a long time that was a
  // separate implementation — so testing only the shared helper would pass
  // happily while the driver kept its own denylist-free copy. Test the thing
  // on the execution path.
  it("refuses a data-modifying CTE at executeWarehouseQuery's guard", async () => {
    const { assertReadOnlySql } = await import("@/utils/warehouse/drivers.server");
    expect(() =>
      assertReadOnlySql("WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d"),
    ).toThrow(/read-only/i);
    expect(() => assertReadOnlySql("WITH cte AS (SELECT * FROM t) DELETE FROM cte")).toThrow(
      /read-only/i,
    );
  });

  it("still returns the trimmed statement for a legitimate query", async () => {
    const { assertReadOnlySql } = await import("@/utils/warehouse/drivers.server");
    expect(assertReadOnlySql("SELECT 1;")).toBe("SELECT 1");
    expect(assertReadOnlySql("SHOW TABLES")).toBe("SHOW TABLES");
  });
});
