// A Hive table as a catalog asset. tests/integration/hiveMetastore.test.ts runs
// these rules on what real Hive writes; here are the shapes it cannot easily
// produce, and each is a way the catalog would otherwise say something false.
import { describe, expect, it } from "vitest";

import { diffColumns, isBreaking, summarizeChanges } from "@/lib/catalogSchemaDiff";
import { parseAssetMetadata } from "@/lib/catalogAssetMetadata";
import { parseMetastoreUri } from "@/lib/hiveMetastoreUri";
import { schemaVersionRows, schemaHash } from "@/utils/catalog/crawler.server";
import {
  hiveFormat,
  hiveTableToAsset,
  hiveViewUpstreams,
  sparkSchema,
  stripUriCredentials,
  type HiveTable,
} from "@/utils/catalog/hive/mapping";

const table = (over: Partial<HiveTable> = {}): HiveTable => ({
  database: "db",
  name: "t",
  tableType: "MANAGED_TABLE",
  columns: [{ name: "id", type: "bigint" }],
  partitionKeys: [],
  parameters: {},
  ...over,
});

describe("statistics", () => {
  const accurate = '{"BASIC_STATS":"true"}';

  it("numRows counts only when Hive vouches for it", () => {
    expect(hiveTableToAsset(table({ parameters: { numRows: "500" } })).row_count).toBeNull();
    expect(
      hiveTableToAsset(table({ parameters: { numRows: "500", COLUMN_STATS_ACCURATE: accurate } }))
        .row_count,
    ).toBe(500);
  });

  it("0 rows is a fact when Hive vouches for it, and unknown when it does not", () => {
    expect(hiveTableToAsset(table({ parameters: { numRows: "0" } })).row_count).toBeNull();
    expect(
      hiveTableToAsset(table({ parameters: { numRows: "0", COLUMN_STATS_ACCURATE: accurate } }))
        .row_count,
    ).toBe(0);
  });

  it("on a table others write to, even a vouched-for zero means nothing", () => {
    // MEASURED on Hive 4: this is what the metastore held for an external table
    // whose folder had a three-row file in it, while SELECT count(*) said 3.
    const stale = {
      EXTERNAL: "TRUE",
      numRows: "0",
      numFiles: "0",
      totalSize: "0",
      COLUMN_STATS_ACCURATE: accurate,
    };
    const a = hiveTableToAsset(table({ tableType: "EXTERNAL_TABLE", parameters: stale }));
    expect(a.row_count).toBeNull();
    expect(a.size_bytes).toBeNull();
    expect(a.file_count).toBeNull();
  });

  it("a counted external table keeps its count", () => {
    const a = hiveTableToAsset(
      table({
        tableType: "EXTERNAL_TABLE",
        parameters: { EXTERNAL: "TRUE", numRows: "7", COLUMN_STATS_ACCURATE: accurate },
      }),
    );
    expect(a.row_count).toBe(7);
  });

  it("a table Hive 4 relabelled external is still Hive's, zero included", () => {
    const a = hiveTableToAsset(
      table({
        tableType: "EXTERNAL_TABLE",
        parameters: {
          EXTERNAL: "TRUE",
          TRANSLATED_TO_EXTERNAL: "TRUE",
          numRows: "0",
          COLUMN_STATS_ACCURATE: accurate,
        },
      }),
    );
    expect(a.row_count).toBe(0);
  });

  it("-1, Hive's own 'not known', is not a row count", () => {
    expect(
      hiveTableToAsset(table({ parameters: { numRows: "-1", COLUMN_STATS_ACCURATE: accurate } }))
        .row_count,
    ).toBeNull();
  });

  it("a size read from the filesystem stands unless it is an unvouched zero", () => {
    expect(hiveTableToAsset(table({ parameters: { totalSize: "2048" } })).size_bytes).toBe(2048);
    expect(hiveTableToAsset(table({ parameters: { totalSize: "0" } })).size_bytes).toBeNull();
  });

  it("Spark's statistics are measured, so they stand alone", () => {
    const a = hiveTableToAsset(
      table({
        parameters: {
          "spark.sql.statistics.numRows": "42",
          "spark.sql.statistics.totalSize": "9000",
        },
      }),
    );
    expect(a.row_count).toBe(42);
    expect(a.size_bytes).toBe(9000);
  });

  it("Iceberg's numRows comes from its snapshot, without Hive's flag", () => {
    const iceberg = { table_type: "ICEBERG", EXTERNAL: "TRUE", TRANSLATED_TO_EXTERNAL: "TRUE" };
    expect(hiveTableToAsset(table({ parameters: { ...iceberg, numRows: "3" } })).row_count).toBe(3);
    // Still only a positive count: the rule for a zero does not change.
    expect(hiveTableToAsset(table({ parameters: { ...iceberg, numRows: "0" } })).row_count).toBe(
      null,
    );
  });

  it("a Spark stand-in layout is not reported as the table's storage", () => {
    const standIn = {
      inputFormat: "org.apache.hadoop.mapred.SequenceFileInputFormat",
      outputFormat: "org.apache.hadoop.hive.ql.io.HiveSequenceFileOutputFormat",
      serde: "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
    };
    const spark = hiveTableToAsset(
      table({ ...standIn, parameters: { "spark.sql.sources.provider": "parquet" } }),
    );
    expect(spark.format).toBe("parquet");
    expect(spark.metadata.serde).toBeUndefined();
    expect(spark.metadata.input_format).toBeUndefined();
    expect(spark.metadata.output_format).toBeUndefined();

    // A Spark table stored the Hive way really is what the metastore says.
    const hiveCompatible = hiveTableToAsset(
      table({
        inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        serde: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
        parameters: { "spark.sql.sources.provider": "parquet" },
      }),
    );
    expect(hiveCompatible.metadata.serde).toContain("ParquetHiveSerDe");
    const hiveText = hiveTableToAsset(
      table({ ...standIn, parameters: { "spark.sql.sources.provider": "hive" } }),
    );
    expect(hiveText.metadata.serde).toContain("LazySimpleSerDe");
  });

  it("a view has no rows of its own", () => {
    const a = hiveTableToAsset(table({ tableType: "VIRTUAL_VIEW", parameters: { numRows: "9" } }));
    expect(a.row_count).toBeNull();
    expect(a.asset_type).toBe("view");
  });

  it("a value that is not a whole number is not a count", () => {
    expect(
      hiveTableToAsset(table({ parameters: { numRows: "abc", COLUMN_STATS_ACCURATE: accurate } }))
        .row_count,
    ).toBeNull();
  });
});

describe("what does not reach the catalog", () => {
  it("a credential in a location", () => {
    expect(stripUriCredentials("s3a://AKIAEXAMPLE:s3cr3t@bucket/path/t")).toBe(
      "s3a://bucket/path/t",
    );
    expect(stripUriCredentials("hdfs://nn:8020/warehouse/t")).toBe("hdfs://nn:8020/warehouse/t");
    const a = hiveTableToAsset(table({ location: "s3a://KEY:SECRET@bucket/t" }));
    expect(JSON.stringify(a)).not.toContain("SECRET");
  });

  it("any property not known to be safe, whatever it is called", () => {
    const a = hiveTableToAsset(
      table({
        parameters: {
          "hive.sql.dbcp.password": "hunter2",
          "fs.s3a.secret.key": "hunter3",
          "some.vendor.opaque.setting": "hunter4",
          EXTERNAL: "TRUE",
        },
      }),
    );
    expect(a.metadata.properties).toEqual({ EXTERNAL: "TRUE" });
    expect(JSON.stringify(a)).not.toContain("hunter");
  });

  it("the SerDe's own parameters, which can hold the same things", () => {
    const a = hiveTableToAsset(table({ serdeParameters: { "ssl.keystore.password": "hunter5" } }));
    expect(JSON.stringify(a)).not.toContain("hunter5");
  });
});

describe("Spark's real schema", () => {
  const placeholder = [{ name: "col", type: "array<string>", comment: "from deserializer" }];
  const doc = JSON.stringify({
    type: "struct",
    fields: [
      { name: "id", type: "long", metadata: {} },
      {
        name: "address",
        type: {
          type: "struct",
          fields: [{ name: "city", type: "string" }],
        },
        metadata: {},
      },
      { name: "dt", type: "string", metadata: {} },
    ],
  });

  it("reassembles a schema split across parts", () => {
    const mid = Math.floor(doc.length / 2);
    const fields = sparkSchema({
      "spark.sql.sources.schema.numParts": "2",
      "spark.sql.sources.schema.part.0": doc.slice(0, mid),
      "spark.sql.sources.schema.part.1": doc.slice(mid),
    });
    expect(fields?.map((f) => f.name)).toEqual(["id", "address", "dt"]);
    expect(fields?.[1].type).toBe("struct<city:string>");
  });

  it("reads the single property newer Spark writes", () => {
    expect(sparkSchema({ "spark.sql.sources.schema": doc })?.length).toBe(3);
  });

  it("half a schema is no schema", () => {
    expect(
      sparkSchema({
        "spark.sql.sources.schema.numParts": "2",
        "spark.sql.sources.schema.part.0": doc.slice(0, 10),
      }),
    ).toBeNull();
  });

  it("partition columns are named apart and move to the end, marked", () => {
    const a = hiveTableToAsset(
      table({
        columns: placeholder,
        parameters: {
          "spark.sql.sources.provider": "parquet",
          "spark.sql.sources.schema": doc,
          "spark.sql.sources.schema.numPartCols": "1",
          "spark.sql.sources.schema.partCol.0": "dt",
        },
      }),
    );
    expect(a.columns.map((c) => [c.name, c.partition ?? false])).toEqual([
      ["id", false],
      ["address", false],
      ["dt", true],
    ]);
    expect(a.metadata.partition_keys).toEqual(["dt"]);
  });

  it("a Delta table with no schema here says why, and shows no `col`", () => {
    const a = hiveTableToAsset(
      table({ columns: placeholder, parameters: { "spark.sql.sources.provider": "delta" } }),
    );
    expect(a.format).toBe("delta");
    expect(a.columns).toEqual([]);
    expect(a.metadata.note).toMatch(/keeps its schema in its own metadata/);
  });

  it("a real column called `col` on an ordinary table stays", () => {
    const a = hiveTableToAsset(table({ columns: [{ name: "col", type: "array<string>" }] }));
    expect(a.columns.map((c) => c.name)).toEqual(["col"]);
  });
});

describe("the format", () => {
  const format = (over: Partial<HiveTable>) => hiveFormat(table(over));

  it("a table format wins over the files it is made of", () => {
    expect(
      format({
        inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        parameters: { table_type: "ICEBERG" },
      }),
    ).toBe("iceberg");
    expect(format({ inputFormat: "org.apache.hudi.hadoop.HoodieParquetInputFormat" })).toBe("hudi");
  });

  it("Spark's provider, as a short name or a class", () => {
    expect(format({ parameters: { "spark.sql.sources.provider": "delta" } })).toBe("delta");
    expect(
      format({
        parameters: {
          "spark.sql.sources.provider": "org.apache.spark.sql.execution.datasources.parquet",
        },
      }),
    ).toBe("parquet");
  });

  it("a storage handler that is no file at all", () => {
    expect(
      format({
        parameters: { storage_handler: "org.apache.hadoop.hive.hbase.HBaseStorageHandler" },
      }),
    ).toBe("hbase");
  });

  it("nothing recognisable is said to be nothing", () => {
    expect(format({ inputFormat: "com.acme.CustomInputFormat" })).toBeNull();
    expect(format({ tableType: "VIRTUAL_VIEW" })).toBeNull();
  });
});

describe("a view's upstreams", () => {
  const view = (over: Partial<HiveTable>) =>
    table({ tableType: "VIRTUAL_VIEW", name: "v", ...over });

  it("reads Hive's expanded text, backticks and all", () => {
    expect(
      hiveViewUpstreams(
        view({
          viewExpandedText:
            "SELECT `o`.`id` FROM `sales`.`orders` `o` JOIN `mkt`.`camps` `c` ON `o`.`id`=`c`.`id`",
        }),
      ),
    ).toEqual(["sales.orders", "mkt.camps"]);
  });

  it("an unqualified name belongs to the view's own database", () => {
    expect(hiveViewUpstreams(view({ viewOriginalText: "SELECT * FROM orders" }))).toEqual([
      "db.orders",
    ]);
  });

  it("a table has no upstreams this way", () => {
    expect(hiveViewUpstreams(table({ viewExpandedText: "SELECT * FROM x" }))).toEqual([]);
  });
});

describe("a metastore's address", () => {
  it("takes what hive-site.xml holds", () => {
    expect(parseMetastoreUri("thrift://hms.internal:9083")).toEqual({
      ok: true,
      host: "hms.internal",
      port: 9083,
    });
  });

  it("a bare host means the default port", () => {
    expect(parseMetastoreUri("hms")).toMatchObject({ ok: true, host: "hms", port: 9083 });
    expect(parseMetastoreUri("10.0.0.5:19083")).toMatchObject({ host: "10.0.0.5", port: 19083 });
  });

  it("an IPv6 literal, bracketed", () => {
    expect(parseMetastoreUri("thrift://[fd00::1]:9083")).toMatchObject({ host: "fd00::1" });
  });

  it("says what is wrong with what it refuses", () => {
    const error = (v: string) => {
      const r = parseMetastoreUri(v);
      return r.ok ? null : r.error;
    };
    expect(error("")).toMatch(/address/);
    expect(error("thrift://a:9083,thrift://b:9083")).toMatch(/one metastore/);
    expect(error("https://hms:9083")).toMatch(/thrift:\/\//);
    expect(error("hms:99999")).toMatch(/port/);
    expect(error("not a host")).toMatch(/host name/);
  });

  it("nothing but a host and a port survives, for a value bound for a socket", () => {
    expect(parseMetastoreUri("thrift://hms/../../etc").ok).toBe(false);
    expect(parseMetastoreUri("thrift://user:pw@hms:9083").ok).toBe(false);
  });
});

describe("a schema's history", () => {
  const before = [
    { name: "id", type: "bigint" },
    { name: "email", type: "string" },
    { name: "amount", type: "int" },
  ];
  const after = [
    { name: "id", type: "bigint" },
    { name: "amount", type: "decimal(12,2)" },
    { name: "country", type: "string" },
  ];

  it("says what changed, not only that something did", () => {
    expect(diffColumns(before, after)).toEqual({
      added: [{ name: "country", type: "string" }],
      removed: [{ name: "email", type: "string" }],
      retyped: [{ name: "amount", from: "int", to: "decimal(12,2)" }],
    });
  });

  it("a removed or retyped column is breaking; an added one is not", () => {
    expect(isBreaking(diffColumns(before, after))).toBe(true);
    expect(isBreaking(diffColumns(before, [...before, { name: "new", type: "int" }]))).toBe(false);
  });

  it("reads as a line for a timeline", () => {
    expect(summarizeChanges(diffColumns(before, after))).toBe("1 added, 1 removed, 1 retyped");
  });

  const asset = (columns: { name: string; type: string }[]) =>
    ({ fqn: "db.t", columns }) as Parameters<typeof schemaVersionRows>[2][number];
  const existing = (columns: { name: string; type: string }[], hash: string | null) =>
    ({ id: "1", fqn: "db.t", columns, schema_hash: hash }) as never;

  it("is written only when a known schema really changed", () => {
    const hash = schemaHash(before);
    expect(schemaVersionRows("u", "s", [asset(before)], [existing(before, hash)])).toEqual([]);
    const rows = schemaVersionRows("u", "s", [asset(after)], [existing(before, hash)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: "u", source_id: "s", fqn: "db.t" });
    expect(rows[0].schema_hash).toBe(schemaHash(after));
  });

  it("a first sighting is not a change", () => {
    expect(schemaVersionRows("u", "s", [asset(after)], [])).toEqual([]);
    expect(schemaVersionRows("u", "s", [asset(after)], [existing(before, null)])).toEqual([]);
  });
});

describe("stored metadata", () => {
  it("anything that is not an object reads as empty", () => {
    expect(parseAssetMetadata(null)).toEqual({});
    expect(parseAssetMetadata([])).toEqual({});
    expect(parseAssetMetadata("x")).toEqual({});
    expect(parseAssetMetadata({ location: "s3://b" })).toEqual({ location: "s3://b" });
  });
});
