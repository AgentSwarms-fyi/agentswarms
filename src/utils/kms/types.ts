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

/** The providers this build can actually talk to. */
export const IMPLEMENTED_KMS_PROVIDERS: readonly KmsProviderId[] = [
  "env",
  "vault",
  "aws",
  "azure",
  "gcp",
  "oci",
];

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

export type GcpKeyRef = {
  /** The key's resource name, normalised: projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>. */
  keyRef: string;
  project: string;
  location: string;
  keyRing: string;
  cryptoKey: string;
};

// A project id (6–30 lowercase letters, digits and hyphens; a legacy
// domain-scoped one has "example.com:" in front) or a project number. Each
// part goes into a URL path, so nothing else gets through.
const GCP_PROJECT = /^(?:(?:[a-z0-9-]+\.)+[a-z]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$|^\d{1,20}$/;
// "global", a region (europe-west3), a multi-region (us), a dual (nam-eur-asia1).
const GCP_LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const GCP_ID = /^[A-Za-z0-9_-]{1,63}$/;
const GCP_KEY_NAME =
  /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)(\/cryptoKeyVersions\/[^/]+)?$/;

/**
 * A Cloud KMS key's resource name, as the console's "Copy resource name"
 * gives it: projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>,
 * or the same after //cloudkms.googleapis.com/. A key VERSION is refused:
 * decrypt takes the key and finds the version from the ciphertext, and encrypt
 * should use whichever version is primary, so rotation works.
 */
export function parseGcpKeyRef(keyRef: string): GcpKeyRef {
  const raw = keyRef.trim().replace(/^\/\/cloudkms\.googleapis\.com\//, "");
  const usage =
    `KMS_KEY_REF for Cloud KMS must be a key's resource name, ` +
    `projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>, not "${keyRef}"`;
  const m = GCP_KEY_NAME.exec(raw);
  if (!m) throw new KmsConfigError(usage);
  if (m[5]) {
    throw new KmsConfigError(
      `KMS_KEY_REF names a key version (${m[5].slice(1)}); name the key itself, ` +
        `so encrypt uses the primary version and rotation works`,
    );
  }
  const [, project, location, keyRing, cryptoKey] = m;
  if (
    !GCP_PROJECT.test(project) ||
    !GCP_LOCATION.test(location) ||
    !GCP_ID.test(keyRing) ||
    !GCP_ID.test(cryptoKey)
  ) {
    throw new KmsConfigError(usage);
  }
  return {
    keyRef: `projects/${project}/locations/${location}/keyRings/${keyRing}/cryptoKeys/${cryptoKey}`,
    project,
    location,
    keyRing,
    cryptoKey,
  };
}

export type OciKeyRef = {
  /** The key's OCID. */
  keyRef: string;
  /** oc1 (the commercial realm), oc2… */
  realm: string;
  /** The region's key or name, as the OCID carries it: iad, us-ashburn-1. */
  region: string;
  /**
   * The vault's part of the OCID, which also names its endpoints
   * (`<vault>-crypto.kms.<region>.oraclecloud.com`); not every OCID has it.
   */
  vault: string | null;
};

// ocid1.key.<realm>.<region>[.<vault>].<unique id>: lowercase letters, digits
// and the region's hyphens. The OCID goes into a URL path (GetKey), so nothing
// else gets through.
const OCI_KEY_OCID = /^ocid1\.key\.(oc[0-9]+)\.([a-z0-9-]+)\.(?:([a-z0-9]+)\.)?([a-z0-9]+)$/;

/**
 * An OCI Vault master encryption key's OCID, as the console's key details
 * show it. A key VERSION's OCID is refused: decrypt finds the version from the
 * ciphertext, and encrypt should use the key's current version, so rotation
 * works.
 */
export function parseOciKeyRef(keyRef: string): OciKeyRef {
  const ref = keyRef.trim();
  if (ref.startsWith("ocid1.keyversion.")) {
    throw new KmsConfigError(
      `KMS_KEY_REF names a key version (${ref}); name the key itself (ocid1.key.…), ` +
        `so encrypt uses its current version and rotation works`,
    );
  }
  const m = OCI_KEY_OCID.exec(ref);
  if (!m) {
    throw new KmsConfigError(
      `KMS_KEY_REF for OCI Vault must be a key's OCID, ocid1.key.oc1.<region>.<…>, not "${keyRef}"`,
    );
  }
  return { keyRef: ref, realm: m[1], region: m[2], vault: m[3] ?? null };
}

/** Which provider a key reference belongs to, by its shape. */
export function keyRefProvider(keyRef: string): "vault" | "aws" | "azure" | "gcp" | "oci" | null {
  const ref = keyRef.trim();
  if (ref.startsWith("ocid1.")) {
    try {
      parseOciKeyRef(ref);
      return "oci";
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z0-9_.-]+\/keys\/[A-Za-z0-9_.-]+$/.test(ref)) return "vault";
  if (ref.startsWith("projects/") || ref.startsWith("//cloudkms.googleapis.com/")) {
    try {
      parseGcpKeyRef(ref);
      return "gcp";
    } catch {
      return null;
    }
  }
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
