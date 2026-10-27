// Endpoint overrides for cloud model providers (private connectivity, F2).
//
// A deployment may reach Bedrock, Vertex AI or OCI Generative AI through a
// private endpoint — an AWS PrivateLink `vpce-…` name, a GCP Private Service
// Connect `*.p.googleapis.com` name, an OCI `*.pe.inference.generativeai.*`
// name — or simply over the public hostname. The override is optional; leaving
// it empty keeps the provider's public hostname (which also covers private DNS
// and on-premises VPN setups, where that hostname resolves privately).
//
// A signed request is only ever sent to a host of the provider's own domain:
// the override must be an https origin whose host ends in one of the suffixes
// below. That keeps an override from re-aiming signed traffic elsewhere — the
// same principle as cloudRegion().

import { cloudRegion } from "./cloudRegion";

export type EndpointProvider = "bedrock" | "vertex" | "oci_genai" | "claude_aws";

const RULES: Record<EndpointProvider, { label: string; suffixes: string[]; example: string }> = {
  bedrock: {
    label: "Bedrock endpoint",
    suffixes: [".vpce.amazonaws.com", ".amazonaws.com", ".api.aws"],
    example: "https://vpce-0abc123.bedrock-runtime.us-east-1.vpce.amazonaws.com",
  },
  vertex: {
    label: "Vertex AI endpoint",
    suffixes: [".googleapis.com"],
    example: "https://aiplatform-myendpoint.p.googleapis.com",
  },
  claude_aws: {
    label: "Claude Platform on AWS endpoint",
    suffixes: [".api.aws", ".vpce.amazonaws.com"],
    example: "https://vpce-0abc123.aws-external-anthropic.us-west-2.vpce.amazonaws.com",
  },
  oci_genai: {
    label: "OCI Generative AI endpoint",
    suffixes: [".oci.oraclecloud.com"],
    example: "https://myprefix.pe.inference.generativeai.us-chicago-1.oci.oraclecloud.com",
  },
};

/** The hosts an override may name, as shown to a person: `*.vpce.amazonaws.com`. */
export function endpointHosts(provider: EndpointProvider): string[] {
  return RULES[provider].suffixes.map((s) => `*${s}`);
}

/**
 * The override as an https origin (`https://host[:port]`), or undefined when
 * none was given. Throws a message naming the field and an accepted example.
 */
export function providerEndpoint(
  provider: EndpointProvider,
  raw: string | undefined | null,
): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const rule = RULES[provider];
  const refuse = (why: string): never => {
    throw new Error(`${rule.label} ${why} — expected something like ${rule.example}`);
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
  // Each suffix begins with a dot, so endsWith already requires a label before
  // it (`googleapis.com` does not end with `.googleapis.com`).
  const host = url.hostname.toLowerCase();
  if (!rule.suffixes.some((s) => host.endsWith(s))) {
    refuse(`must be a ${rule.suffixes.map((s) => `*${s}`).join(" or ")} address`);
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
  const override = providerEndpoint(provider, cfg.endpoint);
  if (override) return override;
  switch (provider) {
    case "bedrock":
      return `https://bedrock-runtime.${cloudRegion(cfg.region || "us-east-1", "Bedrock region")}.amazonaws.com`;
    case "vertex":
      return `https://${cloudRegion(cfg.region || "us-central1", "Vertex location")}-aiplatform.googleapis.com`;
    case "claude_aws":
      return `https://aws-external-anthropic.${cloudRegion(cfg.region ?? "", "Claude Platform on AWS region")}.api.aws`;
    case "oci_genai":
      return `https://inference.generativeai.${cloudRegion(cfg.region ?? "", "OCI region")}.oci.oraclecloud.com`;
  }
}
