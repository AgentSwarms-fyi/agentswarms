// Iceberg interop, the pure half: how an Iceberg REST catalog is described,
// what the engine is told to attach it, and the statements that mount a
// namespace as a lakehouse schema or publish a lakehouse table into it.
//
// The engine side is DuckDB's iceberg extension: a REST catalog attaches as
// a database (`ice_<id>`) whose namespaces are schemas and whose tables are
// tables, readable and - on a catalog that allows it - writable. A mount
// creates views under a lakehouse schema over those tables, so the per-user
// schema guard, the listing and the tools see Iceberg tables exactly as they
// see everything else; nothing is copied. Publishing creates the table in the
// catalog from the source's columns and inserts its rows. Everything below is
// text and rules; the server and the tests import it.

export const ICEBERG_AUTH_TYPES = ["none", "bearer", "oauth2"] as const;
export type IcebergAuthType = (typeof ICEBERG_AUTH_TYPES)[number];

export const ICEBERG_AUTH_LABELS: Record<IcebergAuthType, string> = {
  none: "No authentication",
  bearer: "Bearer token",
  oauth2: "OAuth2 client credentials",
};

/** Where the engine gets credentials for the table files. */
export const ICEBERG_STORAGE_MODES = ["vended", "lakehouse"] as const;
export type IcebergStorageMode = (typeof ICEBERG_STORAGE_MODES)[number];

export type IcebergCatalogConfig = {
  name: string;
  /** REST endpoint, e.g. https://catalog.example.com/api/catalog or http://host:8181 */
  endpoint: string;
  /** The warehouse the catalog serves; what ATTACH names. */
  warehouse: string;
  auth_type: IcebergAuthType;
  /** Secret names (Settings → Secrets); values never enter the row. */
  token_secret: string;
  client_id_secret: string;
  client_secret_secret: string;
  oauth2_server_uri: string;
  /** vended: the catalog hands out storage credentials; lakehouse: the lakehouse's own S3 secret reads the files. */
  storage: IcebergStorageMode;
  /** Attach only when the endpoint and token server resolve to private addresses (R428). */
  require_private?: boolean;
};

export const ICEBERG_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/**
 * A namespace or table name in the catalog, as the engine can address it.
 * FOUND IN R457: this allowed letters, digits and underscores only, so a
 * namespace like `sales-prod`, which catalogs commonly hold and which the
 * engine reads (measured: 100 rows from Spark's `sales-prod`.`daily-metrics`),
 * could be listed but not mounted, and such a table not imported. A hyphen is
 * fine: every statement quotes the name. A dot is not: a nested namespace
 * (`finance.eu`) is not listed by the engine at all on DuckDB 1.5, and its
 * SUPPORT_NESTED_NAMESPACES option requests `/namespaces/financeeu/tables`,
 * dropping the separator, and breaks the listing of every other namespace.
 */
export const ICEBERG_NAMESPACE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
export const ICEBERG_TABLE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export function defaultIcebergCatalog(): IcebergCatalogConfig {
  return {
    name: "",
    endpoint: "",
    warehouse: "",
    auth_type: "none",
    token_secret: "",
    client_id_secret: "",
    client_secret_secret: "",
    oauth2_server_uri: "",
    storage: "vended",
    require_private: false,
  };
}

/** The first thing wrong with a catalog, in the words the dialog shows. */
export function validateIcebergCatalog(cfg: IcebergCatalogConfig): string | null {
  if (!ICEBERG_NAME.test(cfg.name)) {
    return "Name the catalog with lowercase letters, digits and underscores, starting with a letter.";
  }
  if (!/^https?:\/\/\S+$/i.test(cfg.endpoint.trim())) return "The endpoint must be an http(s) URL.";
  if (!cfg.warehouse.trim()) return "A warehouse is required (what the catalog serves).";
  const secretOk = (s: string) => SECRET_NAME.test(s);
  if (cfg.auth_type === "bearer" && !secretOk(cfg.token_secret)) {
    return "Bearer authentication needs the secret holding the token.";
  }
  if (cfg.auth_type === "oauth2") {
    if (!secretOk(cfg.client_id_secret) || !secretOk(cfg.client_secret_secret)) {
      return "OAuth2 needs the secrets holding the client id and the client secret.";
    }
    if (cfg.oauth2_server_uri && !/^https?:\/\/\S+$/i.test(cfg.oauth2_server_uri.trim())) {
      return "The OAuth2 server URI must be an http(s) URL.";
    }
  }
  return null;
}

/** The engine's name for an attached catalog. */
export function icebergAlias(catalogId: string): string {
  return `ice_${catalogId.replace(/-/g, "")}`;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The secrets a catalog needs, as (name → secret name) pairs the server resolves as the owner. */
export function icebergSecretNames(
  cfg: IcebergCatalogConfig,
): { key: "token" | "client_id" | "client_secret"; secret: string }[] {
  if (cfg.auth_type === "bearer") return [{ key: "token", secret: cfg.token_secret }];
  if (cfg.auth_type === "oauth2") {
    return [
      { key: "client_id", secret: cfg.client_id_secret },
      { key: "client_secret", secret: cfg.client_secret_secret },
    ];
  }
  return [];
}

/**
 * CREATE SECRET for the catalog's credentials - a bearer token, or OAuth2
 * client credentials. An open catalog needs none. Kept apart from ATTACH so
 * a token rotation replaces the secret without a detach.
 */
export function icebergSecretSql(
  alias: string,
  cfg: IcebergCatalogConfig,
  secrets: { token?: string; client_id?: string; client_secret?: string },
): string | null {
  if (cfg.auth_type === "none") return null;
  const parts = [`TYPE iceberg`];
  if (cfg.auth_type === "bearer") parts.push(`TOKEN ${lit(secrets.token ?? "")}`);
  if (cfg.auth_type === "oauth2") {
    parts.push(
      `CLIENT_ID ${lit(secrets.client_id ?? "")}`,
      `CLIENT_SECRET ${lit(secrets.client_secret ?? "")}`,
    );
    if (cfg.oauth2_server_uri.trim()) {
      parts.push(`OAUTH2_SERVER_URI ${lit(cfg.oauth2_server_uri.trim())}`);
    } else {
      // FOUND IN R458 against Apache Polaris: with no server URI the engine
      // refused the secret ("no 'oauth2_server_uri' was provided, and no
      // 'endpoint' was provided to fall back on"), because the secret is made
      // apart from the ATTACH that names the endpoint. Every OAuth2 catalog
      // saved without the "optional" URI failed to attach. Given the
      // endpoint, the engine asks the REST spec's <endpoint>/v1/oauth/tokens.
      parts.push(`ENDPOINT ${lit(cfg.endpoint.trim().replace(/\/+$/, ""))}`);
    }
  }
  return `CREATE OR REPLACE SECRET ${ident(alias)} (${parts.join(", ")});`;
}

/** ATTACH the warehouse: the endpoint always here; the auth as the secret, or none. */
export function icebergAttachSql(alias: string, cfg: IcebergCatalogConfig): string {
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, "");
  const auth = cfg.auth_type === "none" ? `AUTHORIZATION_TYPE 'none'` : `SECRET ${ident(alias)}`;
  // READ_ONLY false: the extension attaches read-only unless told otherwise,
  // and publishing needs the write path. Who may write is decided here, not
  // in the engine: a mount exposes views, and publishing checks ownership.
  //
  // FOUND IN R457: the form's "Table files are read with" choice was stored
  // and never reached the engine, which asks every catalog to vend storage
  // credentials (its default ACCESS_DELEGATION_MODE). "The lakehouse's own
  // storage credentials" now tells the catalog not to: a catalog that cannot
  // vend need not be asked, and the files are read with the lakehouse's S3
  // secret, which is what the choice says.
  const delegation = cfg.storage === "lakehouse" ? ", ACCESS_DELEGATION_MODE 'none'" : "";
  return `ATTACH IF NOT EXISTS ${lit(cfg.warehouse.trim())} AS ${ident(alias)} (TYPE iceberg, ENDPOINT ${lit(endpoint)}, ${auth}, READ_ONLY false${delegation});`;
}

export function icebergDetachSql(alias: string): string {
  return `DETACH DATABASE IF EXISTS ${ident(alias)};`;
}

/**
 * Namespaces the catalog exposes (its schemas). An attached Iceberg catalog
 * has no information_schema; DuckDB's own catalog functions see it.
 */
export function icebergListNamespacesSql(alias: string): string {
  return (
    `SELECT schema_name FROM duckdb_schemas() WHERE database_name = ${lit(alias)} ` +
    `AND schema_name NOT IN ('information_schema', 'pg_catalog', 'main') ORDER BY 1`
  );
}

export function icebergListTablesSql(alias: string, namespace: string): string {
  return (
    `SELECT table_name FROM duckdb_tables() WHERE database_name = ${lit(alias)} ` +
    `AND schema_name = ${lit(namespace)} ORDER BY 1`
  );
}

/** A lakehouse view name for an Iceberg table name. */
export function icebergViewName(tableName: string): string | null {
  const v = tableName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 60);
  return /^[a-z][a-z0-9_]*$/.test(v) ? v : null;
}

/** The view a mount creates: the Iceberg table, seen as a lakehouse table. */
export function icebergViewSql(
  schema: string,
  view: string,
  alias: string,
  namespace: string,
  table: string,
): string {
  return (
    `CREATE OR REPLACE VIEW ${ident(schema)}.${ident(view)} AS ` +
    `SELECT * FROM ${ident(alias)}.${ident(namespace)}.${ident(table)}`
  );
}

/** A source column as the engine describes it (`duckdb_columns()`). */
export type PublishColumn = { name: string; type: string };

/** The Iceberg partition transforms a publish can write. */
export const ICEBERG_PARTITION_TRANSFORMS = [
  "identity",
  "year",
  "month",
  "day",
  "hour",
  "bucket",
  "truncate",
] as const;
export type IcebergPartitionTransform = (typeof ICEBERG_PARTITION_TRANSFORMS)[number];

export type IcebergPartitionKey = {
  column: string;
  transform: IcebergPartitionTransform;
  /** Bucket count for `bucket`, width for `truncate`. */
  width?: number;
};

/** What a published table is written as: its format version and partition spec. */
export type IcebergPublishLayout = {
  formatVersion: 2 | 3;
  partition: IcebergPartitionKey[];
};

const TEMPORAL = /^(DATE|TIMESTAMP)/i;
const TIMESTAMP_TYPE = /^TIMESTAMP/i;
/** Iceberg's truncate takes strings, integers and decimals; bucket refuses floats and booleans. */
const TRUNCATABLE =
  /^(VARCHAR|TEXT|STRING|BLOB|TINYINT|SMALLINT|INTEGER|INT|BIGINT|DECIMAL|NUMERIC)/i;
const UNBUCKETABLE = /^(FLOAT|REAL|DOUBLE|BOOLEAN|BOOL)/i;
/** Types only format v3 can hold (measured: a VARIANT column in a v2 table makes the catalog answer HTTP 500). */
const V3_ONLY = /\b(VARIANT|TIMESTAMP_NS|GEOMETRY)\b/i;

/** The source columns that need format v3. */
export function v3OnlyColumns(columns: PublishColumn[]): string[] {
  return columns.filter((c) => V3_ONLY.test(c.type)).map((c) => c.name);
}

/**
 * The first thing wrong with a publish layout for these source columns, in
 * the words the dialog shows; null when it can be written.
 */
export function icebergLayoutError(
  layout: IcebergPublishLayout,
  columns: PublishColumn[],
): string | null {
  if (layout.formatVersion !== 2 && layout.formatVersion !== 3) {
    return "The format version is 2 or 3.";
  }
  const needsV3 = v3OnlyColumns(columns);
  if (layout.formatVersion === 2 && needsV3.length) {
    return `${needsV3.join(", ")} ${needsV3.length === 1 ? "is a type" : "are types"} only Iceberg format v3 holds; publish as v3.`;
  }
  if (layout.partition.length > 4) return "Partition by four columns at most.";
  const seen = new Set<string>();
  for (const key of layout.partition) {
    const col = columns.find((c) => c.name === key.column);
    if (!col) return `There is no column "${key.column}" to partition by.`;
    const label = `${key.transform}(${key.column})`;
    if (seen.has(label)) return `${label} is in the partition spec twice.`;
    seen.add(label);
    const type = col.type;
    if (["year", "month", "day"].includes(key.transform) && !TEMPORAL.test(type)) {
      return `${key.transform}() needs a date or a timestamp; ${key.column} is ${type.toLowerCase()}.`;
    }
    if (key.transform === "hour" && !TIMESTAMP_TYPE.test(type)) {
      return `hour() needs a timestamp; ${key.column} is ${type.toLowerCase()}.`;
    }
    if (key.transform === "truncate") {
      if (!TRUNCATABLE.test(type)) {
        return `truncate() takes text, integers or decimals; ${key.column} is ${type.toLowerCase()}.`;
      }
      if (
        !Number.isInteger(key.width) ||
        (key.width as number) < 1 ||
        (key.width as number) > 1024
      ) {
        return "truncate() needs a width from 1 to 1024.";
      }
    }
    if (key.transform === "bucket") {
      if (UNBUCKETABLE.test(type)) {
        return `bucket() cannot hash ${type.toLowerCase()}; pick another column.`;
      }
      if (
        !Number.isInteger(key.width) ||
        (key.width as number) < 2 ||
        (key.width as number) > 1024
      ) {
        return "bucket() needs a bucket count from 2 to 1024.";
      }
    }
    if (V3_ONLY.test(type) || /\[\]$|^(STRUCT|MAP|LIST|UNION)/i.test(type)) {
      return `${key.column} is ${type.toLowerCase()}, which cannot be a partition key.`;
    }
  }
  return null;
}

/** One partition key as the engine's CREATE TABLE … PARTITIONED BY takes it. */
export function icebergPartitionSql(key: IcebergPartitionKey): string {
  const col = ident(key.column);
  if (key.transform === "identity") return col;
  if (key.transform === "bucket" || key.transform === "truncate") {
    return `${key.transform}(${key.width}, ${col})`;
  }
  return `${key.transform}(${col})`;
}

/**
 * The tail of a CREATE TABLE for a layout: the partition spec, then the
 * format version. Measured on the engine: this order parses and the reverse
 * is a syntax error, and with no WITH a table is written as v2.
 */
export function icebergLayoutSql(layout: IcebergPublishLayout | undefined): string {
  if (!layout) return "";
  const partition = layout.partition.length
    ? ` PARTITIONED BY (${layout.partition.map(icebergPartitionSql).join(", ")})`
    : "";
  return `${partition} WITH ('format-version' = ${layout.formatVersion})`;
}

/**
 * Publishing a lakehouse table into the catalog: the namespace first, then
 * the table from the source's own column list, then its rows. `replace`
 * swaps the new table in on the catalog side; `create` refuses an existing
 * table.
 *
 * FOUND IN R181. This was a CREATE TABLE AS, and the extension build a fresh
 * image bakes writes a CREATE TABLE AS to a relative `data/` directory
 * whenever the ducklake extension is loaded, which in this engine it always
 * is: every publish failed with `Failed to create directory "data":
 * Permission denied`. A CREATE TABLE with columns, then an INSERT, writes to
 * the table's own location in the catalog. Explicit column types are refused
 * or accepted exactly as the CREATE TABLE AS did (checked type by type on
 * the extension: UTINYINT, UBIGINT, ENUM and INTERVAL refused; HUGEINT, MAP,
 * TIMESTAMPTZ, lists and structs accepted).
 */
export function icebergPublishSql(args: {
  alias: string;
  namespace: string;
  table: string;
  sourceSchema: string;
  sourceTable: string;
  mode: "create" | "replace";
  /** The source's columns in order, from icebergSourceColumnsSql. */
  columns: PublishColumn[];
  /** A replace's staging table, from icebergStagingName; unused by create. */
  staging?: string;
  /** Where a replace moves the old table, from icebergRetiredName; unused by create. */
  retired?: string;
  /** Format version and partition spec of the table written; the engine's default (v2, unpartitioned) without. */
  layout?: IcebergPublishLayout;
}): string[] {
  if (args.columns.length === 0) {
    throw new Error(`${args.sourceSchema}.${args.sourceTable} has no columns to publish.`);
  }
  const ns = `${ident(args.alias)}.${ident(args.namespace)}`;
  const target = `${ns}.${ident(args.table)}`;
  const source = `${ident("lake")}.${ident(args.sourceSchema)}.${ident(args.sourceTable)}`;
  const schema = `CREATE SCHEMA IF NOT EXISTS ${ns};`;
  const defs = args.columns.map((col) => `${ident(col.name)} ${col.type}`).join(", ");
  const names = args.columns.map((col) => ident(col.name)).join(", ");
  const make = (t: string) => `CREATE TABLE ${t} (${defs})${icebergLayoutSql(args.layout)};`;
  const fill = (t: string, from: string) =>
    `INSERT INTO ${t} (${names}) SELECT ${names} FROM ${from};`;
  if (args.mode === "create") {
    return [schema, make(target), fill(target, source)];
  }
  // The extension has no CREATE OR REPLACE for Iceberg tables. FOUND IN
  // R107: a drop and then a create left the catalog with no table when the
  // create failed, so the new data is written to a staging table first, and
  // a write that cannot happen fails before the old table is touched.
  //
  // FOUND IN R182: the staged copy then went into the old name by a drop, a
  // create and an insert, and for that time a reader of the catalog found no
  // table (0.9 s, driven) and then an empty one (1.7 s). When the old table
  // has the new data's columns, a replace is now icebergOverwriteSql, one
  // commit with no gap. Otherwise the staged table is swapped in by name: the
  // old table renamed aside and the staged one renamed into its place, in one
  // transaction, and the old table dropped last. The catalog applies those as
  // two renames, one after the other (1.5 s apart on the development
  // catalog), so a reader can still miss the table for that long, but never
  // finds it empty, and nothing is copied a second time. Both names are made
  // for this publish, so the only tables a replace drops are ones it has just
  // made or moved.
  if (!args.staging || !args.retired) throw new Error("A replace needs a staging table.");
  const staging = `${ns}.${ident(args.staging)}`;
  return [
    schema,
    make(staging),
    fill(staging, source),
    `BEGIN TRANSACTION; ALTER TABLE IF EXISTS ${target} RENAME TO ${ident(args.retired)}; ` +
      `ALTER TABLE ${staging} RENAME TO ${ident(args.table)}; COMMIT;`,
    `DROP TABLE IF EXISTS ${ns}.${ident(args.retired)};`,
  ];
}

/**
 * A replace when the old table already has the new data's columns (R182):
 * its rows deleted and the new ones inserted in one transaction, which the
 * catalog takes as one commit. A reader sees the old rows or the new ones,
 * never a missing or an empty table, and a failed write leaves the old rows.
 */
export function icebergOverwriteSql(args: {
  alias: string;
  namespace: string;
  table: string;
  sourceSchema: string;
  sourceTable: string;
  columns: PublishColumn[];
}): string {
  const target = `${ident(args.alias)}.${ident(args.namespace)}.${ident(args.table)}`;
  const source = `${ident("lake")}.${ident(args.sourceSchema)}.${ident(args.sourceTable)}`;
  const names = args.columns.map((col) => ident(col.name)).join(", ");
  return (
    `BEGIN TRANSACTION; DELETE FROM ${target}; ` +
    `INSERT INTO ${target} (${names}) SELECT ${names} FROM ${source}; COMMIT;`
  );
}

/**
 * An upsert into the catalog's table by key columns (R457): rows whose keys
 * match are updated, the rest inserted, in one transaction and so one
 * catalog commit. Measured on the development catalog: one new metadata
 * file. When the merge both updates and inserts it holds two snapshots (an
 * overwrite of the rows it rewrote, then an append); when every row matched,
 * one overwrite. A reader goes from the old table to the new one and never
 * sees the rows in between; an intermediate snapshot is visible only in the
 * table's history. Keys compare with IS NOT DISTINCT FROM, so a row whose key
 * is null updates the row with the same null key instead of adding another
 * each time. The caller has checked that the table has the source's columns
 * and that the source holds each key once: a key that appears twice in the
 * source would match one target row twice.
 */
export function icebergMergeSql(args: {
  alias: string;
  namespace: string;
  table: string;
  sourceSchema: string;
  sourceTable: string;
  columns: PublishColumn[];
  keys: string[];
}): string {
  if (!args.keys.length) throw new Error("An upsert needs at least one key column.");
  const target = `${ident(args.alias)}.${ident(args.namespace)}.${ident(args.table)}`;
  const source = `${ident("lake")}.${ident(args.sourceSchema)}.${ident(args.sourceTable)}`;
  const names = args.columns.map((col) => ident(col.name));
  const keys = new Set(args.keys);
  const on = args.keys.map((k) => `t.${ident(k)} IS NOT DISTINCT FROM s.${ident(k)}`).join(" AND ");
  const sets = args.columns
    .filter((col) => !keys.has(col.name))
    .map((col) => `${ident(col.name)} = s.${ident(col.name)}`);
  const matched = sets.length ? ` WHEN MATCHED THEN UPDATE SET ${sets.join(", ")}` : "";
  return (
    `BEGIN TRANSACTION; MERGE INTO ${target} AS t USING (SELECT ${names.join(", ")} FROM ${source}) AS s ` +
    `ON ${on}${matched} WHEN NOT MATCHED THEN INSERT (${names.join(", ")}) ` +
    `VALUES (${names.map((n) => `s.${n}`).join(", ")}); COMMIT;`
  );
}

/**
 * A document, a nested value or a geometry is not a key: two payloads that
 * mean the same thing need not compare equal, and Iceberg cannot use one as an
 * identifier field. The upsert dialog offered a VARIANT column as a key until
 * the UI showed it (R457).
 */
const UNKEYABLE = /(\bVARIANT\b|\bSTRUCT\b|\bMAP\b|\bUNION\b|\bGEOMETRY\b|\bJSON\b|\[\]$|^LIST\b)/i;

/** Whether a column of this engine type can be an upsert key. */
export function keyable(type: string): boolean {
  return !UNKEYABLE.test(type.trim());
}

/** The first thing wrong with these upsert keys, in the dialog's words; null when they are usable. */
export function upsertKeyError(keys: string[], columns: PublishColumn[]): string | null {
  if (!keys.length) return "An upsert needs at least one key column.";
  for (const k of keys) {
    const col = columns.find((c) => c.name === k);
    if (!col) return `${k} is not a column of the source.`;
    if (!keyable(col.type)) {
      return `${k} is a ${col.type.toLowerCase()}, which cannot be a key: pick columns holding plain values.`;
    }
  }
  return null;
}

/** Source keys that appear more than once: an upsert by them would be ambiguous. */
export function duplicateKeysSql(
  sourceSchema: string,
  sourceTable: string,
  keys: string[],
): string {
  const cols = keys.map(ident).join(", ");
  return (
    `SELECT count(*)::BIGINT FROM (SELECT ${cols} FROM ${ident("lake")}.${ident(sourceSchema)}.` +
    `${ident(sourceTable)} GROUP BY ALL HAVING count(*) > 1)`
  );
}

/** The catalog table's columns as the engine reads them; fails if it does not exist. */
export function icebergDescribeSql(alias: string, namespace: string, table: string): string {
  return `DESCRIBE ${ident(alias)}.${ident(namespace)}.${ident(table)};`;
}

/**
 * Whether the old table can take the new rows as they are: the same column
 * names, in the same order, with the same types as the engine reads them. A
 * type Iceberg widens (SMALLINT is stored as int) reads back differently and
 * takes the swap instead, which is never wrong, only slower.
 */
export function sameColumns(a: PublishColumn[], b: PublishColumn[]): boolean {
  return (
    a.length > 0 &&
    a.length === b.length &&
    a.every((col, i) => col.name === b[i].name && col.type === b[i].type)
  );
}

/**
 * After a swap that failed: the old table back into its name, if the first
 * rename had moved it. A no-op when it had not.
 */
export function icebergSwapBackSql(
  alias: string,
  namespace: string,
  retired: string,
  table: string,
): string {
  return `ALTER TABLE IF EXISTS ${ident(alias)}.${ident(namespace)}.${ident(retired)} RENAME TO ${ident(table)};`;
}

/** The source's columns in order, for icebergPublishSql. */
export function icebergSourceColumnsSql(sourceSchema: string, sourceTable: string): string {
  return (
    `SELECT column_name, data_type FROM duckdb_columns() WHERE database_name = 'lake' ` +
    `AND schema_name = ${lit(sourceSchema)} AND table_name = ${lit(sourceTable)} ORDER BY column_index`
  );
}

/** Dropping a table this publish created, when filling it failed. */
export function icebergDropTableSql(alias: string, namespace: string, table: string): string {
  return `DROP TABLE IF EXISTS ${ident(alias)}.${ident(namespace)}.${ident(table)};`;
}

/**
 * Where a replace stages the new data before the old table is dropped. The
 * token is new for each publish: a fixed name would be a table somebody
 * could own, and the replace would drop it.
 */
export function icebergStagingName(table: string, token: string): string {
  return `${table}__publishing_${token}`;
}

/** Where a replace moves the old table while the new one takes its name (R182). */
export function icebergRetiredName(table: string, token: string): string {
  return `${table}__replaced_${token}`;
}

/** Copying an Iceberg table into the lakehouse (a real DuckLake table, no dependence on the catalog). */
export function icebergImportSql(args: {
  alias: string;
  namespace: string;
  table: string;
  targetSchema: string;
  targetTable: string;
  mode: "create" | "replace";
}): string {
  return (
    `CREATE ${args.mode === "replace" ? "OR REPLACE " : ""}TABLE ${ident("lake")}.${ident(args.targetSchema)}.${ident(args.targetTable)} AS ` +
    `SELECT * FROM ${ident(args.alias)}.${ident(args.namespace)}.${ident(args.table)};`
  );
}

/** An endpoint as shown in lists: no credentials, no trailing slash. */
export function describeIcebergEndpoint(endpoint: string): string {
  return endpoint
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/\/[^@/]+@/, "//");
}
