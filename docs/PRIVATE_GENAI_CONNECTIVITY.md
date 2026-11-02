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
  tracked separately (closed in Phase 3, R422: a cloud's own storage names are
  exempt).

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
   | Bedrock      | Runtime endpoint URL (new)                                | since R427, `bedrock-runtime`'s own names in the region (below) |
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

**End to end (2026-10-28, after the migration):** a Claude Platform on AWS credential saved with
the switch on, an agent on it, and a chat: refused before sending, with
`provider.private_path.refused` in the audit log; with the switch off, the real endpoint answered
the made-up key with a 401 `authentication_error` (UI_TEST_RESULTS).

### Phase 3 — data sources over private paths — **DONE (2026-11-01)**

The same choice for everything the platform reads data from: object storage (S3, GCS, Azure Blob,
MinIO and other S3-compatible stores), databases (Postgres, MySQL, SQL Server, Oracle, MongoDB and
the other connectors), warehouses (Snowflake, BigQuery, Redshift, Databricks SQL, Synapse) and the
lakehouse's catalogs. Public stays the default. For each: a private endpoint or private DNS name
(PrivateLink, Private Service Connect, Azure Private Link, VPC/VNet endpoints, a VPN), the path
reported by its connection test, and an optional require-private rule like the model providers'.
It includes the object-store private-endpoint exemption from `BLOCK_PRIVATE_NETWORK_FETCH` (the
VA-14 residual). Done when: per-connector tests and mutation checks, a UI round per connector
family (real cloud connections cannot be made here; local stand-ins can), and the in-repo and
in-app docs updated. The security campaign continues alongside it.

Built family by family: object storage (R422), databases and warehouses (R424, R425), the
fixed-host warehouses' private endpoints (R426), and the lakehouse's Iceberg catalogs (R428).

**Object storage, as built (R422):**

1. **Private endpoints.** AWS now has an optional Endpoint URL, so an S3 interface endpoint
   (`https://vpce-….s3.<region>.vpce.amazonaws.com`, the bucket added in front unless path-style
   is on) can be entered; GCS takes a Private Service Connect name
   (`https://storage-<endpoint>.p.googleapis.com`); Azure Private Link keeps
   `<account>.blob.core.windows.net` and resolves it privately; R2, Spaces, B2, MinIO and custom
   endpoints are reached over the internet or a VPN. The form's **Network** box says which, per
   provider (`PRIVATE_PATH_HINT`, `src/utils/catalog/storageNetwork.ts`).
2. **The path, reported.** Adding a source tests it and says how it was reached: "Reached direct
   to 172.19.0.12 (private)", with the certificate for an https endpoint. Object-store requests
   go direct, never through the corporate proxy, so the report never says "via proxy".
3. **Require a private network path**, per source, off by default (`require_private` on the
   source's config). `assertStoragePath` refuses, before anything is sent, a store whose host
   resolves to a public address or not at all from the app server, with advice for a store (its
   DNS zone or its Endpoint URL; the proxy is no way round it). Every reader calls it: the signed
   S3 and Azure requests, DuckDB's reads and ORC reads, a lake mount when it is made and when the
   engine registers its secret, and an ETL run's start. A refusal while adding a source is audited
   as `storage.private_path.refused`.
4. **The `BLOCK_PRIVATE_NETWORK_FETCH` exemption (VA-14's residual).** With the switch on, a
   cloud's own storage name may resolve to a private address: S3 names
   (`s3.<region>.amazonaws.com`, a bucket in front, the dual-stack and FIPS forms, interface
   endpoints), `storage.googleapis.com` and `storage-*.p.googleapis.com`, and Azure
   `<account>.blob|dfs.core.windows.net`. A private address there is PrivateLink or a private DNS
   zone, not an internal service. Not the whole cloud domain: an EC2 instance's public DNS name
   ends in `amazonaws.com` and resolves to its private address inside a VPC, and an Azure SQL
   server is `*.database.windows.net`. The exemption is decided per redirect hop
   (`safeFetch`'s `allowPrivateHost`), so a storage name cannot hand a request on to an internal
   host. A self-hosted MinIO stays under the switch.

Tested (`storagePrivatePath.test.ts`, 14): the storage names and the look-alikes that must not
count; the rule passing a private store, refusing a public or unresolved one with the store's
advice, checking the virtual-hosted bucket's host, and ignoring `HTTPS_PROXY`; the exemption
allowing a cloud name and refusing any other private host, per hop, in `safeFetch` and in
DuckDB's guard; and every reader's call. Mutation 14 of 14 (the first run 13: no Azure negative
case; `myserver.database.windows.net` now is one). From the UI with a throwaway SILO on the app
network (UI_TEST_RESULTS, 2026-11-01): a public S3 name with the rule on was refused before
sending and audited; the private store connected and said "Reached direct to 172.19.0.12
(private)".

**Databases and warehouses, as built (R424):** one check before any connection is opened
(`assertWarehouseNetwork`, `src/utils/warehouse/network.server.ts`), run for every query, test and
table listing (`executeWarehouseQuery`) and at an ETL run's start.

1. **The always-refused addresses for wire protocols.** The Postgres, MySQL and SQL Server
   families' drivers open TCP themselves, so none of `safeFetch`'s checks reached them: a
   connection could be aimed at the cloud metadata address, by name or by a name resolving
   there. The host and every address it resolves to are now held to the always-refused tier;
   private networks stay allowed, a database on the deployment's network being the normal case.
   The HTTPS engines (Snowflake, Databricks, BigQuery, Redshift and Athena's APIs, Trino,
   ClickHouse, Oracle ORDS) already had this from `connectorFetch`, per request and per hop.
2. **The path, reported.** **Test connection** says how the connection was reached ("direct to
   10.0.4.7 (private)"; the certificate for an HTTPS engine; "via proxy …" when its calls use
   the proxy).
3. **Require a private network path**, per connection, off by default (`require_private`). A
   wire protocol is always direct, so the proxy does not count for it, and its refusal advises
   the DNS zone or the VPN route; an HTTPS engine's calls may leave through the proxy, which
   counts, as for the model providers. A refusal from **Test connection** is audited
   (`warehouse.private_path.refused`).
4. **How each engine is reached privately**, in the form's Network box
   (the hints live in `src/utils/warehouse/destinations.ts`): RDS, Cloud SQL and Azure private endpoints keep their names;
   Snowflake PrivateLink takes the account with `.privatelink`, so calls go to
   `<account>.privatelink.snowflakecomputing.com`; Databricks and Synapse keep their names under a
   private DNS zone; Redshift and Athena keep the regional names with private DNS on their
   interface endpoints. The engines whose API host is fixed take an endpoint override since
   R426 (below).

Tested (`warehousePrivatePath.test.ts`): the metadata address refused by literal and by
resolution, a private database allowed, an unresolvable name named; the rule for a wire protocol
(private passes, public refused with the database's advice, the proxy not counting) and for an
HTTPS engine (the proxy counting), a PrivateLink account's host; the path; and every wiring point.

**Checked again as each socket connects (R425).** The check above runs before the driver connects,
but the driver (pg, mysql2, tedious) then resolved the name again itself, so a resolver could answer
the check with a safe address and the driver with the metadata address. Each driver now resolves
through `guardedLookup` (`network.server.ts`): pg through a socket whose `connect(port, host)`
carries the lookup, mysql2 through its `stream` factory, tedious through its `connector` (which it
calls for an Azure gateway's redirect too). The lookup resolves the name, refuses the always-refused
addresses and, when the connection requires a private path, any public one, and hands the socket
exactly the addresses it checked. TLS still takes its server name from the configured host. A pool's later
sockets pass the same check, so a failover that moves the name to a new address keeps working, and
the rule is part of the pool key, so turning it on builds a new pool. Tested
(`warehouseConnectPinning.test.ts`) with the real drivers over real sockets, against a local server
reached through names only the test's resolver knows: each driver reaches the server through the
lookup and is refused before connecting once the name answers with the metadata address, and a name
that answers the check safely and the driver with the metadata address is refused for all three
engines, pooled and not. **Not covered:** the HTTPS engines' requests are pinned to checked
addresses by `safeFetch`, but their require-private rule is checked before each query rather than
per request; a named SQL Server instance's port lookup (a UDP query to its host) resolves the name
on its own; an ETL pipeline's code connects from its own runtime.

**Endpoint overrides for the fixed-host engines (R426).** BigQuery, Redshift's Data API and Athena
are called at a host the app builds. With private DNS (Private Google Access, or an interface
endpoint with private DNS enabled) that host resolves privately and needs nothing. Without it, the
connection's optional **Private endpoint** names the endpoint itself (`src/utils/warehouse/endpoints.ts`):

| Engine   | Accepted                                                                                 | Also used for                                                           |
| -------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| BigQuery | `https://bigquery-<endpoint>.p.googleapis.com` (a PSC endpoint's name)                   | the token: `oauth2-<endpoint>.p.googleapis.com`, JWT audience unchanged |
| Redshift | `https://vpce-….redshift-data.<region>.vpce.amazonaws.com`, or the regional or FIPS name | every Data API call, signed for that host                               |
| Athena   | `https://vpce-….athena.<region>.vpce.amazonaws.com`, or the regional or FIPS name        | every call, signed for that host, session token included                |

The override must be that engine's own name, in the connection's region, as an address alone
(https, no port, path or credentials). These requests carry a signature (and Athena's may carry a
session token), so nothing broader is accepted: not another service's endpoint, not another
region's, and not the names under `amazonaws.com` that customers control. The ones that matter
carry AWS's own valid certificate and hand the whole request to their owner, such as an API Gateway
stage, `<id>.execute-api.<region>.amazonaws.com`. (An EC2 instance's or a load balancer's name is
customer-controlled too, but cannot present a valid certificate for itself, so TLS stops the
request first.) A save that names anything else is
refused with the field and an example. The drivers, the network check (path report and
**Require a private network path**) and the shared-secret check (R420) take the host from the same
function, so each sees the host the calls use. A Redshift connection's region is now checked
before it goes into the host: anything was accepted, and `x.attacker.test/` made the host
`redshift-data.x.attacker.test`. Tested (`warehouseEndpoints.test.ts`): the accepted and refused
names; the hosts each check sees; and each driver run with the fetch layer replaced, reading back
what it sent: every call to the endpoint, an AWS signature recomputed from the request as sent,
BigQuery's token through the PSC name with Google's audience.

**Exact names for the AWS model providers (R427).** Phase 1's Bedrock override accepted any
`*.vpce.amazonaws.com`, `*.amazonaws.com` or `*.api.aws` host, and Claude Platform on AWS any
`*.api.aws` or `*.vpce.amazonaws.com` host. That admitted an API Gateway stage someone else owns. A
Bedrock call aimed there would have carried its signature, session token and prompt, and a Claude
Platform call its API key. The stage's answer would have come back as the model's. The two
overrides now follow the warehouses' rule (`src/utils/providers/privateEndpoint.ts`): the service's
own name, in the region the request is signed for.

| Provider               | Accepted                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bedrock                | `bedrock-runtime.<region>.amazonaws.com`, its `-fips` name, the dual-stack `….<region>.api.aws` names, `vpce-….bedrock-runtime.<region>.vpce.amazonaws.com` |
| Claude Platform on AWS | `aws-external-anthropic.<region>.api.aws`, `vpce-….aws-external-anthropic.<region>.vpce.amazonaws.com`                                                      |

Another region's name is refused too. The request is signed for the connection's region, so the
message names that region, with an example in it. The dialog's hint lists the names for the region
typed so far. The save, the **Check network path** button and the adapters all use the same rule,
so a saved override that the rule now refuses fails its next call with that message, and is
re-saved with the right name. Vertex AI and OCI keep their domain rule (`*.googleapis.com`,
`*.oci.oraclecloud.com`). Their private names include ones the customer picks: a PSC endpoint name,
an OCI private endpoint prefix. No name under those domains is known to hand a request to its owner.
Tested (`providerEndpointAws.test.ts`): the accepted names, zonal interface endpoints included; the
refused ones (API Gateway, its dual-stack name, AppSync, an S3 bucket, another account's endpoint
service, another Bedrock service, look-alikes, another region); the adapters send nothing to a
refused name; and a save stores nothing.

**The lakehouse's Iceberg catalogs, as built (R428).** The engine (DuckDB's iceberg extension)
calls a catalog's REST endpoint, and its OAuth2 token server, itself, from the shared engine; the
app never makes those requests. A catalog on a private endpoint keeps its name and resolves
privately, so there is no endpoint to override. What is new:

1. **The path, reported.** The add-catalog form's **Network** box has **Check network path**: for
   the endpoint and the token server, the addresses each name resolves to from the app server,
   private or public, and the certificate of an https name. Nothing is sent but a TLS handshake.
2. **Require a private network path**, per catalog, off by default (`require_private`, migration
   `20261104000000`). The catalog attaches only when both names resolve only to private
   addresses: checked at every attach (the save's probe, a mount, a publish, the sync) and again
   at every engine sync for a catalog already attached, which is detached, with the reason on its
   row, when its name stops resolving privately. A query on one of its mounts then names the
   catalog and gives that reason (R436; to the owner, while someone reading a shared mount hears
   only the catalog's name), and the first query after the name resolves privately again attaches
   it. A proxy does not count, unlike a model
   provider's. The engine reads the proxy settings from the environment itself, so the app
   cannot vouch for which way a call goes (below). A refusal is audited
   (`lakehouse.iceberg.private_path.refused`). The rule can be turned on for a saved catalog from
   its row, and turning it on checks the path first. A change is audited
   (`lakehouse.iceberg.network_rule`).
3. **Before the migration**, every catalog reads as not requiring the rule, a catalog without it
   saves as before, and asking for it says which migration to apply.

**Found doing it: the engine's proxy.** Measured on the running image (DuckDB 1.5.5), the engine
takes `HTTP_PROXY` (upper case only) as its `http_proxy` setting for every request, https
included. Its HTTP client also honours `HTTPS_PROXY` for https, and it honours `NO_PROXY`. The
app's own calls use `HTTPS_PROXY` for https. So with only `HTTP_PROXY` set, the app's calls go
direct and the engine's through the proxy. That is why the rule does not count a proxy for a
catalog, and why the path report notes a proxy rather than assuming one.

**Not covered:** the table files. A catalog points the engine at its data files (and, with vended
credentials, at the store holding them) only when a table is read, so the rule cannot check
their path beforehand. The lakehouse's own store already has R422's rule. The engine also
resolves the catalog's name again itself after the check (VA-14's DuckDB residual), so the check
narrows that window to one sync rather than closing it.

Tested (`icebergPrivatePath.test.ts`):

- the rule at every attach: the endpoint and the token server, a mixed answer, a proxy set, the
  metadata address with and without the rule;
- the sync: a catalog detached when its name turns public, with its reason and an audit; kept
  out through the retry backoff; attached again once the name resolves privately;
- saving and toggling, before and after the migration;
- the path report.

The migration was proved in a throwaway Postgres: applied twice over an existing row, which reads
false.

#### And the credential key provider (R429)

AWS KMS, as the provider of the key that encrypts stored credentials, takes the same rule from
the environment: `KMS_REQUIRE_PRIVATE=true` refuses a KMS call, and the STS exchange web identity
makes, that would go directly to a public address. `AWS_ENDPOINT_URL_KMS` takes the KMS VPC
endpoint's name when private DNS is off. See
[KEY_MANAGEMENT.md](./KEY_MANAGEMENT.md#over-a-private-path).

Azure Key Vault takes the same rule (R431): with `KMS_REQUIRE_PRIVATE=true` a Key Vault call that
would go directly to a public address is refused. A vault's private endpoint keeps the vault's own
name (the `privatelink.vaultcore.azure.net` zone), so `KMS_KEY_REF` does not change. The Entra ID
sign-in has no private endpoint and is not held to the rule; a managed identity's token never
leaves the host. See [KEY_MANAGEMENT.md](./KEY_MANAGEMENT.md#over-a-private-endpoint).

Google Cloud KMS takes the same rule (R435): with `KMS_REQUIRE_PRIVATE=true` a Cloud KMS call that
would go directly to a public address is refused. A Private Service Connect endpoint is reached by
setting `GCP_KMS_ENDPOINT` to its `cloudkms-<endpoint>.p.googleapis.com` name (the token is then
fetched from `oauth2-<endpoint>.p.googleapis.com`), or by giving `cloudkms.googleapis.com` the
endpoint's address in private DNS. `private.googleapis.com` and `restricted.googleapis.com` are
public addresses routed privately, and the rule refuses them. See
[KEY_MANAGEMENT.md](./KEY_MANAGEMENT.md#over-private-service-connect).

OCI Vault takes the same rule (R437): with `KMS_REQUIRE_PRIVATE=true` a Vault call that would go
directly to a public address is refused. A service gateway keeps the traffic on Oracle's network
but the vault's addresses stay public, so the rule refuses them; a Private Service Access
endpoint, whose private DNS answers the vault's endpoint name with an address in your subnet,
passes. An instance principal's call to the identity service is not covered. See
[KEY_MANAGEMENT.md](./KEY_MANAGEMENT.md#over-a-private-address).

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
