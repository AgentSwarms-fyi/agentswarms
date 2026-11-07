// What a catalog asset knows about where it lives and how it is laid out.
//
// A table in a warehouse is a name and columns. A table in a lake is more than
// that, and engines cannot read it without the rest: where its files are, how
// they are written, what it is partitioned by. catalog_assets.metadata holds
// those facts. Crawler-owned and rewritten on every crawl, unlike description,
// tags, owner and status, which are people's and survive.

export type AssetMetadata = {
  /** Where the data lives, with any credentials in the URI removed. */
  location?: string;
  /** MANAGED_TABLE, EXTERNAL_TABLE, VIRTUAL_VIEW, MATERIALIZED_VIEW, or the catalog's own word. */
  table_type?: string;
  input_format?: string;
  output_format?: string;
  serde?: string;
  /** Partition columns, in partition order. */
  partition_keys?: string[];
  /** Partitions seen. With `partition_count_capped`, a lower bound. */
  partition_count?: number;
  partition_count_capped?: boolean;
  first_partition?: string;
  last_partition?: string;
  bucket_columns?: string[];
  bucket_count?: number;
  /** The user the source itself names. Not curation: `hive` is rarely who to ask. */
  source_owner?: string;
  created_at?: string;
  /** A view's SQL, as the source stores it. */
  view_sql?: string;
  /** Selected table properties. Selected: see hive/mapping.ts. */
  properties?: Record<string, string>;
  /**
   * True when the row count was scaled from part of the data, so it is shown as
   * approximate. False when it was counted. Unset on an older crawl's asset.
   */
  row_count_estimated?: boolean;
  /** Iceberg format version, snapshot count and the like, for a table format. */
  format_version?: number;
  snapshot_count?: number;
  /**
   * Why the columns may be empty or the numbers absent, in a sentence for the
   * person reading the asset. Better said than left to look like a bug.
   */
  note?: string;
};

/** A row's metadata, whatever was stored. Older rows and bad JSON read as empty. */
export function parseAssetMetadata(v: unknown): AssetMetadata {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AssetMetadata) : {};
}
