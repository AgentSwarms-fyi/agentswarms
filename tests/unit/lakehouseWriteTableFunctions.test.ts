// A write statement may not call a table function.
//
// FOUND IN R226. A SELECT's table functions are found in DuckDB's own parse
// and refused. DuckDB will not serialize a write, so a write's reads were
// checked by a text scan that only sees `schema.table` names, and a table
// function inside CREATE TABLE … AS, INSERT … SELECT or a subquery ran with
// the engine's own access. Driven: from the SQL editor, the SELECT form was
// refused and the CREATE TABLE … AS form of the same read created the table.
//
// Behavioural where it can be: the function list is read from a real DuckDB
// in memory, the same query the engine runs, and every write shape is scanned
// with the real calledNames.
import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const { readTableFunctionNames } = await import("@/utils/lakehouse/core.server");
const { calledNames } = await import("@/utils/lakehouse/sqlRefs");

let fns: Set<string>;
beforeAll(async () => {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  fns = await readTableFunctionNames(c);
  c.closeSync();
});

const refused = (sql: string) => calledNames(sql).find((n) => fns.has(n)) ?? null;

describe("the engine's table functions", () => {
  it("include the file readers and leave out the pure generators", () => {
    for (const f of ["read_text", "read_blob", "read_parquet", "read_csv", "glob"]) {
      expect(fns.has(f), f).toBe(true);
    }
    for (const f of ["range", "generate_series", "unnest"]) expect(fns.has(f), f).toBe(false);
  });
});

describe("a write statement", () => {
  it("is refused when any of its shapes calls a table function", () => {
    const shapes = [
      "CREATE TABLE mine.t AS SELECT * FROM read_text('/etc/hostname')",
      "CREATE OR REPLACE VIEW mine.v AS SELECT * FROM read_parquet('s3://lake/x/*.parquet')",
      "INSERT INTO mine.t SELECT * FROM glob('/tmp/*')",
      "INSERT INTO mine.t VALUES ((SELECT content FROM read_text('/etc/hostname')))",
      "UPDATE mine.t SET c = (SELECT content FROM read_text('/etc/hostname'))",
      "DELETE FROM mine.t WHERE c IN (SELECT content FROM read_blob('/etc/hostname'))",
      "CREATE TABLE mine.t AS SELECT * FROM \"read_text\"('/etc/hostname')",
      "CREATE TABLE mine.t AS SELECT * FROM main.read_text ('/etc/hostname')",
      "CREATE TABLE mine.t AS SELECT * FROM READ_TEXT(/* c */ '/etc/hostname')",
    ];
    for (const sql of shapes) expect(refused(sql), sql).not.toBeNull();
  });

  it("runs as before when it calls only ordinary functions, or names a function in a string", () => {
    const fine = [
      "CREATE TABLE mine.t AS SELECT upper(a), count(*) FROM mine.s GROUP BY 1",
      "INSERT INTO mine.t (a, b) SELECT a, b FROM mine.s WHERE a IN (1, 2)",
      "INSERT INTO mine.t SELECT * FROM range(10)",
      "INSERT INTO mine.t VALUES ('read_text(''/etc/hostname'')')",
      "UPDATE mine.t SET note = 'see glob(x)' -- read_text(y)\nWHERE id = 1",
    ];
    for (const sql of fine) expect(refused(sql), sql).toBeNull();
  });
});

describe("the statement runner", () => {
  it("checks a write's calls before anything runs", () => {
    const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    const branch = core.indexOf('if (classified.kind !== "select") {');
    const check = core.indexOf("await assertNoTableFunctions(sql);", branch);
    const run = core.indexOf("for (let attempt", branch);
    expect(branch).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(branch);
    expect(check).toBeLessThan(run);
  });
});
