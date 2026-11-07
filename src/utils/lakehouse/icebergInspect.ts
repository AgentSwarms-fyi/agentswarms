// What an Iceberg table is, read from its own metadata: the pure half of the
// table tab's Iceberg panel. The engine hands the table's metadata as JSON
// (`iceberg_load_table_response(...).metadata`, the catalog's LoadTable
// answer) and a count of its files by kind (`iceberg_metadata`); this turns
// them into what a person needs: the format version and the v3 features in
// use, the schema and how it evolved, partitioning and sort order, the
// snapshots with what each did, the branches and tags, and advice on upkeep.
//
// Every 64-bit id stays a string. Snapshot ids are random 63-bit numbers
// (7259124565828023429 in the development catalog), well past what a JS
// number holds exactly, and a rounded id time-travels to a snapshot that
// does not exist.
//
// Measured against tables Spark 4.1 and Iceberg 1.12 wrote (R457): the engine
// renders every number in the metadata as a string ("format-version":"3"),
// and nested types as objects. Both are handled; neither is assumed.

export type IcebergColumn = {
  id: number;
  name: string;
  type: string;
  required: boolean;
  /** A v3 default for rows written before the column existed. */
  initial_default?: string;
};

export type IcebergSnapshot = {
  id: string;
  parent_id: string | null;
  sequence: number | null;
  time: string | null;
  operation: string;
  added_records: number | null;
  deleted_records: number | null;
  /** Records in the snapshot's data files, deleted-but-not-rewritten rows included. */
  total_records: number | null;
  /**
   * The rows a reader sees: the data files' records less the position
   * deletes against them. Null when equality deletes are in play, whose
   * effect is not a count. FOUND IN R457's UI pass: the list showed
   * total_records as "rows", 10,176 for a table that reads 10,125.
   */
  rows: number | null;
  data_files: number | null;
  delete_files: number | null;
  schema_id: number | null;
  /** The branches and tags whose head this snapshot is. */
  refs: string[];
};

export type IcebergRef = { name: string; type: "branch" | "tag"; snapshot_id: string };

export type IcebergFileCounts = {
  data_files: number;
  data_records: number;
  /** Positional delete files written as Parquet (v2). */
  position_delete_files: number;
  /** Deletion vectors in Puffin files (v3). */
  deletion_vector_files: number;
  equality_delete_files: number;
  deleted_records: number;
};

export type IcebergAdvice = {
  kind: "compact" | "deletes" | "snapshots" | "upgrade" | "ok";
  title: string;
  detail: string;
  /** Spark SQL that does it, for the engine that runs Iceberg maintenance. */
  sql?: string;
};

export type IcebergInspection = {
  format_version: number | null;
  table_uuid: string | null;
  location: string | null;
  last_updated: string | null;
  current_snapshot_id: string | null;
  columns: IcebergColumn[];
  schema_versions: number;
  schema_changes: string[];
  partition_spec: { name: string; transform: string; source: string }[];
  partition_spec_versions: number;
  sort_order: { source: string; transform: string; direction: string; nulls: string }[];
  snapshots: IcebergSnapshot[];
  snapshot_count: number;
  refs: IcebergRef[];
  properties: { key: string; value: string }[];
  features: {
    deletion_vectors: boolean;
    row_lineage: boolean;
    variant: boolean;
    nanosecond_timestamps: boolean;
    geospatial: boolean;
    column_defaults: boolean;
  };
  next_row_id: string | null;
  files: IcebergFileCounts | null;
  advice: IcebergAdvice[];
};

type Json = Record<string, unknown>;

const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === "string" ? v : String(v);
/** A number the metadata may give as a string. Null when it is not one. */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** An Iceberg type as people read it: primitives as named, nested ones spelled out. */
export function icebergTypeName(t: unknown): string {
  if (typeof t === "string") return t;
  const o = obj(t);
  const kind = str(o.type);
  if (kind === "struct") {
    const fields = arr(o.fields).map((f) => {
      const fo = obj(f);
      return `${str(fo.name) ?? "?"}: ${icebergTypeName(fo.type)}`;
    });
    return `struct<${fields.join(", ")}>`;
  }
  if (kind === "list") return `list<${icebergTypeName(o.element)}>`;
  if (kind === "map") return `map<${icebergTypeName(o.key)}, ${icebergTypeName(o.value)}>`;
  return kind ?? "unknown";
}

/** Property keys that may carry a credential; never shown, whatever the catalog put there. */
const SECRET_KEY = /secret|token|password|passwd|credential|access[-_.]?key|private|session/i;

/** A table's properties, safe to show. */
export function safeProperties(props: unknown): { key: string; value: string }[] {
  return Object.entries(obj(props))
    .filter(([k]) => !SECRET_KEY.test(k))
    .map(([key, value]) => ({ key, value: str(value) ?? "" }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function columnsOf(schema: Json): IcebergColumn[] {
  return arr(schema.fields).map((f) => {
    const fo = obj(f);
    const def = fo["initial-default"];
    return {
      id: num(fo.id) ?? 0,
      name: str(fo.name) ?? "",
      type: icebergTypeName(fo.type),
      required: fo.required === true || fo.required === "true",
      ...(def !== undefined && def !== null ? { initial_default: str(def) ?? "" } : {}),
    };
  });
}

/**
 * How the schema evolved, oldest change first: columns added, renamed,
 * dropped or retyped between consecutive schema versions, matched by field
 * id the way Iceberg matches them (a rename keeps its id).
 */
export function schemaChanges(schemas: unknown[]): string[] {
  const ordered = schemas
    .map((s) => obj(s))
    .sort((a, b) => (num(a["schema-id"]) ?? 0) - (num(b["schema-id"]) ?? 0));
  const out: string[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const before = new Map(columnsOf(ordered[i - 1]).map((c) => [c.id, c]));
    const after = new Map(columnsOf(ordered[i]).map((c) => [c.id, c]));
    const version = num(ordered[i]["schema-id"]);
    const at = version === null ? "" : ` (schema ${version})`;
    for (const [id, col] of after) {
      const old = before.get(id);
      if (!old) out.push(`${col.name} added${at}`);
      else if (old.name !== col.name) out.push(`${old.name} renamed to ${col.name}${at}`);
      else if (old.type !== col.type)
        out.push(`${col.name} changed from ${old.type} to ${col.type}${at}`);
    }
    for (const [id, col] of before) if (!after.has(id)) out.push(`${col.name} dropped${at}`);
  }
  return out;
}

const MAX_SNAPSHOTS = 50;

/** Iceberg's millisecond epoch as an ISO time; null when it is not one. */
function isoMs(v: unknown): string | null {
  const ms = num(v);
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The table, from its metadata and its file counts. */
export function inspectIcebergMetadata(
  metadata: unknown,
  files: IcebergFileCounts | null,
  opts: { catalog: string; namespace: string; table: string },
): IcebergInspection {
  const md = obj(metadata);
  const schemas = arr(md.schemas);
  const currentSchemaId = num(md["current-schema-id"]);
  const current =
    schemas.map(obj).find((s) => num(s["schema-id"]) === currentSchemaId) ??
    obj(schemas[schemas.length - 1]);
  const columns = columnsOf(current);
  const byId = new Map(columns.map((c) => [c.id, c.name]));
  // A source dropped since still names something: look in every schema.
  for (const s of schemas)
    for (const c of columnsOf(obj(s))) if (!byId.has(c.id)) byId.set(c.id, c.name);
  const sourceName = (id: unknown) => byId.get(num(id) ?? -1) ?? `field ${str(id) ?? "?"}`;

  const specs = arr(md["partition-specs"]).map(obj);
  const defaultSpecId = num(md["default-spec-id"]);
  const spec =
    specs.find((s) => num(s["spec-id"]) === defaultSpecId) ?? specs[specs.length - 1] ?? {};
  const sorts = arr(md["sort-orders"]).map(obj);
  const defaultSortId = num(md["default-sort-order-id"]);
  const sort = sorts.find((s) => num(s["order-id"]) === defaultSortId) ?? {};

  const refs: IcebergRef[] = Object.entries(obj(md.refs))
    .map(([name, r]) => {
      const ro = obj(r);
      return {
        name,
        type: (str(ro.type) === "tag" ? "tag" : "branch") as IcebergRef["type"],
        snapshot_id: str(ro["snapshot-id"]) ?? "",
      };
    })
    .filter((r) => r.snapshot_id)
    .sort((a, b) =>
      a.name === "main"
        ? -1
        : b.name === "main"
          ? 1
          : a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    );

  const snapshots: IcebergSnapshot[] = arr(md.snapshots)
    .map(obj)
    .map((s) => {
      const sum = obj(s.summary);
      const id = str(s["snapshot-id"]) ?? "";
      const total = num(sum["total-records"]);
      const positionDeletes = num(sum["total-position-deletes"]) ?? 0;
      const equalityDeletes = num(sum["total-equality-deletes"]) ?? 0;
      return {
        id,
        parent_id: str(s["parent-snapshot-id"]),
        sequence: num(s["sequence-number"]),
        time: isoMs(s["timestamp-ms"]),
        operation: str(sum.operation) ?? "unknown",
        added_records: num(sum["added-records"]),
        deleted_records: num(sum["deleted-records"]),
        total_records: total,
        rows: total !== null && equalityDeletes === 0 ? Math.max(0, total - positionDeletes) : null,
        data_files: num(sum["total-data-files"]),
        delete_files: num(sum["total-delete-files"]),
        schema_id: num(s["schema-id"]),
        refs: refs.filter((r) => r.snapshot_id === id).map((r) => r.name),
      };
    })
    .filter((s) => s.id)
    .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));

  const formatVersion = num(md["format-version"]);
  const allTypes = schemas.flatMap((s) => columnsOf(obj(s)).map((c) => c.type.toLowerCase()));
  const nextRowId = str(md["next-row-id"]);
  const features = {
    deletion_vectors: (files?.deletion_vector_files ?? 0) > 0,
    row_lineage: (formatVersion ?? 0) >= 3 && nextRowId !== null,
    variant: allTypes.some((t) => /\bvariant\b/.test(t)),
    nanosecond_timestamps: allTypes.some((t) => /timestamp(tz)?_ns/.test(t)),
    geospatial: allTypes.some((t) => /\b(geometry|geography)\b/.test(t)),
    column_defaults: columns.some((c) => c.initial_default !== undefined),
  };

  const inspection: IcebergInspection = {
    format_version: formatVersion,
    table_uuid: str(md["table-uuid"]),
    location: str(md.location),
    last_updated: isoMs(md["last-updated-ms"]),
    current_snapshot_id: str(md["current-snapshot-id"]),
    columns,
    schema_versions: schemas.length,
    schema_changes: schemaChanges(schemas),
    partition_spec: arr(spec.fields).map((f) => {
      const fo = obj(f);
      return {
        name: str(fo.name) ?? "",
        transform: str(fo.transform) ?? "identity",
        source: sourceName(fo["source-id"]),
      };
    }),
    partition_spec_versions: specs.length,
    sort_order: arr(sort.fields).map((f) => {
      const fo = obj(f);
      return {
        source: sourceName(fo["source-id"]),
        transform: str(fo.transform) ?? "identity",
        direction: str(fo.direction) ?? "asc",
        nulls: str(fo["null-order"]) ?? "nulls-first",
      };
    }),
    snapshots: snapshots.slice(0, MAX_SNAPSHOTS),
    snapshot_count: snapshots.length,
    refs,
    properties: safeProperties(md.properties),
    features,
    next_row_id: nextRowId,
    files,
    advice: [],
  };
  inspection.advice = icebergAdvice(inspection, opts);
  return inspection;
}

/** File counts from `iceberg_metadata` rows grouped by manifest content, content and format. */
export function fileCountsFrom(
  rows: {
    manifest_content: string;
    content: string;
    file_format: string;
    files: number;
    records: number;
  }[],
): IcebergFileCounts {
  const out: IcebergFileCounts = {
    data_files: 0,
    data_records: 0,
    position_delete_files: 0,
    deletion_vector_files: 0,
    equality_delete_files: 0,
    deleted_records: 0,
  };
  for (const r of rows) {
    const manifest = r.manifest_content.toUpperCase();
    const content = r.content.toUpperCase();
    if (manifest === "DATA") {
      out.data_files += r.files;
      out.data_records += r.records;
      continue;
    }
    out.deleted_records += r.records;
    if (content.includes("EQUALITY")) out.equality_delete_files += r.files;
    else if (r.file_format.toUpperCase() === "PUFFIN") out.deletion_vector_files += r.files;
    else out.position_delete_files += r.files;
  }
  return out;
}

const SMALL_FILE_RECORDS = 50_000;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

/**
 * Upkeep, most valuable first. This lakehouse reads Iceberg tables and does
 * not rewrite them: compaction and snapshot expiry belong to the engine that
 * owns the table, so each item carries the Spark procedure that does it,
 * with the catalog named as it is registered here.
 */
export function icebergAdvice(
  t: IcebergInspection,
  opts: { catalog: string; namespace: string; table: string },
): IcebergAdvice[] {
  const out: IcebergAdvice[] = [];
  const ref = `${opts.namespace}.${opts.table}`;
  const call = (proc: string, extra = "") =>
    `CALL ${opts.catalog}.system.${proc}(table => '${ref.replace(/'/g, "''")}'${extra})`;
  const f = t.files;
  if (f) {
    const deleteFiles = f.position_delete_files + f.deletion_vector_files + f.equality_delete_files;
    if (deleteFiles > 0 && (deleteFiles >= 20 || f.deleted_records * 10 >= f.data_records)) {
      out.push({
        kind: "deletes",
        title: `${plural(deleteFiles, "delete file")} applied on every read`,
        detail: `${plural(f.deleted_records, "deleted row")} are still in the data files and are filtered out each time the table is read${f.equality_delete_files ? "; equality deletes are the costliest kind" : ""}. Rewriting the affected files removes them.`,
        sql: call("rewrite_data_files", ", options => map('delete-file-threshold', '1')"),
      });
    }
    const avg = f.data_files ? f.data_records / f.data_files : 0;
    if (f.data_files >= 32 && avg < SMALL_FILE_RECORDS) {
      out.push({
        kind: "compact",
        title: `${plural(f.data_files, "data file")} averaging ${Math.round(avg).toLocaleString()} rows`,
        detail:
          "A scan opens every file it cannot rule out, and small files multiply the opens. Compaction merges them into files near the target size." +
          (t.partition_spec.length > 1
            ? " A partition spec this fine also writes a file per combination."
            : ""),
        sql: call("rewrite_data_files"),
      });
    }
  }
  if (t.snapshot_count > 100) {
    out.push({
      kind: "snapshots",
      title: `${plural(t.snapshot_count, "snapshot")} kept`,
      detail:
        "Every snapshot keeps the files it references. Expiring old ones frees storage; time travel to them goes with them, and branches and tags are kept.",
      sql: call("expire_snapshots", ", older_than => TIMESTAMP '<cutoff>', retain_last => 20"),
    });
  }
  if (t.format_version !== null && t.format_version < 3) {
    out.push({
      kind: "upgrade",
      title: `Format v${t.format_version}`,
      detail:
        "v3 adds deletion vectors (cheaper deletes), row lineage, VARIANT and nanosecond timestamps. An upgrade cannot be undone, and every engine that reads the table must support v3 first.",
      sql: `ALTER TABLE ${opts.catalog}.${ref} SET TBLPROPERTIES ('format-version' = '3')`,
    });
  }
  if (!out.length) {
    out.push({
      kind: "ok",
      title: "Nothing to do",
      detail: "Few files, few deletes, a short history.",
    });
  }
  return out;
}

/** Every snapshot id in the metadata, uncapped: what a time-travel id is checked against. */
export function allSnapshotIds(metadata: unknown): string[] {
  return arr(obj(metadata).snapshots)
    .map((s) => str(obj(s)["snapshot-id"]))
    .filter((s): s is string => Boolean(s));
}

/**
 * The snapshot a branch, a tag or an id names; null when the table has no
 * such ref or snapshot. The engine's AT (VERSION => …) takes only an id
 * (measured: a tag name fails with "Could not convert string 'q3-close' to
 * INT64"), so a ref is resolved here first.
 */
export function resolveSnapshotRef(
  refs: IcebergRef[],
  snapshotIds: string[],
  ref: string,
): string | null {
  const r = refs.find((x) => x.name === ref);
  if (r) return r.snapshot_id;
  if (/^\d{1,20}$/.test(ref) && snapshotIds.includes(ref)) return ref;
  return null;
}

/**
 * The Iceberg table a mount's view reads, from the view's own SQL as the
 * engine keeps it: `… FROM "ice_<id>"."<namespace>"."<table>"`, each part
 * quoted or not. Null when the view reads something else.
 */
export function mountViewTarget(
  viewSql: string,
): { alias: string; namespace: string; table: string } | null {
  const part = String.raw`("(?:[^"]|"")+"|[A-Za-z0-9_]+)`;
  const m = new RegExp(String.raw`\bFROM\s+${part}\.${part}\.${part}`, "i").exec(viewSql);
  if (!m) return null;
  const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
  const alias = unq(m[1]);
  if (!/^ice_[0-9a-f]{32}$/.test(alias)) return null;
  return { alias, namespace: unq(m[2]), table: unq(m[3]) };
}
