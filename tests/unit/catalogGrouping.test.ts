// Object-storage grouping rules, pinned after a live ETL-destination crawl
// showed both failure modes: dlt writes ONE file per table-load, so every
// pipeline table lost its name to the "two files make a dataset" gate, while
// dlt's _dlt_* bookkeeping folders showed up as datasets beside the data.
import { describe, expect, it } from "vitest";

import { gzipSync } from "node:zlib";

import { groupObjects, isMetadataPath } from "@/utils/catalog/crawler.server";
import { fileFormat, inferColumns } from "@/utils/catalog/objectStore.server";
import type { StoredObject } from "@/utils/catalog/objectStore.server";

const obj = (key: string, size = 100): StoredObject => ({
  key,
  size,
  last_modified: "2026-08-29T00:00:00Z",
});

describe("isMetadataPath", () => {
  it("hides underscore- and dot-prefixed segments (the Spark/Hive rule)", () => {
    expect(isMetadataPath("medallion/_dlt_loads/1.jsonl")).toBe(true);
    expect(isMetadataPath("_state/orders_watermark.json")).toBe(true);
    expect(isMetadataPath("raw/.hidden/file.csv")).toBe(true);
    expect(isMetadataPath("raw/orders/part1.csv")).toBe(false);
    // An underscore INSIDE a name is ordinary; only a leading one is metadata.
    expect(isMetadataPath("scd/dim_employees/1.parquet")).toBe(false);
  });
});

describe("groupObjects", () => {
  it("drops metadata paths entirely", () => {
    const groups = groupObjects([
      obj("medallion/_dlt_loads/1.jsonl"),
      obj("medallion/_dlt_version/1.jsonl"),
      obj("medallion/orders_silver/a.parquet"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].dir).toBe("medallion/orders_silver");
  });

  it("keeps one group per directory+format, in table-per-folder layouts", () => {
    const groups = groupObjects([
      obj("scd/dim_employees/load1.parquet"),
      obj("scd/dim_employees/load2.parquet"),
      obj("scd/hook/load1.parquet"),
    ]);
    expect(groups.map((g) => g.dir).sort()).toEqual(["scd/dim_employees", "scd/hook"]);
  });
});

describe("fileFormat", () => {
  it("sees through gzip to the inner text format (dlt gzips jsonl by default)", () => {
    expect(fileFormat("finance/x/file.jsonl.gz")).toBe("ndjson");
    expect(fileFormat("raw/orders.csv.gz")).toBe("csv");
    expect(fileFormat("logs/day.json.gz")).toBe("json");
  });

  it("keeps archives and unknown-gz opaque", () => {
    expect(fileFormat("backup.zip")).toBe("compressed");
    expect(fileFormat("dump.sql.zst")).toBe("compressed");
    expect(fileFormat("blob.bin.gz")).toBe("compressed");
    expect(fileFormat("data.parquet")).toBe("parquet");
  });
});

describe("inferColumns on gzipped samples", () => {
  const jsonl = '{"id": 1, "name": "a"}\n{"id": 2, "name": "b"}\n';

  it("decompresses a full gzip sample and infers columns", () => {
    const cols = inferColumns("ndjson", gzipSync(Buffer.from(jsonl)), "t/f.jsonl.gz");
    expect(cols.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("tolerates a TRUNCATED gzip stream — ranged GETs never fetch the tail", () => {
    // A head-of-file slice, the shape sampleObject actually produces. zlib's
    // sync-flush hands back everything that decoded cleanly before the cut.
    const whole = gzipSync(Buffer.from(jsonl.repeat(50000)));
    const cols = inferColumns("ndjson", whole.subarray(0, 1024), "t/f.jsonl.gz");
    expect(cols.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("returns [] for garbage that only claims to be gzip", () => {
    expect(inferColumns("ndjson", Buffer.from("not gzip at all"), "t/f.jsonl.gz")).toEqual([]);
  });
});
