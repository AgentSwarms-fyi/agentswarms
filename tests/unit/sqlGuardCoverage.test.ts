// Every path that EXECUTES SQL validates it first.
//
// biAgent turns a user's question into SQL with a language model. Nothing about
// that generation can be trusted — a prompt-injected document in a knowledge
// base, or simply a model having a bad day, can produce a DELETE as easily as a
// SELECT. So the guard belongs at the EXECUTION boundary, not at the point of
// generation, and that is where it is: five call sites, one per engine.
//
// Checked rather than assumed. Auditing biAgent for SQL safety found no guard
// in biAgent at all, which looks alarming until you follow the SQL to where it
// runs. This test exists so that stays true as engines are added — a sixth
// execution path with no check would be the whole protection gone, silently.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertLocalReadOnlySql,
  checkLocalReadOnlySql,
  checkWarehouseReadOnlySql,
} from "@/lib/sqlSafety";

/** Every module that hands SQL to an engine, and the guard it must call. */
const EXECUTION_PATHS: [file: string, guard: string][] = [
  ["src/lib/browserDuckdb.ts", "assertLocalReadOnlySql"],
  ["src/utils/data/duckdb.server.ts", "assertLocalReadOnlySql"],
  ["src/utils/data/localEngine.server.ts", "assertLocalReadOnlySql"],
  ["src/utils/bi/refresh.server.ts", "assertLocalReadOnlySql"],
  ["src/utils/warehouse/drivers.server.ts", "checkWarehouseReadOnlySql"],
];

describe("every engine validates before it executes", () => {
  for (const [file, guard] of EXECUTION_PATHS) {
    it(`${file.split("/").pop()} calls ${guard}`, () => {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} does not import the guard`).toContain(guard);
      // Called, not merely imported.
      expect(src, `${file} imports the guard without using it`).toMatch(
        new RegExp(`${guard}\\s*\\(`),
      );
    });
  }

  it("the model that writes the SQL is not the thing that checks it", () => {
    // biAgent generates; it must not be the place trust is decided, because a
    // guard there is bypassed by any caller that builds SQL another way.
    const bi = readFileSync("src/lib/biAgent.ts", "utf8");
    expect(bi).not.toContain("assertLocalReadOnlySql");
    expect(bi).not.toContain("checkWarehouseReadOnlySql");
  });
});

describe("what the guard actually refuses", () => {
  const REJECTED = [
    "DELETE FROM sales",
    "DROP TABLE sales",
    "UPDATE sales SET amount = 0",
    "INSERT INTO sales VALUES (1)",
    "TRUNCATE sales",
    "ALTER TABLE sales ADD COLUMN x int",
    "CREATE TABLE t (a int)",
    "GRANT ALL ON sales TO PUBLIC",
    // Stacked statements: the SELECT is a decoy.
    "SELECT 1; DROP TABLE sales",
    // A data-modifying CTE is a WITH that writes — the shape that made the
    // warehouse guard's leading-verb check insufficient on its own.
    "WITH d AS (DELETE FROM sales RETURNING *) SELECT * FROM d",
  ];

  it("refuses every statement that writes, on both engines", () => {
    for (const sql of REJECTED) {
      expect(checkLocalReadOnlySql(sql).ok, `local allowed: ${sql}`).toBe(false);
      expect(checkWarehouseReadOnlySql(sql).ok, `warehouse allowed: ${sql}`).toBe(false);
    }
  });

  it("allows the reads a question legitimately produces", () => {
    for (const sql of [
      "SELECT * FROM sales",
      "SELECT region, sum(amount) FROM sales GROUP BY region ORDER BY 2 DESC LIMIT 10",
      "WITH totals AS (SELECT region, sum(amount) a FROM sales GROUP BY region) SELECT * FROM totals",
    ]) {
      expect(checkLocalReadOnlySql(sql).ok, `local refused: ${sql}`).toBe(true);
    }
  });

  it("does not trip on a column or literal that merely reads like a keyword", () => {
    // Refusing these would break real questions — "which rows were updated?" is
    // a reasonable thing to ask of a table with an `update` column.
    for (const sql of [
      'SELECT "update" FROM audit',
      "SELECT * FROM t WHERE note = 'please delete this row'",
      "SELECT deleted_at FROM users WHERE deleted_at IS NULL",
    ]) {
      expect(checkLocalReadOnlySql(sql).ok, `refused a legitimate read: ${sql}`).toBe(true);
    }
  });

  it("throws rather than returning something executable", () => {
    // assertLocalReadOnlySql is the form the execution paths use, so its
    // failure mode is what actually protects them.
    expect(() => assertLocalReadOnlySql("DROP TABLE sales")).toThrow();
    expect(assertLocalReadOnlySql("SELECT 1")).toContain("SELECT 1");
  });
});
