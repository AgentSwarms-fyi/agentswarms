// DuckLake's own sort order, which a clustered rewrite now records (R457),
// against a real DuckLake catalog: set, read back from DuckLake's catalog,
// honoured when inlined rows are flushed, and reset when the layout is
// cleared.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  describeSortKey,
  resetSortedSql,
  sortKeysSql,
  sortedBySql,
} from "@/utils/lakehouse/layout";

describe("DuckLake's sort order", () => {
  let dir = "";
  let c: DuckDBConnection;
  const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRows();
  const sortKeys = async () =>
    (await rows(sortKeysSql("s", "t"))).map((r) => describeSortKey(String(r[0]), String(r[1])));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lake-sort-")).replace(/\\/g, "/");
    const db = await DuckDBInstance.create(":memory:");
    c = await db.connect();
    await c.run(
      `LOAD ducklake; ATTACH 'ducklake:${dir}/cat.ducklake' AS lake (DATA_PATH '${dir}/data', DATA_INLINING_ROW_LIMIT 1000); USE lake;`,
    );
    await c.run("CREATE SCHEMA s; CREATE TABLE s.t (id INT, k INT)");
  }, 60_000);

  afterAll(() => {
    c?.closeSync();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("is recorded in DuckLake's catalog and read back from it", async () => {
    expect(await sortKeys()).toEqual([]);
    await c.run(sortedBySql("s", "t", ["k", "id"]));
    expect(await sortKeys()).toEqual(["k", "id"]);
  });

  it("puts rows flushed from the catalog in key order", async () => {
    // Small inserts stay inlined in the catalog; written in reverse order.
    for (let b = 3; b >= 0; b--) {
      await c.run(
        `INSERT INTO s.t SELECT i, ${b} * 100 + (i % 100) FROM range(${b * 100}, ${b * 100 + 100}) r(i)`,
      );
    }
    await c.run("CALL ducklake_flush_inlined_data('lake')");
    const ks = (await rows("SELECT k FROM s.t")).map((r) => Number(r[0]));
    expect(ks).toHaveLength(400);
    expect(ks).toEqual([...ks].sort((a, b) => a - b));
  });

  it("is forgotten when the layout is cleared", async () => {
    await c.run(resetSortedSql("s", "t"));
    expect(await sortKeys()).toEqual([]);
  });

  it("describes a descending key", () => {
    expect(describeSortKey("ts", "DESC")).toBe("ts DESC");
    expect(describeSortKey("ts", "ASC")).toBe("ts");
    expect(sortedBySql("s", "t", ['we"ird'])).toBe(`ALTER TABLE "s"."t" SET SORTED BY ("we""ird")`);
  });
});
