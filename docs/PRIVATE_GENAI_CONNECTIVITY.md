# Private connectivity for GenAI providers

> Part of the [AgentSwarms docs](../README.md#documentation).

**Status: design. Not implemented.** An exploration of how AgentSwarms, running
inside a customer's VPC/VNet, can reach every GenAI provider it integrates with
over private network paths instead of the public internet — what each cloud
offers, what the app supports today, the gaps, and a phased plan. Provider facts
were checked against official documentation on 2026-10-27; anything marked
_unconfirmed_ could not be verified from an official source.

## The short version

- **Azure OpenAI / Foundry and every OpenAI-compatible base URL already work**
  over private endpoints, as long as the container resolves the private DNS
  zone. Nothing in the app changes for them.
- **Five gaps block the rest:** GenAI calls ignore the corporate proxy; Vertex's
  and OCI's endpoint fields are shown but dropped on save; Bedrock has no
  endpoint override; nothing proves a call actually took the private path; and
  the private-network SSRF block cannot exempt a known private endpoint.
- **Phase 1** (small, low-risk) closes those. **Phase 2** adds a per-provider
  "Network" section, a connectivity test that reports the path taken, an
  optional per-provider "require a private path" setting, and Claude Platform
  on AWS. Private connectivity stays a choice: _Public_ remains the default.

## What each provider offers

### AWS Bedrock

PrivateLink interface VPC endpoints, one per API surface
([AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)):

| Service name                                   | Covers                                                  | Hostname with private DNS                      |
| ---------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| `com.amazonaws.<region>.bedrock-runtime`       | InvokeModel / Converse (what we call)                   | `bedrock-runtime.<region>.amazonaws.com`       |
| `com.amazonaws.<region>.bedrock-agent-runtime` | Agents runtime, Knowledge Base retrieve                 | `bedrock-agent-runtime.<region>.amazonaws.com` |
| `com.amazonaws.<region>.bedrock-mantle`        | OpenAI-compatible endpoints (since 2026-02, 13 regions) | `bedrock-mantle.<region>.api.aws`              |
| `com.amazonaws.<region>.bedrock`               | Control plane                                           | `bedrock.<region>.amazonaws.com`               |

- **Private DNS on:** clients keep the public hostname; it resolves to the
  endpoint's private IPs. No SigV4 change.
- **Private DNS off:** the client must call the endpoint-specific name,
  `vpce-<id>.bedrock-runtime.<region>.vpce.amazonaws.com`
  ([PrivateLink docs](https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-access-aws-services.html)).
- On-prem or peered networks need Route 53 Resolver rules. Endpoint policies can
  restrict which actions pass.

### Azure OpenAI / Microsoft Foundry

Private Link private endpoints on the Cognitive Services account
([DNS zones](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns),
[networking](https://learn.microsoft.com/en-us/azure/ai-services/cognitive-services-virtual-networks)):

- Zones: `privatelink.openai.azure.com`, `privatelink.cognitiveservices.azure.com`,
  `privatelink.services.ai.azure.com`.
- Clients **keep** the custom-subdomain hostname (`<name>.openai.azure.com`);
  public DNS CNAMEs it into the privatelink zone. Calling a `*.privatelink.*`
  name directly is explicitly unsupported.
- Custom DNS servers must forward the privatelink zones to 168.63.129.16.
- Foundry agents have extra limits under network isolation (some tools still go
  public); Serverless API deployments list private networking as supported.

### Google Vertex AI (and the Gemini API)

Private Service Connect (PSC) endpoints for Google APIs, Private Google Access,
and VPC Service Controls
([PSC](https://docs.cloud.google.com/vpc/docs/configure-private-service-connect-apis),
[access methods](https://docs.cloud.google.com/vertex-ai/docs/general/googleapi-access-methods)):

- A PSC endpoint is one internal IP; Service Directory names it
  `<service>-<endpoint>.p.googleapis.com` (e.g. `aiplatform-genai1.p.googleapis.com`).
- Clients either **override the API endpoint** to that name, or keep default
  hostnames with a private `googleapis.com` zone pointing at the PSC IP.
- The OAuth token endpoint (`oauth2.googleapis.com`) must be reachable the same
  way — a service-account call needs both.
- Anthropic models on Vertex use the same `aiplatform` hostnames; whether PSC/VPC-SC
  covers them is _unconfirmed_.
- **Gemini API** (`generativelanguage.googleapis.com`) is not on the VPC-SC
  supported list and PSC coverage is _unconfirmed_ — for private Gemini, use
  Gemini on Vertex.

### Oracle OCI Generative AI

Private endpoints, plus a Service Gateway alternative
([private endpoint](https://docs.oracle.com/en-us/iaas/Content/generative-ai/create-private-endpoint.htm),
[on-demand support](https://docs.oracle.com/iaas/releasenotes/generative-ai/private-endpoint-on-demand.htm)):

- FQDN: `<prefix>.pe.inference.generativeai.<region>.oci.oraclecloud.com`. The
  client **must** call this name.
- Covers dedicated AI clusters and, since 2026-01, on-demand models when enabled
  on the endpoint. Default limit 5 per tenancy.

### OpenAI (direct)

Azure Private Link only, arranged through OpenAI, not self-service
([OpenAI docs](https://developers.openai.com/api/docs/guides/private-link)):
the client changes its base URL to a regional name such as
`https://southcentralus.privatelink.api.openai.com/v1`. Not compatible with IP
allow-lists or mTLS.

### Anthropic (direct)

No PrivateLink for `api.anthropic.com` found (_unconfirmed_ that none exists);
fixed IP ranges are published for allow-lists
([IPs](https://platform.claude.com/docs/en/api/ip-addresses)). Private routes are
via Bedrock, Vertex, Foundry, or Claude Platform on AWS
(`aws-external-anthropic.<region>.api.aws`, PrivateLink stated as supported;
service name _unconfirmed_).

### Others

| Provider                 | Private option                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Databricks Model Serving | Workspace Private Link; private connectivity only for provisioned-throughput / custom-model endpoints    |
| Snowflake Cortex REST    | Account PrivateLink (`<org>-<account>.privatelink.snowflakecomputing.com`); Cortex over it _unconfirmed_ |
| IBM watsonx.ai           | `https://private.<region>.ml.cloud.ibm.com` with private service endpoints enabled                       |
| Cohere, Mistral          | Private/self-deployed models (set the base URL); PrivateLink to their public APIs _unconfirmed_          |
| NVIDIA NIM, vLLM, Ollama | Self-hosted, private by nature; air-gapped NIM pre-populates its model cache                             |

## What the app supports today

| Provider (Integrations)                                                   | How it is reached                         | Private endpoint today                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| OpenAI and OpenAI-compatible (Groq, Grok, Qwen, NVIDIA, OpenRouter, vLLM) | `base_url` override                       | **Works** — including OpenAI's `*.privatelink.api.openai.com` base URL                      |
| Ollama                                                                    | `endpoint`                                | **Works**                                                                                   |
| Azure OpenAI                                                              | full endpoint URL                         | **Works** with private DNS resolving from the container                                     |
| Anthropic                                                                 | `base_url` (Integrations page path)       | Works for a private gateway; no first-party private link exists                             |
| AWS Bedrock                                                               | host built from region                    | **Only with PrivateLink private DNS on** — no endpoint override                             |
| Google Vertex AI                                                          | host built from location                  | **No** — the UI's "Custom Endpoint" field is dropped on save                                |
| OCI Generative AI                                                         | host built from region                    | **No** — the UI's "Service Endpoint" field is dropped on save; private endpoints require it |
| Gemini (AI Studio)                                                        | fixed `generativelanguage.googleapis.com` | No override; use Vertex for private Gemini                                                  |
| LLM gateway (route all traffic)                                           | OpenAI-compatible `base_url`              | **Works** for an in-VPC LiteLLM/Portkey — but silently skipped for Bedrock/Vertex/Azure/OCI |

Cross-cutting:

- **Proxy:** `HTTPS_PROXY` / `NO_PROXY` are honoured by warehouse and SaaS
  connectors (one shared client), **not** by model calls. A network whose only
  egress is a proxy cannot reach any hosted model today.
- **Custom CA:** Node reads `NODE_EXTRA_CA_CERTS` at startup, so it already works
  for TLS-inspecting proxies and private CAs — but it is documented only for the
  Kubernetes runtime.
- **SSRF guard (R386/R387):** model calls allow private addresses (a VPC endpoint
  is one) and refuse only metadata/link-local, so private endpoints pass.
  Object-store reads honour `BLOCK_PRIVATE_NETWORK_FETCH`, which would also
  refuse an S3/Blob private endpoint — there is no way to exempt one.

## Gaps

1. **Model calls ignore the corporate proxy.**
2. **Vertex and OCI endpoint overrides are not wired** (shown, dropped on save,
   absent from the adapter config types); Bedrock has no override at all.
3. **No proof of path.** Nothing tells an admin whether a call resolved to a
   private or a public address, so a mis-set DNS zone silently sends traffic
   over the internet.
4. **No policy to require private paths** for GenAI traffic.
5. **`BLOCK_PRIVATE_NETWORK_FETCH` cannot exempt a named private endpoint**, so
   operators must choose between SSRF strictness and private object storage.
6. **The route-all gateway does not cover Bedrock/Vertex/Azure/OCI** — and does
   not say so in the UI.

## Plan

### Phase 1 — make private endpoints usable (small, low-risk)

1. **Proxy for model calls.** `providerFetch` takes the same proxy dispatcher
   `connectorFetch` already builds from `HTTPS_PROXY` / `NO_PROXY` (portable to
   every supported Node version, unlike `NODE_USE_ENV_PROXY`). The SSRF check
   still runs on the target before the proxy is chosen.
2. **Endpoint overrides, validated per provider.** Each override is optional,
   and its host must match the provider's documented private names, so a signed
   request cannot be re-aimed elsewhere (the R386 principle):

   | Provider     | New / wired field                                         | Accepted host                                                   |
   | ------------ | --------------------------------------------------------- | --------------------------------------------------------------- |
   | Bedrock      | Runtime endpoint URL (new)                                | `*.vpce.amazonaws.com`, `*.amazonaws.com`, `*.api.aws`          |
   | Vertex       | Custom Endpoint (wire it through)                         | `*.googleapis.com` (incl. `*.p.googleapis.com`)                 |
   | OCI          | Service Endpoint (wire it through)                        | `*.oci.oraclecloud.com` (incl. `*.pe.inference.generativeai.*`) |
   | Vertex token | token URI follows the endpoint's PSC name when one is set | `*.googleapis.com`                                              |

   SigV4/OCI signing uses the override's host; region stays the signing region.

3. **Azure guard rail.** Refuse an endpoint whose host is a `*.privatelink.*`
   name, with a message saying to use the resource's own hostname and private
   DNS — the configuration Microsoft documents as unsupported.
4. **Exempt named private endpoints from the private-network block.** A new
   `PRIVATE_ENDPOINT_HOSTS` list (host suffixes) lets an operator keep
   `BLOCK_PRIVATE_NETWORK_FETCH` on and still reach their S3/Blob/Bedrock
   private endpoints. Metadata and link-local stay refused regardless.
5. **Document** private DNS per cloud (Route 53 Resolver, Azure privatelink
   zones and 168.63.129.16 forwarding, Cloud DNS `googleapis.com` /
   `p.googleapis.com`, CoreDNS forwarding on Kubernetes), `NODE_EXTRA_CA_CERTS`
   for Compose, and that the route-all gateway does not cover signed-auth
   providers.

### Phase 2 — make the path visible and enforceable

1. **"Network" section per provider integration:** _Public_, _Private DNS_
   (public hostname, resolves privately), or _Private endpoint URL_ — with the
   accepted host shape shown inline.
2. **Connectivity test that reports the path:** Test & Connect shows the
   resolved address and whether it is private (RFC 1918 / ULA / CGNAT), the TLS
   certificate subject, and whether a proxy was used — e.g. "Connected via
   10.0.12.34 (private) — PrivateLink".
3. **"Require a private path", per provider, off by default:** when ticked,
   that provider's calls must resolve to a private address (or go through a
   configured proxy); a public resolution is refused and audited, so a broken
   DNS zone fails loudly instead of sending traffic over the internet. An
   operator may set the default for new integrations with
   `GENAI_REQUIRE_PRIVATE`; it never changes an existing integration.
4. **Gateway clarity:** the route-all switch says which providers it covers, and
   the provider list marks those it cannot.
5. **New provider: Claude Platform on AWS** (`aws-external-anthropic.<region>.api.aws`,
   SigV4 service `aws-external-anthropic` or a Bearer key; PrivateLink-capable).
   Bedrock's OpenAI-compatible Mantle endpoint can follow the same pattern later.

### How it would be tested

- **Proxy:** a throwaway Squid container on the app network as the only egress;
  a chat turn and a model listing succeed through it, and a `NO_PROXY` host
  bypasses it.
- **Endpoint overrides:** a local stand-in server answers on a private address
  under a name matching each provider's accepted shape (Docker network alias);
  the adapter calls it, the signed host matches, and a non-matching host is
  refused at save time.
- **Path reporting and the policy:** the same stand-in reached by private
  address passes; pointed at a public address with `GENAI_REQUIRE_PRIVATE` on,
  the call is refused and audited.
- **Live cloud validation** is deferred: everything above is proven from the
  code side (unit tests, local stand-ins, the UI).

## Decisions (2026-10-27)

- **Private connectivity is a choice, never an assumption.** Not every
  deployment has a private endpoint — on a cloud, or on-premises reaching the
  cloud over a VPN or Direct Connect / ExpressRoute / Interconnect. _Public_
  stays the default; the _Private DNS_ mode covers the VPN case (the public
  hostname resolves to a private address over the link), and the _Private
  endpoint URL_ mode covers endpoint-specific names.
- **"Require a private path" is per provider and off by default**, with an
  optional operator default for new integrations.
- **Claude Platform on AWS is in scope** as a new provider.
- **Live cloud validation is skipped for now**; all testing is code-side.
