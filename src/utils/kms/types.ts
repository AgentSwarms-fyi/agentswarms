// Key providers for envelope encryption — the contract, and the reading of
// the environment that picks one. Pure: no network, no database, so the
// routes, the keyring and the tests share one definition.
//
// The data-encryption key (DEK) is what encrypts credentials. A provider
// holds the key-encrypting key (KEK) that wraps the DEK, and never gives it
// out: the app holds a permission to unwrap, not the key. `env` is the
// provider that is not a provider — the DEK is derived from
// PROVIDER_CREDS_SECRET exactly as before this existed, so a deployment
// that sets nothing changes nothing.

export const KMS_PROVIDERS = ["env", "vault", "aws", "gcp", "azure", "oci"] as const;
export type KmsProviderId = (typeof KMS_PROVIDERS)[number];

/** The providers this build can actually talk to. The rest are designed, not built. */
export const IMPLEMENTED_KMS_PROVIDERS: readonly KmsProviderId[] = ["env", "vault", "aws", "azure"];

export type WrappedDek = {
  provider: KmsProviderId;
  /** The provider's reference for the KEK: a Vault transit key path, an ARN… */
  keyRef: string;
  /** The wrapped DEK in the provider's own ciphertext form. */
  material: string;
};

export type ProbeResult = {
  ok: boolean;
  detail: string;
  /** What the settings card lists under the provider: the key, where it lives, who the app is. */
  facts?: Array<{ label: string; value: string }>;
};

export interface KeyProvider {
  readonly id: KmsProviderId;
  readonly keyRef: string;
  /** Unwrap a stored DEK. Called once per process, and on rotation. Throws — never guesses. */
  unwrapDek(wrapped: WrappedDek): Promise<Uint8Array>;
  /** Wrap a fresh DEK for storage. Called only when a data key is created. */
  wrapDek(dek: Uint8Array): Promise<WrappedDek>;
  /**
   * Have the provider generate the DEK itself (AWS KMS GenerateDataKey: the
   * bytes come from its HSMs). Preferred over wrapDek when a provider has it.
   */
  generateDek?(): Promise<{ dek: Uint8Array; wrapped: WrappedDek }>;
  /** Cheap check that the provider is reachable and the permission is live. */
  probe(): Promise<ProbeResult>;
}

export type KmsConfig =
  { provider: "env" } | { provider: Exclude<KmsProviderId, "env">; keyRef: string };

export class KmsConfigError extends Error {}

/**
 * Read KMS_PROVIDER and KMS_KEY_REF. A misconfiguration is an error that
 * names the variable, because the alternative — quietly falling back to the
 * env key — would leave an operator believing credentials are under a KMS
 * when they are not.
 */
export function kmsConfigFromEnv(env: Record<string, string | undefined> = process.env): KmsConfig {
  const raw = (env.KMS_PROVIDER ?? "env").trim().toLowerCase();
  if (!(KMS_PROVIDERS as readonly string[]).includes(raw)) {
    throw new KmsConfigError(
      `KMS_PROVIDER=${raw} is not a key provider; use one of ${KMS_PROVIDERS.join(", ")}`,
    );
  }
  const provider = raw as KmsProviderId;
  if (provider === "env") return { provider };
  if (!IMPLEMENTED_KMS_PROVIDERS.includes(provider)) {
    throw new KmsConfigError(
      `KMS_PROVIDER=${provider} is designed but not built in this release; use ${IMPLEMENTED_KMS_PROVIDERS.join(", ")}`,
    );
  }
  const keyRef = (env.KMS_KEY_REF ?? "").trim();
  if (!keyRef) {
    throw new KmsConfigError(
      `KMS_PROVIDER=${provider} needs KMS_KEY_REF (the provider's reference for the key)`,
    );
  }
  return { provider, keyRef };
}

/** `transit/keys/<name>` → the mount and the key name Vault's Transit API wants. */
export function parseVaultKeyRef(keyRef: string): { mount: string; name: string } {
  const m = /^([A-Za-z0-9_.-]+)\/keys\/([A-Za-z0-9_.-]+)$/.exec(keyRef.trim());
  if (!m) {
    throw new KmsConfigError(
      `KMS_KEY_REF for Vault must look like transit/keys/<name>, not "${keyRef}"`,
    );
  }
  return { mount: m[1], name: m[2] };
}

export type AwsKeyRef = {
  kind: "key-arn" | "alias-arn" | "alias" | "key-id";
  /** From an ARN; a bare alias or key id takes the region from the environment. */
  region: string | null;
};

const AWS_KMS_ARN =
  /^arn:aws(?:-cn|-us-gov)?:kms:([a-z0-9]+(?:-[a-z0-9]+)*):\d{12}:(key|alias)\/(.+)$/;
const AWS_KEY_ID = /^(?:mrk-)?[0-9a-f]{8,}(?:-[0-9a-f]+)*$/;
const AWS_ALIAS_NAME = /^[A-Za-z0-9/_-]{1,250}$/;

/**
 * An AWS KMS key reference: a key ARN, an alias ARN, `alias/<name>`, or a key
 * id. AWS-managed aliases (`alias/aws/…`) are refused: their keys serve one
 * AWS service each, and the call would fail with a less useful message.
 */
export function parseAwsKeyRef(keyRef: string): AwsKeyRef {
  const ref = keyRef.trim();
  const usage =
    `KMS_KEY_REF for AWS KMS must be a key ARN (arn:aws:kms:<region>:<account>:key/<id>), ` +
    `an alias ARN, alias/<name> or a key id, not "${keyRef}"`;
  const arn = AWS_KMS_ARN.exec(ref);
  let kind: AwsKeyRef["kind"];
  let rest: string;
  if (arn) {
    kind = arn[2] === "key" ? "key-arn" : "alias-arn";
    rest = arn[3];
  } else if (ref.startsWith("alias/")) {
    kind = "alias";
    rest = ref.slice("alias/".length);
  } else if (AWS_KEY_ID.test(ref)) {
    return { kind: "key-id", region: null };
  } else {
    throw new KmsConfigError(usage);
  }
  if (kind === "key-arn" ? !AWS_KEY_ID.test(rest) : !AWS_ALIAS_NAME.test(rest)) {
    throw new KmsConfigError(usage);
  }
  if (kind !== "key-arn" && (rest === "aws" || rest.startsWith("aws/"))) {
    throw new KmsConfigError(
      `KMS_KEY_REF ${ref} is an AWS-managed key, which only its own AWS service can use; create a customer managed key`,
    );
  }
  return { kind, region: arn ? arn[1] : null };
}

export type AzureKeyRef = {
  /** The key identifier, normalised: https://<vault>.vault.azure.net/keys/<name>[/<version>]. */
  keyRef: string;
  /** The vault's, or the Managed HSM's, origin. */
  vault: string;
  name: string;
  /** Pinned by the reference, or null for the key's current version. */
  version: string | null;
  kind: "vault" | "managed-hsm";
  /** The Entra ID scope a token for it needs. */
  scope: string;
};

// The Key Vault and Managed HSM domains of each Azure cloud. A key elsewhere is
// refused: the scope a token is asked for comes from the domain, and a
// private endpoint keeps the public name (privatelink DNS), so there is no
// legitimate other host to allow.
const AZURE_KEY_HOSTS: ReadonlyArray<[suffix: string, kind: AzureKeyRef["kind"]]> = [
  ["vault.azure.net", "vault"],
  ["vault.azure.cn", "vault"],
  ["vault.usgovcloudapi.net", "vault"],
  ["managedhsm.azure.net", "managed-hsm"],
  ["managedhsm.azure.cn", "managed-hsm"],
  ["managedhsm.usgovcloudapi.net", "managed-hsm"],
];
// 3–24 letters, digits and single hyphens, from a letter to a letter or digit.
const AZURE_VAULT_NAME = /^(?=.{3,24}$)[a-z](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;
const AZURE_KEY_NAME = /^[A-Za-z0-9-]{1,127}$/;
const AZURE_KEY_VERSION = /^[0-9A-Za-z]{1,64}$/;

/**
 * An Azure Key Vault or Managed HSM key identifier, as the portal shows it:
 * https://<vault>.vault.azure.net/keys/<name>, optionally with a version.
 */
export function parseAzureKeyRef(keyRef: string): AzureKeyRef {
  const raw = keyRef.trim();
  const usage =
    `KMS_KEY_REF for Azure Key Vault must be a key identifier, https://<vault>.vault.azure.net/keys/<name> ` +
    `(or a Managed HSM's, https://<pool>.managedhsm.azure.net/keys/<name>), optionally with a version, not "${keyRef}"`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new KmsConfigError(usage);
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.search || u.hash) {
    throw new KmsConfigError(usage);
  }
  const host = u.hostname.toLowerCase();
  const match = AZURE_KEY_HOSTS.find(([suffix]) => host.endsWith(`.${suffix}`));
  if (!match || !AZURE_VAULT_NAME.test(host.slice(0, -(match[0].length + 1)))) {
    throw new KmsConfigError(usage);
  }
  const parts = u.pathname.replace(/\/+$/, "").split("/");
  const [lead, keys, name, version] = parts;
  if (
    parts.length < 3 ||
    parts.length > 4 ||
    lead !== "" ||
    keys !== "keys" ||
    !AZURE_KEY_NAME.test(name) ||
    (version !== undefined && !AZURE_KEY_VERSION.test(version))
  ) {
    throw new KmsConfigError(usage);
  }
  const vault = `https://${host}`;
  return {
    keyRef: `${vault}/keys/${name}${version ? `/${version}` : ""}`,
    vault,
    name,
    version: version ?? null,
    kind: match[1],
    scope: `https://${match[0]}/.default`,
  };
}

/** Which provider a key reference belongs to, by its shape. */
export function keyRefProvider(keyRef: string): "vault" | "aws" | "azure" | null {
  const ref = keyRef.trim();
  if (/^[A-Za-z0-9_.-]+\/keys\/[A-Za-z0-9_.-]+$/.test(ref)) return "vault";
  if (ref.startsWith("arn:") || ref.startsWith("alias/") || AWS_KEY_ID.test(ref)) return "aws";
  if (/^https:\/\//i.test(ref)) {
    try {
      parseAzureKeyRef(ref);
      return "azure";
    } catch {
      return null;
    }
  }
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
