// Reading a Delta, Iceberg or Hudi table in a bucket from its own metadata.
//
// Each format says what it is in a place the crawl can read cheaply, without
// touching a data file: Delta in its commit log, Iceberg in its metadata JSON,
// Hudi in a properties file. Row counts come only from a format that records
// them. Adding up Parquet footers under a Delta table would count rows it has
// deleted, and a wrong total is worse than none.
import type { AssetMetadata } from "@/lib/catalogAssetMetadata";

import { sampleObject, type ObjectStoreConfig, type StoredObject } from "./objectStore.server";
import { icebergTableToAsset, type IcebergTableResp } from "./crawler.server";
import {
  deltaCommitsNewestFirst,
  icebergMetadataNewestFirst,
  parseDeltaCommit,
  parseHudiProperties,
  type TableFormat,
  type TableSchemaField,
} from "./lakeLayout";

/** A metadata file can run to megabytes on a table with a long history. */
const METADATA_READ_BYTES = 8 * 1024 * 1024;
/** Commits looked through for a schema. The first holds one unless compacted. */
const DELTA_COMMITS_READ = 8;

export type TableFormatRead = {
  columns: TableSchemaField[];
  row_count: number | null;
  size_bytes: number | null;
  description?: string;
  metadata: AssetMetadata;
};

async function readDelta(
  cfg: ObjectStoreConfig,
  objects: StoredObject[],
): Promise<TableFormatRead> {
  const commits = deltaCommitsNewestFirst(objects.map((o) => o.key));
  // The newest few, then the very first: a schema is written at creation and
  // again only when it changes.
  const toRead = [...commits.slice(0, DELTA_COMMITS_READ), commits[commits.length - 1]].filter(
    (k, i, all) => k !== undefined && all.indexOf(k) === i,
  );
  for (const key of toRead) {
    const found = parseDeltaCommit(
      (await sampleObject(cfg, key, METADATA_READ_BYTES)).toString("utf8"),
    );
    if (found) {
      return {
        columns: found.fields,
        row_count: null,
        size_bytes: null,
        ...(found.description ? { description: found.description } : {}),
        metadata: {
          table_type: "DELTA",
          ...(found.partitionColumns.length ? { partition_keys: found.partitionColumns } : {}),
          ...(commits.length ? { snapshot_count: commits.length } : {}),
        },
      };
    }
  }
  return {
    columns: [],
    row_count: null,
    size_bytes: null,
    metadata: {
      table_type: "DELTA",
      note: "This Delta table's schema is in a checkpoint, not in the recent commits read here, so its columns are not listed.",
    },
  };
}

async function readIceberg(
  cfg: ObjectStoreConfig,
  root: string,
  objects: StoredObject[],
): Promise<TableFormatRead> {
  const newest = icebergMetadataNewestFirst(objects.map((o) => o.key))[0];
  if (!newest) throw new Error("no metadata file");
  const md = JSON.parse(
    (await sampleObject(cfg, newest, METADATA_READ_BYTES)).toString("utf8"),
  ) as IcebergTableResp["metadata"];
  const asset = icebergTableToAsset([], root.split("/").pop() ?? root, { metadata: md });
  if (!asset) throw new Error("the metadata file holds no table");
  return {
    columns: asset.columns,
    row_count: asset.row_count,
    size_bytes: asset.size_bytes,
    ...(asset.description ? { description: asset.description } : {}),
    metadata: { table_type: "ICEBERG", ...asset.metadata },
  };
}

async function readHudi(cfg: ObjectStoreConfig, objects: StoredObject[]): Promise<TableFormatRead> {
  const key = objects.find((o) => /\.hoodie\/hoodie\.properties$/.test(o.key))?.key;
  if (!key) throw new Error("no hoodie.properties");
  const props = parseHudiProperties((await sampleObject(cfg, key, 256 * 1024)).toString("utf8"));
  return {
    columns: props.fields,
    row_count: null,
    size_bytes: null,
    metadata: {
      table_type: props.tableType ? `HUDI ${props.tableType}` : "HUDI",
      ...(props.partitionFields.length ? { partition_keys: props.partitionFields } : {}),
      ...(props.fields.length
        ? {}
        : {
            note: "This Hudi table does not record its schema in hoodie.properties, so its columns are not listed.",
          }),
    },
  };
}

export async function readTableFormat(
  cfg: ObjectStoreConfig,
  format: TableFormat,
  root: string,
  metadataObjects: StoredObject[],
): Promise<TableFormatRead> {
  if (format === "delta") return readDelta(cfg, metadataObjects);
  if (format === "iceberg") return readIceberg(cfg, root, metadataObjects);
  return readHudi(cfg, metadataObjects);
}
