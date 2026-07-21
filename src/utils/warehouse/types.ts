// Shared types for external data warehouse connections.
// Client-safe: no secrets, no server-only imports.

export type WarehouseProvider =
  | "redshift"
  | "snowflake"
  | "databricks"
  | "bigquery"
  | "azure_synapse"
  | "postgres"
  | "mysql";

export const WAREHOUSE_PROVIDERS: WarehouseProvider[] = [
  "postgres",
  "mysql",
  "redshift",
  "snowflake",
  "databricks",
  "bigquery",
  "azure_synapse",
];

export const WAREHOUSE_LABELS: Record<WarehouseProvider, string> = {
  redshift: "Amazon Redshift",
  snowflake: "Snowflake",
  databricks: "Databricks SQL",
  bigquery: "Google BigQuery",
  azure_synapse: "Azure Synapse (dedicated SQL pool)",
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
};

/** Per-provider connection config. Stored encrypted — never sent back to the client. */
export type WarehouseConfig =
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
};
