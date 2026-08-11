# Security

How this application protects credentials and data, what it deliberately does
not do, and how to report a problem. Every mechanism below names the file that
implements it, so a claim here can be checked rather than trusted.

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Credential encryption](#credential-encryption)
- [Rotating the credential key](#rotating-the-credential-key)
- [Secret references](#secret-references)
- [Access control](#access-control)
- [Outbound request protection (SSRF)](#outbound-request-protection-ssrf)
- [Query safety](#query-safety)
- [Code execution](#code-execution)
- [Auditing](#auditing)
- [Deployment responsibilities](#deployment-responsibilities)
- [What this project does not claim](#what-this-project-does-not-claim)

---

## Reporting a vulnerability

Please **do not** open a public GitHub issue. Email **hello@agentswarms.fyi**
with a description and impact, steps to reproduce (a minimal proof of concept
helps), and a suggested fix if you have one. We will acknowledge as soon as we
can and follow up once triaged. Please allow a reasonable period before public
disclosure.

Numbered releases exist as git tags and GitHub Releases from `v1.0.0`. `main`
is the development branch and is where fixes land first; there is no separate
long-term support matrix.

---

## Credential encryption

Provider API keys, warehouse and database passwords, SaaS connector
credentials, MCP bearer tokens, Git tokens and everything stored in **Secrets**
are encrypted at rest before they reach the database.

| Property       | Value                                                                            |
| -------------- | -------------------------------------------------------------------------------- |
| Algorithm      | **AES-256-GCM** (authenticated — tampering fails, never silently)                |
| Key derivation | `SHA-256(PROVIDER_CREDS_SECRET)`                                                 |
| IV             | 12 random bytes, fresh per encryption                                            |
| Stored shape   | `{ ciphertext, iv, kid }`, base64                                                |
| Implementation | `src/utils/providers/crypto.server.ts` — server-only, never imported client-side |

`PROVIDER_CREDS_SECRET` has **no default**. If it is missing the code throws
rather than falling back to a built-in key, so a misconfigured deployment fails
loudly instead of encrypting everything under a value an attacker could read in
the source.

The setup scripts generate one on first run (32 bytes from a CSPRNG, hex
encoded — `scripts/setup.sh`, `scripts/setup.ps1`), which is why you may never
have typed it.

**Three consequences worth understanding:**

1. **That secret protects every stored credential.** Anyone holding both your
   `.env` and a database dump has all of them. Treat it like a password-manager
   master key.
2. **Lose it and the data is unrecoverable.** There is no escrow. A different
   secret derives a different key. Back it up.
3. **It is not a substitute for database access control.** Encryption at rest
   protects a stolen dump; it does not protect a live connection with valid
   credentials.

## Rotating the credential key

Rotation is supported and does not require downtime. Ciphertext carries a
`kid` — a **fingerprint of the writing key**, derived as
`SHA-256("agentswarms/creds-kid/v1|" + secret)`. The domain separator matters:
without it the fingerprint would be the first bytes of the AES key itself, so
publishing it in every row and in the admin UI would publish key material. It
identifies which key wrote a row and reveals nothing else.

| Variable                    | Meaning                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `PROVIDER_CREDS_SECRET`     | The **current** key. Everything new is encrypted with it.                      |
| `PROVIDER_CREDS_SECRET_OLD` | Zero or more **previous** keys, comma-separated, accepted for decryption only. |

**To rotate:**

1. Put the new secret in `PROVIDER_CREDS_SECRET` and move the old one to
   `PROVIDER_CREDS_SECRET_OLD`.
2. Restart. Both keys now decrypt; everything written from here uses the new one.
3. Open **Admin → IAM → Settings → Credential encryption key**. It shows the
   current fingerprint and how many stored values are on which key.
4. Run **Re-encrypt to current key**.
5. When nothing is left on the old key, remove `PROVIDER_CREDS_SECRET_OLD`.

The sweep is **idempotent** — values already on the current key are skipped —
and **fails safe**: a value that cannot be decrypted under any configured key is
counted, reported, and left byte-identical rather than replaced. A wrong keyring
costs you an error message, not your credentials.

> [!WARNING]
> **The sweep is global and the forward direction is not reversible by
> reverting `.env`.** It re-encrypts every stored credential in the instance to
> whatever key is currently configured. If you sweep and then put the old secret
> back as `PROVIDER_CREDS_SECRET` without listing the new one in
> `PROVIDER_CREDS_SECRET_OLD`, every credential becomes unreadable. Check the
> fingerprint and the counts on the Settings card **before** running it — that
> panel is the dry run.

Implementation: `crypto.server.ts` (keyring, fingerprints, deep re-encryption),
`keyRotation.server.ts` (the table sweep), `keyRotation.functions.ts`
(superadmin gate + audit). Behaviour is pinned by `tests/unit/keyRotation.test.ts`,
including that an undecryptable value is preserved rather than destroyed.

## Secret references

Anywhere a credential is accepted you can write `{{secret:NAME}}` instead of
pasting the value. It is resolved **on the server at call time** and never sent
to the browser, so someone who can edit a swarm, a connection or an integration
still cannot read the secret.

Resolution enforces per-user access: `resolveSecretRefs` (`utils/secrets.server.ts`)
returns your own secret, or one shared with you through IAM, and **throws
naming the secret** if neither applies — it is never quietly replaced with an
empty string, which would turn a credential problem into an unauthenticated
request some APIs answer with `200`.

The fields that resolve references are listed exactly in the in-app
**Docs → Secrets** page. A reference written anywhere else is passed through as
literal text.

## Access control

- **Row Level Security** is enabled on user data. Resources — knowledge bases,
  datasets, secrets, dashboards, connections — are **owner-only plus explicit
  grants**, not readable by default.
- **IAM** (`Admin → IAM`) provides users, groups, per-resource grants with
  optional row filters and column masks, model allow-lists, and group budgets.
- **Model access** can be set to allow-by-default or **deny-by-default**, where
  a user with no rule can call no model until allow-listed. Superadmins bypass
  deny mode so you cannot lock yourself out.
- **Shared resources are read-only** and run **as their owner** — a grantee's
  query hits the owner's warehouse under the owner's credentials, and the
  credential itself is never exposed.
- Admin server functions are gated by `requireSuperadmin` (`utils/iam.server.ts`).

## Outbound request protection (SSRF)

Several features fetch a URL supplied by a user or chosen by a model (the swarm
`http` node, the `web_browse` tool, A2A remote agents, catalog crawling). All of
them go through `assertPublicUrl` / `safeFetch` in `utils/ssrfGuard.server.ts`.

- **Always refused, and nothing can enable them:** link-local and cloud
  instance metadata (`169.254.0.0/16`, including `169.254.169.254`), the IPv6
  equivalents, `fd00:ec2::254`, `0.0.0.0/8`, multicast, and the unspecified
  address. Both spellings of IPv4-mapped IPv6 are recognised, including the
  compressed `::ffff:a9fe:a9fe`.
- **The hostname is resolved and every returned address is checked**, so a
  public name whose A record points somewhere private is refused. Verified
  against a live host: a public hostname resolving to `127.0.0.1` is blocked at
  resolution, not merely by string match.
- **Every redirect hop is re-validated**, so a public URL cannot `302` into a
  blocked range.
- **Ordinary private networks** (RFC1918, loopback, CGNAT, IPv6 ULA) are allowed
  by default because self-hosted model servers and in-cluster MCP live there.
  Set `BLOCK_PRIVATE_NETWORK_FETCH=true` to refuse those too. The A2A proxy
  always refuses them regardless, because it returns the response body to the
  browser.
- Only `http` and `https` are permitted.

## Query safety

- Warehouse queries are **read-only**: only `SELECT` / `WITH` / `SHOW` /
  `DESCRIBE` / `EXPLAIN` are accepted, enforced server-side in
  `utils/warehouse/drivers.server.ts`. A `DROP` is refused with an explicit
  message.
- Result size and runtime are capped (`WAREHOUSE_MAX_ROWS`,
  `WAREHOUSE_ABS_MAX_ROWS`, `WAREHOUSE_QUERY_TIMEOUT_MS` — see
  `docs/SCALE_AND_LIMITS.md`). Aggregates push down into the warehouse; a
  `SELECT *` over a huge table is refused rather than materialised.
- Both successful and **refused** queries are audited, so an attempted `DROP`
  against production appears in the log.
- **The local SQL engine is sandboxed.** DuckDB's file-reading table functions
  (`read_text`, `read_csv`, `glob`) are ordinary `SELECT`s and pass any
  read-only check, so the engine that runs user- and model-authored SQL is
  started with `enable_external_access=false`, `allowed_directories` limited to
  its own Parquet cache, and `lock_configuration=true` so neither can be turned
  back on. That closes local file reads **and** outbound HTTP from inside a
  query — `read_csv('http://169.254.169.254/…')` cannot reach cloud metadata.
  Pinned by `tests/unit/duckdbSandbox.test.ts`, which drives the real engine.
- **Object-store queries never reach the networked engine.** Reading `s3://`
  requires network access, and there is no DuckDB setting that grants it while
  denying the local filesystem. So the engine that reads a bucket runs only
  statements the platform composes; your SQL runs in the sandboxed engine over
  rows fetched for it. A query naming a file the catalog has not crawled is
  refused by name rather than attempted, which makes the file list an
  allow-list rather than a denylist of dangerous functions.
- **Bucket endpoints are checked before use.** DuckDB's `httpfs` makes its own
  HTTP calls and does not go through `safeFetch`, so the endpoint is validated
  once at configuration time: link-local and instance-metadata addresses are
  refused outright, and private ranges follow `BLOCK_PRIVATE_NETWORK_FETCH`.

## Code execution

- Swarm **Function (JS)** nodes run sandboxed with a short timeout.
- The **developer workspace** runtime executes user code in a container with a
  read-only rootfs, all capabilities dropped, `no-new-privileges`, and
  pid/memory/CPU limits (`utils/notebookRuntime/docker.server.ts`).
- Notebook runtime tokens are HMAC-signed and compared with
  `timingSafeEqual` (`utils/notebookRuntime/token.server.ts`).
- Internal headless runs authenticate with `INTERNAL_RUN_SECRET`, compared in
  constant time, with the acting user resolved server-side rather than taken
  from the request.

## Auditing

`audit_events` records who did what and when — resource access, sharing
changes, warehouse queries (successful **and** refused), IAM changes and
credential re-encryption. Trace retention is configurable in
`Admin → IAM → Settings`; audit events are governed separately and are not
deleted by that setting.

Guardrails can redact or block PII on the way to a model, and the redacted form
is what is persisted to traces — the raw value is not written to
`execution_traces.prompt`.

## Deployment responsibilities

These are yours, not the application's:

- **`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security.** Never expose it
  to client code. Anything without a `VITE_` prefix stays server-side by design.
- **Back up `PROVIDER_CREDS_SECRET`.** Losing it means losing every stored
  credential.
- **Turn on email confirmations.** With them disabled, Supabase stamps
  `email_confirmed_at` at signup for everyone, which weakens the bootstrap-admin
  check — there is no server-side way to distinguish the operator from an
  attacker when both present only possession of a string.
- **Serve over TLS.** Nothing here substitutes for transport security.
- **Pool and rate limits are per process.** Behind a load balancer, multiply by
  replica count when sizing against a warehouse's `max_connections`.

See [`docs/INSTALL.md`](./docs/INSTALL.md) and
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## What this project does not claim

Stated plainly because you will ask:

- **No third-party certification.** Not SOC 2, ISO 27001 or HIPAA certified,
  and there is no penetration-test report to share.
- **No external KMS integration yet.** The master key is an environment
  variable. Sourcing it from AWS KMS, GCP KMS, Azure Key Vault, OCI Vault or
  HashiCorp Vault is designed in
  [`docs/KEY_MANAGEMENT.md`](./docs/KEY_MANAGEMENT.md) and not yet built.
- **No hardware-backed key storage**, and no automatic re-encryption on a
  schedule — rotation is operator-initiated.
- **Encryption at rest is not end-to-end.** The server decrypts credentials in
  order to use them, so a compromised server process can read them in memory.
