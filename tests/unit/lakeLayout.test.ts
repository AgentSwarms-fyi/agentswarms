// What a bucket's paths say. A year of daily partitions is one table, and a
// Delta table is not its Parquet files. Both were being catalogued as if they
// were: grouping went by exact folder, and the markers that say what a folder
// is were thrown away as bookkeeping.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { objectSqlName } from "@/lib/objectSqlName";
import { datasetFqn, groupObjects, isDatasetGroup } from "@/utils/catalog/crawler.server";
import {
  deltaCommitsNewestFirst,
  icebergMetadataNewestFirst,
  owningRoot,
  parseDeltaCommit,
  parseHudiProperties,
  splitPartitionDir,
  tableFormatRoots,
} from "@/utils/catalog/lakeLayout";
import type { StoredObject } from "@/utils/catalog/objectStore.server";

const obj = (key: string, size = 100): StoredObject => ({
  key,
  size,
  last_modified: "2026-11-01T00:00:00Z",
});

describe("a Hive partition folder", () => {
  it("splits the table from the keys below it", () => {
    expect(splitPartitionDir("lake/sales/dt=2026-01-01/region=emea")).toEqual({
      root: "lake/sales",
      keys: ["dt", "region"],
    });
  });

  it("only a run at the END is a partition", () => {
    expect(splitPartitionDir("a=1/raw")).toEqual({ root: "a=1/raw", keys: [] });
    expect(splitPartitionDir("sales/2026")).toEqual({ root: "sales/2026", keys: [] });
  });

  it("a value may hold anything, including another =", () => {
    expect(splitPartitionDir("t/expr=a=b").keys).toEqual(["expr"]);
    expect(splitPartitionDir("t/dt=__HIVE_DEFAULT_PARTITION__").keys).toEqual(["dt"]);
  });

  it("the table can be the prefix's own root", () => {
    expect(splitPartitionDir("dt=2026-01-01")).toEqual({ root: "", keys: ["dt"] });
  });
});

describe("grouping a partitioned table", () => {
  const year = Array.from({ length: 365 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    return obj(`lake/sales/dt=${day}/part-0.parquet`);
  });

  it("a year of daily folders is ONE table, not 365 assets", () => {
    const groups = groupObjects(year);
    expect(groups).toHaveLength(1);
    expect(groups[0].dir).toBe("lake/sales");
    expect(groups[0].partitionKeys).toEqual(["dt"]);
    expect(groups[0].partitions?.size).toBe(365);
    expect(groups[0].objects).toHaveLength(365);
  });

  it("is named by a glob that reaches every partition", () => {
    const [g] = groupObjects(year);
    expect(datasetFqn(g)).toBe("lake/sales/**/*.parquet");
    expect(isDatasetGroup(g)).toBe(true);
  });

  it("its SQL name is the table, as the seeded query and the server both resolve it", () => {
    expect(objectSqlName("lake/sales/**/*.parquet")).toBe("sales");
    expect(objectSqlName("lake/sales/**/*.jsonl.gz")).toBe("sales");
    // Unchanged for everything else.
    expect(objectSqlName("sales/*.parquet")).toBe("sales");
    expect(objectSqlName("data/orders.parquet")).toBe("orders");
  });

  it("two depths under one root are one table, or the fqn is written twice", () => {
    const groups = groupObjects([
      obj("t/dt=1/a.parquet"),
      obj("t/dt=2/hour=3/b.parquet"),
      obj("t/dt=2/hour=4/c.parquet"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].partitionKeys).toEqual(["dt", "hour"]);
    expect(groups[0].partitions?.size).toBe(3);
  });

  it("different formats under one root stay apart", () => {
    const groups = groupObjects([obj("t/dt=1/a.parquet"), obj("t/dt=1/b.csv")]);
    expect(groups.map(datasetFqn).sort()).toEqual(["t/**/*.csv", "t/**/*.parquet"]);
  });

  it("a plain folder keeps the name it always had", () => {
    const [g] = groupObjects([obj("sales/a.parquet"), obj("sales/b.parquet")]);
    expect(datasetFqn(g)).toBe("sales/*.parquet");
    expect(g.partitionKeys).toBeUndefined();
  });
});

describe("table formats in a bucket", () => {
  it("recognises each by the marker it leaves", () => {
    const roots = tableFormatRoots([
      "lake/orders/_delta_log/00000000000000000000.json",
      "lake/events/metadata/v3.metadata.json",
      "lake/trips/.hoodie/hoodie.properties",
      "lake/plain/a.parquet",
    ]);
    expect([...roots].sort()).toEqual([
      ["lake/events", "iceberg"],
      ["lake/orders", "delta"],
      ["lake/trips", "hudi"],
    ]);
  });

  it("a table at the root of the listing still counts", () => {
    expect(tableFormatRoots(["_delta_log/0.json"]).get("")).toBe("delta");
  });

  it("a folder called metadata full of CSVs is not an Iceberg table", () => {
    expect(tableFormatRoots(["reports/metadata/2026.csv"]).size).toBe(0);
    expect(tableFormatRoots(["reports/metadata/notes.json"]).size).toBe(0);
  });

  it("the deepest root owns a key, so a nested table stays its own", () => {
    const roots = tableFormatRoots(["lake/_delta_log/0.json", "lake/inner/_delta_log/0.json"]);
    expect(owningRoot("lake/inner/part.parquet", roots)).toBe("lake/inner");
    expect(owningRoot("lake/part.parquet", roots)).toBe("lake");
    expect(owningRoot("elsewhere/x.parquet", roots)).toBeUndefined();
  });

  const delta = [
    obj("lake/orders/_delta_log/00000000000000000000.json"),
    obj("lake/orders/_delta_log/00000000000000000001.json"),
    obj("lake/orders/dt=1/part-0.parquet", 500),
    obj("lake/orders/dt=2/part-0.parquet", 700),
  ];

  it("a Delta table is ONE asset, not a dataset per data folder", () => {
    const groups = groupObjects(delta);
    expect(groups).toHaveLength(1);
    expect(groups[0].tableFormat).toBe("delta");
    expect(groups[0].objects).toHaveLength(2);
    expect(groups[0].metadataObjects).toHaveLength(2);
  });

  it("its fqn names no files, so nothing can scan them as a glob", () => {
    const [g] = groupObjects(delta);
    expect(datasetFqn(g)).toBe("lake/orders/");
    // The Workbench and the catalog's Query button both key on this.
    expect(/\.(parquet|csv|tsv|json|ndjson|jsonl|orc)(\.gz)?$/i.test(datasetFqn(g))).toBe(false);
  });

  it("an Iceberg table's data folder is not a dataset called `data`", () => {
    const groups = groupObjects([
      obj("lake/events/metadata/v1.metadata.json"),
      obj("lake/events/metadata/snap-1.avro"),
      obj("lake/events/data/a.parquet"),
    ]);
    expect(groups).toHaveLength(1);
    expect(datasetFqn(groups[0])).toBe("lake/events/");
    expect(groups[0].format).toBe("iceberg");
  });

  it("a table beside plain data leaves the plain data alone", () => {
    const groups = groupObjects([...delta, obj("lake/plain/a.csv")]);
    expect(groups.map(datasetFqn).sort()).toEqual(["lake/orders/", "lake/plain/*.csv"]);
  });

  it("an empty table, metadata and no data files, is still catalogued", () => {
    const groups = groupObjects([obj("lake/empty/_delta_log/0.json")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].objects).toHaveLength(0);
    expect(datasetFqn(groups[0])).toBe("lake/empty/");
  });
});

describe("reading a Delta commit", () => {
  const meta = (schema: object, extra: object = {}) =>
    JSON.stringify({ metaData: { schemaString: JSON.stringify(schema), ...extra } });

  it("takes the schema, partition columns and description", () => {
    const md = parseDeltaCommit(
      [
        JSON.stringify({ protocol: { minReaderVersion: 1 } }),
        meta(
          {
            type: "struct",
            fields: [
              { name: "id", type: "long", metadata: { comment: "key" } },
              { name: "tags", type: { type: "array", elementType: "string" }, metadata: {} },
              { name: "dt", type: "date", metadata: {} },
            ],
          },
          { partitionColumns: ["dt"], description: "All orders" },
        ),
      ].join("\n"),
    );
    expect(md).toEqual({
      fields: [
        { name: "id", type: "long", comment: "key" },
        { name: "tags", type: "array<string>" },
        { name: "dt", type: "date" },
      ],
      partitionColumns: ["dt"],
      description: "All orders",
    });
  });

  it("a commit that only adds files has no schema to find", () => {
    expect(parseDeltaCommit(JSON.stringify({ add: { path: "a.parquet" } }))).toBeNull();
  });

  it("a read that stopped partway through a line is passed over", () => {
    const whole = meta({ type: "struct", fields: [{ name: "a", type: "int", metadata: {} }] });
    expect(parseDeltaCommit(`${whole}\n{"metaData":{"schemaStr`)?.fields).toEqual([
      { name: "a", type: "int" },
    ]);
  });

  it("newest commit first, and only commits", () => {
    expect(
      deltaCommitsNewestFirst([
        "t/_delta_log/00000000000000000001.json",
        "t/_delta_log/00000000000000000010.json",
        "t/_delta_log/00000000000000000010.checkpoint.parquet",
        "t/_delta_log/_last_checkpoint",
      ]),
    ).toEqual(["t/_delta_log/00000000000000000010.json", "t/_delta_log/00000000000000000001.json"]);
  });
});

describe("the newest Iceberg metadata file", () => {
  it("sorts by version, not as text: v10 is after v9", () => {
    expect(
      icebergMetadataNewestFirst([
        "t/metadata/v9.metadata.json",
        "t/metadata/v10.metadata.json",
        "t/metadata/v2.metadata.json",
      ])[0],
    ).toBe("t/metadata/v10.metadata.json");
  });

  it("reads the numbered form other writers use", () => {
    expect(
      icebergMetadataNewestFirst([
        "t/metadata/00002-aaaa.metadata.json",
        "t/metadata/00012-bbbb.metadata.json",
      ])[0],
    ).toBe("t/metadata/00012-bbbb.metadata.json");
  });

  it("is not fooled by manifests", () => {
    expect(icebergMetadataNewestFirst(["t/metadata/snap-1.avro"])).toEqual([]);
  });
});

describe("hoodie.properties", () => {
  it("reads the table's name, type and partition fields", () => {
    const p = parseHudiProperties(
      [
        "#Properties saved on 2026-01-01",
        "hoodie.table.name=trips",
        "hoodie.table.type=MERGE_ON_READ",
        "hoodie.table.partition.fields=city,dt",
      ].join("\n"),
    );
    expect(p).toMatchObject({
      name: "trips",
      tableType: "MERGE_ON_READ",
      partitionFields: ["city", "dt"],
      fields: [],
    });
  });

  it("reads a recorded schema and drops Hudi's own columns", () => {
    const schema = JSON.stringify({
      fields: [
        { name: "_hoodie_commit_time", type: "string" },
        { name: "id", type: ["null", "long"], doc: "the key" },
        { name: "at", type: ["null", { type: "long", logicalType: "timestamp-millis" }] },
      ],
    });
    const p = parseHudiProperties(`hoodie.table.create.schema=${schema}`);
    expect(p.fields).toEqual([
      { name: "id", type: "long", comment: "the key" },
      { name: "at", type: "timestamp-millis" },
    ]);
  });

  it("a schema it cannot parse leaves the columns unlisted, not the read failed", () => {
    const p = parseHudiProperties("hoodie.table.create.schema={not json\nhoodie.table.name=t");
    expect(p.fields).toEqual([]);
    expect(p.name).toBe("t");
  });
});

describe("a listing that stopped at its cap", () => {
  const cr = readFileSync("src/utils/catalog/crawler.server.ts", "utf8");
  const store = readFileSync("src/utils/catalog/objectStore.server.ts", "utf8");

  it("says so, where the listing ends", () => {
    expect(store).toContain("return { objects: out, capped: true };");
  });

  it("removes nothing: an asset not seen may simply be past where it stopped", () => {
    const branch = cr.slice(cr.indexOf("if (res.capped) {"), cr.indexOf("const changes = await"));
    expect(branch).toContain("for (const e of existing) keep.add(e.fqn);");
    expect(branch).toContain("Nothing was removed.");
  });
});
