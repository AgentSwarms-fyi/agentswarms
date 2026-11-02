# Key management and external KMS

**Status: envelope encryption is built, with six providers.** `env` (the
default) derives the key from `PROVIDER_CREDS_SECRET` exactly as before,
`vault` keeps the key-encrypting key in HashiCorp Vault Transit, `aws` in AWS
KMS ([below](#aws-kms)), `azure` in Azure Key Vault or an Azure Managed HSM
([below](#azure-key-vault)), and `gcp` in Google Cloud KMS
([below](#google-cloud-kms)), and `oci` in OCI Vault ([below](#oci-vault)).
Under that key, every user's credentials are under their own key, and a
**customer key**, held by the app or in a customer's own KMS, can wrap the
keys of the users and groups assigned to it
([below](#customer-keys-and-user-keys)). Encrypting the data beyond
credentials is [designed](#data-beyond-credentials-design), not built.

For what exists now — AES-256-GCM, key fingerprints, and the rotation sweep —
see [SECURITY.md](../SECURITY.md#credential-encryption).

## What exists

| Variable                                                            | Meaning                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KMS_PROVIDER`                                                      | `env` (default), `vault`, `aws`, `azure`, `gcp` or `oci`                                                                                                                                                                                                                                                                |
| `KMS_KEY_REF`                                                       | The provider's reference for the key-encrypting key. Vault: `transit/keys/<name>`. AWS KMS: a key ARN, an alias ARN, `alias/<name>` or a key id. Azure: the key identifier, `https://<vault>.vault.azure.net/keys/<name>`. Cloud KMS: the key's resource name, `projects/…/cryptoKeys/<key>`. OCI Vault: the key's OCID |
| `VAULT_ADDR`, `VAULT_TOKEN` / `VAULT_TOKEN_FILE` / `VAULT_K8S_ROLE` | Where Vault is and how to authenticate: a token, a mounted token file, or a Kubernetes service-account login (`VAULT_K8S_MOUNT`, default `kubernetes`)                                                                                                                                                                  |
| `VAULT_NAMESPACE`                                                   | Vault Enterprise namespaces only                                                                                                                                                                                                                                                                                        |

**Switching a running deployment to Vault**, which is a rotation and not a
cutover (from `env`; from another external provider it is a re-key, see
[Changing key providers](#changing-key-providers)):

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
under an external provider before a process binds the port, and a process
whose keyring does not load exits with code 78 (EX_CONFIG, from sysexits.h). When no worker
has come up yet, the whole server stops with that code, so Docker shows the
container as exited and Kubernetes as `CrashLoopBackOff`, and their restart
back-off applies. A replacement worker that meets a KMS outage while the
others serve does not take them down: it waits and tries again, from one
second up to a minute.
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
`security.kms.private_path.refused`, with `system:kms` as the actor. A call through the proxy counts as the
egress you chose. The STS exchange that web identity makes is held to the
same rule. The rule refuses at boot too, so a process whose KMS is not
reached privately does not start. Vault calls go straight to `VAULT_ADDR` and
are not covered.

**Testing without an AWS account.** `tests/integration/awsKmsEmulator.test.ts`
drives the real provider against an emulator over HTTP; the comment at its top
gives the commands. LocalStack's community image does not check signatures.
The signer is proved by the AWS test suite instead.

## Azure Key Vault

`KMS_PROVIDER=azure` keeps the key-encrypting key in Azure Key Vault, or in an
Azure Managed HSM. Key Vault has no data-key operation, so the data key is 32
random bytes the app makes, wrapped with `wrapKey` and stored only after
`unwrapKey` has given back the same bytes. An RSA key wraps with
RSA-OAEP-256: a Standard vault keeps RSA keys in software, a Premium vault
keeps `RSA-HSM` keys in its HSMs. A Managed HSM keeps the key in your own
single-tenant HSM pool, and its AES keys (`oct-HSM`) wrap with A256KW, AES key
wrap. There is no Azure SDK: the Key Vault REST API (version 7.4) with a
Microsoft Entra ID token.

| Variable               | Meaning                                                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KMS_KEY_REF`          | The key identifier, as the portal shows it: `https://<vault>.vault.azure.net/keys/<name>`, or a Managed HSM's `https://<pool>.managedhsm.azure.net/keys/<name>`. The Azure China and Azure Government domains are accepted, and no other host. Without a version, the key's current version wraps; a version pins it |
| `KMS_REQUIRE_PRIVATE`  | `true`: every Key Vault call must take a private network path ([below](#over-a-private-endpoint))                                                                                                                                                                                                                    |
| `AZURE_AUTHORITY_HOST` | The Entra ID authority for a sovereign cloud, e.g. `https://login.microsoftonline.us`. Default `https://login.microsoftonline.com`                                                                                                                                                                                   |
| the identity variables | The app's own Entra ID identity, [below](#the-apps-entra-id-identity)                                                                                                                                                                                                                                                |

**Switching to Azure Key Vault** is the same rotation as for Vault:

1. Create the key with the permitted operations `wrapKey` and `unwrapKey`: RSA
   3072 in a vault (`RSA-HSM` in a Premium vault, for a key in HSMs), or an
   `RSA-HSM` or AES-256 key in a Managed HSM. **Turn on purge protection**: a
   purged key takes every credential it wraps with it, and the settings card
   warns while it is off. Give the app's identity the **Key Vault Crypto
   Service Encryption User** role on the key (it allows `get`, `wrapKey` and
   `unwrapKey`), or, in a vault on the access-policy model, an access policy
   with the key permissions Get, Wrap Key and Unwrap Key. In a Managed HSM,
   the local role **Managed HSM Crypto Service Encryption User**, scoped to
   the key.
2. Set `KMS_KEY_REF` to the key identifier, give the app its identity, leave
   `KMS_PROVIDER` unset and restart. **Admin → IAM → Settings → Credential
   encryption key** shows the key's version, what protects it, its recovery
   level, the endpoint and its network path, and who the app signs in as.
   **Create a data key in Azure Key Vault** is enabled only for an enabled key
   that may wrap and unwrap, within its activation and expiry dates.
3. Create the data key.
4. Set `KMS_PROVIDER=azure`, restart, and run **Re-encrypt to current key**.

The stored data key names the **key version** that wrapped it, and unwrap asks
that version. Rotating the key in Key Vault (a new version, by hand or by a
rotation policy) changes nothing for data keys already stored, as long as the
older versions stay enabled; **Rotate the data key** wraps a new one with the
current version. Unwrap refuses a stored data key whose key identifier is not
a version of the row's own key, before anything is sent: a database row an
attacker rewrote cannot point the app at another vault.

### The app's Entra ID identity

The token the app presents when it calls Azure as itself
(`src/utils/azure/credentials.server.ts`). The order is
`DefaultAzureCredential`'s, and the first source whose variables are set is
the source. If that source fails, the call fails: it never falls through to
another identity.

| Source             | Variables                                                                                                                            | Typical deployment                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Client secret      | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`                                                                          | Outside Azure; prefer a certificate or an identity |
| Client certificate | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH`, optionally `AZURE_CLIENT_CERTIFICATE_PASSWORD`                | Outside Azure                                      |
| Workload identity  | `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`                                                                   | AKS workload identity, or any federated credential |
| Managed identity   | none; `AZURE_CLIENT_ID` picks a user-assigned identity. App Service and Container Apps set `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` | VMs, scale sets, App Service, Container Apps       |

- **A certificate** is a PEM holding the private key and the certificate (from
  a `.pfx`: `openssl pkcs12 -in app.pfx -out app.pem -nodes`). The app signs
  an assertion with it (RS256, the certificate's SHA-1 thumbprint as `x5t`),
  checks first that the key belongs to the certificate, and reads the file
  again at every exchange, so a renewed certificate is picked up.
- **Workload identity** reads the projected token again at every exchange,
  because the kubelet rotates it. On AKS, give the web Deployment in
  `deploy/k8s/app/agentswarms.yaml` a ServiceAccount annotated with
  `azure.workload.identity/client-id` and the pod label
  `azure.workload.identity/use: "true"`: the webhook mounts the token and
  sets the variables. `automountServiceAccountToken: false` stays.
- **Managed identity** asks the instance metadata service
  (`169.254.169.254`), or App Service's loopback endpoint, directly: never
  through the proxy and never following a redirect, the same kind of client
  the AWS chain uses. An `IDENTITY_ENDPOINT` over plain http may only be the
  loopback or a link-local address. `AZURE_POD_IDENTITY_AUTHORITY_HOST` moves
  the metadata service (an emulator, a pod identity proxy).
- Tokens are cached until five minutes before they expire.
- Not read: the Azure CLI's or an IDE's sign-in, Azure Arc and Service Fabric
  managed identity.

### Over a private endpoint

Key Vault calls go the way every outbound call goes: the SSRF guard's
always-blocked tier, and the proxy. With a private endpoint for the vault and
the `privatelink.vaultcore.azure.net` zone (`privatelink.managedhsm.azure.net`
for a Managed HSM) linked to the app's network, the vault's own name resolves
to the private endpoint, with no change to `KMS_KEY_REF`.
`KMS_REQUIRE_PRIVATE=true` makes that a rule: a Key Vault call that would go
directly to a public address is refused before anything is sent, audited as
`security.kms.private_path.refused` with `system:kms` as the actor, and the
process refuses to start on it. **The Entra ID sign-in is not covered:**
Entra ID offers no private endpoint, so a client secret, certificate or
workload identity exchange goes to `AZURE_AUTHORITY_HOST` directly or through
`HTTPS_PROXY`. It carries the app's credential, never key material. A managed
identity's token comes from the metadata endpoint on the host and never
leaves it.

**Testing without an Azure account.**
`tests/integration/azureKeyVaultEmulator.test.ts` drives the real provider
against lowkey-vault, whose managed identity token endpoint stands in for the
metadata service, over TLS under a real `*.vault.azure.net` name; the comment
at its top gives the commands. lowkey-vault wraps with RSA keys only, so AES
key wrap (Managed HSM) is covered by the unit tests.

## Google Cloud KMS

`KMS_PROVIDER=gcp` keeps the key-encrypting key in Cloud KMS: a symmetric key
in software, in Cloud HSM, or in an external key manager through Cloud EKM.
The data key is 32 random bytes the app makes, encrypted with the key's
primary version and stored only after a decrypt has given back the same
bytes. There is no Google SDK: the Cloud KMS REST API (v1) with an OAuth token
for the `cloudkms` scope.

Every byte string carries its CRC-32C both ways, as Google asks: the request
names the checksum of its plaintext (or ciphertext) and of its additional
authenticated data, the answer must say the service verified them, and the
checksum of what comes back is checked before it is used. An answer that fails
any of these is discarded and nothing is stored. Every encrypt and decrypt
carries the same additional authenticated data,
`agentswarms:credential-data-key`, so a ciphertext made with the same key for
anything else does not decrypt as a data key.

| Variable               | Meaning                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KMS_KEY_REF`          | The key's resource name, as the console's "Copy resource name" gives it: `projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>` (or the same after `//cloudkms.googleapis.com/`). A key **version** is refused: decrypt finds the version from the ciphertext, and encrypt uses the primary, so rotation works  |
| `GCP_KMS_ENDPOINT`     | Where the calls go instead of `https://cloudkms.googleapis.com`: a regional endpoint (`https://cloudkms.<location>.rep.googleapis.com`), a Private Service Connect endpoint (`https://cloudkms-<endpoint>.p.googleapis.com`, whose token is then fetched from `oauth2-<endpoint>.p.googleapis.com`), or an emulator. An origin only |
| `KMS_REQUIRE_PRIVATE`  | `true`: every Cloud KMS call must take a private network path ([below](#over-private-service-connect))                                                                                                                                                                                                                              |
| the identity variables | The app's own Google identity, [below](#the-apps-google-identity)                                                                                                                                                                                                                                                                   |

**Switching to Cloud KMS** is the same rotation as for Vault:

1. Create a key ring in the location your data lives in, and a key with the
   purpose **Symmetric encrypt/decrypt**: protection level Software, HSM (Cloud
   HSM) or External (Cloud EKM). Give it a **rotation period**: the settings
   card says when there is none. Grant the app's identity **Cloud KMS
   CryptoKey Encrypter/Decrypter** (`roles/cloudkms.cryptoKeyEncrypterDecrypter`)
   on the key, not the project. Add **Cloud KMS Viewer** on the key if you want
   the card to show its protection level, primary version and rotation; the
   app does not need it.
2. Set `KMS_KEY_REF` to the key's resource name, give the app its identity,
   leave `KMS_PROVIDER` unset and restart. **Admin → IAM → Settings →
   Credential encryption key** shows the endpoint and its network path, who
   the app signs in as, and, when it may read them, the key's protection
   level, primary version, rotation and how long a version scheduled for
   destruction can be restored. Opening the card proves the permission with a
   test encrypt and decrypt of 32 random bytes; **Create a data key in Cloud
   KMS** is enabled only when that works and the primary version is enabled.
3. Create the data key.
4. Set `KMS_PROVIDER=gcp`, restart, and run **Re-encrypt to current key**.

The stored data key names the **version** that encrypted it, checked to be a
version of the row's own key before anything is sent, and decrypt is asked at
the row's own key: Cloud KMS refuses a ciphertext from any other key. Rotation
in Cloud KMS (a new primary version, on the key's schedule or by hand) changes
nothing for data keys already stored as long as their versions stay enabled;
**Rotate the data key** encrypts a new one with the new primary. A version
scheduled for destruction can be restored until its destruction date (the
key's `destroyScheduledDuration`, 30 days by default); after that, every
credential under a data key it encrypted is gone.

### The app's Google identity

The token the app presents when it calls Google Cloud as itself
(`src/utils/google/credentials.server.ts`): Application Default Credentials,
as Google's libraries find them, without gcloud's file in the home directory.
If `GOOGLE_APPLICATION_CREDENTIALS` is set, that file is the source, and if it
fails the call fails: it never falls through to the metadata server.

| Source                       | Set                                                                      | Typical deployment                                                                         |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| The metadata server          | nothing                                                                  | Compute Engine, GKE with Workload Identity Federation for GKE, Cloud Run, Cloud Functions  |
| Workload identity federation | `GOOGLE_APPLICATION_CREDENTIALS`: an `external_account` file             | EKS, AKS, any cluster with an OIDC issuer, a CI's OIDC token: no key leaves Google         |
| A service account key        | `GOOGLE_APPLICATION_CREDENTIALS`: a `service_account` key file           | Outside Google Cloud when federation is not possible; prefer federation                    |
| Impersonation                | `GOOGLE_APPLICATION_CREDENTIALS`: an `impersonated_service_account` file | A key or user credential acting as the service account that holds the KMS role             |
| User credentials             | `GOOGLE_APPLICATION_CREDENTIALS`: an `authorized_user` file              | Development only (`gcloud auth application-default login`); its `quota_project_id` is sent |

- **The metadata server** is asked directly at `169.254.169.254` (or
  `GCE_METADATA_HOST`), never through the proxy and never following a
  redirect, and an answer without `Metadata-Flavor: Google` is refused.
- **Workload identity federation** reads the other identity provider's token
  from a file (read again at every exchange, because platforms rotate it) or a
  URL (`credential_source.url`, with its headers and a JSON field; a
  link-local or loopback URL is fetched directly, anything else through the
  guarded fetch), exchanges it at Google's Security Token Service and, with
  `service_account_impersonation_url`, for the service account's token. The
  `aws` and `executable` credential sources are not read: on AWS, use the
  pod's or instance's OIDC token file.
- **A service account key** signs an RS256 assertion (its `private_key_id`
  as `kid`) and is read again at every exchange, so a replaced key file is
  picked up.
- Tokens are cached until five minutes before they expire.

### Over Private Service Connect

Cloud KMS calls go the way every outbound call goes: the SSRF guard's
always-blocked tier, and the proxy. With a Private Service Connect endpoint
for Google APIs, either set `GCP_KMS_ENDPOINT` to the endpoint's
`cloudkms-<endpoint>.p.googleapis.com` name, or give `cloudkms.googleapis.com`
the endpoint's address in a private DNS zone. `KMS_REQUIRE_PRIVATE=true` makes
that a rule: a Cloud KMS call that would go directly to a public address is
refused before anything is sent, audited as `security.kms.private_path.refused`
with `system:kms` as the actor, and the process refuses to start on it. The
`private.googleapis.com` and `restricted.googleapis.com` ranges are public
addresses routed privately, so the rule refuses them: use a PSC endpoint,
whose address is your VPC's own. **The token request is not covered:** it
goes to the key file's `token_uri` (or `oauth2-<endpoint>.p.googleapis.com`
with a PSC endpoint), to STS and to iamcredentials as configured, directly or
through `HTTPS_PROXY`, and carries the app's credential, never key material.
A metadata server token never leaves the host.

**Testing without a Google Cloud account.**
`tests/integration/gcpKmsEmulator.test.ts` drives the real provider and the
real service account sign-in against floci-gcp (pinned by digest), whose
token endpoint accepts the key's assertion; the comment at its top gives the
commands and what the emulator does differently. Federation, impersonation,
the metadata server and the IAM errors are covered by the unit tests.

## OCI Vault

`KMS_PROVIDER=oci` keeps the key-encrypting key in OCI Vault: an AES master
encryption key, HSM-protected, software-protected, or held in your own key
manager through OCI External KMS. The data key is 32 random bytes the app
makes, encrypted with the key's current version and stored only after a
decrypt has given back the same bytes. There is no Oracle SDK: the Vault
crypto API (`20180608`) at the vault's own cryptographic endpoint, every
request signed by the app's identity with OCI's request signature
(`src/utils/oci/signer.ts`, proved against the OCI Go SDK's test vectors).

Every encrypt and decrypt carries the same associated data,
`{"purpose": "agentswarms:credential-data-key"}`, which Vault binds into its
AES-GCM, so a ciphertext made with the same key for anything else does not
decrypt as a data key. An answer that names another key, or a decrypt that
names another version than the stored data key's, is not used. The decrypt
answer's `plaintextChecksum` is not relied on: OCI does not document how it
is computed, and the keyring already refuses an unwrapped key whose
fingerprint is not the stored one.

| Variable                      | Meaning                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KMS_KEY_REF`                 | The key's OCID, from the key's details page: `ocid1.key.oc1.<region>.<vault>.<id>`. A key **version** OCID is refused: decrypt finds the version from the ciphertext, and encrypt uses the current one, so rotation works |
| `OCI_KMS_CRYPTO_ENDPOINT`     | Required. The vault's **Cryptographic Endpoint**, from the vault's details page: `https://<vault>-crypto.kms.<region>.oraclecloud.com`, or a private name for it, or an emulator. An origin only                          |
| `OCI_KMS_MANAGEMENT_ENDPOINT` | The vault's **Management Endpoint**, only for the key's details on the settings card. Taken from the crypto endpoint when that is Oracle's name (`-crypto.` becomes `-management.`)                                       |
| `KMS_REQUIRE_PRIVATE`         | `true`: every Vault call must take a private network path ([below](#over-a-private-address))                                                                                                                              |
| the identity variables        | The app's own OCI identity, [below](#the-apps-oci-identity)                                                                                                                                                               |

**Switching to OCI Vault** is the same rotation as for Vault:

1. In a vault (a **virtual private vault** if you want its own HSM
   partition), create a master encryption key with the shape **AES 256**,
   protection mode HSM, Software, or External. Turn on **auto-rotation** for
   it if your vault offers it: the settings card says when nothing rotates the
   key. Let the app's identity use that key and nothing else, for an instance
   principal through a dynamic group:
   `Allow dynamic-group <group> to use keys in compartment <compartment> where target.key.id = '<key OCID>'`
   (a group, for an API key's user). `read keys` lets the card show the key's
   protection mode, shape, current version and rotation; the app does not need
   it.
2. Set `KMS_KEY_REF` to the key's OCID and `OCI_KMS_CRYPTO_ENDPOINT` to its
   vault's cryptographic endpoint, give the app its identity, leave
   `KMS_PROVIDER` unset and restart. **Admin → IAM → Settings → Credential
   encryption key** shows the endpoint and its network path, who the app
   signs in as, and, when it may read them, the key's protection mode, shape,
   current version and rotation. Opening the card proves the permission with
   a test encrypt and decrypt of 32 random bytes; **Create a data key in OCI
   Vault** is enabled only when that works and the key is enabled.
3. Create the data key.
4. Set `KMS_PROVIDER=oci`, restart, and run **Re-encrypt to current key**.

The stored data key names the **version** that encrypted it, and decrypt is
asked at the row's own key and that version: Vault refuses a ciphertext from
any other key. Rotation in Vault (a new current version, on a schedule or by
hand) changes nothing for data keys already stored; **Rotate the data key**
encrypts a new one with the new version. A vault's keys are reached only at
that vault's endpoint, so a data key made with a key in another vault is
refused before anything is sent, saying which vault. **Deleting** a key in
OCI is scheduled 7 to 30 days ahead and can be cancelled until then; after
that, every credential under a data key it encrypted is gone.

### The app's OCI identity

The key the app signs a request with when it calls OCI as itself
(`src/utils/oci/credentials.server.ts`). `OCI_AUTH` names the source;
otherwise the first that is configured, in this order. A chosen source that
fails is the error: it never falls through to another.

| Source                | Set                                                                                                    | Typical deployment                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| An API key            | `OCI_CONFIG_FILE`: the config file `oci setup config` writes (profile `OCI_CONFIG_PROFILE`, `DEFAULT`) | Outside OCI, or anywhere a principal is not possible      |
| A resource principal  | `OCI_RESOURCE_PRINCIPAL_VERSION=2.2` and the session token and key OCI provides                        | OCI Functions, Container Instances and services like them |
| An instance principal | nothing (`OCI_AUTH=instance_principal` to say so)                                                      | A compute instance or an OKE node in a dynamic group      |

- **An API key** is the profile's `user`, `fingerprint`, `key_file` (read
  beside the config file when relative; `pass_phrase` when it is encrypted)
  and `tenancy`; a profile takes `DEFAULT`'s values unless it sets its own.
  The key is checked against the fingerprint, so a key file and a fingerprint
  from two different keys are reported as that, not as OCI's bare
  `NotAuthenticated`. The files are read again every 15 minutes, so a
  replaced key is used.
- **A resource principal** (version 2.2) is `OCI_RESOURCE_PRINCIPAL_RPST`
  and `OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM`, each the value or an absolute
  path to a file the platform keeps fresh; the token is read again five
  minutes before it expires.
- **An instance principal** asks the instance metadata service (directly at
  `169.254.169.254/opc/v2`, or `OCI_METADATA_BASE_URL`, with
  `Authorization: Bearer Oracle`, never through the proxy) for the region and
  realm, the instance's certificate, its key and the intermediate
  certificate, then exchanges them at the region's identity service,
  `https://auth.<region>.<realm domain>/v1/x509` (or
  `OCI_FEDERATION_ENDPOINT`), for a session token bound to a key pair made in
  the process. The token is renewed five minutes before it expires.
- **Not supported**, refused by name: OKE workload identity (on OKE, use the
  node pool's instance principal, or an API key) and session tokens from
  `oci session authenticate`.

### Over a private address

Vault calls go the way every outbound call goes: the SSRF guard's
always-blocked tier, and the proxy. `KMS_REQUIRE_PRIVATE=true` makes a
private path a rule: a Vault call that would go directly to a public address
is refused before anything is sent, audited as
`security.kms.private_path.refused` with `system:kms` as the actor, and the
process refuses to start on it. A **service gateway** keeps traffic to OCI
services on Oracle's network, but the vault's endpoint addresses stay public,
so the rule refuses them: reach the vault through a **Private Service
Access** endpoint where your region offers one for OCI Vault (its private DNS
answers the vault's endpoint name with the endpoint's address in your
subnet), or through `HTTPS_PROXY`. **The identity call is not covered:** an
instance principal's exchange at the identity service carries the instance's
certificate, never key material, and goes directly or through `HTTPS_PROXY`.

**Testing without an OCI account.** `tests/integration/ociKmsEmulator.test.ts`
drives the real provider and a real API key against floci-oci (pinned by
digest, signatures required); the comment at its top gives the commands and
what the emulator does differently: it does not verify signatures or apply
the associated data. Request signing is proved against the OCI Go SDK's own
vectors, and the instance and resource principals, the associated data and
the errors are covered by the unit tests.

## Changing key providers

Three different changes, in the order they are usually needed.

**Rotating within a provider.** The common one, and transparent. AWS KMS
automatic rotation, a new Key Vault key version, a new Cloud KMS primary
version and `vault write -f transit/keys/<name>/rotate` change nothing for the app: the provider unwraps
what its older key material wrapped. To move to a different key in the same
provider, point `KMS_KEY_REF` at it, restart, use **Rotate the data key**, and
run **Re-encrypt to current key**.

**Moving the app to another cloud, keeping the key.** Usually the right answer
when the deployment moves, say from AWS to Azure: the key-encrypting key does
not have to move with the workload. The app keeps calling the key provider it
uses today, as its own identity, from wherever it now runs:

- **AWS KMS from AKS, GKE or any cluster with an OIDC issuer:** create an IAM
  OIDC identity provider for the cluster's issuer and a role that trusts it
  for the app's service account, mount a projected service account token with
  the audience `sts.amazonaws.com`, and set `AWS_WEB_IDENTITY_TOKEN_FILE` and
  `AWS_ROLE_ARN` (the web identity source above).
- **Azure Key Vault from EKS, GKE or any cluster with an OIDC issuer:** add a
  federated identity credential to the app registration or user-assigned
  identity, trusting the cluster's issuer and the service account, mount a
  projected token with the audience `api://AzureADTokenExchange`, and set
  `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` (the
  workload identity source above).
- **Cloud KMS from EKS, AKS or any cluster with an OIDC issuer:** create a
  workload identity pool and provider trusting the cluster's issuer, let the
  pool's principal for the app's service account impersonate the service
  account that holds the KMS role, mount a projected token with the
  provider's audience, and point `GOOGLE_APPLICATION_CREDENTIALS` at the
  `external_account` file `gcloud iam workload-identity-pools
create-cred-config` writes (workload identity federation, above).
- **Vault Transit:** anywhere `VAULT_ADDR` is reachable.

Nothing is re-encrypted and no data key changes. The key provider calls then
cross clouds: to its public endpoint (`KMS_REQUIRE_PRIVATE` refuses that),
through `HTTPS_PROXY`, or over a private interconnect whose DNS gives the
provider's name a private address. There is one unwrap per process start and
no key provider call on the request path, so the distance costs nothing while
the app runs.

**Moving the key to another provider.** From `env` to a provider this is the
rotation described above, because `PROVIDER_CREDS_SECRET` stays readable
until the sweep has moved every value. **Between two external providers it is
a re-key, not a rotation, in this release.** The keyring holds one
provider's data keys at a time, so values on the old provider's data key do
not decrypt under the new one, and a sweep cannot move them. Plan it:

1. Note what is stored. **Admin → IAM → Settings → Credential encryption
   key** counts the values; they are model provider keys, warehouse
   connections, stored secrets, integrations, Data Catalog sources, Git
   export, knowledge base sources and MCP servers.
2. Restart with `KMS_PROVIDER` unset, `KMS_KEY_REF` set to the new key and
   the new provider's identity, and create the data key there. The old
   provider's data key is kept, not retired: the card lists it as "Also
   kept", read only with its own `KMS_PROVIDER`. Until the next step, values
   on it do not decrypt.
3. Set `KMS_PROVIDER` to the new provider and restart. The card counts the
   values "on a key this server does not hold" and names that key.
4. Enter each of those credentials again (every save writes it under the new
   data key) until the count is 0, then run **Re-encrypt to current key** for
   whatever is left on the `env` key.
5. Only then disable the old provider's key. Until the count reaches 0, the
   way back is the old `KMS_PROVIDER` and `KMS_KEY_REF`: its data key was
   kept, so values not yet entered again still read there. Values already
   entered under the new key do not read on the way back.

A provider-to-provider rotation in the app (holding both providers' data keys
while a sweep moves the values) is a possible later change. It is not built,
because moving clouds rarely needs the key to move with it.

## Customer keys and user keys

Every user's stored credentials are under that **user's own key**, and a
**customer key** can wrap the user keys of the users and groups assigned to
it. A customer key is held by the app, or it is a key in the customer's own
KMS, which the customer controls and can revoke.

```
   deployment key (KMS_PROVIDER, or PROVIDER_CREDS_SECRET)      customer's own KMS key
        │ wraps                                                     │ wraps (in their KMS)
        ├──────────▶ customer key, held by the app                  ▼
        │                      │                         customer key, in their KMS
        │                      └──────────┬──────────────────────────┘
        │                                 │ wraps the user keys of its members
        ▼                                 ▼
   user key  ◀────────────────────────────┘
        │ AES-256-GCM
   the user's stored values: model keys, warehouse and SaaS connections,
   secrets, integrations, catalog and knowledge-base sources, Git export,
   MCP servers, Slack workspaces, Teams bots, signed embed viewers
```

What each layer gives you:

- **A user key per user.** It is made at the user's first save, 32 random
  bytes, wrapped (AES-256-GCM, here) by the deployment's current key, or by
  their customer key. Every value the user stores is encrypted under it and
  stamped with its fingerprint. **Erasing** it (Admin → IAM → Settings →
  Customer keys → Erase a user's key) leaves everything they stored
  unreadable at once; their next save makes them a new key. Deleting the
  account deletes the key with it.
- **A customer key per customer.** An admin creates one and assigns IAM
  groups or users to it; every member's user key is then wrapped by it.
  **Destroying** it (the card's **Destroy**, by typing its name) erases every
  user key it wraps, in one database transaction, and removes its
  assignments. A customer who **revokes** their own KMS key (disables it,
  removes the app's grant, or deletes it) stops the app reading what their
  members stored, and nobody else's, within `DATA_KEY_CACHE_SECONDS`.
- **Moving a user** between customers, or out of one, re-wraps that user's
  one key. No value is re-encrypted, so it is instant however much the user
  stored. Assigning or removing a group, or a user, moves everyone it covers
  at once; so does a change to a group's members (Admin → IAM, or SCIM), in
  the background, and the next sweep catches anything that was missed.
- **Rotating the deployment key** re-wraps user keys and the app-held customer
  keys; the values under them are untouched. **Re-encrypt to current key**
  does it, and moves any value still on the deployment key itself onto its
  owner's user key.

The deployment's own keyring does not change: values on it read as before,
the boot check and `/api/health/ready` depend only on it, and no customer's
KMS is on the startup path. A customer whose KMS is down or who revoked their
key affects their members' reads and saves, and nothing else.

**Turning it on.** Apply `supabase/migrations/20261105000000_customer_keys.sql`.
Until then the card says the migration is needed and every value is written
under the deployment's key, as before. Once it is applied, user keys are made
as users save; run **Re-encrypt to current key** once to move what was stored
before onto its owners' keys. Until you do, the credential key card counts
those values as "on the deployment key, not yet on their owner's key" (they
read; nothing is wrong), and the fingerprint it shows is the **deployment
key**'s, the one that wraps every user key.

What each change on the Customer keys card reports, in its toast and in the
audit log (`security.customer_key.create`, `.assign`, `.unassign`,
`.destroy`, `security.user_key.erase`): how many users it covers, how many
user keys it re-wrapped, and how many values it re-encrypted onto an owner's
key (only values still on the deployment key; a move itself re-encrypts
nothing).

### Creating a customer key

| Where the key is          | What it means                                                                                                                                                                                                                                                      | What the customer does                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Held by the app**       | 32 random bytes, wrapped by the deployment's current key and stored. Destroying it in the card erases its members' data.                                                                                                                                           | Nothing: it is the operator's key, kept per customer.                            |
| **In the customer's KMS** | The customer key is wrapped by a key in the customer's own AWS KMS, Azure Key Vault or Managed HSM, Cloud KMS, OCI Vault or Vault Transit; the app unwraps it as its own identity when a member's value is first read, then keeps it for `DATA_KEY_CACHE_SECONDS`. | Grants the app's identity encrypt and decrypt on that key, and can take it away. |

The key reference is the same form as `KMS_KEY_REF`'s, and the provider is
told by its shape. The app calls the customer's key as **its own identity**
(the one [above](#aws-kms) for each provider), with `KMS_REQUIRE_PRIVATE`
applying the same way, so the grant the customer writes names that identity:

| Customer's KMS                | The grant, in the customer's account                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS KMS                       | A key policy statement allowing `kms:GenerateDataKey`, `kms:Decrypt` and `kms:DescribeKey` to the app's role ARN, with the encryption-context condition [above](#aws-kms). Cross-account works: the role also needs those actions on the key's ARN in its own policy.                                                         |
| Azure Key Vault / Managed HSM | **Key Vault Crypto Service Encryption User** on the key (or Get, Wrap Key and Unwrap Key in an access policy; in a Managed HSM, **Managed HSM Crypto Service Encryption User**), to the app's identity. In another Entra tenant, the app registration must be multi-tenant with a service principal in the customer's tenant. |
| Cloud KMS                     | **Cloud KMS CryptoKey Encrypter/Decrypter** (`roles/cloudkms.cryptoKeyEncrypterDecrypter`) on the key, to the app's service account.                                                                                                                                                                                          |
| OCI Vault                     | `use keys` on the key for the app's dynamic group (or user), as [above](#oci-vault); from another tenancy, with the matching `endorse` statement in the app's tenancy and `admit` in the customer's. Also enter the vault's cryptographic endpoint.                                                                           |
| Vault Transit                 | A policy allowing `encrypt` and `decrypt` on `transit/encrypt/<name>` and `transit/decrypt/<name>` to the app's token or role; the same `VAULT_ADDR`.                                                                                                                                                                         |

Creating it proves the round trip before anything is stored (the key is
wrapped, unwrapped, and compared). **Check** unwraps it again past the cache
and, for a KMS key, lists what the provider says about it. The deployment's
own `KMS_KEY_REF` is refused as a customer key: it is the operator's key, not
the customer's; choose **Held by the app** instead.

### Who is under which key

- A user is assigned directly, or through an IAM group. **A direct
  assignment wins** over any group's.
- A user or a group belongs to one customer key at most (the database
  enforces it).
- A user whose groups name two different customer keys is a **conflict**: the
  app does not guess. Nothing new is stored for them, and the save says which
  keys and groups; values they already have stay readable where they are. The
  card lists conflicts; assign the user directly to one key to settle it. An
  assignment that would create a conflict is refused, naming the other key.

### Failure modes

| Situation                                                                                                  | What happens                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The customer's KMS refuses or is down                                                                      | That customer's members' values do not read, and saves for them fail, naming the customer key and the provider's answer. Nobody else is affected; the app keeps serving. Never written under another key instead.    |
| A customer key is destroyed                                                                                | Its user keys are erased with it. Its members' values do not read ("erased on <date>; enter it again"). Their next save is under a new user key, wrapped by the deployment's key unless they are assigned elsewhere. |
| A user key is erased                                                                                       | That user's values do not read; the next save makes a new key.                                                                                                                                                       |
| A user's groups name two keys                                                                              | Nothing new is stored for that user until an admin assigns them directly.                                                                                                                                            |
| The deployment key a user key is wrapped by is gone (`PROVIDER_CREDS_SECRET_OLD` dropped before the sweep) | That user's values do not read, and a save for them is refused rather than make a new key that would orphan them. Put the old secret back, run the sweep, then retire it.                                            |
| A wrapped key's stored form is changed (copied to another row, another key's material)                     | Refused: each wrapped key is bound to its own row and fingerprint.                                                                                                                                                   |
| The migration is not applied                                                                               | Everything is under the deployment's key, as before; the card says so.                                                                                                                                               |

`DATA_KEY_CACHE_SECONDS` (default 300) is how long a process keeps an
unwrapped user key or customer key before reading it again. A key erased,
destroyed or revoked elsewhere stops working in every process within that
long; in the process that erased or destroyed it, at once. With a customer's
KMS that is down, a failed unwrap is not asked again for 15 seconds, so the
KMS is not called on every read. `0` keeps nothing: every read of a member's
value calls their KMS.

### What erasure covers, and what it does not

A key erased or destroyed **in the app** is gone from the live database, but a
database **backup taken before** still holds it, wrapped by the deployment's
key or the customer key that wrapped it, and so does a restore of that
backup. Erasure that reaches backups needs one of:

- the backup to expire under your retention, or
- a customer key in the customer's own KMS, **deleted in that KMS**: every
  backup's copy of its wrapped key is then unreadable too, and so is every
  member's data in every backup. This is the strongest guarantee, and the one
  enterprise customers usually mean by "bring your own key".

Customer keys cover what the app encrypts: stored credentials and secrets.
The data a customer's users work with is not under these keys yet; see the
next section.

## Data beyond credentials (design)

**Status: designed, not built.** The app encrypts credentials itself. The
data a customer's users bring and make is stored in places the app does not
encrypt today: Postgres rows (chat history, knowledge-base documents and
chunks, agent memory, notebooks, BI definitions), the object store
(lakehouse files, uploads, generated documents) and the vector store. Those
rely on the storage's own encryption at rest, under the operator's keys. For
"a customer's data is unreadable once their key is gone" to cover them, each
store needs its own scheme, under the same customer key:

| Data                                         | Where                                                 | Proposed scheme                                                                                                                                                                                                                                                                                              | What it costs                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat messages, agent memory, notebook source | Postgres text and JSON columns                        | Application-level AES-GCM under the owner's user key, as credentials are: a value is encrypted on write and decrypted on read in the server.                                                                                                                                                                 | Postgres can no longer search, sort or index those columns: the chat search and memory recall would move to the server or to the vector store.                                     |
| Knowledge-base documents and chunks          | Postgres (`kb_chunks`, its text) and the vector store | The chunk text encrypted as above; the embeddings left in clear, since search needs them, and stated as such (an embedding reveals something about its text). Or a vector store per customer.                                                                                                                | Keyword search over chunk text (Postgres full text) stops working unless it moves to the server; embeddings are a known residual.                                                  |
| Lakehouse tables and uploaded files          | The object store (SILO, MinIO, S3, Azure Blob, GCS)   | A storage prefix or bucket per customer, with the store's own server-side encryption under the customer's KMS key (S3 SSE-KMS, Azure Blob customer-managed keys, GCS CMEK); the app passes the key per request, or the bucket is configured with it. Revoking the key stops the store serving those objects. | Per-customer storage layout; SILO and MinIO need their KMS integration (MinIO KES) configured; DuckLake's catalog and DuckDB reads must carry the per-customer key or credentials. |
| The lakehouse catalog                        | Postgres (DuckLake metadata)                          | Metadata only (names, statistics, file paths); left under the database's encryption, documented.                                                                                                                                                                                                             | —                                                                                                                                                                                  |
| Generated documents, exports                 | The object store                                      | As lakehouse files.                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                  |

**Order, if built:** lakehouse files first (the largest and most sensitive,
and the store does the encryption, so search and queries are unaffected),
then chat and memory text, then knowledge-base text. Each is its own round
with a measured cost, and none is started without a decision on what may
stop working.

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
| **Cloud KMS**       | `projects/…/cryptoKeys/…`         | `encrypt` / `decrypt`, with CRC-32C both ways and fixed AAD                               | Metadata server or federation; else service-account JSON   |
| **Azure Key Vault** | `https://…vault.azure.net/keys/…` | `wrapKey` / `unwrapKey`                                                                   | Managed Identity; else client secret / cert                |
| **OCI Vault**       | key OCID + crypto endpoint        | `encrypt` / `decrypt`, with fixed associated data                                         | Instance or resource principal; else API signing key       |
| **HashiCorp Vault** | `transit/keys/<name>`             | Transit `encrypt` / `decrypt`                                                             | Kubernetes auth, AppRole, or token                         |

Vault Transit is the most portable and the one to build **second** after `env`,
because it runs anywhere and needs no cloud account to test.

## Failure modes, and what each should do

This is the part that decides whether the feature is safe, so it is specified
before any code.

| Situation                                                     | Behaviour                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KMS unreachable **at startup**                                | **Refuse to start.** Serving with no ability to decrypt credentials would surface as hundreds of confusing per-feature errors. Fail once, loudly, with the provider and key ref in the message.                                                                                          |
| KMS unreachable **while running**                             | Keep serving. The DEK is already in memory; no KMS call is on the request path. Surface a warning on the health page.                                                                                                                                                                    |
| Permission revoked mid-run                                    | Same as above until restart. The next restart fails closed.                                                                                                                                                                                                                              |
| Wrapped DEK missing or corrupt                                | Refuse to start. Never silently generate a new DEK — that would leave every existing credential unreadable while looking healthy.                                                                                                                                                        |
| Provider misconfigured (`KMS_PROVIDER=aws`, no `KMS_KEY_REF`) | Refuse to start, naming the missing variable.                                                                                                                                                                                                                                            |
| Switching provider                                            | From `env`: a **rotation** (create the data key, switch, run the re-encrypt sweep). Between two external providers: a **re-key**, not a rotation in this release ([Changing key providers](#changing-key-providers)). The old provider's data key is kept, never retired by the new one. |

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
3. **Add AWS (done), Azure (done), GCP (done), then OCI (done)**, each behind the same interface,
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
- **One DEK per instance, or per tenant?** Answered in R438: one data key per
  instance, a user key per user under it, and a customer key per customer that
  wants its own ([Customer keys and user keys](#customer-keys-and-user-keys)).
  The KMS calls stay few: a user key is wrapped here, and a customer's KMS is
  called once per process per `DATA_KEY_CACHE_SECONDS`.
- **Should `probe()` run on the health page?** It proves the permission is live,
  but adds a periodic billable KMS call.
