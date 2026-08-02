// Shared types for external data warehouse connections.
// Client-safe: no secrets, no server-only imports.

export type WarehouseProvider =
  | "redshift"
  | "snowflake"
  | "databricks"
  | "bigquery"
  | "azure_synapse"
  | "postgres"
  | "mysql"
  | "trino"
  | "athena"
  | "oracle"
  // ── Postgres wire protocol ────────────────────────────────────────────
  | "cockroachdb"
  | "timescaledb"
  | "alloydb"
  | "greenplum"
  | "yugabytedb"
  // ── MySQL wire protocol ───────────────────────────────────────────────
  | "mariadb"
  | "singlestore"
  | "starrocks"
  | "doris"
  | "planetscale"
  // ── TDS (SQL Server) wire protocol ────────────────────────────────────
  | "sqlserver"
  // ── Own HTTP protocol ─────────────────────────────────────────────────
  | "clickhouse";

/**
 * The wire protocol a provider speaks.
 *
 * MOST "NEW DATABASES" ARE NOT NEW PROTOCOLS. CockroachDB, Timescale, AlloyDB,
 * Greenplum and Yugabyte all speak the PostgreSQL wire protocol; MariaDB,
 * SingleStore, StarRocks, Doris and PlanetScale speak MySQL's; Azure Synapse
 * and SQL Server both speak TDS. Giving each its own driver would mean ten
 * copies of one connection routine, ten places for a timeout fix to be missed,
 * and ten drivers of which only two are ever exercised in anger.
 *
 * So a provider declares its family and the dispatcher routes on THAT. The
 * provider is still first-class — its own entry, label, defaults and docs,
 * because someone looking for CockroachDB should find CockroachDB — but the
 * code that talks to it is the code that is already proven.
 */
export type WireFamily = "postgres" | "mysql" | "tds" | "own";

export const PROVIDER_FAMILY: Record<WarehouseProvider, WireFamily> = {
  postgres: "postgres",
  cockroachdb: "postgres",
  timescaledb: "postgres",
  alloydb: "postgres",
  greenplum: "postgres",
  yugabytedb: "postgres",
  // Redshift's HTTP Data API is used instead of its Postgres wire protocol —
  // it needs no VPC route and authenticates with IAM, so it stays "own".
  redshift: "own",

  mysql: "mysql",
  mariadb: "mysql",
  singlestore: "mysql",
  starrocks: "mysql",
  doris: "mysql",
  planetscale: "mysql",

  azure_synapse: "tds",
  sqlserver: "tds",

  snowflake: "own",
  databricks: "own",
  bigquery: "own",
  trino: "own",
  athena: "own",
  oracle: "own",
  clickhouse: "own",
};

/**
 * Providers whose config is exactly host/port/database/user/password.
 *
 * `postgres`, `mysql` and `sqlserver` are deliberately NOT here: they are the
 * originals and carry extra fields of their own, so they keep bespoke entries.
 */
export const HOST_PORT_PROVIDERS = [
  "cockroachdb",
  "timescaledb",
  "alloydb",
  "greenplum",
  "yugabytedb",
  "mariadb",
  "singlestore",
  "starrocks",
  "doris",
  "planetscale",
] as const satisfies readonly WarehouseProvider[];

/** Default TCP port per family, used when a connection leaves port blank. */
export const FAMILY_DEFAULT_PORT: Record<Exclude<WireFamily, "own">, number> = {
  postgres: 5432,
  mysql: 3306,
  tds: 1433,
};

export const WAREHOUSE_PROVIDERS: WarehouseProvider[] = [
  "postgres",
  "mysql",
  "sqlserver",
  "oracle",
  "redshift",
  "snowflake",
  "databricks",
  "bigquery",
  "azure_synapse",
  "trino",
  "athena",
  "clickhouse",
  "cockroachdb",
  "timescaledb",
  "alloydb",
  "greenplum",
  "yugabytedb",
  "mariadb",
  "singlestore",
  "starrocks",
  "doris",
  "planetscale",
];

export const WAREHOUSE_LABELS: Record<WarehouseProvider, string> = {
  redshift: "Amazon Redshift",
  snowflake: "Snowflake",
  databricks: "Databricks SQL",
  bigquery: "Google BigQuery",
  azure_synapse: "Azure Synapse (dedicated SQL pool)",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  trino: "Trino / Starburst / Presto",
  athena: "Amazon Athena",
  oracle: "Oracle Database / Autonomous DB",
  sqlserver: "Microsoft SQL Server / Azure SQL",
  clickhouse: "ClickHouse",
  cockroachdb: "CockroachDB",
  timescaledb: "TimescaleDB",
  alloydb: "Google AlloyDB",
  greenplum: "Greenplum",
  yugabytedb: "YugabyteDB",
  mariadb: "MariaDB",
  singlestore: "SingleStore",
  starrocks: "StarRocks",
  doris: "Apache Doris",
  planetscale: "PlanetScale",
};

/**
 * Host/port/user/password, the shape every wire-compatible database shares.
 *
 * `provider` stays specific so the connection remembers what it actually is —
 * the label, the docs and the default port all follow from it — while the
 * driver dispatches on PROVIDER_FAMILY.
 */
export type HostPortConfig<P extends WarehouseProvider> = {
  provider: P;
  host: string;
  port?: string;
  database: string;
  username: string;
  password: string;
  /** "require" enables TLS (rejectUnauthorized: false for managed hosts). */
  ssl?: string;
};

/** Per-provider connection config. Stored encrypted — never sent back to the client. */
export type WarehouseConfig =
  | HostPortConfig<"cockroachdb">
  | HostPortConfig<"timescaledb">
  | HostPortConfig<"alloydb">
  | HostPortConfig<"greenplum">
  | HostPortConfig<"yugabytedb">
  | HostPortConfig<"mariadb">
  | HostPortConfig<"singlestore">
  | HostPortConfig<"starrocks">
  | HostPortConfig<"doris">
  | HostPortConfig<"planetscale">
  | (HostPortConfig<"sqlserver"> & {
      /** Self-signed certs are normal on-prem; Azure SQL should leave this off. */
      trust_server_certificate?: string;
      /** Named instance, e.g. "SQLEXPRESS". Mutually exclusive with a port. */
      instance_name?: string;
    })
  | {
      provider: "clickhouse";
      /** Base URL of the HTTP interface, e.g. "https://abc.clickhouse.cloud:8443". */
      url: string;
      username: string;
      password: string;
      database?: string;
    }
  | {
      provider: "redshift";
      region: string;
      access_key_id: string;
      secret_access_key: string;
      database: string;
      /** Serverless workgroup name (either this or cluster_identifier+db_user). */
      workgroup_name?: string;
      cluster_identifier?: string;
      db_user?: string;
    }
  | {
      provider: "snowflake";
      /** Account identifier, e.g. "xy12345.eu-west-1" or "myorg-myaccount". */
      account: string;
      /** Programmatic access token (PAT). */
      token: string;
      warehouse: string;
      database: string;
      schema?: string;
      role?: string;
    }
  | {
      provider: "databricks";
      /** Workspace URL, e.g. "https://dbc-xxxx.cloud.databricks.com". */
      host: string;
      /** SQL warehouse id (from the warehouse's Connection Details tab). */
      warehouse_id: string;
      /** Personal access token. */
      token: string;
      catalog?: string;
      schema?: string;
    }
  | {
      provider: "bigquery";
      project_id: string;
      /** Full service-account key JSON, pasted as a string. */
      service_account_json: string;
      /** e.g. "US", "EU", "us-central1". Used for jobs + region-wide table listing. */
      location?: string;
      /** Optional: restrict table browsing to one dataset. */
      dataset?: string;
    }
  | {
      provider: "azure_synapse";
      /** e.g. "myworkspace.sql.azuresynapse.net". */
      server: string;
      database: string;
      username: string;
      password: string;
    }
  | {
      provider: "postgres";
      host: string;
      port?: string;
      database: string;
      username: string;
      password: string;
      /** "require" enables TLS (rejectUnauthorized: false for managed hosts). */
      ssl?: string;
    }
  | {
      provider: "mysql";
      host: string;
      port?: string;
      database: string;
      username: string;
      password: string;
      ssl?: string;
    }
  | {
      provider: "trino";
      /** Coordinator hostname, e.g. "trino.example.com" (no scheme). */
      host: string;
      /** Defaults to 443 (TLS) or 8080 (plain). */
      port?: string;
      /** Trino user (sent as X-Trino-User; required by the protocol). */
      username: string;
      /** Password for Basic auth (optional for anonymous coordinators). */
      password?: string;
      /** JWT/OAuth2 bearer token — takes precedence over password when set. */
      access_token?: string;
      /** Catalog to query, e.g. "iceberg", "hive", "delta". */
      catalog?: string;
      /** Default schema. */
      schema?: string;
      /** "disable" turns off TLS (plain http); anything else = https (default). */
      ssl?: string;
    }
  | {
      provider: "athena";
      /** AWS region, e.g. "us-east-1". */
      region: string;
      access_key_id: string;
      secret_access_key: string;
      /** Optional STS session token for temporary credentials. */
      session_token?: string;
      /** Glue database queried by default (also scopes schema browsing). */
      database?: string;
      /** Data catalog name (defaults to "AwsDataCatalog"). */
      catalog?: string;
      /** Workgroup (defaults to "primary"). */
      workgroup?: string;
      /** s3://bucket/prefix/ for query results — required unless the workgroup sets one. */
      output_location?: string;
    }
  | {
      provider: "oracle";
      /**
       * ORDS base URL. Autonomous Database ships ORDS enabled — copy the base
       * from Database Actions, e.g.
       * "https://<id>-<db>.adb.<region>.oraclecloudapps.com/ords". Works over
       * plain HTTPS (no wallet / Instant Client needed).
       */
      ords_url: string;
      /** DB user for HTTP Basic auth against the REST-enabled schema. */
      username: string;
      password: string;
      /**
       * URL schema-alias segment (from ORDS.ENABLE_SCHEMA). Defaults to the
       * lower-cased username, which is ORDS's own default.
       */
      schema?: string;
    };

export type WarehouseColumn = { name: string; type: string };

export type WarehouseQueryResult = {
  columns: WarehouseColumn[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
};

export type WarehouseTable = {
  schema: string;
  name: string;
  columns: WarehouseColumn[];
};

/** Row shape returned to clients when listing connections (no secrets). */
export type WarehouseConnectionSummary = {
  id: string;
  provider: WarehouseProvider;
  name: string;
  is_active: boolean;
  last_test_status: string | null;
  last_test_error: string | null;
  last_tested_at: string | null;
  created_at: string;
  /**
   * When the stored credential was last entered.
   *
   * NOT `updated_at`, which the scheduled health check and the Test button
   * both bump — using that would report every credential as freshly rotated
   * and hide precisely the stale ones this exists to surface.
   */
  credentials_rotated_at?: string | null;
  /**
   * Reached through an IAM grant rather than owned.
   *
   * A shared connection is usable but NOT editable: its credential belongs to
   * someone else, and queries run against their warehouse. The UI must not
   * offer edit or delete on one — the server refuses regardless, but a button
   * that always errors is its own bug.
   */
  shared?: boolean;
};
