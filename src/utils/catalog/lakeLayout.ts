// How a bucket's paths say what they hold.
//
// A lake has conventions a crawl must read or it describes the files rather
// than the tables. Two of them change what the right answer is:
//
//   HIVE PARTITIONS. `sales/dt=2026-01-01/region=emea/part-0.parquet` is one
//   table, `sales`, partitioned by dt and region, whatever Spark, Hive, Trino
//   or Athena wrote it. Grouped by exact folder it is one asset per partition:
//   a year of daily data is 365 catalog entries, each with a name like
//   `region=emea`, and no entry for the table anyone is looking for.
//
//   TABLE FORMATS. A Delta, Iceberg or Hudi table is not its Parquet files. It
//   is a log saying which files are live; deleted and superseded rows stay in
//   the bucket until something vacuums them. Scanning `*.parquet` under one
//   answers with rows the table no longer has. Their marker folders start with
//   `_` or `.`, or are called `metadata`, so they were being discarded as
//   bookkeeping: the one thing that said what the folder was.
//
// Pure, because these rules are what the catalog stands on and each has edge
// cases worth a test.
import { sparkTypeName } from "@/utils/catalog/hive/mapping";

export type TableFormat = "delta" | "iceberg" | "hudi";

/** `dt=2026-01-01`: a key that could be a column name, then anything. */
const PARTITION_DIR = /^[A-Za-z_][\w.-]*=/;

/**
 * Split a folder into the table root and the partition keys below it.
 *
 * Only a run of `key=value` segments at the END counts: `a=1/raw/` is a folder
 * that happens to have an `=` above it, not a partition of anything.
 */
export function splitPartitionDir(dir: string): { root: string; keys: string[] } {
  const segs = dir.split("/");
  let i = segs.length;
  while (i > 0 && PARTITION_DIR.test(segs[i - 1])) i--;
  if (i === segs.length) return { root: dir, keys: [] };
  return {
    root: segs.slice(0, i).join("/"),
    keys: segs.slice(i).map((s) => s.slice(0, s.indexOf("="))),
  };
}

/** The tables in a listing, by the marker each format leaves: root -> format. */
export function tableFormatRoots(keys: Iterable<string>): Map<string, TableFormat> {
  const roots = new Map<string, TableFormat>();
  for (const key of keys) {
    const delta = /^(?:(.*)\/)?_delta_log\/[^/]+$/.exec(key);
    if (delta) {
      roots.set(delta[1] ?? "", "delta");
      continue;
    }
    const hudi = /^(?:(.*)\/)?\.hoodie\//.exec(key);
    if (hudi) {
      roots.set(hudi[1] ?? "", "hudi");
      continue;
    }
    const iceberg = /^(?:(.*)\/)?metadata\/[^/]*\.metadata\.json$/.exec(key);
    if (iceberg) roots.set(iceberg[1] ?? "", "iceberg");
  }
  return roots;
}

/**
 * The table a key belongs to, or undefined.
 *
 * The longest root wins, so a table nested under another's folder stays its
 * own. Walks the key's own folders, so it costs the path's depth and not the
 * number of tables, on listings of tens of thousands of objects.
 */
export function owningRoot(key: string, roots: Map<string, TableFormat>): string | undefined {
  if (roots.size === 0) return undefined;
  for (let at = key.lastIndexOf("/"); at > 0; at = key.lastIndexOf("/", at - 1)) {
    const root = key.slice(0, at);
    if (roots.has(root)) return root;
  }
  return roots.has("") ? "" : undefined;
}

export type TableSchemaField = { name: string; type: string; comment?: string };

export type DeltaMetadata = {
  fields: TableSchemaField[];
  partitionColumns: string[];
  description?: string;
};

/**
 * The newest `metaData` action in one commit file, or null.
 *
 * A commit is newline-delimited JSON. The read may have stopped partway
 * through a line, so a line that will not parse is passed over, not fatal.
 */
export function parseDeltaCommit(text: string): DeltaMetadata | null {
  let found: DeltaMetadata | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"metaData"')) continue;
    try {
      const action = JSON.parse(line) as {
        metaData?: { schemaString?: string; partitionColumns?: unknown; description?: unknown };
      };
      const md = action.metaData;
      if (!md?.schemaString) continue;
      const schema = JSON.parse(md.schemaString) as {
        fields?: { name: string; type: unknown; metadata?: { comment?: unknown } }[];
      };
      if (!Array.isArray(schema.fields)) continue;
      found = {
        fields: schema.fields.map((f) => {
          const comment = typeof f.metadata?.comment === "string" ? f.metadata.comment : undefined;
          return { name: f.name, type: sparkTypeName(f.type), ...(comment ? { comment } : {}) };
        }),
        partitionColumns: Array.isArray(md.partitionColumns)
          ? md.partitionColumns.filter((c): c is string => typeof c === "string")
          : [],
        ...(typeof md.description === "string" && md.description
          ? { description: md.description }
          : {}),
      };
    } catch {
      /* a cut or malformed line */
    }
  }
  return found;
}

/** Delta commit files, newest first: `000…012.json`, sorted by their number. */
export function deltaCommitsNewestFirst(keys: string[]): string[] {
  return keys
    .filter((k) => /\/?_delta_log\/\d+\.json$/.test(k))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Iceberg's `v12.metadata.json` or `00012-<uuid>.metadata.json`, newest first. */
export function icebergMetadataNewestFirst(keys: string[]): string[] {
  const version = (k: string) => {
    const m = /(?:^|\/)v?(\d+)[-.][^/]*metadata\.json$/.exec(k);
    return m ? Number(m[1]) : -1;
  };
  return keys
    .filter((k) => /\.metadata\.json$/.test(k))
    .sort((a, b) => version(b) - version(a) || (a < b ? 1 : a > b ? -1 : 0));
}

export type HudiProperties = {
  name?: string;
  partitionFields: string[];
  tableType?: string;
  fields: TableSchemaField[];
};

/** `.hoodie/hoodie.properties`, a Java properties file. */
export function parseHudiProperties(text: string): HudiProperties {
  const props = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  let fields: TableSchemaField[] = [];
  try {
    // An Avro schema, Java-escaped; present on tables written by recent Hudi.
    const raw = props.get("hoodie.table.create.schema");
    if (raw) {
      const avro = JSON.parse(raw.replace(/\\(.)/g, "$1")) as {
        fields?: { name: string; type: unknown; doc?: unknown }[];
      };
      fields = (avro.fields ?? [])
        .filter((f) => !f.name.startsWith("_hoodie_"))
        .map((f) => {
          const t = Array.isArray(f.type) ? f.type.find((x) => x !== "null") : f.type;
          const type =
            typeof t === "string"
              ? t
              : ((t as { logicalType?: string; type?: string } | undefined)?.logicalType ??
                (t as { type?: string } | undefined)?.type ??
                "unknown");
          return {
            name: f.name,
            type,
            ...(typeof f.doc === "string" && f.doc ? { comment: f.doc } : {}),
          };
        });
    }
  } catch {
    /* the columns stay unlisted; the note says why */
  }
  const partitions = props.get("hoodie.table.partition.fields");
  return {
    name: props.get("hoodie.table.name"),
    partitionFields: partitions
      ? partitions
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    tableType: props.get("hoodie.table.type"),
    fields,
  };
}
