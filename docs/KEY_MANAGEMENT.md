# Key management and external KMS

**Status: envelope encryption is built, with three providers.** `env` (the
default) derives the key from `PROVIDER_CREDS_SECRET` exactly as before,
`vault` keeps the key-encrypting key in HashiCorp Vault Transit, and `aws`
keeps it in AWS KMS ([below](#aws-kms)). GCP KMS, Azure Key Vault and OCI
Vault are designed behind the same interface and not yet built;
`KMS_PROVIDER` refuses them by name rather than pretending.

For what exists now — AES-256-GCM, key fingerprints, and the rotation sweep —
see [SECURITY.md](../SECURITY.md#credential-encryption).

## What exists

| Variable                                                            | Meaning                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KMS_PROVIDER`                                                      | `env` (default), `vault` or `aws`                                                                                                                      |
| `KMS_KEY_REF`                                                       | The provider's reference for the key-encrypting key. Vault: `transit/keys/<name>`. AWS KMS: a key ARN, an alias ARN, `alias/<name>` or a key id        |
| `VAULT_ADDR`, `VAULT_TOKEN` / `VAULT_TOKEN_FILE` / `VAULT_K8S_ROLE` | Where Vault is and how to authenticate: a token, a mounted token file, or a Kubernetes service-account login (`VAULT_K8S_MOUNT`, default `kubernetes`) |
| `VAULT_NAMESPACE`                                                   | Vault Enterprise namespaces only                                                                                                                       |

**Switching a running deployment to Vault**, which is a rotation and not a
cutover:

1. Create a transit key in Vault (`vault secrets enable transit`,
   `vault write -f transit/keys/agentswarms`) and a policy that allows
   `encrypt`, `decrypt` and `read` on it for the token or role the app will use.
2. Set `KMS_KEY_REF=transit/keys/agentswarms` and the `VAULT_*` variables,
   leave `KMS_PROVIDER` unset, restart. **Admin → IAM → Settings → Credential
   encryption key** now shows Vault, its probe result, and **Create a data key
   in Vault Transit**.
3. Create the data key. Thirty-two random bytes are generated, wrapped by the
   transit key, proven to unwrap to the same bytes, and only then stored in
   `encryption_keys` with a fingerprint. Nothing is re-encrypted yet and the
   current key does not change.
4. Set `KMS_PROVIDER=vault` and restart. The process unwraps the data key
   once, on the way up, and **refuses to start** if it cannot — with the
   provider, key reference and fingerprint in the message. From now on
   everything new is written under the data key; everything old still reads,
   because `PROVIDER_CREDS_SECRET` stays in the keyring for decryption.
5. Run **Re-encrypt to current key**. When nothing is left on the env key,
   `PROVIDER_CREDS_SECRET` can be removed.

Rotating the data key later is the same button, now labelled **Rotate**: the
previous data key is retired, stays accepted for reading, and the sweep moves
the rows. Vault Transit's own key rotation (`vault write -f
transit/keys/<name>/rotate`) is transparent — Vault decrypts older versions of
its key, and the stored material names the version it was wrapped with.

What the readiness probe and the boot check do: `/api/health/ready` reports
`checks.keys` — whether the keyring loaded — beside the database, so a pod
without its KMS permission is held out of rotation; `server.mjs` calls it
before taking traffic under an external provider and exits when it says no.
No KMS call is on the request path: the unwrap happens once and is cached;
Vault being unreachable while the process runs changes nothing until the next
restart, exactly as the failure-mode table below asks.

The open questions at the end are answered: the wrapped data key lives in a
database row (replicas share it, it backs up with the data, and a dump without
the provider's permission opens nothing); there is one data key per instance;
`probe()` runs when the settings card is opened, not on a timer.

## AWS KMS

`KMS_PROVIDER=aws` keeps the key-encrypting key in AWS KMS. The data key is
made by AWS KMS itself (`GenerateDataKey`, AES-256), so its bytes come from
the KMS HSMs, or from your CloudHSM cluster when the key lives in a custom key
store. It is stored wrapped and unwrapped once per process start with
`Decrypt`. There is no AWS SDK: the JSON API is signed with SigV4 by
`src/utils/aws/sigv4.ts`, which is checked against the published AWS SigV4
test suite.

| Variable                                    | Meaning                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KMS_KEY_REF`                               | The key: `arn:aws:kms:<region>:<account>:key/<id>` (preferred), an alias ARN, `alias/<name>`, or a key id. AWS-managed aliases (`alias/aws/…`) are refused: only their own service can use them |
| `AWS_REGION` / `AWS_DEFAULT_REGION`         | The key's region, when `KMS_KEY_REF` is not an ARN. An ARN's region wins                                                                                                                        |
| `AWS_USE_FIPS_ENDPOINT`                     | `true`: call `kms-fips.<region>.amazonaws.com`                                                                                                                                                  |
| `AWS_ENDPOINT_URL_KMS` / `AWS_ENDPOINT_URL` | An endpoint of your own: a VPC endpoint's DNS name, or an emulator. An origin only (scheme, host, port)                                                                                         |
| `AWS_ENDPOINT_URL_STS`                      | The STS endpoint for web identity, e.g. its VPC endpoint. Default: `sts.<region>.amazonaws.com`                                                                                                 |
| `KMS_REQUIRE_PRIVATE`                       | `true`: every KMS and STS call must take a private network path ([below](#over-a-private-path))                                                                                                 |
| the credential variables                    | The app's own AWS identity, [below](#the-apps-aws-identity)                                                                                                                                     |

**Switching to AWS KMS** is the same rotation as for Vault:

1. Create a symmetric encryption key (`SYMMETRIC_DEFAULT`, `ENCRYPT_DECRYPT`)
   and give the app's role `kms:GenerateDataKey`, `kms:Decrypt` and
   `kms:DescribeKey` on it, in both the role's policy and the key policy. Every
   call carries the encryption context
   `agentswarms:purpose=credential-data-key`, so the key policy can allow this
   use and nothing else:

   ```json
   {
     "Sid": "AgentSwarmsCredentialKey",
     "Effect": "Allow",
     "Principal": { "AWS": "arn:aws:iam::111122223333:role/agentswarms" },
     "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
     "Resource": "*",
     "Condition": {
       "StringEquals": { "kms:EncryptionContext:agentswarms:purpose": "credential-data-key" }
     }
   }
   ```

   Add a second statement for `kms:DescribeKey`, without the condition:
   `DescribeKey` takes no encryption context, and the settings card uses it.

2. Set `KMS_KEY_REF` to the key's ARN, give the app its identity, leave
   `KMS_PROVIDER` unset and restart. **Admin → IAM → Settings → Credential
   encryption key** shows AWS KMS with what `DescribeKey` returned: the key,
   its state, where the key material is kept, the endpoint and its network
   path, and the identity the app signs as. **Create a data key in AWS KMS**
   is enabled only when the key is enabled and is a symmetric encryption key.
3. Create the data key. AWS KMS generates it and returns it plain and wrapped.
   The app unwraps the wrapped copy and compares the bytes, and only then
   stores it. A role that may generate but not decrypt stores nothing.
4. Set `KMS_PROVIDER=aws`, restart, and run **Re-encrypt to current key**, as
   for Vault.

`Decrypt` names the key it expects: the stored data key row's own key
reference. A wrapped data key from any other KMS key is refused by AWS
(`IncorrectKeyException`), and so is one wrapped under another encryption
context (`InvalidCiphertextException`). A database row an attacker rewrote
cannot point the app at their own key.

**Rotation.** AWS KMS automatic key rotation is transparent: the key ARN
stays the same and AWS decrypts under the older key material. To move to a
different KMS key, point `KMS_KEY_REF` at it, restart and use **Rotate the
data key in AWS KMS**. The retired data key keeps decrypting under its own key
reference, in the same region, for as long as the role may still use that
key. Prefer key ARNs to
aliases: an alias moved to another key no longer decrypts what the old key
wrapped.

**HSMs.** The AWS KMS HSMs are FIPS 140-3 validated. For keys in hardware you
operate, create the KMS key in a **CloudHSM custom key store**, or in an
**external key store** (XKS) in front of your own HSM. The app needs nothing
different: the card shows "kept in your AWS CloudHSM cluster (custom key store
cks-…)" or "kept in your external key manager, through an XKS proxy".

### The app's AWS identity

The credentials the app signs with when it calls AWS as itself
(`src/utils/aws/credentials.server.ts`). A connection a user configures carries
its own keys and is not affected. The order is the AWS SDKs' order, and the
first source whose variables are set is the source. If that source fails, the
call fails: it never falls through to another identity.

| Source           | Variables                                                                                                                       | Typical deployment                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Keys             | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optionally `AWS_SESSION_TOKEN`                                                    | Outside AWS; prefer a role where there is one        |
| Web identity     | `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, optionally `AWS_ROLE_SESSION_NAME` (default `agentswarms-kms`)                   | EKS with IRSA, or any OIDC federation to an IAM role |
| Container        | `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, or `AWS_CONTAINER_CREDENTIALS_FULL_URI` with `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | ECS task role; EKS Pod Identity                      |
| Instance profile | none; `AWS_EC2_METADATA_DISABLED=true` turns it off, `AWS_EC2_METADATA_SERVICE_ENDPOINT` / `_MODE` move it                      | EC2                                                  |

- **Web identity** exchanges the token at STS (`AssumeRoleWithWebIdentity`,
  an unsigned call) and reads the token file again at every exchange, because
  the kubelet rotates it. On EKS, give the web Deployment in
  `deploy/k8s/app/agentswarms.yaml` a ServiceAccount annotated with
  `eks.amazonaws.com/role-arn`: the EKS webhook mounts the token and sets both
  variables. `automountServiceAccountToken: false` stays, because the AWS
  token is a volume of its own.
- **Container credentials** over http go only to the loopback or the ECS / EKS
  Pod Identity agent addresses; any other host must be https. The
  authorization token is read from its file every time.
- **Instance profile** uses IMDSv2 only, a session token first. There is no
  fall-back to IMDSv1, whose plain GET requests are what an SSRF against an
  instance reaches. In a container on EC2, the instance's hop limit must allow
  the token response to reach the container (2).
- Credentials are cached until five minutes before they expire.
- The metadata endpoints are link-local addresses that the SSRF guard refuses
  for every other caller. The credential chain reaches them only at fixed
  URLs, or ones you set, through a direct connection that never uses the
  proxy and never follows a redirect.
- Not read: the shared `~/.aws/config` and `credentials` files, profiles, and
  SSO. Give the container a role or the variables.

### Over a private path

The KMS and STS calls go the way every outbound call from the app goes: the
SSRF guard's always-blocked tier, and the proxy (`HTTPS_PROXY`, bypassed per
host by `NO_PROXY`). With an interface VPC endpoint for KMS and private DNS,
`kms.<region>.amazonaws.com` resolves to the endpoint's private addresses
without any change. `KMS_REQUIRE_PRIVATE=true` makes that a rule, like a model
provider's **Require a private network path**: a call that would go directly
to a public address is refused before anything is sent, and audited as
`security.kms.private_path.refused`. A call through the proxy counts as the
egress you chose. The STS exchange that web identity makes is held to the
same rule. The rule refuses at boot too, so a process whose KMS is not
reached privately does not start. Vault calls go straight to `VAULT_ADDR` and
are not covered.

**Testing without an AWS account.** `tests/integration/awsKmsEmulator.test.ts`
drives the real provider against an emulator over HTTP; the comment at its top
gives the commands. LocalStack's community image does not check signatures.
The signer is proved by the AWS test suite instead.

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
// src/utils/kms/types.ts   (shipped)
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
3. **Add AWS (done), then Azure, GCP, OCI**, each behind the same interface,
   each with an integration test that is skipped when its emulator or
   credentials are absent.
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
