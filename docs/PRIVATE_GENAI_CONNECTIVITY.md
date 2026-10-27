# Private connectivity for GenAI providers

> Part of the [AgentSwarms docs](../README.md#documentation).

**Status: Phases 1 and 2 implemented (2026-10-27); live cloud validation
deferred.** An exploration of how AgentSwarms, running
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

| Provider (Integrations)                                                   | How it is reached                            | Private endpoint today                                                                            |
| ------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| OpenAI and OpenAI-compatible (Groq, Grok, Qwen, NVIDIA, OpenRouter, vLLM) | `base_url` override                          | **Works** — including OpenAI's `*.privatelink.api.openai.com` base URL                            |
| Ollama                                                                    | `endpoint`                                   | **Works**                                                                                         |
| Azure OpenAI                                                              | full endpoint URL                            | **Works** with private DNS resolving from the container                                           |
| Anthropic                                                                 | `base_url` (Integrations page path)          | Works for a private gateway; no first-party private link exists                                   |
| AWS Bedrock                                                               | host from region, **or endpoint override**   | **Works** with PrivateLink private DNS, or a `vpce`/`amazonaws.com`/`api.aws` endpoint URL        |
| Google Vertex AI                                                          | host from location, **or endpoint override** | **Works** — a `*.googleapis.com` (incl. PSC `*.p.googleapis.com`) endpoint URL; the token follows |
| OCI Generative AI                                                         | host from region, **or endpoint override**   | **Works** — a `*.oci.oraclecloud.com` (incl. `*.pe.*`) endpoint URL                               |
| Gemini (AI Studio)                                                        | fixed `generativelanguage.googleapis.com`    | No override; use Vertex for private Gemini                                                        |
| LLM gateway (route all traffic)                                           | OpenAI-compatible `base_url`                 | **Works** for an in-VPC LiteLLM/Portkey — but silently skipped for Bedrock/Vertex/Azure/OCI       |

Cross-cutting:

- **Proxy:** `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are honoured by warehouse
  and SaaS connectors **and, since this work, by every model call** (one shared
  dispatcher). A proxy-only network can now reach hosted models.
- **Custom CA:** Node reads `NODE_EXTRA_CA_CERTS` at startup, so it already works
  for TLS-inspecting proxies and private CAs — now documented for Compose too.
- **SSRF guard (R386/R387):** model calls allow private addresses (a VPC endpoint
  is one) and refuse only metadata/link-local, so private endpoints pass.
  Object-store reads honour `BLOCK_PRIVATE_NETWORK_FETCH`, which would also
  refuse an S3/Blob private endpoint — that is a data-source concern, not GenAI,
  tracked separately.

## Gaps

**Closed (Phase 1):** model calls honour the corporate proxy; Bedrock, Vertex
and OCI take a validated endpoint override; Azure refuses a `privatelink`
hostname with guidance.

**Closed (Phase 2):** the path a call takes is reported (proxy, or direct to a
private or public address, with the endpoint's TLS certificate); a provider can
require a private path; the route-all gateway says which providers it does not
cover. Remaining:

1. **Gemini (AI Studio)** has no endpoint override (use Vertex for private
   Gemini).
2. **Live cloud validation** against real PrivateLink / PSC / private endpoints.

## Plan

### Phase 1 — make private endpoints usable — **DONE (2026-10-27)**

1. **Proxy for model calls.** `providerFetch` now routes through the same proxy
   dispatcher `connectorFetch` builds from `HTTPS_PROXY` / `HTTP_PROXY` /
   `NO_PROXY`, chosen per redirect hop; the SSRF check still runs on the target
   first, so metadata/link-local stay refused before any proxy is used. Provider
   connection tests use the same path (`providerTestFetch`), so a test can never
   pass a route the real call refuses, or fail one it would take.
2. **Endpoint overrides, validated per provider** (`providers/privateEndpoint.ts`).
   Each override is optional; empty keeps the public hostname (which also covers
   private DNS and VPN setups). An override must be an https origin, with no path
   or credentials, whose host is on the provider's own domain — so a signed
   request cannot be re-aimed elsewhere (the R386 principle):

   | Provider     | New / wired field                                         | Accepted host                                                   |
   | ------------ | --------------------------------------------------------- | --------------------------------------------------------------- |
   | Bedrock      | Runtime endpoint URL (new)                                | `*.vpce.amazonaws.com`, `*.amazonaws.com`, `*.api.aws`          |
   | Vertex       | Custom Endpoint (wire it through)                         | `*.googleapis.com` (incl. `*.p.googleapis.com`)                 |
   | OCI          | Service Endpoint (wire it through)                        | `*.oci.oraclecloud.com` (incl. `*.pe.inference.generativeai.*`) |
   | Vertex token | token URI follows the endpoint's PSC name when one is set | `*.googleapis.com`                                              |

   SigV4/OCI signing uses the override's host; region stays the signing region.

   SigV4 / OCI signing uses the override's host; the region stays the signing
   region. The Vertex OAuth token request follows the API endpoint over PSC
   (`oauth2-<endpoint>.p.googleapis.com`) while the JWT audience stays the public
   token URL, as Google's design requires.

3. **Azure guard rail.** A save whose endpoint host is a `*.privatelink.*` name
   is refused with a message to use the resource's own hostname and private DNS
   — the configuration Microsoft documents as unsupported.

Deferred out of this phase: `NODE_EXTRA_CA_CERTS` for Compose and the per-cloud
private-DNS write-up go with the Phase 2 docs; the object-store private-endpoint
exemption from `BLOCK_PRIVATE_NETWORK_FETCH` is a data-source item, tracked with
VA-14's residual rather than here (GenAI calls already allow private addresses).

**Tested, code side** (`providerProxy.test.ts`, `privateEndpoint.test.ts`,
`providerPrivateEndpoints.test.ts`): an in-process forward proxy proves model
calls and connection tests tunnel through it, a `NO_PROXY` host goes direct, and
the metadata address is still refused before the proxy; the validator accepts
each provider's documented hosts and refuses other domains, paths, credentials,
http and look-alikes; and the adapters, driven end to end, call (and sign for)
the override host while keeping the region scope, with the Vertex token routed
through the PSC name.

### Phase 2 — make the path visible and enforceable — **DONE (2026-10-27)**

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

**As built:**

1. Every provider dialog has a **Network** section. For the four providers that
   take an override (Bedrock, Vertex, OCI, Claude Platform on AWS) it offers
   _Public_, _Private DNS_ and _Private endpoint URL_, the last showing the
   accepted hosts (`endpointHosts`). _Public_ and _Private DNS_ save the same
   thing, no endpoint; they differ only in what the name resolves to from the
   server, which the path check shows, so no mode is stored. Azure's section
   says to keep the resource's own hostname and resolve it privately.
2. `describeConnectivity` (`connectivityPath.server.ts`) reports the path: via
   the proxy (its host, never its credentials), or direct to the resolved
   addresses, private only if every one is. With `tls`, a direct https call
   also reads the endpoint's certificate (subject, issuer, valid for the name)
   in a handshake to the address already resolved, with SNI, a 5 s timeout, and
   never to a name resolving to a metadata or link-local address. A passing
   Test & Connect appends it; the four cloud providers and Azure, which have no
   live test, get a credential-free **Check network path** button. A
   certificate not valid for the name is flagged: every call to it would fail.
3. **Require a private network path** is a switch on every provider, stored as
   `requirePrivate` (encrypted credentials) or `require_private` (Integrations
   rows). A provider call runs in a scope (`withPrivatePathScope`) that its
   saved configuration marks; `safeFetch` then refuses, per connection and per
   redirect hop, a direct hop to a name with any public address or none, and
   lets a proxied hop through. An OpenAI-compatible transport, fetched later by
   its caller, is preflighted (`assertPrivatePath`). Refusals are audited
   (`provider.private_path.refused`) and are `SsrfRefusedError`s, so never
   retried. Connection tests run under the same rule. `GENAI_REQUIRE_PRIVATE`
   sets the starting value for new integrations only.
4. The route-all switch lists what it does not cover — Bedrock, Vertex, Azure,
   OCI and Claude Platform on AWS, which sign their own requests — and, with
   route-all on, those cards say _Called directly, not via your gateway_. The
   cards read only the gateway's route-all flag, never its key.
5. **Claude Platform on AWS** (`claude_aws`): `claudeAws.server.ts` calls
   `/v1/messages` at `aws-external-anthropic.<region>.api.aws` (or the private
   endpoint) with `anthropic-workspace-id`, authenticated by an API key
   (Bearer) or SigV4 for `aws-external-anthropic` (Bedrock's signer, now
   taking a service name). There is no default region and the workspace id
   must look like `wrkspc_…`. Registered in the save schema, dispatch, chat,
   gateway prefixes and every model picker. Migration
   `20261028000000_provider_credentials_providers.sql` widens the encrypted
   store's provider check, which had admitted only four providers, so OCI
   Generative AI and Qwen keys could not be saved there either.

**Tested, code side** (`privatePathPolicy.test.ts`, `connectivityPath.test.ts`,
`connectivityTls.test.ts`, `claudeAwsProvider.test.ts`, `privateEndpoint.test.ts`):
the per-connection rule (public, mixed, unresolvable, proxied, redirect hops, a
throwing audit hook, a non-provider fetch in the scope); a chat call and a
resolved transport marked from a saved row, refused and audited or sent; the
connection test under the rule; the path report and the certificate (mocked
handshake: SNI, the resolved address, validity, fallbacks, failure and
timeout, and the cases that must not probe); Claude Platform on AWS end to end
(Bearer and SigV4 requests, the exact signature for a PrivateLink host, the
refusals, the stream); and the gateway list matching the server's dispatch.
Three mutation rounds: 73 of 74 mutants caught; the survivor (a refusal from a
test that does not catch its own errors) got a test and is caught.

The UI round (docs/UI_TEST_RESULTS.md, 2026-10-27) found that a failed test
stores the key with no way to delete it — a private-path refusal is a failed
test — so a saved key whose test failed now offers Disconnect, and a row a
disconnect has emptied no longer reads as a saved key.

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
