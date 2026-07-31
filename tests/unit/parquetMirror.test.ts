// The columnar mirror.
//
// The property that matters is equivalence: a query answered from the Parquet
// mirror must return exactly what the same query returns from the rows. A
// cache that answers differently from its source is worse than no cache,
// because the difference is invisible until someone reconciles a number.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mirrorIsCurrent } from "@/utils/data/parquet.server";
import { runLocalSqlDuckDB, writeTableToParquet, type DuckTable } from "@/utils/data/duckdb.server";

let dir = "";
let parquetPath = "";

const source: DuckTable = {
  name: "orders",
  columns: [
    { name: "id", type: "number" },
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
    { name: "day", type: "date" },
  ],
  rows: [
    { id: 1, region: "EMEA", amount: 100, day: "2026-01-15" },
    { id: 2, region: "EMEA", amount: 250.5, day: "2026-02-01" },
    { id: 3, region: "APAC", amount: 0, day: "2026-02-14" },
    { id: 4, region: null, amount: -40, day: "2026-03-02" },
    // The empty string must survive the round trip as an empty string.
    { id: 5, region: "", amount: null, day: "2026-04-01" },
    { id: 6, region: "Zürich", amount: 12.25, day: "2026-05-30" },
  ],
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "parquet-test-"));
  parquetPath = path.join(dir, "orders.parquet");
  await writeTableToParquet(source, parquetPath);
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** The same query, once from rows and once from the mirror. */
async function both(sql: string) {
  const fromRows = await runLocalSqlDuckDB(sql, [source]);
  const fromMirror = await runLocalSqlDuckDB(sql, [
    { name: source.name, columns: source.columns, rows: [], parquetPath },
  ]);
  return { fromRows, fromMirror };
}

describe("mirror and rows answer identically", () => {
  it.each([
    ["select all", "SELECT * FROM orders ORDER BY id"],
    ["projection", "SELECT id, amount FROM orders ORDER BY id"],
    ["filter", "SELECT id FROM orders WHERE region = 'EMEA' ORDER BY id"],
    ["null filter", "SELECT id FROM orders WHERE region IS NULL"],
    ["empty-string filter", "SELECT id FROM orders WHERE region = ''"],
    ["aggregate", "SELECT SUM(amount) AS s, COUNT(*) AS n, AVG(amount) AS a FROM orders"],
    ["group by", "SELECT region, SUM(amount) AS s FROM orders GROUP BY region ORDER BY region"],
    ["ordering", "SELECT id FROM orders ORDER BY amount DESC"],
    ["date range", "SELECT id FROM orders WHERE day >= '2026-02-01' AND day < '2026-04-01'"],
    ["unicode", "SELECT id FROM orders WHERE region = 'Zürich'"],
    ["negative and zero", "SELECT id FROM orders WHERE amount <= 0 ORDER BY id"],
  ])("%s", async (_label, sql) => {
    const { fromRows, fromMirror } = await both(sql);
    expect(fromMirror.rows).toEqual(fromRows.rows);
  });

  it("preserves the empty string as distinct from NULL", async () => {
    const res = await runLocalSqlDuckDB("SELECT id FROM orders WHERE region IS NULL", [
      { name: "orders", columns: source.columns, rows: [], parquetPath },
    ]);
    // Only row 4 is NULL; row 5 is the empty string.
    expect(res.rows).toEqual([{ id: 4 }]);
  });

  it("keeps numeric types, so SUM is a number not a concatenation", async () => {
    const res = await runLocalSqlDuckDB("SELECT SUM(amount) AS s FROM orders", [
      { name: "orders", columns: source.columns, rows: [], parquetPath },
    ]);
    expect(res.rows[0].s).toBeCloseTo(322.75, 6);
  });

  it("still normalises DuckDB types on the way out", async () => {
    const res = await runLocalSqlDuckDB("SELECT COUNT(*) AS n FROM orders", [
      { name: "orders", columns: source.columns, rows: [], parquetPath },
    ]);
    expect(typeof res.rows[0].n).toBe("number");
    expect(() => JSON.stringify(res.rows)).not.toThrow();
  });

  it("joins a mirrored dataset to a row-backed one", async () => {
    const lookup: DuckTable = {
      name: "regions",
      columns: [
        { name: "region", type: "string" },
        { name: "label", type: "string" },
      ],
      rows: [{ region: "EMEA", label: "Europe" }],
    };
    const res = await runLocalSqlDuckDB(
      "SELECT o.id, r.label FROM orders o INNER JOIN regions r ON o.region = r.region ORDER BY o.id",
      [{ name: "orders", columns: source.columns, rows: [], parquetPath }, lookup],
    );
    expect(res.rows).toEqual([
      { id: 1, label: "Europe" },
      { id: 2, label: "Europe" },
    ]);
  });
});

describe("read-only enforcement still applies to mirrored tables", () => {
  it.each(["DROP TABLE orders", "INSERT INTO orders VALUES (9)", "SELECT 1; DROP TABLE orders"])(
    "refuses %s",
    async (sql) => {
      await expect(
        runLocalSqlDuckDB(sql, [
          { name: "orders", columns: source.columns, rows: [], parquetPath },
        ]),
      ).rejects.toThrow();
    },
  );
});

describe("staleness decides whether a mirror may be used", () => {
  const base = { tableId: "t", userId: "u" };

  it("is unusable when it was never written", () => {
    expect(
      mirrorIsCurrent({ ...base, parquet_synced_at: null, data_loaded_at: "2026-01-01T00:00:00Z" }),
    ).toBe(false);
  });

  it("is unusable when the rows were written after it", () => {
    // The critical case: a browser-side save bumped data_loaded_at and could
    // not rebuild the mirror. Using it would serve last week's numbers.
    expect(
      mirrorIsCurrent({
        ...base,
        parquet_synced_at: "2026-01-01T00:00:00Z",
        data_loaded_at: "2026-02-01T00:00:00Z",
      }),
    ).toBe(false);
  });

  it("is usable when it is newer than the last row write", () => {
    expect(
      mirrorIsCurrent({
        ...base,
        parquet_synced_at: "2026-02-02T00:00:00Z",
        data_loaded_at: "2026-02-01T00:00:00Z",
      }),
    ).toBe(true);
  });

  it("is usable at exactly the same instant", () => {
    expect(
      mirrorIsCurrent({
        ...base,
        parquet_synced_at: "2026-02-01T00:00:00Z",
        data_loaded_at: "2026-02-01T00:00:00Z",
      }),
    ).toBe(true);
  });

  it("is usable when the dataset has no recorded load time", () => {
    expect(
      mirrorIsCurrent({ ...base, parquet_synced_at: "2026-02-01T00:00:00Z", data_loaded_at: null }),
    ).toBe(true);
  });
});
