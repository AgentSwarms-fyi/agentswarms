// The Glue connector against moto's implementation of the Glue API.
//
// This proves the calls, the paging and the mapping. It proves nothing about
// AWS's signature check: moto does not verify one. Skipped unless
// GLUE_TEST_ENDPOINT is set.
//
//   docker run -d --name glue -p 127.0.0.1:15000:5000 motoserver/moto:5.1.4
//   GLUE_TEST_ENDPOINT=http://127.0.0.1:15000 \
//     npx vitest run --config vitest.integration.config.ts tests/integration/glueEmulator.test.ts
import { beforeAll, describe, expect, it } from "vitest";

import { crawlGlue, testGlue, type GlueConfig } from "@/utils/catalog/hive/glue.server";

const ENDPOINT = process.env.GLUE_TEST_ENDPOINT;

/** Far past one page: paging is where a hand-written client loses tables quietly. */
const BULK_TABLES = 130;

async function glue(operation: string, payload: unknown): Promise<void> {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSGlue.${operation}`,
      // moto reads the region from the credential scope.
      authorization:
        "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/glue/aws4_request, SignedHeaders=host, Signature=0",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok && !(await res.clone().text()).includes("AlreadyExists")) {
    throw new Error(`${operation}: ${res.status} ${await res.text()}`);
  }
}

describe.skipIf(!ENDPOINT)("the Glue API", () => {
  const cfg: GlueConfig = {
    region: "us-east-1",
    access_key_id: "testing",
    secret_access_key: "testing",
    endpoint: ENDPOINT,
  };
  const storage = {
    Columns: [
      { Name: "id", Type: "bigint", Comment: "the key" },
      { Name: "email", Type: "string" },
    ],
    Location: "s3://lake/orders/",
    InputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
    OutputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
    SerdeInfo: {
      SerializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
    },
  };

  beforeAll(async () => {
    await glue("CreateDatabase", {
      DatabaseInput: { Name: "analytics", Description: "Reporting tables" },
    });
    await glue("CreateDatabase", { DatabaseInput: { Name: "bulk" } });
    await glue("CreateTable", {
      DatabaseName: "analytics",
      TableInput: {
        Name: "orders",
        Description: "All orders",
        TableType: "EXTERNAL_TABLE",
        Parameters: { classification: "parquet", recordCount: "1200" },
        PartitionKeys: [{ Name: "dt", Type: "string" }],
        StorageDescriptor: storage,
      },
    });
    for (const dt of ["2026-01-01", "2026-01-02"]) {
      await glue("CreatePartition", {
        DatabaseName: "analytics",
        TableName: "orders",
        PartitionInput: { Values: [dt], StorageDescriptor: storage },
      });
    }
    const sql = "SELECT id FROM analytics.orders";
    await glue("CreateTable", {
      DatabaseName: "analytics",
      TableInput: {
        Name: "order_ids",
        TableType: "VIRTUAL_VIEW",
        ViewOriginalText: `/* Presto View: ${Buffer.from(JSON.stringify({ originalSql: sql })).toString("base64")} */`,
        ViewExpandedText: "/* Presto View */",
        StorageDescriptor: { Columns: [{ Name: "id", Type: "bigint" }] },
      },
    });
    for (let i = 0; i < BULK_TABLES; i++) {
      await glue("CreateTable", {
        DatabaseName: "bulk",
        TableInput: { Name: `t${String(i).padStart(3, "0")}`, StorageDescriptor: storage },
      });
    }
  }, 120_000);

  it("connects and counts", async () => {
    const probe = await testGlue(cfg);
    expect(probe.databases).toBeGreaterThanOrEqual(2);
  });

  it("reads tables, partitions and a view, with nothing left unread", async () => {
    const crawl = await crawlGlue(cfg);
    expect(crawl.unread.firstError).toBeNull();
    const orders = crawl.assets.find((a) => a.fqn === "analytics.orders");
    expect(orders).toMatchObject({
      format: "parquet",
      row_count: 1200,
      description: "All orders",
      pii: true,
    });
    expect(orders?.metadata.partition_keys).toEqual(["dt"]);
    expect(orders?.metadata.partition_count).toBe(2);
    expect(orders?.metadata.first_partition).toBe("dt=2026-01-01");
    expect(orders?.metadata.last_partition).toBe("dt=2026-01-02");

    const view = crawl.assets.find((a) => a.fqn === "analytics.order_ids");
    expect(view?.asset_type).toBe("view");
    expect(view?.metadata.view_sql).toBe("SELECT id FROM analytics.orders");
    expect(crawl.edges).toContainEqual({
      upstream_fqn: "analytics.orders",
      downstream_fqn: "analytics.order_ids",
    });
  });

  it("follows every page", async () => {
    const crawl = await crawlGlue(cfg);
    expect(crawl.assets.filter((a) => a.schema_name === "bulk")).toHaveLength(BULK_TABLES);
  });

  it("says so when the endpoint is not Glue, instead of a parser error", async () => {
    // moto's S3 answers an unsigned-looking path with XML: a 200 that is not JSON.
    const notGlue = { ...cfg, endpoint: `${ENDPOINT}/moto-api/` };
    await expect(testGlue(notGlue)).rejects.toThrow(/answered, but not as AWS Glue/);
  });

  it("says what AWS said when it refuses", async () => {
    await expect(testGlue({ ...cfg, endpoint: "http://127.0.0.1:1" })).rejects.toThrow(/Glue/);
  });
});
