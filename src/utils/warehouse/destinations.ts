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
import { bigqueryTokenUrl, warehouseApiOrigin } from "./endpoints";
import { PROVIDER_FAMILY, type WarehouseConfig, type WarehouseProvider } from "./types";

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
    case "bigquery": {
      // The service-account JWT goes to Google's token endpoint, the queries
      // to BigQuery; the key itself never leaves. Over Private Service Connect
      // both go through the endpoint (R426).
      const token = bigqueryTokenUrl(s(c.endpoint));
      return [
        warehouseApiOrigin({ provider: "bigquery", endpoint: s(c.endpoint) }),
        token ? new URL(token).origin : "https://oauth2.googleapis.com",
      ];
    }
    case "redshift":
    case "athena":
      // The interface endpoint when one is set, else the regional name (R426).
      return [
        warehouseApiOrigin({ provider: c.provider, region: s(c.region), endpoint: s(c.endpoint) }),
      ];
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

/**
 * A wire-protocol database (the Postgres, MySQL and SQL Server families): its
 * driver opens a TCP connection itself, never through the HTTP proxy, and none
 * of safeFetch's checks apply to it (R424). Every other engine is called over
 * HTTPS through connectorFetch, which uses the proxy and does its own checks.
 */
export function isWireProtocol(cfg: Pick<WarehouseConfig, "provider">): boolean {
  return PROVIDER_FAMILY[cfg.provider] !== "own";
}

const VPN =
  "Over a VPN, VPC peering or a cloud private endpoint, the host name stays and resolves to a " +
  "private address.";

/** How each engine is reached privately, for the connection form (R424). */
export const WAREHOUSE_PRIVATE_PATH_HINT: Record<WarehouseProvider, string> = {
  postgres: `${VPN} RDS, Cloud SQL and Azure private endpoints keep their own names.`,
  cockroachdb: VPN,
  timescaledb: VPN,
  alloydb: `${VPN} AlloyDB is usually reached by its private IP.`,
  greenplum: VPN,
  yugabytedb: VPN,
  mysql: `${VPN} RDS, Cloud SQL and Azure private endpoints keep their own names.`,
  mariadb: VPN,
  singlestore: VPN,
  starrocks: VPN,
  doris: VPN,
  planetscale: VPN,
  sqlserver: `${VPN} Azure SQL over Private Link keeps <server>.database.windows.net.`,
  azure_synapse:
    "Private Link keeps <workspace>.sql.azuresynapse.net; its DNS zone resolves it privately.",
  snowflake:
    "PrivateLink: enter the account with .privatelink, e.g. xy12345.us-east-1.privatelink, so " +
    "calls go to <account>.privatelink.snowflakecomputing.com.",
  databricks: "PrivateLink keeps the workspace URL; its DNS zone resolves it privately.",
  bigquery:
    "Private Google Access or a VPN: bigquery.googleapis.com and oauth2.googleapis.com resolve " +
    "privately. Private Service Connect: enter the endpoint's BigQuery name as the Private " +
    "endpoint; the token is fetched through the same endpoint.",
  redshift:
    "A VPC interface endpoint for the Redshift Data API with private DNS keeps the regional " +
    "name. Without private DNS, enter the endpoint's own vpce-… name as the Private endpoint.",
  athena:
    "A VPC interface endpoint for Athena with private DNS keeps the regional name. Without " +
    "private DNS, enter the endpoint's own vpce-… name as the Private endpoint.",
  trino: VPN,
  clickhouse: `${VPN} ClickHouse Cloud's private endpoints keep the service's name.`,
  oracle: `${VPN} Autonomous Database private endpoints keep the ORDS host.`,
  lakehouse: "Built in: it never leaves this deployment.",
};
