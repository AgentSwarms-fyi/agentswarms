// Private endpoints for the warehouses whose API host is fixed (private
// connectivity, Phase 3, R426).
//
// BigQuery, Redshift and Athena are called at a host the app builds, not one
// the person types. A deployment that reaches them privately either keeps that
// host and resolves it privately (Private Google Access, or an interface
// endpoint with private DNS), which needs nothing here, or calls the private
// endpoint by its own name:
//
//   - BigQuery over Private Service Connect: `bigquery-<endpoint>.p.googleapis.com`,
//     with the token fetched through `oauth2-<endpoint>.p.googleapis.com`;
//   - Redshift's Data API and Athena over an interface endpoint without private
//     DNS: `vpce-….redshift-data.<region>.vpce.amazonaws.com`,
//     `vpce-….athena.<region>.vpce.amazonaws.com`.
//
// Each override must be exactly that engine's name for that region. These
// requests carry a signed Authorization (and Athena's may carry a session
// token), so an override can never aim them at another host, even one under
// amazonaws.com that a customer controls and that carries AWS's own valid
// certificate (an API Gateway stage, `<id>.execute-api.<region>.amazonaws.com`).
//
// The region of a Redshift connection is checked here too: it is put into the
// host, and until R426 anything was accepted (`x.attacker.test/` made the host
// `redshift-data.x.attacker.test`). Athena already checked its own.

import { cloudRegion } from "@/utils/providers/cloudRegion";

export type EndpointEngine = "bigquery" | "redshift" | "athena";

/** What the form shows: an accepted example for each engine. */
export const WAREHOUSE_ENDPOINT_EXAMPLE: Record<EndpointEngine, string> = {
  bigquery: "https://bigquery-myendpoint.p.googleapis.com",
  redshift: "https://vpce-0abc123-xyz.redshift-data.us-east-1.vpce.amazonaws.com",
  athena: "https://vpce-0abc123-xyz.athena.us-east-1.vpce.amazonaws.com",
};

const LABEL: Record<EndpointEngine, string> = {
  bigquery: "BigQuery endpoint",
  redshift: "Redshift endpoint",
  athena: "Athena endpoint",
};

// A Private Service Connect endpoint for Google APIs is named with 1 to 20
// lowercase letters and digits, starting with a letter.
const PSC_BIGQUERY = /^bigquery-([a-z][a-z0-9]{0,19})\.p\.googleapis\.com$/;

/** The AWS service's own names in one region: public (and FIPS), or an interface endpoint's. */
function awsHostPattern(service: string, region: string): RegExp {
  const r = region.replace(/-/g, "\\-");
  return new RegExp(
    `^(?:${service}(?:-fips)?\\.${r}\\.amazonaws\\.com` +
      `|vpce-[a-z0-9]+(?:-[a-z0-9]+)*\\.${service}\\.${r}\\.vpce\\.amazonaws\\.com)$`,
  );
}

/**
 * The override as an https origin, or undefined when none was given. Throws a
 * message naming the field and an accepted example.
 */
function endpointOrigin(
  engine: EndpointEngine,
  raw: string | undefined | null,
  region?: string,
): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const refuse = (why: string): never => {
    throw new Error(
      `${LABEL[engine]} ${why} — expected something like ${WAREHOUSE_ENDPOINT_EXAMPLE[engine]}`,
    );
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("is not a valid URL");
  }
  if (url.protocol !== "https:") refuse("must use https");
  if (url.username || url.password) refuse("must not contain credentials");
  if (url.port) refuse("must not name a port");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    refuse("must be the endpoint's address only, with no path");
  }
  const host = url.hostname.toLowerCase();
  if (engine === "bigquery") {
    if (!PSC_BIGQUERY.test(host)) refuse("must be a Private Service Connect name");
  } else {
    const service = engine === "redshift" ? "redshift-data" : "athena";
    if (!awsHostPattern(service, region ?? "").test(host)) {
      refuse(`must be ${service}'s own address in ${region}`);
    }
  }
  return `https://${host}`;
}

type EngineConfig =
  | { provider: "bigquery"; endpoint?: string }
  | { provider: "redshift" | "athena"; region: string; endpoint?: string };

/**
 * The origin an engine's API calls go to: the private endpoint when one is
 * set, else the public host. The drivers, the network check and the shared
 * secret check all use it, so each sees exactly the host the calls use.
 */
export function warehouseApiOrigin(cfg: EngineConfig): string {
  if (cfg.provider === "bigquery") {
    return endpointOrigin("bigquery", cfg.endpoint) ?? "https://bigquery.googleapis.com";
  }
  const label = cfg.provider === "redshift" ? "Redshift region" : "Athena region";
  const region = cloudRegion(cfg.region ?? "", label);
  const service = cfg.provider === "redshift" ? "redshift-data" : "athena";
  return (
    endpointOrigin(cfg.provider, cfg.endpoint, region) ??
    `https://${service}.${region}.amazonaws.com`
  );
}

/**
 * Where BigQuery's token is fetched over Private Service Connect: through the
 * same endpoint (`oauth2-<endpoint>.p.googleapis.com/token`). Undefined
 * without one: the key's own token URI is used.
 */
export function bigqueryTokenUrl(endpoint: string | undefined | null): string | undefined {
  const origin = endpointOrigin("bigquery", endpoint);
  if (!origin) return undefined;
  const name = PSC_BIGQUERY.exec(new URL(origin).hostname)![1];
  return `https://oauth2-${name}.p.googleapis.com/token`;
}

/** Why this connection's endpoint or region cannot be used, or null. For the save. */
export function warehouseEndpointProblem(cfg: { provider: string }): string | null {
  if (cfg.provider !== "bigquery" && cfg.provider !== "redshift" && cfg.provider !== "athena") {
    return null;
  }
  try {
    warehouseApiOrigin(cfg as EngineConfig);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
