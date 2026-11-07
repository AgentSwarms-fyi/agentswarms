// A Glue table is a Hive table with different field names, so what is specific
// to Glue is small: its wire, a region that goes into a host name, the way
// Athena wraps a view, and what a Glue crawler writes into a table's parameters.
import { describe, expect, it } from "vitest";

import { decodeAthenaView, glueEndpoint, glueTableToHive } from "@/utils/catalog/hive/glue.server";
import { hiveFormat, hiveTableToAsset, hiveViewUpstreams } from "@/utils/catalog/hive/mapping";

describe("where a call goes", () => {
  it("the regional endpoint, by the region", () => {
    expect(glueEndpoint({ region: "eu-west-1" })).toBe("https://glue.eu-west-1.amazonaws.com");
    expect(glueEndpoint({ region: "us-gov-west-1" })).toBe(
      "https://glue.us-gov-west-1.amazonaws.com",
    );
    expect(glueEndpoint({ region: "cn-north-1" })).toBe("https://glue.cn-north-1.amazonaws.com.cn");
  });

  it("a region that is not one never reaches a host name", () => {
    for (const region of ["metadata.attacker.test#", "us-east-1.evil.com/", "", "a b"]) {
      expect(() => glueEndpoint({ region })).toThrow(/not an AWS region/);
    }
  });

  it("an endpoint does not excuse the region: it is still signed", () => {
    expect(() =>
      glueEndpoint({ region: "evil.example.com/x", endpoint: "https://vpce-1.glue.example.com" }),
    ).toThrow(/not an AWS region/);
  });

  it("a configured endpoint wins", () => {
    expect(
      glueEndpoint({ region: "us-east-1", endpoint: "https://vpce-1.glue.example.com/" }),
    ).toBe("https://vpce-1.glue.example.com");
  });
});

describe("an Athena view", () => {
  const blob = (sql: string) =>
    `/* Presto View: ${Buffer.from(JSON.stringify({ originalSql: sql, catalog: "awsdatacatalog" })).toString("base64")} */`;

  it("is SQL once unwrapped, not a blob", () => {
    expect(decodeAthenaView(blob("SELECT * FROM sales.orders"))).toBe("SELECT * FROM sales.orders");
  });

  it("anything else passes through untouched", () => {
    expect(decodeAthenaView("SELECT 1")).toBe("SELECT 1");
    expect(decodeAthenaView(undefined)).toBeUndefined();
    expect(decodeAthenaView("/* Presto View: not-base64! */")).toBe(
      "/* Presto View: not-base64! */",
    );
  });

  it("gives the catalog its definition and its upstreams", () => {
    const t = glueTableToHive(
      {
        Name: "summary",
        TableType: "VIRTUAL_VIEW",
        ViewOriginalText: blob("SELECT id FROM sales.orders JOIN mkt.camps ON 1=1"),
        ViewExpandedText: "/* Presto View */",
      },
      "sales",
    );
    expect(hiveViewUpstreams(t)).toEqual(["sales.orders", "mkt.camps"]);
    expect(hiveTableToAsset(t).metadata.view_sql).toBe(
      "SELECT id FROM sales.orders JOIN mkt.camps ON 1=1",
    );
  });
});

describe("a Glue table", () => {
  const raw = {
    Name: "orders",
    DatabaseName: "sales",
    Description: "All orders",
    Owner: "etl",
    CreateTime: 1767225600.5,
    TableType: "EXTERNAL_TABLE",
    Parameters: {
      classification: "parquet",
      recordCount: "1200",
      sizeKey: "4096",
      objectCount: "3",
      "aws.secret": "should-not-travel",
    },
    PartitionKeys: [{ Name: "dt", Type: "string" }],
    StorageDescriptor: {
      Columns: [
        { Name: "id", Type: "bigint", Comment: "the key" },
        { Name: "email", Type: "string" },
      ],
      Location: "s3://lake/orders/",
      InputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
      SerdeInfo: {
        SerializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
      },
    },
  };

  it("maps to the catalog's asset, the crawler's findings included", () => {
    const a = hiveTableToAsset(glueTableToHive(raw, "sales"), { count: 2, capped: false });
    expect(a).toMatchObject({
      fqn: "sales.orders",
      format: "parquet",
      row_count: 1200,
      size_bytes: 4096,
      file_count: 3,
      description: "All orders",
      pii: true,
    });
    expect(a.columns.map((c) => c.name)).toEqual(["id", "email", "dt"]);
    expect(a.metadata).toMatchObject({
      location: "s3://lake/orders/",
      table_type: "EXTERNAL_TABLE",
      partition_keys: ["dt"],
      partition_count: 2,
      source_owner: "etl",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("carries no parameter it does not know to be safe", () => {
    const a = hiveTableToAsset(glueTableToHive(raw, "sales"));
    expect(JSON.stringify(a)).not.toContain("should-not-travel");
    expect(a.metadata.properties?.classification).toBe("parquet");
  });

  it("a crawler's classification names the format when the classes do not", () => {
    expect(
      hiveFormat(glueTableToHive({ Name: "t", Parameters: { classification: "csv" } }, "d")),
    ).toBe("csv");
  });

  it("an Iceberg table registered by Athena is Iceberg", () => {
    expect(
      hiveFormat(
        glueTableToHive(
          {
            Name: "t",
            Parameters: { table_type: "ICEBERG", metadata_location: "s3://b/m.json" },
          },
          "d",
        ),
      ),
    ).toBe("iceberg");
  });

  it("a crawler's zero is not a measurement", () => {
    const a = hiveTableToAsset(
      glueTableToHive({ Name: "t", Parameters: { recordCount: "0", sizeKey: "0" } }, "d"),
    );
    expect(a.row_count).toBeNull();
    expect(a.size_bytes).toBeNull();
  });

  it("a time as an ISO string reads the same", () => {
    const t = glueTableToHive({ Name: "t", CreateTime: "2026-01-01T00:00:00Z" }, "d");
    expect(hiveTableToAsset(t).metadata.created_at).toBe("2026-01-01T00:00:00.000Z");
  });
});
