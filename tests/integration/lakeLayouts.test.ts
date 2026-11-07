// A bucket crawl against real lake layouts, written by the tools that write them:
// DuckDB's PARTITION_BY, Spark's Delta with a DELETE, Hive 4's Iceberg. Skipped
// unless LAKE_TEST_ENDPOINT and LAKE_TEST_SECRET name an S3 store holding them.
import { beforeAll, describe, expect, it } from "vitest";

import { crawlObjectStorage, type CrawledAsset } from "@/utils/catalog/crawler.server";
import type { ObjectStoreConfig } from "@/utils/catalog/objectStore.server";
import { readObjectRows } from "@/utils/catalog/objectStoreRead.server";

const ENDPOINT = process.env.LAKE_TEST_ENDPOINT;
const SECRET = process.env.LAKE_TEST_SECRET;

describe.skipIf(!ENDPOINT || !SECRET)("real lake layouts in a bucket", () => {
  const cfg: ObjectStoreConfig = {
    provider: "minio",
    endpoint: ENDPOINT,
    region: "us-east-1",
    bucket: "lake",
    path_style: true,
    access_key_id: "catalogtest",
    secret_access_key: SECRET ?? "",
  };
  let assets: CrawledAsset[];
  const named = (fqn: string) => {
    const a = assets.find((x) => x.fqn === fqn);
    if (!a) throw new Error(`${fqn} not crawled: ${assets.map((x) => x.fqn).join(", ")}`);
    return a;
  };

  beforeAll(async () => {
    ({ assets } = await crawlObjectStorage(cfg));
  }, 120_000);

  it("a partitioned table is one asset, not one per folder", () => {
    expect(assets.filter((a) => a.fqn.startsWith("warehouse/sales"))).toHaveLength(1);
    const sales = named("warehouse/sales/**/*.parquet");
    expect(sales.name).toBe("sales");
    expect(sales.file_count).toBe(30);
    expect(sales.metadata?.partition_keys).toEqual(["dt", "region"]);
    expect(sales.metadata?.partition_count).toBe(30);
    expect(sales.metadata?.first_partition).toBe("dt=2026-01-01/region=emea");
    expect(sales.metadata?.last_partition).toBe("dt=2026-01-30/region=apac");
  });

  it("counts a Parquet table from its footers, exactly", () => {
    const sales = named("warehouse/sales/**/*.parquet");
    // Scaling the largest file by size said 5,956.
    expect(sales.row_count).toBe(6000);
    expect(sales.metadata?.row_count_estimated).toBe(false);
  });

  it("lists its partition columns, marked, after the data columns", () => {
    const sales = named("warehouse/sales/**/*.parquet");
    expect(sales.columns.map((c) => c.name)).toEqual([
      "order_id",
      "customer_email",
      "amount",
      "dt",
      "region",
    ]);
    expect(sales.columns.filter((c) => c.partition).map((c) => c.name)).toEqual(["dt", "region"]);
    expect(sales.pii).toBe(true);
  });

  it("a text table gets the partition column its files cannot show", () => {
    const clicks = named("warehouse/clicks/**/*.csv");
    expect(clicks.columns.find((c) => c.name === "dt")?.partition).toBe(true);
    expect(clicks.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["id", "url"]));
  });

  it("the glob reads every partition, with its columns", async () => {
    const read = await readObjectRows(cfg, "warehouse/sales/**/*.parquet", "parquet", 10_000);
    expect(read.rows).toHaveLength(6000);
    expect(read.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["dt", "region"]));
    expect(new Set(read.rows.map((r) => r.dt)).size).toBe(30);
  });

  it("a Delta table is one asset, read from its own log", () => {
    expect(assets.filter((a) => a.fqn.startsWith("warehouse/payments"))).toHaveLength(1);
    const payments = named("warehouse/payments/");
    expect(payments.name).toBe("payments");
    expect(payments.format).toBe("delta");
    expect(payments.columns.map((c) => c.name)).toEqual([
      "payment_id",
      "card_holder_email",
      "amount",
      "dt",
    ]);
    expect(payments.columns.find((c) => c.name === "payment_id")?.comment).toBe("Primary key");
    expect(payments.columns.find((c) => c.name === "dt")?.partition).toBe(true);
    expect(payments.description).toBe("Card payments");
    expect(payments.metadata?.partition_keys).toEqual(["dt"]);
    expect(payments.metadata?.table_type).toBe("DELTA");
    expect(payments.metadata?.snapshot_count).toBeGreaterThanOrEqual(3);
  });

  it("...and why it must be: a scan of its files returns the row it deleted", async () => {
    // Spark wrote three rows and DELETEd one, so the table holds two. The file
    // holding the deleted row is still in the folder.
    const scan = await readObjectRows(cfg, "warehouse/payments/**/*.parquet", "parquet", 1_000);
    expect(scan.rows.length).toBeGreaterThan(2);
    expect(scan.rows.map((r) => Number(r.payment_id))).toContain(1);
    // So the catalog claims no count, and offers no glob to scan.
    const payments = named("warehouse/payments/");
    expect(payments.row_count).toBeNull();
    expect(payments.fqn).not.toMatch(/\*/);
  });

  it("an Iceberg table is one asset, with the count it records", () => {
    expect(assets.filter((a) => a.fqn.startsWith("warehouse/ledger_iceberg"))).toHaveLength(1);
    const ledger = named("warehouse/ledger_iceberg/");
    expect(ledger.format).toBe("iceberg");
    expect(ledger.row_count).toBe(3);
    expect(ledger.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["id", "memo", "year"]),
    );
    expect(ledger.metadata?.format_version).toBeGreaterThanOrEqual(1);
    expect(ledger.metadata?.partition_keys).toEqual(["year"]);
  });

  it("leaves what is not a lake table as it always was", () => {
    expect(named("plain/products/*.parquet").name).toBe("products");
    expect(named("plain/products/*.parquet").row_count).toBe(100);
    expect(named("plain/*.csv").columns.map((c) => c.name)).toEqual(["id", "twice"]);
  });
});
