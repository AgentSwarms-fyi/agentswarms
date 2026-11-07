// A Hive table, as a catalog asset.
//
// Pure: no socket and no server import, so it is tested on real metastore
// output, and anything else that follows the Hive table model (AWS Glue does,
// field for field) maps through the same rules.
//
// Four things in here look like they could be simpler, and each is a way a
// catalog ends up saying something false:
//
//   SPARK'S SCHEMA. A table Spark wrote stores `col array<string>` in the
//   metastore and its real columns in table properties, because Hive could not
//   always represent them. Read the columns naively and every Spark table in
//   the estate has one column called `col`.
//
//   STATISTICS. numRows of 0 on a table Hive has not analysed means "not
//   counted", not "empty", and on an external table it can mean that even with
//   Hive vouching for it (see tableStats). A catalog that shows 0 rows on a
//   billion-row table is worse than one that shows nothing.
//
//   PROPERTIES ARE NOT SAFE TO COPY. A JDBC-backed table keeps its password in
//   hive.sql.dbcp.password, in plain text, and s3a settings can sit there too.
//   The catalog is shared with people the metastore's admins never considered,
//   so what is kept is a list of names known to be harmless, not everything
//   minus names that look bad.
//
//   LOCATIONS CAN CARRY CREDENTIALS. s3a://KEY:SECRET@bucket/path was once how
//   this was done, and old tables still have it.
import type { AssetMetadata } from "@/lib/catalogAssetMetadata";
import { isPiiColumnName } from "@/lib/piiHeuristic";
import { extractTableRefs } from "@/lib/sqlRefs";

export type HiveField = { name: string; type: string; comment?: string };

export type HiveDatabase = {
  name: string;
  description?: string;
  location?: string;
  owner?: string;
};

export type HiveTable = {
  database: string;
  name: string;
  owner?: string;
  /** Seconds since the epoch. */
  createTime?: number;
  tableType?: string;
  location?: string;
  inputFormat?: string;
  outputFormat?: string;
  compressed?: boolean;
  numBuckets?: number;
  bucketCols?: string[];
  serde?: string;
  serdeParameters?: Record<string, string>;
  columns: HiveField[];
  partitionKeys: HiveField[];
  parameters: Record<string, string>;
  viewOriginalText?: string;
  viewExpandedText?: string;
};

export type HivePartitions = {
  count: number;
  capped: boolean;
  first?: string;
  last?: string;
};

/** A column as the catalog stores it, including its partition mark. */
export type HiveAssetColumn = {
  name: string;
  type: string;
  comment?: string;
  pii?: boolean;
  /** A partition key: a directory in the path, not a value in the files. */
  partition?: boolean;
};

export type HiveAsset = {
  asset_type: "table" | "view";
  schema_name: string;
  name: string;
  fqn: string;
  columns: HiveAssetColumn[];
  row_count: number | null;
  size_bytes: number | null;
  format: string | null;
  file_count: number | null;
  pii: boolean;
  description: string | null;
  metadata: AssetMetadata;
};

const isView = (t: HiveTable) => /VIEW/i.test(t.tableType ?? "");

/** Table properties that describe the table and cannot hold a secret. */
const SAFE_PROPERTIES = new Set([
  "EXTERNAL",
  "TRANSLATED_TO_EXTERNAL",
  "external.table.purge",
  "transient_lastDdlTime",
  "numFiles",
  "numRows",
  "numPartitions",
  "numFilesErasureCoded",
  "rawDataSize",
  "totalSize",
  "bucketing_version",
  "table_type",
  "metadata_location",
  "previous_metadata_location",
  "spark.sql.sources.provider",
  "spark.sql.create.version",
  "parquet.compression",
  "orc.compress",
  "skip.header.line.count",
  "skip.footer.line.count",
  "field.delim",
  "serialization.format",
  "transactional",
  "transactional_properties",
  "COLUMN_STATS_ACCURATE",
  // What a Glue crawler records.
  "classification",
  "compressionType",
  "recordCount",
  "sizeKey",
  "objectCount",
  "averageRecordSize",
]);

const PROPERTY_VALUE_MAX = 300;

function safeProperties(t: HiveTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.parameters)) {
    if (SAFE_PROPERTIES.has(k)) out[k] = v.slice(0, PROPERTY_VALUE_MAX);
  }
  return out;
}

/**
 * The URI with its userinfo gone: `s3a://key:secret@bucket/x` -> `s3a://bucket/x`.
 * A regex, not URL: an s3a bucket can be a name URL would refuse, and a value
 * that fails to parse must not come back whole with the secret still in it.
 */
export function stripUriCredentials(uri: string): string {
  return uri.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
}

/**
 * A Spark schema type: a name, or a struct/array/map, as Hive would write it.
 * Delta's log uses the same JSON, so it reads through here too.
 */
export function sparkTypeName(t: unknown): string {
  if (typeof t === "string") return t;
  if (!t || typeof t !== "object") return "unknown";
  const o = t as {
    type?: string;
    elementType?: unknown;
    keyType?: unknown;
    valueType?: unknown;
    fields?: { name: string; type: unknown }[];
  };
  if (o.type === "array") return `array<${sparkTypeName(o.elementType)}>`;
  if (o.type === "map") return `map<${sparkTypeName(o.keyType)},${sparkTypeName(o.valueType)}>`;
  if (o.type === "struct") {
    return `struct<${(o.fields ?? []).map((f) => `${f.name}:${sparkTypeName(f.type)}`).join(",")}>`;
  }
  return o.type ?? "unknown";
}

/**
 * The columns Spark really wrote, from table properties: one JSON document,
 * or split across numbered parts when it was too long for one property.
 * Null when this is not such a table, or the JSON will not parse.
 */
export function sparkSchema(p: Record<string, string>): HiveField[] | null {
  const prefix = "spark.sql.sources.schema";
  let json = p[prefix];
  const parts = Number(p[`${prefix}.numParts`]);
  if (!json && Number.isInteger(parts) && parts > 0) {
    json = "";
    for (let i = 0; i < parts; i++) {
      const part = p[`${prefix}.part.${i}`];
      // A missing part means the JSON is cut, and half a schema is a lie.
      if (part === undefined) return null;
      json += part;
    }
  }
  if (!json) return null;
  try {
    const doc = JSON.parse(json) as {
      fields?: { name: string; type: unknown; metadata?: { comment?: unknown } }[];
    };
    if (!Array.isArray(doc.fields)) return null;
    return doc.fields.map((f) => {
      const comment = typeof f.metadata?.comment === "string" ? f.metadata.comment : undefined;
      return { name: f.name, type: sparkTypeName(f.type), ...(comment ? { comment } : {}) };
    });
  } catch {
    return null;
  }
}

/** Spark's partition columns, in order: their names only, in the properties. */
function sparkPartitionColumns(p: Record<string, string>): string[] {
  const n = Number(p["spark.sql.sources.schema.numPartCols"]);
  if (!Number.isInteger(n) || n <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = p[`spark.sql.sources.schema.partCol.${i}`];
    if (c) out.push(c);
  }
  return out;
}

/** The table format, or the file format: whichever a reader must know first. */
export function hiveFormat(t: HiveTable): string | null {
  if (isView(t)) return null;
  const p = t.parameters;
  if ((p.table_type ?? "").toLowerCase() === "iceberg" || p.metadata_location) return "iceberg";
  const provider = (p["spark.sql.sources.provider"] ?? "").toLowerCase();
  if (provider && provider !== "hive") {
    // Spark writes a short name, or a class: org.apache.spark.sql.parquet.
    const short = provider.includes(".")
      ? (provider
          .split(".")
          .find((s) => /^(delta|hudi|iceberg|parquet|orc|avro|csv|json)$/.test(s)) ??
        provider.split(".").pop()!)
      : provider;
    return short;
  }
  // What a Glue crawler concluded from the files themselves.
  const classification = (p.classification ?? "").toLowerCase();
  if (/^(parquet|orc|avro|csv|json|xml|delta|hudi|iceberg)$/.test(classification)) {
    return classification;
  }
  const handler = (p.storage_handler ?? "").toLowerCase();
  for (const [needle, name] of [
    ["hbase", "hbase"],
    ["jdbc", "jdbc"],
    ["kudu", "kudu"],
    ["druid", "druid"],
    ["kafka", "kafka"],
    ["iceberg", "iceberg"],
  ] as const) {
    if (handler.includes(needle)) return name;
  }
  const input = (t.inputFormat ?? "").toLowerCase();
  const serde = (t.serde ?? "").toLowerCase();
  if (input.includes("hoodie")) return "hudi";
  if (input.includes("parquet")) return "parquet";
  if (input.includes("orc")) return "orc";
  if (input.includes("avro")) return "avro";
  if (input.includes("rcfile")) return "rcfile";
  if (input.includes("sequencefile")) return "sequencefile";
  if (input.includes("textinputformat")) {
    if (serde.includes("opencsv")) return "csv";
    if (serde.includes("json")) return "json";
    return "text";
  }
  return null;
}

/** A property as a count: a non-negative whole number, or nothing. */
function count(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Has Hive vouched for its basic statistics on this table? */
function statsAccurate(p: Record<string, string>): boolean {
  const raw = p.COLUMN_STATS_ACCURATE;
  if (!raw) return false;
  if (raw === "true") return true;
  try {
    const doc = JSON.parse(raw) as { BASIC_STATS?: unknown };
    return doc.BASIC_STATS === "true" || doc.BASIC_STATS === true;
  } catch {
    return false;
  }
}

/**
 * Written by something other than Hive?
 *
 * Hive 4 turns a plain CREATE TABLE into EXTERNAL_TABLE and marks the change
 * with TRANSLATED_TO_EXTERNAL, so EXTERNAL alone no longer means this. Those
 * tables are still Hive's, and Hive keeps their counts.
 */
function writtenOutsideHive(p: Record<string, string>): boolean {
  const isTrue = (v: string | undefined) => (v ?? "").toUpperCase() === "TRUE";
  return isTrue(p.EXTERNAL) && !isTrue(p.TRANSLATED_TO_EXTERNAL);
}

/**
 * Row and size numbers, each one only when it can be believed.
 *
 * Spark's statistics are measured, so a value there is a value. Hive's numRows
 * means something only under COLUMN_STATS_ACCURATE. numFiles and totalSize are
 * read from the filesystem, so a positive one is a fact.
 *
 * A ZERO IS DIFFERENT. MEASURED on apache/hive:4.0.1: an external table created
 * over an empty folder got numRows 0, numFiles 0 and COLUMN_STATS_ACCURATE true.
 * A file then landed in the folder the way files land in external tables, from
 * outside Hive. SELECT count(*) said 3. The metastore still said 0, and still
 * said accurate. So on such a table Hive's word for zero is worth nothing, and
 * the catalog says it does not know rather than that the table is empty.
 *
 * ICEBERG IS THE EXCEPTION THE OTHER WAY. Iceberg writes numRows from its own
 * snapshot at each commit, and BASIC_STATS never appears in the accuracy flag.
 * MEASURED on apache/hive:4.0.1: numRows 3, SELECT count(*) 3, no BASIC_STATS.
 */
function tableStats(p: Record<string, string>): {
  row_count: number | null;
  size_bytes: number | null;
  file_count: number | null;
} {
  const sparkRows = count(p["spark.sql.statistics.numRows"]);
  const sparkSize = count(p["spark.sql.statistics.totalSize"]);
  const accurate = statsAccurate(p);
  const zeroStands = accurate && !writtenOutsideHive(p);
  const iceberg = (p.table_type ?? "").toUpperCase() === "ICEBERG";
  const believable = (v: number | null) => (v !== null && (v > 0 || zeroStands) ? v : null);
  // A Glue crawler's own count is an estimate, and a zero there is no more a
  // measurement than Hive's: it describes what the crawler last saw.
  const positive = (v: number | null) => (v !== null && v > 0 ? v : null);
  return {
    row_count:
      sparkRows ??
      positive(count(p.recordCount)) ??
      (accurate || iceberg ? believable(count(p.numRows)) : null),
    size_bytes: sparkSize ?? positive(count(p.sizeKey)) ?? believable(count(p.totalSize)),
    file_count: positive(count(p.objectCount)) ?? believable(count(p.numFiles)),
  };
}

/** Is this column the placeholder Hive holds for a table it cannot read? */
const isPlaceholderSchema = (cols: HiveField[]) =>
  cols.length === 1 && cols[0].name === "col" && cols[0].type === "array<string>";

/** Formats that keep their schema in their own metadata, not the metastore's. */
const SELF_DESCRIBING = new Set(["delta", "iceberg", "hudi"]);

/** Hive's column types are lowercase already; keep them as the metastore wrote them. */
function assetColumns(t: HiveTable): {
  columns: HiveAssetColumn[];
  partitionNames: string[];
  note?: string;
} {
  const spark = sparkSchema(t.parameters);
  const sparkParts = sparkPartitionColumns(t.parameters);
  const format = hiveFormat(t);
  let data: HiveField[];
  let keys: HiveField[];
  let note: string | undefined;
  if (spark) {
    // Spark's list holds every column; its partition columns are named apart.
    const names = new Set(sparkParts.length ? sparkParts : t.partitionKeys.map((k) => k.name));
    data = spark.filter((c) => !names.has(c.name));
    keys = [...names].map(
      (n) =>
        spark.find((c) => c.name === n) ??
        t.partitionKeys.find((k) => k.name === n) ?? { name: n, type: "unknown" },
    );
  } else if (isPlaceholderSchema(t.columns) && format !== null && SELF_DESCRIBING.has(format)) {
    // Not one column called `col`. The schema is in the table's own log.
    data = [];
    keys = t.partitionKeys;
    note = `This ${format[0].toUpperCase()}${format.slice(1)} table keeps its schema in its own metadata, not in the metastore, so the metastore cannot list its columns.`;
  } else {
    data = t.columns;
    keys = t.partitionKeys;
  }
  const mark = (c: HiveField, partition: boolean): HiveAssetColumn => {
    const pii = isPiiColumnName(c.name);
    return {
      name: c.name,
      type: c.type,
      ...(c.comment && c.comment !== "from deserializer" ? { comment: c.comment } : {}),
      ...(pii ? { pii: true } : {}),
      ...(partition ? { partition: true } : {}),
    };
  };
  return {
    columns: [...data.map((c) => mark(c, false)), ...keys.map((c) => mark(c, true))],
    partitionNames: keys.map((k) => k.name),
    ...(note ? { note } : {}),
  };
}

/**
 * Spark keeps a datasource table's format in its own properties and leaves a
 * stand-in layout in the metastore: a text or sequence file that describes
 * nothing. Shown, it would say a Parquet table is a text table.
 */
function isSparkStandIn(t: HiveTable): boolean {
  const provider = (t.parameters["spark.sql.sources.provider"] ?? "").toLowerCase();
  return (
    provider !== "" &&
    provider !== "hive" &&
    /(SequenceFile|Text)InputFormat/.test(t.inputFormat ?? "")
  );
}

/** Hive's epoch seconds as ISO. Zero and negatives are "not set". */
function isoFromSeconds(s: number | undefined): string | undefined {
  return s && s > 0 ? new Date(s * 1000).toISOString() : undefined;
}

export function hiveTableToAsset(t: HiveTable, partitions?: HivePartitions): HiveAsset {
  const view = isView(t);
  const { columns, partitionNames, note } = assetColumns(t);
  const stats = view
    ? { row_count: null, size_bytes: null, file_count: null }
    : tableStats(t.parameters);
  const properties = safeProperties(t);
  const viewSql = view ? (t.viewOriginalText ?? t.viewExpandedText) : undefined;
  const standIn = isSparkStandIn(t);
  const metadata: AssetMetadata = {
    ...(t.location ? { location: stripUriCredentials(t.location) } : {}),
    ...(t.tableType ? { table_type: t.tableType } : {}),
    ...(t.inputFormat && !standIn ? { input_format: t.inputFormat } : {}),
    ...(t.outputFormat && !standIn ? { output_format: t.outputFormat } : {}),
    ...(t.serde && !standIn ? { serde: t.serde } : {}),
    ...(partitionNames.length ? { partition_keys: partitionNames } : {}),
    ...(partitions
      ? {
          partition_count: partitions.count,
          ...(partitions.capped ? { partition_count_capped: true } : {}),
          ...(partitions.first ? { first_partition: partitions.first } : {}),
          ...(partitions.last ? { last_partition: partitions.last } : {}),
        }
      : {}),
    ...(t.bucketCols?.length ? { bucket_columns: t.bucketCols } : {}),
    ...(t.numBuckets && t.numBuckets > 0 ? { bucket_count: t.numBuckets } : {}),
    ...(t.owner ? { source_owner: t.owner } : {}),
    ...(isoFromSeconds(t.createTime) ? { created_at: isoFromSeconds(t.createTime) } : {}),
    ...(viewSql ? { view_sql: viewSql } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(note ? { note } : {}),
  };
  return {
    asset_type: view ? "view" : "table",
    schema_name: t.database,
    name: t.name,
    fqn: `${t.database}.${t.name}`,
    columns,
    ...stats,
    format: hiveFormat(t),
    pii: columns.some((c) => c.pii),
    description: t.parameters.comment?.trim() || null,
    metadata,
  };
}

/**
 * What a view reads, for the lineage graph: `db.table` for each reference.
 * Hive's expanded text qualifies every name, so it is preferred. An unqualified
 * name in the original text belongs to the view's own database.
 */
export function hiveViewUpstreams(t: HiveTable): string[] {
  if (!isView(t)) return [];
  const sql = t.viewExpandedText || t.viewOriginalText;
  if (!sql) return [];
  const self = `${t.database}.${t.name}`.toLowerCase();
  return [
    ...new Set(
      extractTableRefs(sql)
        .map((r) => r.replace(/[`"]/g, ""))
        .map((r) => (r.includes(".") ? r : `${t.database}.${r}`.toLowerCase()))
        .filter((r) => r !== self),
    ),
  ];
}
