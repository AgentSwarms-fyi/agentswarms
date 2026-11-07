// A table's own snapshots, partition transforms, and the change feed (R457),
// with the statements run against a real DuckLake catalog: an in-memory
// DuckDB with a scratch file catalog, so what is asserted is what the
// engine does, not what the SQL text looks like.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  describePartitionKey,
  fromDuckLakeTransform,
  partitionAdvice,
  partitionEstimateSql,
  partitionKeyError,
  partitionKeySql,
  transformsFor,
} from "@/utils/lakehouse/partitioning";
// (partitionable is exercised through transformsFor and partitionKeyError.)
import {
  changeCountsSql,
  changeFeedSql,
  describeChangeCounts,
  snapshotKinds,
  tableIdentitySql,
  tableSnapshotsSql,
} from "@/utils/lakehouse/tableHistory";

describe("partition keys", () => {
  it("offers time transforms only on dates and timestamps", () => {
    expect(transformsFor("TIMESTAMP WITH TIME ZONE")).toContain("hour");
    expect(transformsFor("DATE")).toEqual(["day", "month", "year", "identity", "bucket"]);
    expect(transformsFor("VARCHAR")).toEqual(["identity", "bucket"]);
  });

  it("offers nothing on a VARIANT, a nested value or a blob, and refuses one in words", () => {
    // The UI pass found the dialog offering `payload variant` like any column.
    for (const t of [
      "VARIANT",
      "STRUCT(a INTEGER)",
      "MAP(VARCHAR, INTEGER)",
      "INTEGER[]",
      "BLOB",
      "GEOMETRY",
    ]) {
      expect(transformsFor(t)).toEqual([]);
    }
    expect(partitionKeyError({ column: "payload", transform: "identity" }, "VARIANT")).toBe(
      "payload is variant, which cannot be a partition key: it would write a file set per distinct value.",
    );
  });

  it("refuses year() of text, which the engine would accept and mean nothing by", () => {
    expect(partitionKeyError({ column: "v", transform: "year" }, "VARCHAR")).toBe(
      "year() needs a date or a timestamp; v is varchar.",
    );
    expect(partitionKeyError({ column: "d", transform: "hour" }, "DATE")).toBe(
      "hour() needs a timestamp; d is date.",
    );
    expect(
      partitionKeyError({ column: "id", transform: "bucket", buckets: 1 }, "BIGINT"),
    ).toContain("from 2 to 1024");
    expect(partitionKeyError({ column: "x", transform: "identity" }, undefined)).toBe(
      'There is no column "x".',
    );
    expect(
      partitionKeyError({ column: "id", transform: "bucket", buckets: 16 }, "BIGINT"),
    ).toBeNull();
  });

  it("writes and reads back keys the way DuckLake records them", () => {
    expect(partitionKeySql({ column: "ts", transform: "day" })).toBe('day("ts")');
    expect(partitionKeySql({ column: "id", transform: "bucket", buckets: 8 })).toBe(
      'bucket(8, "id")',
    );
    expect(partitionKeySql({ column: 'we"ird', transform: "identity" })).toBe('"we""ird"');
    expect(fromDuckLakeTransform("id", "bucket(4)")).toEqual({
      column: "id",
      transform: "bucket",
      buckets: 4,
    });
    expect(fromDuckLakeTransform("r", null)).toEqual({ column: "r", transform: "identity" });
    expect(fromDuckLakeTransform("ts", "epoch_day")).toEqual({
      column: "ts",
      transform: "identity",
      unknown: "epoch_day",
    });
    expect(describePartitionKey({ column: "id", transform: "bucket", buckets: 4 })).toBe(
      "bucket(4, id)",
    );
  });

  // The UI pass: day(ts) and bucket(16, id) cut a 498-row table into ~330
  // partitions, and a re-insert of it took 150 s against the object store.
  it("warns before a spec cuts a small table into many small partitions", () => {
    const small = partitionAdvice({ rows: 498, bytes: 7_900, partitions: 330 });
    expect(small.level).toBe("warn");
    expect(small.text).toContain("330 partition(s), about 24 B each");
    expect(small.text).toContain("writes 330 small files");
    // Few partitions, or big ones, are what partitioning is for.
    expect(partitionAdvice({ rows: 498, bytes: 7_900, partitions: 3 }).level).toBe("ok");
    expect(partitionAdvice({ rows: 9e8, bytes: 400 * 1024 ** 3, partitions: 365 }).level).toBe(
      "ok",
    );
  });
});

describe("snapshot kinds", () => {
  it("names what a snapshot did to this table, by id or by name", () => {
    expect(snapshotKinds('{"tables_inserted_into":["2"],"inlined_delete":["2"]}', "2", [])).toEqual(
      ["inserted", "deleted"],
    );
    expect(snapshotKinds('{"tables_created":["s.a2"]}', "2", ["s.a", "s.a2"])).toEqual(["created"]);
    expect(snapshotKinds('{"tables_inserted_into":["3"]}', "2", ["s.a"])).toEqual([]);
    expect(snapshotKinds("not json", "2", [])).toEqual([]);
  });

  it("describes change counts in words", () => {
    expect(
      describeChangeCounts({ insert: 3, update_preimage: 2, update_postimage: 2, delete: 1 }),
    ).toBe("3 inserted, 2 updated, 1 deleted");
    expect(describeChangeCounts({})).toBe("no row changes");
  });
});

describe("against a real DuckLake catalog", () => {
  let dir = "";
  let c: DuckDBConnection;
  const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRows();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lake-history-")).replace(/\\/g, "/");
    const db = await DuckDBInstance.create(":memory:");
    c = await db.connect();
    await c.run(
      `LOAD ducklake; ATTACH 'ducklake:${dir}/cat.ducklake' AS lake (DATA_PATH '${dir}/data'); USE lake;`,
    );
    await c.run(
      "CREATE SCHEMA s; CREATE TABLE s.a (id INT, ts TIMESTAMP, v VARCHAR); CREATE TABLE s.other (id INT);",
    );
    await c.run(
      "INSERT INTO s.a SELECT i, TIMESTAMP '2026-01-01' + INTERVAL (i) DAY, 'x' FROM range(20) r(i)",
    );
    // Another table's commits, between this table's: the old list showed these.
    for (let i = 0; i < 15; i++) await c.run(`INSERT INTO s.other VALUES (${i})`);
    await c.run("UPDATE s.a SET v = 'y' WHERE id < 3");
    await c.run("DELETE FROM s.a WHERE id = 7");
  }, 60_000);

  afterAll(() => {
    c?.closeSync();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("lists only the snapshots that changed this table, though another table committed fifteen times since", async () => {
    const identity = await rows(tableIdentitySql("s", "a"));
    expect(identity).toHaveLength(1);
    const id = String(identity[0][0]);
    const names = identity.map((r) => String(r[1]));
    const snaps = await rows(tableSnapshotsSql(id, names, 20));
    const kinds = snaps.map((r) => snapshotKinds(String(r[2]), id, names).join("+"));
    expect(kinds).toEqual(["deleted", "inserted+deleted", "inserted", "created"]);
    // The whole lakehouse's latest twelve: none of them is this table's.
    const lakeWide = await rows(
      "SELECT snapshot_id FROM lake.snapshots() ORDER BY 1 DESC LIMIT 12",
    );
    const ours = new Set(snaps.map((r) => String(r[0])));
    expect(lakeWide.slice(2).every((r) => !ours.has(String(r[0])))).toBe(true);
  });

  it("follows the table through a rename, and the change feed starts at the rename", async () => {
    await c.run("ALTER TABLE s.a RENAME TO a2");
    const identity = await rows(tableIdentitySql("s", "a2"));
    expect(identity.map((r) => String(r[1]))).toEqual(["s.a", "s.a2"]);
    const current = identity.find((r) => r[3] === true);
    expect(current).toBeTruthy();
    const id = String(identity[0][0]);
    const snaps = await rows(
      tableSnapshotsSql(
        id,
        identity.map((r) => String(r[1])),
        20,
      ),
    );
    expect(snaps.length).toBe(5);
    const since = Number(current?.[2]);
    // Before the rename, the feed cannot be asked under the new name: the
    // server says so instead of passing the engine's error on.
    await expect(rows(changeCountsSql("s", "a2", since - 1))).rejects.toThrow(
      /does not exist at version/,
    );
  });

  it("shows the rows one snapshot changed", async () => {
    await c.run("CREATE TABLE s.feed (id INT, v VARCHAR)");
    await c.run("INSERT INTO s.feed SELECT i, 'x' FROM range(5) r(i)");
    await c.run("UPDATE s.feed SET v = 'y' WHERE id = 1");
    const [snap] = (await rows("SELECT max(snapshot_id) FROM lake.snapshots()")).map((r) =>
      Number(r[0]),
    );
    const counts = Object.fromEntries(
      (await rows(changeCountsSql("s", "feed", snap))).map((r) => [String(r[0]), Number(r[1])]),
    );
    expect(counts).toEqual({ update_postimage: 1, update_preimage: 1 });
    const feed = await c.runAndReadAll(
      changeFeedSql({ schema: "s", table: "feed", snapshot: snap, rowCap: 10 }),
    );
    expect(feed.columnNames()).toEqual(["change_type", "id", "v", "_row_id"]);
    expect(
      feed
        .getRows()
        .map((r) => `${r[0]}:${r[2]}`)
        .sort(),
    ).toEqual(["update_postimage:y", "update_preimage:x"]);
  });

  it("sets transformed partition keys the catalog then reports back", async () => {
    await c.run(
      `ALTER TABLE s.a2 SET PARTITIONED BY (${[
        partitionKeySql({ column: "ts", transform: "month" }),
        partitionKeySql({ column: "id", transform: "bucket", buckets: 4 }),
      ].join(", ")})`,
    );
    const back = await rows(
      `SELECT col.column_name, pc.transform FROM __ducklake_metadata_lake.ducklake_partition_info pi
       JOIN __ducklake_metadata_lake.ducklake_partition_column pc ON pc.partition_id = pi.partition_id AND pc.table_id = pi.table_id
       JOIN __ducklake_metadata_lake.ducklake_column col ON col.table_id = pi.table_id AND col.column_id = pc.column_id AND col.end_snapshot IS NULL
       WHERE pi.end_snapshot IS NULL ORDER BY pc.partition_key_index`,
    );
    expect(
      back.map((r) => describePartitionKey(fromDuckLakeTransform(String(r[0]), String(r[1])))),
    ).toEqual(["month(ts)", "bucket(4, id)"]);
  });

  it("estimates the partitions a spec makes as the files an insert then writes", async () => {
    await c.run("CREATE TABLE s.est (id INT, ts TIMESTAMP)");
    await c.run(
      "INSERT INTO s.est SELECT i, TIMESTAMP '2026-01-01' + INTERVAL (i * 7) HOUR FROM range(60) r(i)",
    );
    const day = { column: "ts", transform: "day" } as const;
    const [[n, partitions]] = await rows(partitionEstimateSql("s", "est", [day]));
    expect(Number(n)).toBe(60);
    expect(Number(partitions)).toBe(18); // 60 rows 7 h apart span 18 calendar days
    expect(
      Number(
        (
          await rows(partitionEstimateSql("s", "est", [{ column: "ts", transform: "month" }]))
        )[0][1],
      ),
    ).toBe(1);
    // What the engine then does: one file per partition the insert touched.
    await c.run(`ALTER TABLE s.est SET PARTITIONED BY (${partitionKeySql(day)})`);
    const before = Number(
      (await rows("SELECT count(*) FROM ducklake_list_files('lake', 'est', schema => 's')"))[0][0],
    );
    await c.run("INSERT INTO s.est SELECT * FROM s.est");
    const after = Number(
      (await rows("SELECT count(*) FROM ducklake_list_files('lake', 'est', schema => 's')"))[0][0],
    );
    expect(after - before).toBe(18);
  });
});
