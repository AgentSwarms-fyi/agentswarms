// Partition keys with transforms, the pure half: what a key may be, the SQL
// that sets it, and how DuckLake's own catalog describes it back.
//
// A key is a column, or a column through a transform: year, month, day or
// hour of a date or timestamp, or a hash bucket of anything. A transform is
// what makes a partition key usable on a fine-grained column: partitioning
// by a timestamp itself writes a file per distinct instant, by day(ts) one
// per day. These are the transforms the engine's DuckLake extension accepts,
// measured on DuckDB 1.5.5: truncate is refused ("only year, month, day,
// hour, and bucket are supported"), and year() on a VARCHAR column is
// accepted and means nothing, which is why the type check below exists.

export const PARTITION_TRANSFORMS = ["identity", "year", "month", "day", "hour", "bucket"] as const;
export type PartitionTransform = (typeof PARTITION_TRANSFORMS)[number];

export type PartitionKey = {
  column: string;
  transform: PartitionTransform;
  /** Bucket count, for `bucket` only. */
  buckets?: number;
};

export const PARTITION_TRANSFORM_LABELS: Record<PartitionTransform, string> = {
  identity: "value",
  year: "year",
  month: "month",
  day: "day",
  hour: "hour",
  bucket: "hash bucket",
};

export const MAX_PARTITION_KEYS = 4;
export const MAX_BUCKETS = 1024;

const DATE_OR_TIME = /^(DATE|TIMESTAMP)/i;
const TIMESTAMP = /^TIMESTAMP/i;
/**
 * Types that cannot be a partition key: a VARIANT, a nested value or a blob
 * has a distinct value per row as often as not, and a file set per value is
 * a file per row. FOUND IN R457's UI pass: the dialog offered `payload
 * variant` like any column.
 */
const UNPARTITIONABLE = /^(VARIANT|STRUCT|MAP|UNION|BLOB|BYTEA|GEOMETRY|JSON)\b|\[\]$|^LIST\b/i;

/** Whether a column of this type can be a partition key at all. */
export function partitionable(columnType: string): boolean {
  return !UNPARTITIONABLE.test(columnType.trim());
}

/** The transforms a column of this type can take, in the order a picker offers them. */
export function transformsFor(columnType: string): PartitionTransform[] {
  if (!partitionable(columnType)) return [];
  if (TIMESTAMP.test(columnType)) return ["day", "month", "year", "hour", "identity", "bucket"];
  if (DATE_OR_TIME.test(columnType)) return ["day", "month", "year", "identity", "bucket"];
  return ["identity", "bucket"];
}

/** The first thing wrong with a key, in the words the dialog shows; null when it is fine. */
export function partitionKeyError(
  key: PartitionKey,
  columnType: string | undefined,
): string | null {
  if (columnType === undefined) return `There is no column "${key.column}".`;
  if (!partitionable(columnType)) {
    return `${key.column} is ${columnType.toLowerCase()}, which cannot be a partition key: it would write a file set per distinct value.`;
  }
  if (!PARTITION_TRANSFORMS.includes(key.transform)) {
    return `"${key.transform}" is not a partition transform.`;
  }
  if (!transformsFor(columnType).includes(key.transform)) {
    return key.transform === "hour"
      ? `hour() needs a timestamp; ${key.column} is ${columnType.toLowerCase()}.`
      : `${key.transform}() needs a date or a timestamp; ${key.column} is ${columnType.toLowerCase()}.`;
  }
  if (key.transform === "bucket") {
    const n = key.buckets;
    if (!Number.isInteger(n) || (n as number) < 2 || (n as number) > MAX_BUCKETS) {
      return `A hash bucket needs a bucket count from 2 to ${MAX_BUCKETS}.`;
    }
  }
  return null;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** One key as ALTER TABLE … SET PARTITIONED BY takes it. The column must already be checked. */
export function partitionKeySql(key: PartitionKey): string {
  const col = ident(key.column);
  if (key.transform === "identity") return col;
  if (key.transform === "bucket") return `bucket(${key.buckets}, ${col})`;
  return `${key.transform}(${col})`;
}

/** A key as people read it: `region`, `day(ts)`, `bucket(16, id)`. */
export function describePartitionKey(key: PartitionKey): string {
  if (key.transform === "identity") return key.column;
  if (key.transform === "bucket") return `bucket(${key.buckets}, ${key.column})`;
  return `${key.transform}(${key.column})`;
}

/**
 * A key from DuckLake's catalog: `ducklake_partition_column.transform` holds
 * `identity`, `year`, `month`, `day`, `hour` or `bucket(N)`. Anything else, a
 * transform a later DuckLake adds, is kept as written rather than dropped, so
 * the badge still says the table is partitioned.
 */
export function fromDuckLakeTransform(
  column: string,
  transform: string | null,
): PartitionKey & {
  unknown?: string;
} {
  const t = (transform ?? "identity").trim().toLowerCase();
  const bucket = /^bucket\((\d+)\)$/.exec(t);
  if (bucket) return { column, transform: "bucket", buckets: Number(bucket[1]) };
  if ((PARTITION_TRANSFORMS as readonly string[]).includes(t)) {
    return { column, transform: t as PartitionTransform };
  }
  return { column, transform: "identity", unknown: t };
}

/**
 * The partition a row falls in under one key, as SQL over the table's own
 * column, so the partitions a spec would make can be counted before it is set.
 * A bucket is counted with the engine's hash rather than Iceberg's murmur3:
 * the count of distinct buckets is what matters, not which one a row is in.
 */
export function partitionValueSql(key: PartitionKey): string {
  const col = ident(key.column);
  switch (key.transform) {
    case "identity":
      return col;
    case "year":
      return `year(${col})`;
    case "bucket":
      return `hash(${col}) % ${Math.trunc(key.buckets ?? 16)}`;
    default:
      return `date_trunc('${key.transform}', ${col})`;
  }
}

/** Rows, and the partitions they would fall in under these (already checked) keys. */
export function partitionEstimateSql(schema: string, table: string, keys: PartitionKey[]): string {
  return (
    `SELECT count(*)::BIGINT, count(DISTINCT row(${keys.map(partitionValueSql).join(", ")}))::BIGINT ` +
    `FROM "lake".${ident(schema)}.${ident(table)}`
  );
}

export type PartitionEstimate = { rows: number; bytes: number; partitions: number };

/** Below this a partition's files are small enough that partitioning costs more than it saves. */
export const SMALL_PARTITION_BYTES = 32 * 1024 * 1024;

const fmt = (n: number) =>
  n >= 1024 * 1024 * 1024
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 * 1024
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${Math.round(n)} B`;

/**
 * What a spec would do to the table's files, in the dialog's words.
 *
 * DuckLake writes one file per partition an insert touches, so a spec that
 * cuts a table into many small partitions turns every insert into many small
 * writes. FOUND IN R457's UI pass: day(ts) and bucket(16, id) on a 498-row
 * table made about 330 partitions, and re-inserting those rows (a clustered
 * rewrite) took 150 s against the development object store, one upload per
 * file, where the same insert on local disk takes under 4 s (measured).
 */
export function partitionAdvice(e: PartitionEstimate): { level: "ok" | "warn"; text: string } {
  const per = e.partitions > 0 ? e.bytes / e.partitions : 0;
  const now =
    `Today's ${e.rows.toLocaleString()} row(s) would fall in ${e.partitions.toLocaleString()} ` +
    `partition(s), about ${fmt(per)} each.`;
  if (e.partitions >= 8 && per < SMALL_PARTITION_BYTES) {
    return {
      level: "warn",
      text:
        `${now} Every insert writes a file per partition it touches, so one that spans them all ` +
        `writes ${e.partitions.toLocaleString()} small files, and a read opens more files than it skips. ` +
        `Use a coarser key (month instead of day, fewer buckets), or leave a table this size ` +
        `unpartitioned until it grows.`,
    };
  }
  return { level: "ok", text: now };
}

/** Keys as display strings, for the badge: an unknown transform shows as DuckLake wrote it. */
export function describePartitionKeys(keys: (PartitionKey & { unknown?: string })[]): string[] {
  return keys.map((k) => (k.unknown ? `${k.unknown}(${k.column})` : describePartitionKey(k)));
}
