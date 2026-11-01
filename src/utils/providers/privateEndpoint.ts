// Endpoint overrides for cloud model providers (private connectivity, F2).
//
// A deployment may reach Bedrock, Vertex AI or OCI Generative AI through a
// private endpoint — an AWS PrivateLink `vpce-…` name, a GCP Private Service
// Connect `*.p.googleapis.com` name, an OCI `*.pe.inference.generativeai.*`
// name — or simply over the public hostname. The override is optional; leaving
// it empty keeps the provider's public hostname (which also covers private DNS
// and on-premises VPN setups, where that hostname resolves privately).
//
// The override must be an https origin. For Bedrock and Claude Platform on AWS
// it must be exactly the service's own name in the region the request is signed
// for (R427): the public name, the FIPS or dual-stack name, or an interface
// endpoint's `vpce-…` name. Until R427 any `*.amazonaws.com` or `*.api.aws` host
// was accepted, and under amazonaws.com sit names a customer controls that carry
// a valid certificate and hand the whole request to their owner — an API Gateway
// stage, `<id>.execute-api.<region>.amazonaws.com`. A request sent there would
// have carried the signature and session token (or Claude Platform's API key)
// and the prompt, and its answer would have come back as the model's.
//
// Vertex and OCI keep a domain rule (`*.googleapis.com`, `*.oci.oraclecloud.com`):
// their private names include ones the customer picks (a PSC endpoint name, an
// OCI private endpoint prefix), and no name under those domains is known to hand
// a request to a customer. Same principle as cloudRegion().

import { cloudRegion } from "./cloudRegion";

export type EndpointProvider = "bedrock" | "vertex" | "oci_genai" | "claude_aws";

type AwsProvider = "bedrock" | "claude_aws";

const LABEL: Record<EndpointProvider, string> = {
  bedrock: "Bedrock endpoint",
  vertex: "Vertex AI endpoint",
  claude_aws: "Claude Platform on AWS endpoint",
  oci_genai: "OCI Generative AI endpoint",
};

const DOMAIN_RULES: Record<
  Exclude<EndpointProvider, AwsProvider>,
  { suffix: string; example: string }
> = {
  vertex: { suffix: ".googleapis.com", example: "https://aiplatform-myendpoint.p.googleapis.com" },
  oci_genai: {
    suffix: ".oci.oraclecloud.com",
    example: "https://myprefix.pe.inference.generativeai.us-chicago-1.oci.oraclecloud.com",
  },
};

const AWS_RULES: Record<
  AwsProvider,
  { service: string; regionLabel: string; defaultRegion: string; publicNames: string }
> = {
  // bedrock-runtime.<region>.amazonaws.com, its -fips name, and the dual-stack
  // api.aws names.
  bedrock: {
    service: "bedrock-runtime",
    regionLabel: "Bedrock region",
    defaultRegion: "us-east-1",
    publicNames: "bedrock-runtime(?:-fips)?\\.{region}\\.(?:amazonaws\\.com|api\\.aws)",
  },
  // aws-external-anthropic.<region>.api.aws; there is no default region.
  claude_aws: {
    service: "aws-external-anthropic",
    regionLabel: "Claude Platform on AWS region",
    defaultRegion: "",
    publicNames: "aws-external-anthropic\\.{region}\\.api\\.aws",
  },
};

function isAws(provider: EndpointProvider): provider is AwsProvider {
  return provider === "bedrock" || provider === "claude_aws";
}

/** The region an AWS provider's request is signed for, checked. */
function awsRegion(provider: AwsProvider, region: string | undefined): string {
  const rule = AWS_RULES[provider];
  return cloudRegion(region || rule.defaultRegion, rule.regionLabel);
}

/** The service's own names in one region: public, FIPS, dual-stack, or an interface endpoint's. */
function awsHostPattern(provider: AwsProvider, region: string): RegExp {
  const { service, publicNames } = AWS_RULES[provider];
  return new RegExp(
    `^(?:${publicNames.replace("{region}", region)}` +
      `|vpce-[a-z0-9]+(?:-[a-z0-9]+)*\\.${service}\\.${region}\\.vpce\\.amazonaws\\.com)$`,
  );
}

function example(provider: EndpointProvider, region: string): string {
  if (!isAws(provider)) return DOMAIN_RULES[provider].example;
  return `https://vpce-0abc123.${AWS_RULES[provider].service}.${region}.vpce.amazonaws.com`;
}

/**
 * The hosts an override may name, as shown to a person. For Bedrock and Claude
 * Platform on AWS these are the service's names in the region typed so far
 * (`<region>` before one is); for Vertex and OCI, the domain as a wildcard.
 */
export function endpointHosts(provider: EndpointProvider, region?: string): string[] {
  if (!isAws(provider)) return [`*${DOMAIN_RULES[provider].suffix}`];
  const { service } = AWS_RULES[provider];
  let r = "<region>";
  try {
    r = awsRegion(provider, region);
  } catch {
    /* not a region yet: keep the placeholder */
  }
  const publicName =
    provider === "bedrock" ? `${service}.${r}.amazonaws.com` : `${service}.${r}.api.aws`;
  return [publicName, `vpce-….${service}.${r}.vpce.amazonaws.com`];
}

/**
 * The override as an https origin (`https://host[:port]`), or undefined when
 * none was given. Throws a message naming the field and an accepted example.
 * For Bedrock and Claude Platform on AWS, `region` is the region the request is
 * signed for; the override must be that region's name for the service.
 */
export function providerEndpoint(
  provider: EndpointProvider,
  raw: string | undefined | null,
  region?: string,
): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const signedFor = isAws(provider) ? awsRegion(provider, region) : "";
  const refuse = (why: string): never => {
    throw new Error(
      `${LABEL[provider]} ${why} — expected something like ${example(provider, signedFor)}`,
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
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    refuse("must be the endpoint's address only, with no path");
  }
  const host = url.hostname.toLowerCase();
  if (isAws(provider)) {
    if (!awsHostPattern(provider, signedFor).test(host)) {
      refuse(`must be ${AWS_RULES[provider].service}'s own address in ${signedFor}`);
    }
  } else {
    // The suffix begins with a dot, so endsWith already requires a label before
    // it (`googleapis.com` does not end with `.googleapis.com`).
    const { suffix } = DOMAIN_RULES[provider];
    if (!host.endsWith(suffix)) refuse(`must be a *${suffix} address`);
  }
  return url.origin;
}

/**
 * Azure OpenAI over Private Link keeps the resource's own hostname
 * (`<name>.openai.azure.com`); the `*.privatelink.*` name it resolves through
 * is not a supported address to call. Returns an error message, or null.
 */
export function azureEndpointProblem(endpoint: string): string | null {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "The Azure endpoint is not a valid URL";
  }
  if (host.includes(".privatelink.")) {
    return (
      "Use the resource's own endpoint (https://<name>.openai.azure.com), not the " +
      "privatelink name — with a private endpoint, private DNS resolves the resource's " +
      "hostname to its private address."
    );
  }
  return null;
}

/**
 * Vertex's OAuth token request over Private Service Connect: when the API
 * endpoint is a PSC name (`aiplatform-<endpoint>.p.googleapis.com`), the token
 * is fetched through the same PSC endpoint (`oauth2-<endpoint>.p.googleapis.com`).
 * Otherwise the service account's own token URI is used unchanged.
 */
export function vertexTokenUrl(apiEndpoint: string | undefined, tokenUri: string): string {
  if (!apiEndpoint) return tokenUri;
  const m = /^https:\/\/aiplatform-([a-z0-9-]+)\.p\.googleapis\.com$/i.exec(apiEndpoint);
  if (!m) return tokenUri;
  let path = "/token";
  try {
    path = new URL(tokenUri).pathname || "/token";
  } catch {
    /* keep /token */
  }
  return `https://oauth2-${m[1].toLowerCase()}.p.googleapis.com${path}`;
}

/**
 * The origin a provider's calls go to: the override when one is set, else the
 * provider's public regional host. The adapters and the network-path check both
 * use it, so the check reports exactly the host the call will use.
 */
export function providerOrigin(
  provider: EndpointProvider,
  cfg: { region?: string; endpoint?: string | null },
): string {
  const override = providerEndpoint(provider, cfg.endpoint, cfg.region);
  if (override) return override;
  switch (provider) {
    case "bedrock":
      return `https://bedrock-runtime.${awsRegion("bedrock", cfg.region)}.amazonaws.com`;
    case "vertex":
      return `https://${cloudRegion(cfg.region || "us-central1", "Vertex location")}-aiplatform.googleapis.com`;
    case "claude_aws":
      return `https://aws-external-anthropic.${awsRegion("claude_aws", cfg.region)}.api.aws`;
    case "oci_genai":
      return `https://inference.generativeai.${cloudRegion(cfg.region ?? "", "OCI region")}.oci.oraclecloud.com`;
  }
}
