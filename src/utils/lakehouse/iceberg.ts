// Iceberg interop, the pure half: how an Iceberg REST catalog is described,
// what the engine is told to attach it, and the statements that mount a
// namespace as a lakehouse schema or publish a lakehouse table into it.
//
// The engine side is DuckDB's iceberg extension: a REST catalog attaches as
// a database (`ice_<id>`) whose namespaces are schemas and whose tables are
// tables, readable and - on a catalog that allows it - writable. A mount
// creates views under a lakehouse schema over those tables, so the per-user
// schema guard, the listing and the tools see Iceberg tables exactly as they
// see everything else; nothing is copied. Publishing is a CREATE TABLE AS
// into the catalog. Everything below is text and rules; the server and the
// tests import it.

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
};

export const ICEBERG_NAME = /^[a-z][a-z0-9_]{0,62}$/;
export const ICEBERG_NAMESPACE = /^[A-Za-z0-9_]{1,128}$/;
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
    if (cfg.oauth2_server_uri.trim())
      parts.push(`OAUTH2_SERVER_URI ${lit(cfg.oauth2_server_uri.trim())}`);
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
  return `ATTACH IF NOT EXISTS ${lit(cfg.warehouse.trim())} AS ${ident(alias)} (TYPE iceberg, ENDPOINT ${lit(endpoint)}, ${auth}, READ_ONLY false);`;
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

/**
 * Publishing a lakehouse table into the catalog: the namespace first, then a
 * CREATE TABLE AS over the governed table. `replace` drops and recreates on
 * the catalog side; `create` refuses an existing table.
 */
export function icebergPublishSql(args: {
  alias: string;
  namespace: string;
  table: string;
  sourceSchema: string;
  sourceTable: string;
  mode: "create" | "replace";
}): string[] {
  const target = `${ident(args.alias)}.${ident(args.namespace)}.${ident(args.table)}`;
  // The extension has no CREATE OR REPLACE for Iceberg tables: replace is a
  // drop and a create, two statements the caller runs in order.
  return [
    `CREATE SCHEMA IF NOT EXISTS ${ident(args.alias)}.${ident(args.namespace)};`,
    ...(args.mode === "replace" ? [`DROP TABLE IF EXISTS ${target};`] : []),
    `CREATE TABLE ${target} AS ` +
      `SELECT * FROM ${ident("lake")}.${ident(args.sourceSchema)}.${ident(args.sourceTable)};`,
  ];
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
