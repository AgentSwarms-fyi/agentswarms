// Where a warehouse connection's credential is sent (R420, VA-2026-10-25-30).
//
// A secret shared with the connection's owner fills a credential field only
// toward hosts its owner allowed (R419). These are the hosts each driver in
// drivers.server.ts connects to, built the way the driver builds them, so the
// list and the request cannot disagree (warehouseDestinations.test.ts holds
// the two together). The fields that decide the host (host, account, region,
// url, server) are not credentials: they take only a secret the owner owns.
//
// PURE: no driver imports.
import type { WarehouseConfig } from "./types";

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The hosts this connection's requests and sessions go to. Empty: none is known. */
export function warehouseHosts(cfg: WarehouseConfig): string[] {
  const c = cfg as Record<string, unknown> & { provider: string };
  switch (c.provider) {
    case "lakehouse":
      return [];
    case "snowflake":
      return [`https://${s(c.account)}.snowflakecomputing.com`];
    case "databricks":
      return [s(c.host)];
    case "bigquery":
      // The service-account JWT goes to Google's token endpoint, the queries
      // to BigQuery; the key itself never leaves.
      return ["https://bigquery.googleapis.com", "https://oauth2.googleapis.com"];
    case "redshift":
      return [`https://redshift-data.${s(c.region)}.amazonaws.com`];
    case "athena":
      return [`https://athena.${s(c.region)}.amazonaws.com`];
    case "clickhouse":
      return [s(c.url)];
    case "oracle":
      return [s(c.ords_url)];
    case "azure_synapse":
      return [s(c.server)];
    case "trino":
      return [
        s(c.host)
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, ""),
      ];
    default:
      // Every host/port engine: Postgres, MySQL and SQL Server families.
      return [s(c.host)];
  }
}

/** The fields of this connection a shared secret may fill. */
export function warehouseCredentialFields(cfg: WarehouseConfig): string[] {
  switch ((cfg as { provider: string }).provider) {
    case "lakehouse":
      return [];
    case "snowflake":
    case "databricks":
      return ["token"];
    case "bigquery":
      return ["service_account_json"];
    case "redshift":
      return ["access_key_id", "secret_access_key"];
    case "athena":
      return ["access_key_id", "secret_access_key", "session_token"];
    case "trino":
      return ["username", "password", "access_token"];
    default:
      return ["username", "password"];
  }
}
