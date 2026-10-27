// R388 (VA-2026-10-25-15): a local-engine query reads only the datasets loaded
// for it.
//
// Every dataset's Parquet mirror lives in the one directory the engine's
// sandbox allows. The sandbox keeps the engine out of the rest of the disk, but
// inside that directory it cannot tell one dataset's mirror from another's, so
// it is not what keeps a query to its own data. The statement itself is now
// parsed by DuckDB and refused if it calls a table function other than the
// pure generators or names a table that is not one of its loaded datasets.
//
// These call runLocalSqlDuckDB itself, with two real mirrors in the cache: one
// loaded for the query ("mine"), one that is not ("other").
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fwd = (p: string) => p.split("\\").join("/");

let dir: string;
let cache: string;
let mineFile: string;
let otherFile: string;
let run: typeof import("@/utils/data/duckdb.server").runLocalSqlDuckDB;

const cols = [
  { name: "id", type: "number" as const },
  { name: "label", type: "string" as const },
];

beforeAll(async () => {
  dir = fwd(mkdtempSync(join(tmpdir(), "read-scope-test-")));
  cache = `${dir}/cache`;
  mkdirSync(cache, { recursive: true });
  mineFile = `${cache}/aaaa1111.000000000001.parquet`;
  otherFile = `${cache}/bbbb2222.000000000002.parquet`;
  process.env.PARQUET_CACHE_DIR = cache;
  const mod = await import("@/utils/data/duckdb.server");
  run = mod.runLocalSqlDuckDB;
  await mod.writeTableToParquet(
    { name: "seed_a", columns: cols, rows: [{ id: 1, label: "mine" }] },
    mineFile,
  );
  await mod.writeTableToParquet(
    { name: "seed_b", columns: cols, rows: [{ id: 2, label: "other" }] },
    otherFile,
  );
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mine = () => [{ name: "sales", columns: [], rows: [], parquetPath: mineFile }];

async function refused(sql: string): Promise<string> {
  try {
    await run(sql, mine());
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`ran, but should have been refused: ${sql}`);
}

describe("a query cannot name a file or another dataset", () => {
  it("refuses a file-reading table function on the other mirror", async () => {
    expect(await refused(`SELECT * FROM read_parquet('${otherFile}')`)).toMatch(
      /read_parquet\(\) is not available here/,
    );
  });

  it("refuses a wildcard over the cache directory", async () => {
    expect(await refused(`SELECT * FROM read_parquet('${cache}/*.parquet')`)).toMatch(
      /not available here/,
    );
  });

  it("refuses listing or describing the cache", async () => {
    expect(await refused(`SELECT * FROM glob('${cache}/*')`)).toMatch(/glob\(\)/);
    expect(await refused(`SELECT * FROM parquet_metadata('${otherFile}')`)).toMatch(
      /parquet_metadata\(\)/,
    );
  });

  it("refuses a file path written as a table name", async () => {
    expect(await refused(`SELECT * FROM '${otherFile}'`)).toMatch(/not one of the datasets/);
  });

  it("refuses running other SQL through query()", async () => {
    expect(await refused(`SELECT * FROM query('SELECT 1')`)).toMatch(/query\(\)/);
  });

  it("refuses a table that was not loaded for this query", async () => {
    expect(await refused("SELECT * FROM not_loaded")).toMatch(/not one of the datasets/);
  });

  it("finds a file function inside a subquery or CTE too", async () => {
    expect(
      await refused(
        `WITH x AS (SELECT * FROM read_parquet('${otherFile}')) SELECT * FROM sales JOIN x USING (id)`,
      ),
    ).toMatch(/not available here/);
  });
});

describe("and ordinary SQL still runs", () => {
  it("reads its own mirrored dataset", async () => {
    const res = await run("SELECT label FROM sales", mine());
    expect(res.rows).toEqual([{ label: "mine" }]);
  });

  it("allows CTEs, joins of loaded datasets and schema-qualified names", async () => {
    const res = await run(
      "WITH s AS (SELECT * FROM main.sales) SELECT s.label, t.v FROM s JOIN t ON t.id = s.id",
      [
        ...mine(),
        {
          name: "t",
          columns: [
            { name: "id", type: "number" },
            { name: "v", type: "string" },
          ],
          rows: [{ id: 1, v: "x" }],
        },
      ],
    );
    expect(res.rows).toEqual([{ label: "mine", v: "x" }]);
  });

  it("allows the row generators", async () => {
    const res = await run(
      "SELECT count(*) AS n FROM range(3) r, generate_series(1, 2) g, (SELECT unnest([1, 2]) AS u) x",
      mine(),
    );
    expect(Number(res.rows[0].n)).toBe(12);
  });

  it("lets information_schema describe only this query's datasets", async () => {
    const res = await run(
      "SELECT DISTINCT table_name FROM information_schema.columns ORDER BY 1",
      mine(),
    );
    expect(res.rows).toEqual([{ table_name: "sales" }]);
  });
});

it("checks the statement before any dataset is loaded", () => {
  const src = readFileSync("src/utils/data/duckdb.server.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function runLocalSqlDuckDB("));
  const check = fn.indexOf("await assertReadsOnlyLoadedTables(");
  expect(check).toBeGreaterThan(-1);
  expect(check).toBeLessThan(fn.indexOf("await loadTable(connection, table)"));
});
