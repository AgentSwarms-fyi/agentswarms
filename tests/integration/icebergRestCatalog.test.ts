// The Iceberg statements against a real REST catalog and tables another
// engine wrote: Spark 4.1 with Iceberg 1.12 seeds sales.orders_v3 (format 3,
// deletion vectors, a branch and a tag, an evolved schema and partition spec),
// sales.orders_v2 and `sales-prod`.`daily-metrics` (R457). Skipped unless
// ICEBERG_TEST_ENDPOINT names the catalog and ICEBERG_TEST_S3_* the store its
// files are in. Writes only into the namespace it creates, and drops it.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultIcebergCatalog,
  duplicateKeysSql,
  icebergAttachSql,
  icebergMergeSql,
  icebergPublishSql,
  icebergViewName,
  icebergViewSql,
} from "@/utils/lakehouse/iceberg";
import {
  allSnapshotIds,
  fileCountsFrom,
  inspectIcebergMetadata,
  mountViewTarget,
  resolveSnapshotRef,
} from "@/utils/lakehouse/icebergInspect";

const ENDPOINT = process.env.ICEBERG_TEST_ENDPOINT;
const S3 = process.env.ICEBERG_TEST_S3_ENDPOINT;
const KEY = process.env.ICEBERG_TEST_S3_KEY;
const SECRET = process.env.ICEBERG_TEST_S3_SECRET;
const alias = `ice_${"0".repeat(31)}1`;
const ns = `r457_${Date.now().toString(36)}`;

describe.skipIf(!ENDPOINT || !S3 || !KEY || !SECRET)("a real Iceberg REST catalog", () => {
  let c: DuckDBConnection;
  const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
  const one = async (sql: string) => Number(Object.values((await rows(sql))[0] ?? {})[0]);
  const metadataOf = async (q: string) =>
    (await rows(`SELECT metadata FROM iceberg_load_table_response(${q})`))[0].metadata;
  const filesOf = async (q: string) =>
    fileCountsFrom(
      (
        await rows(
          `SELECT manifest_content, content, file_format, count(*)::BIGINT files, coalesce(sum(record_count),0)::BIGINT records FROM iceberg_metadata(${q}) WHERE status <> 'DELETED' GROUP BY ALL`,
        )
      ).map((r) => ({
        manifest_content: String(r.manifest_content),
        content: String(r.content),
        file_format: String(r.file_format),
        files: Number(r.files),
        records: Number(r.records),
      })),
    );

  beforeAll(async () => {
    const db = await DuckDBInstance.create(":memory:");
    c = await db.connect();
    await c.run("LOAD iceberg; LOAD httpfs; LOAD ducklake;");
    await c.run(
      `CREATE SECRET test_s3 (TYPE s3, KEY_ID '${KEY}', SECRET '${SECRET}', ENDPOINT '${S3}', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1')`,
    );
    // The attach the app sends for "read with the lakehouse's own credentials".
    await c.run(
      icebergAttachSql(alias, {
        ...defaultIcebergCatalog(),
        name: "rig",
        endpoint: ENDPOINT ?? "",
        warehouse: "",
        storage: "lakehouse",
      }).replace("ATTACH IF NOT EXISTS ''", "ATTACH ''"),
    );
    // A lakehouse to mount into: a scratch in-memory DuckLake stand-in.
    // The app's connection has `lake` as its default catalog, as here: a
    // mount's view is created under it unqualified.
    await c.run(
      "ATTACH ':memory:' AS lake; USE lake; CREATE SCHEMA lake.ice_sales; CREATE SCHEMA lake.analytics;",
    );
  }, 120_000);

  afterAll(async () => {
    try {
      for (const t of ["published", "upserted"])
        await c.run(`DROP TABLE IF EXISTS "${alias}"."${ns}"."${t}"`);
      await c.run(`DROP SCHEMA IF EXISTS "${alias}"."${ns}"`);
    } finally {
      c?.closeSync();
    }
  });

  it("reads Spark's v3 table with its deletion vectors applied, as Spark counts it", async () => {
    expect(await one(`SELECT count(*) FROM "${alias}".sales.orders_v3`)).toBe(10125);
    expect(await one(`SELECT count(*) FROM "${alias}".sales.orders_v2`)).toBe(1800);
  });

  it("mounts a hyphenated namespace's table, and finds it again from the view the engine stored", async () => {
    const view = icebergViewName("daily-metrics");
    expect(view).toBe("daily_metrics");
    await c.run(icebergViewSql("ice_sales", view ?? "", alias, "sales-prod", "daily-metrics"));
    expect(await one(`SELECT count(*) FROM lake.ice_sales.daily_metrics`)).toBe(100);
    const [{ sql }] = await rows(
      "SELECT sql FROM duckdb_views() WHERE database_name = 'lake' AND schema_name = 'ice_sales' AND view_name = 'daily_metrics'",
    );
    expect(mountViewTarget(String(sql))).toEqual({
      alias,
      namespace: "sales-prod",
      table: "daily-metrics",
    });
  });

  it("inspects the table from its own metadata, and time-travels to its tag and branch", async () => {
    const q = `"${alias}".sales.orders_v3`;
    const md = await metadataOf(q);
    const t = inspectIcebergMetadata(md, await filesOf(q), {
      catalog: "rig",
      namespace: "sales",
      table: "orders_v3",
    });
    expect(t.format_version).toBe(3);
    expect(t.features.deletion_vectors).toBe(true);
    expect(t.refs.map((r) => r.name).sort()).toEqual(["audit", "main", "q3-close"]);
    const ids = allSnapshotIds(md);
    const tag = resolveSnapshotRef(t.refs, ids, "q3-close");
    const branch = resolveSnapshotRef(t.refs, ids, "audit");
    // What Spark counted at the tag and on the branch when it wrote them.
    expect(await one(`SELECT count(*) FROM ${q} AT (VERSION => ${tag})`)).toBe(9975);
    expect(await one(`SELECT count(*) FROM ${q} AT (VERSION => ${branch})`)).toBe(10126);
  });

  it("publishes as v3 with a partition spec, then upserts by key in one commit", async () => {
    await c.run(
      "CREATE TABLE lake.analytics.src AS SELECT i::BIGINT AS id, TIMESTAMP '2026-01-01' + INTERVAL (i) DAY AS ts, 'r' || (i % 3) AS region, {'n': i}::VARIANT AS payload FROM range(40) t(i)",
    );
    const columns = (
      await rows(
        "SELECT column_name AS name, data_type AS type FROM duckdb_columns() WHERE database_name = 'lake' AND schema_name = 'analytics' AND table_name = 'src' ORDER BY column_index",
      )
    ).map((r) => ({ name: String(r.name), type: String(r.type) }));
    const plan = icebergPublishSql({
      alias,
      namespace: ns,
      table: "published",
      sourceSchema: "analytics",
      sourceTable: "src",
      mode: "create",
      columns,
      layout: {
        formatVersion: 3,
        partition: [
          { column: "ts", transform: "month" },
          { column: "id", transform: "bucket", width: 4 },
        ],
      },
    });
    for (const sql of plan) await c.run(sql);
    const q = `"${alias}"."${ns}".published`;
    expect(await one(`SELECT count(*) FROM ${q}`)).toBe(40);
    const t = inspectIcebergMetadata(await metadataOf(q), await filesOf(q), {
      catalog: "rig",
      namespace: ns,
      table: "published",
    });
    expect(t.format_version).toBe(3);
    expect(t.features.variant).toBe(true);
    expect(t.partition_spec.map((p) => `${p.transform}(${p.source})`)).toEqual([
      "month(ts)",
      "bucket[4](id)",
    ]);

    // Upsert: ten rows change, five are new.
    await c.run(
      "CREATE OR REPLACE TABLE lake.analytics.src AS SELECT i::BIGINT AS id, TIMESTAMP '2026-01-01' + INTERVAL (i) DAY AS ts, CASE WHEN i >= 30 THEN 'changed' ELSE 'r' || (i % 3) END AS region, {'n': i}::VARIANT AS payload FROM range(30, 45) t(i)",
    );
    expect(await one(duplicateKeysSql("analytics", "src", ["id"]))).toBe(0);
    const commits = async () =>
      ((await metadataOf(q)) as { "metadata-log"?: unknown[] })["metadata-log"]?.length ?? 0;
    const before = await commits();
    await c.run(
      icebergMergeSql({
        alias,
        namespace: ns,
        table: "published",
        sourceSchema: "analytics",
        sourceTable: "src",
        columns,
        keys: ["id"],
      }),
    );
    expect(await one(`SELECT count(*) FROM ${q}`)).toBe(45);
    expect(await one(`SELECT count(*) FROM ${q} WHERE region = 'changed'`)).toBe(15);
    // One MERGE, one transaction, one catalog commit: one new metadata file.
    // The engine records it as two snapshots (an overwrite, then an append)
    // inside that one commit, so no reader sees the state between them.
    expect((await commits()) - before).toBe(1);
  });

  it("sees a key that appears twice before an upsert can be ambiguous", async () => {
    await c.run(
      "CREATE OR REPLACE TABLE lake.analytics.dups AS SELECT * FROM (VALUES (1, 'a'), (1, 'b'), (2, 'c')) t(id, v)",
    );
    expect(await one(duplicateKeysSql("analytics", "dups", ["id"]))).toBe(1);
  });
});
