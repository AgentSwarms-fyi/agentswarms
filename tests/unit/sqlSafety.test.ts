// The read-only guard for local SQL engines.
//
// This is a security boundary: everything downstream (AlaSQL in the browser,
// AlaSQL on the refresh path) will execute whatever gets past it, including
// DDL and DML. It previously existed in two copies with different holes — one
// blocked stacked statements but had no keyword denylist, the other the
// reverse. These tests pin both halves.
import { describe, expect, it } from "vitest";

import { checkLocalReadOnlySql, isLocalReadOnlySql } from "@/lib/sqlSafety";

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
