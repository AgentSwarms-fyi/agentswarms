# Key management and external KMS

**Status: design. Not implemented.** Today the master key is
`PROVIDER_CREDS_SECRET`, an environment variable. This document is the plan for
sourcing it from AWS KMS, GCP KMS, Azure Key Vault, OCI Vault or HashiCorp
Vault, written so the work can be picked up and costed rather than
re-litigated.

For what exists now — AES-256-GCM, key fingerprints, and the rotation sweep —
see [SECURITY.md](../SECURITY.md#credential-encryption).

---

## Why the current design is not simply wrong

Worth stating, because "put it in a KMS" is often assumed to be strictly better.

An environment variable is a **reasonable default for a self-hosted product**.
It has no cloud dependency, no per-operation cost, no latency, and works on a
laptop, a Raspberry Pi and an air-gapped network alike. Requiring a KMS would
make the smallest deployment harder to stand up than the largest.

What it does not give you:

- **Auditability of key USE.** A KMS logs every decrypt. An env var logs nothing.
- **Separation of duties.** Anyone who can read the process environment (or a
  `.env`, or a container inspect) has the key. With a KMS, the app holds a
  _permission to decrypt_, not the key.
- **Centralised revocation.** Disabling a KMS key stops every deployment using
  it, at once. Rotating an env var means editing every host.
- **Hardware backing.** KMS keys are HSM-backed; a hashed env var is not.

So the goal is not to replace the env var but to make it **one provider among
several**, with the same code path underneath.

## The shape of the change: envelope encryption

Today the master secret directly derives the AES key that encrypts every
credential. That is the wrong shape for a KMS, because it would mean one KMS
call per credential read — expensive, slow, and a hard dependency on the KMS
being reachable for every request.

The standard answer is **envelope encryption**:

```
                      ┌──────────────────────────────┐
   KMS / env ────────▶│  Key Encrypting Key   (KEK)  │   never leaves the KMS
                      └──────────────┬───────────────┘
                                     │ decrypts (one call, cached)
                      ┌──────────────▼───────────────┐
                      │  Data Encryption Key  (DEK)  │   held in memory only
                      └──────────────┬───────────────┘
                                     │ AES-256-GCM
                      ┌──────────────▼───────────────┐
                      │  credential ciphertext rows  │   unchanged on disk
                      └──────────────────────────────┘
```

- The **DEK** is what actually encrypts credentials — exactly what the current
  code does, unchanged.
- The DEK is itself stored encrypted (as a _wrapped_ blob) and is unwrapped by
  the **KEK**, which lives in the KMS and never leaves it.
- Unwrapping happens **once per process start**, not per credential. The KMS is
  on the startup path, not the request path.

The existing `kid` fingerprint already identifies which key wrote a row, so
multiple DEK generations coexist during rotation with no schema change. **The
stored ciphertext format does not change at all** — this is why the rotation
work landed first.

## Provider abstraction

One interface, five or six implementations. The whole point is that
`crypto.server.ts` should not know which one is in use.

```ts
// src/utils/providers/kms/types.ts   (proposed)
export interface KeyProvider {
  readonly id: "env" | "aws" | "gcp" | "azure" | "oci" | "vault";

  /** Unwrap the stored DEK. Called once at startup, and on rotation. */
  unwrapDek(wrapped: WrappedDek): Promise<Uint8Array>;

  /** Wrap a freshly generated DEK for storage. Called only when rotating. */
  wrapDek(dek: Uint8Array): Promise<WrappedDek>;

  /** Cheap liveness/permission check for the health page. */
  probe(): Promise<{ ok: boolean; detail: string }>;
}

export type WrappedDek = {
  provider: KeyProvider["id"];
  /** Provider-specific key reference — an ARN, a resource name, a Vault path. */
  keyRef: string;
  /** Base64 of the wrapped DEK. For `env`, the DEK derived from the secret. */
  material: string;
  /** Fingerprint, same scheme as the existing `kid`. */
  kid: string;
  createdAt: string;
};
```

Selected by environment, defaulting to today's behaviour so nothing changes for
an existing deployment:

| Variable       | Values                                                 | Default |
| -------------- | ------------------------------------------------------ | ------- |
| `KMS_PROVIDER` | `env` \| `aws` \| `gcp` \| `azure` \| `oci` \| `vault` | `env`   |
| `KMS_KEY_REF`  | ARN / resource name / vault path                       | —       |

### Per-provider notes

| Provider            | Key reference                     | Wrap / unwrap                                                                             | Auth in a self-hosted deployment                           |
| ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **AWS KMS**         | `arn:aws:kms:…:key/…`             | `Encrypt` / `Decrypt`, or `GenerateDataKey` which returns plaintext + wrapped in one call | IAM role via IRSA / instance profile; else access key pair |
| **GCP KMS**         | `projects/…/cryptoKeys/…`         | `encrypt` / `decrypt`                                                                     | Workload Identity; else service-account JSON               |
| **Azure Key Vault** | `https://…vault.azure.net/keys/…` | `wrapKey` / `unwrapKey`                                                                   | Managed Identity; else client secret / cert                |
| **OCI Vault**       | key OCID + crypto endpoint        | `encrypt` / `decrypt`                                                                     | Instance principal; else API signing key                   |
| **HashiCorp Vault** | `transit/keys/<name>`             | Transit `encrypt` / `decrypt`                                                             | Kubernetes auth, AppRole, or token                         |

Vault Transit is the most portable and the one to build **second** after `env`,
because it runs anywhere and needs no cloud account to test.

## Failure modes, and what each should do

This is the part that decides whether the feature is safe, so it is specified
before any code.

| Situation                                                     | Behaviour                                                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KMS unreachable **at startup**                                | **Refuse to start.** Serving with no ability to decrypt credentials would surface as hundreds of confusing per-feature errors. Fail once, loudly, with the provider and key ref in the message. |
| KMS unreachable **while running**                             | Keep serving. The DEK is already in memory; no KMS call is on the request path. Surface a warning on the health page.                                                                           |
| Permission revoked mid-run                                    | Same as above until restart. The next restart fails closed.                                                                                                                                     |
| Wrapped DEK missing or corrupt                                | Refuse to start. Never silently generate a new DEK — that would leave every existing credential unreadable while looking healthy.                                                               |
| Provider misconfigured (`KMS_PROVIDER=aws`, no `KMS_KEY_REF`) | Refuse to start, naming the missing variable.                                                                                                                                                   |
| Switching provider                                            | Treated as a **rotation**: unwrap with the old provider, generate a new DEK, wrap with the new one, run the existing re-encrypt sweep.                                                          |

The DEK is held **in memory only** — never written to disk, never logged, and
excluded from error serialisation.

## Migration path

Deliberately incremental. Each step is shippable and reversible.

1. **Introduce the DEK indirection with `env` as the only provider.** The DEK is
   derived from `PROVIDER_CREDS_SECRET` exactly as today, so behaviour is
   byte-identical and nothing needs re-encrypting. This is the risky structural
   change, done with no external dependency to debug alongside it.
2. **Add `KeyProvider` and the Vault Transit implementation.** Testable in CI
   with a Vault dev container — no cloud account needed.
3. **Add AWS, then GCP, Azure, OCI**, each behind the same interface, each with
   an integration test that is skipped when credentials are absent.
4. **Add a provider-switch flow** to the existing Settings card, reusing the
   re-encrypt sweep already built.

## Testing

- **Unit:** a fake `KeyProvider` covering unwrap success, unwrap failure,
  corrupt wrapped DEK, and provider switch. No network.
- **Contract:** one shared suite every provider must pass — wrap→unwrap
  round-trips, a wrong key ref fails closed, `probe()` reports honestly.
- **Integration:** per provider, skipped without credentials, so CI stays green
  on a fork.
- **Mutation:** the fail-closed paths specifically. A KMS integration that
  silently generates a fresh DEK when unwrapping fails is worse than no
  integration, and that is exactly the bug a passing happy-path test hides.

## Open questions

Genuinely undecided, listed rather than guessed:

- **Where does the wrapped DEK live?** A database row is convenient and backs up
  with the data — but then a database dump plus KMS access is enough, slightly
  weakening the separation. A file on disk or a second env var keeps them apart
  at the cost of another thing to deploy.
- **One DEK per instance, or per tenant?** Per-tenant enables per-tenant
  revocation and crypto-shredding on delete, at the cost of many more KMS calls
  and a more complex rotation.
- **Should `probe()` run on the health page?** It proves the permission is live,
  but adds a periodic billable KMS call.
