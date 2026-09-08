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
export const IMPLEMENTED_KMS_PROVIDERS: readonly KmsProviderId[] = ["env", "vault"];

export type WrappedDek = {
  provider: KmsProviderId;
  /** The provider's reference for the KEK: a Vault transit key path, an ARN… */
  keyRef: string;
  /** The wrapped DEK in the provider's own ciphertext form. */
  material: string;
};

export interface KeyProvider {
  readonly id: KmsProviderId;
  readonly keyRef: string;
  /** Unwrap a stored DEK. Called once per process, and on rotation. Throws — never guesses. */
  unwrapDek(wrapped: WrappedDek): Promise<Uint8Array>;
  /** Wrap a fresh DEK for storage. Called only when a data key is created. */
  wrapDek(dek: Uint8Array): Promise<WrappedDek>;
  /** Cheap check that the provider is reachable and the permission is live. */
  probe(): Promise<{ ok: boolean; detail: string }>;
}

export type KmsConfig =
  | { provider: "env" }
  | { provider: Exclude<KmsProviderId, "env">; keyRef: string };

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
      `KMS_PROVIDER=${provider} is designed but not built in this release; use env or vault`,
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
