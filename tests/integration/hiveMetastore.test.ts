// The connector against a REAL Hive Metastore, on tables real Hive created.
//
// Everything a hand-written Thrift client gets wrong shows up only here: field
// ids, what a method is called in this version, what a table Hive made actually
// holds. Skipped unless HIVE_METASTORE_TEST_URI is set.
//
//   docker run -d --name hms -p 127.0.0.1:19083:9083 \
//     -e SERVICE_NAME=metastore apache/hive:4.0.1
//   (load tests/fixtures/hive-metastore-seed.sql through HiveServer2)
//   HIVE_METASTORE_TEST_URI=thrift://127.0.0.1:19083 \
//     npx vitest run --config vitest.integration.config.ts tests/integration/hiveMetastore.test.ts
import { beforeAll, describe, expect, it } from "vitest";

import { parseMetastoreUri } from "@/lib/hiveMetastoreUri";
import {
  crawlHiveMetastore,
  testHiveMetastore,
  type HiveCrawl,
} from "@/utils/catalog/hive/crawl.server";
import type { HiveAsset } from "@/utils/catalog/hive/mapping";
import { getTables, withMetastore } from "@/utils/catalog/hive/metastore.server";

const URI = process.env.HIVE_METASTORE_TEST_URI;
/** A version label is optional, and differs by release. */
const expectedMajor = process.env.HIVE_METASTORE_TEST_MAJOR;

describe.skipIf(!URI)("a real Hive Metastore", () => {
  const address = parseMetastoreUri(URI ?? "");
  if (URI && !address.ok) throw new Error(address.error);
  const cfg = address.ok ? { host: address.host, port: address.port } : { host: "", port: 0 };
  let crawl: HiveCrawl;
  const asset = (fqn: string): HiveAsset => {
    const a = crawl.assets.find((x) => x.fqn === fqn);
    if (!a) throw new Error(`${fqn} is not in the crawl: ${crawl.assets.map((x) => x.fqn).join()}`);
    return a;
  };
  const column = (a: HiveAsset, name: string) => a.columns.find((c) => c.name === name);

  beforeAll(async () => {
    crawl = await crawlHiveMetastore(cfg);
  }, 60_000);

  it("connects, finds the transport, and says what it reached", async () => {
    const probe = await testHiveMetastore(cfg);
    expect(probe.framed).toBe(false);
    expect(probe.databases).toBeGreaterThanOrEqual(3);
    if (expectedMajor) expect(probe.version ?? "").toMatch(new RegExp(`^${expectedMajor}\\.`));
  });

  it("reads every database and every table, with nothing left unread", () => {
    expect(crawl.unread.firstError).toBeNull();
    expect(crawl.unread.tables).toEqual([]);
    expect(crawl.unread.namespaces).toEqual([]);
    expect(crawl.databases.map((d) => d.name)).toEqual(
      expect.arrayContaining(["default", "sales", "marketing"]),
    );
    expect(crawl.databases.find((d) => d.name === "sales")?.description).toBe(
      "Revenue data, owned by finance",
    );
  });

  it("a managed Parquet table: types, comments, format, the honest row count", () => {
    const orders = asset("sales.orders");
    expect(orders.asset_type).toBe("table");
    expect(orders.format).toBe("parquet");
    // Hive 4 turns a plain CREATE TABLE into an external one; earlier Hive does not.
    expect(orders.metadata.table_type).toMatch(/^(MANAGED|EXTERNAL)_TABLE$/);
    expect(orders.description).toBe("Every order we have taken");
    expect(column(orders, "amount")?.type).toBe("decimal(12,2)");
    expect(column(orders, "order_id")?.comment).toBe("Primary key");
    expect(orders.row_count).toBe(3);
    expect(orders.metadata.location).toMatch(/sales\.db\/orders/);
    expect(orders.metadata.serde).toMatch(/ParquetHiveSerDe/);
  });

  it("flags likely PII by column name", () => {
    expect(column(asset("sales.orders"), "customer_email")?.pii).toBe(true);
    expect(asset("sales.orders").pii).toBe(true);
    expect(column(asset("marketing.bucketed_users"), "ssn")?.pii).toBe(true);
  });

  it("a partitioned table: keys last and marked, with the real partitions", () => {
    const events = asset("sales.events");
    expect(events.format).toBe("orc");
    expect(events.columns.map((c) => c.name)).toEqual(["event_id", "payload", "dt", "region"]);
    expect(column(events, "dt")?.partition).toBe(true);
    expect(column(events, "event_id")?.partition).toBeUndefined();
    expect(events.metadata.partition_keys).toEqual(["dt", "region"]);
    expect(events.metadata.partition_count).toBe(3);
    expect(events.metadata.partition_count_capped).toBeUndefined();
    expect(events.metadata.first_partition).toBe("dt=2026-01-01/region=apac");
    expect(events.metadata.last_partition).toBe("dt=2026-01-02/region=emea");
  });

  it("an external table nothing has analysed reads as unknown, never as 0 rows", () => {
    const csv = asset("sales.customers_csv");
    expect(csv.format).toBe("csv");
    expect(csv.metadata.table_type).toBe("EXTERNAL_TABLE");
    expect(csv.row_count).toBeNull();
    expect(csv.metadata.properties?.["skip.header.line.count"]).toBe("1");
  });

  it("keeps nested types whole", () => {
    const campaigns = asset("marketing.campaigns");
    expect(campaigns.format).toBe("avro");
    expect(column(campaigns, "tags")?.type).toBe("array<string>");
    expect(column(campaigns, "budget")?.type).toBe("map<string,double>");
    expect(column(campaigns, "owner_info")?.type).toBe("struct<name:string,email:string>");
  });

  it("tells the text formats apart by their SerDe", () => {
    expect(asset("marketing.clicks_json").format).toBe("json");
    expect(asset("marketing.raw_log").format).toBe("text");
  });

  it("reads bucketing", () => {
    const users = asset("marketing.bucketed_users");
    expect(users.metadata.bucket_count).toBe(8);
    expect(users.metadata.bucket_columns).toEqual(["user_id"]);
  });

  it("NEVER carries a JDBC table's password, or its user, into the catalog", () => {
    expect(asset("sales.jdbc_ledger").name).toBe("jdbc_ledger");
    const everything = JSON.stringify(crawl);
    expect(everything).not.toContain("FIXTURE-NOT-A-REAL-PASSWORD");
    expect(everything).not.toContain("ledger_ro");
    expect(everything).not.toContain("ledger.internal");
  });

  it("a view: its SQL, and lineage to what it reads across databases", () => {
    const view = asset("sales.order_summary");
    expect(view.asset_type).toBe("view");
    expect(view.format).toBeNull();
    expect(view.row_count).toBeNull();
    expect(view.metadata.view_sql).toMatch(/sales\.orders/i);
    expect(view.description).toBe("Orders with campaign spend");
    expect(crawl.edges).toEqual(
      expect.arrayContaining([
        { upstream_fqn: "sales.orders", downstream_fqn: "sales.order_summary" },
        { upstream_fqn: "marketing.campaigns", downstream_fqn: "sales.order_summary" },
      ]),
    );
  });

  // Hive stores Iceberg tables natively from 4.0.
  it.skipIf(expectedMajor === "3")("an Iceberg table Hive wrote is an Iceberg table", () => {
    const iceberg = asset("sales.ledger_iceberg");
    expect(iceberg.format).toBe("iceberg");
    expect(iceberg.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["id", "memo"]));
    // SELECT count(*) says 3. Iceberg wrote it; Hive's accuracy flag never mentions it.
    expect(iceberg.row_count).toBe(3);
  });

  it("Spark's real columns, not its placeholder", () => {
    const spark = asset("sales.spark_users");
    expect(spark.format).toBe("parquet");
    expect(spark.columns.map((c) => c.name)).toEqual(["id", "email", "prefs"]);
    expect(column(spark, "id")?.type).toBe("long");
    expect(column(spark, "id")?.comment).toBe("user id");
    expect(column(spark, "prefs")?.type).toBe("map<string,integer>");
    expect(column(spark, "email")?.pii).toBe(true);
    // The metastore's layout for it is a stand-in, not its storage.
    expect(spark.metadata.serde).toBeUndefined();
  });

  // Hive 3 still answers the call older metastores have, and Hive 4 does not,
  // so this is the one real server that can prove the fallback's wire format.
  it.skipIf(expectedMajor !== "3")("reads tables through the legacy call too", async () => {
    await withMetastore(cfg, async (c) => {
      c.legacyTableCalls = true;
      const tables = await getTables(c, "sales", ["orders", "events"]);
      expect(tables.map((t) => t.name).sort()).toEqual(["events", "orders"]);
      expect(tables.find((t) => t.name === "events")?.partitionKeys.map((k) => k.name)).toEqual([
        "dt",
        "region",
      ]);
    });
  });

  it("refuses to pretend when the metastore is not there", async () => {
    await expect(testHiveMetastore({ host: cfg.host, port: 1 })).rejects.toThrow(/refused/);
  });
});
