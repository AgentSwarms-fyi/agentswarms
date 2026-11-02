// Server-only AES-256-GCM helpers for encrypting per-user provider credentials.
// Uses Web Crypto (works in the Worker runtime) — never import this from client code.
//
// WHERE THE KEY COMES FROM is the keyring's business (src/utils/kms): with
// KMS_PROVIDER=env it is SHA-256(PROVIDER_CREDS_SECRET) plus any previous
// secrets in PROVIDER_CREDS_SECRET_OLD; with an external provider it is a
// data-encryption key the provider unwraps once per process. This module
// only knows a current key to write with and a list of keys to read under.
//
// WHOSE KEY: a value is written under its owner's user key
// (src/utils/kms/keyHierarchy.server.ts), which the deployment's key wraps,
// or a customer key does when the owner is a customer's member. Every caller
// says who owns what it encrypts; `owner: null` is the deployment's key
// itself. Reading needs no owner: the value's `kid` names its key.
//
// Every ciphertext is stamped with a `kid` — a short fingerprint of the key that
// wrote it. The fingerprint is a DOMAIN-SEPARATED hash, never key material, so
// publishing it in the row (and the admin UI) leaks nothing. Decryption picks
// the key whose kid matches and, failing that, tries every configured key — so
// blobs written before this scheme existed (no kid) and callers that pass only
// (ciphertext, iv) keep working unchanged.
import { providerForKeyRef, resolveKeyring, type Keyring } from "@/utils/kms/keyring.server";
import {
  createKeyHierarchy,
  dataKeyCacheMs,
  DataKeyUnavailableError,
  KeyStoreMissingError,
  type CustomerKeyRow,
  type DataKey,
  type KeyHierarchy,
  type KeyStore,
} from "@/utils/kms/keyHierarchy.server";
import { keyRefProvider, type KeyProvider } from "@/utils/kms/types";

const ALGO = "AES-GCM";

/** A blob as stored: base64 ciphertext + iv, plus the writing key's fingerprint. */
export type EncryptedBlob = { ciphertext: string; iv: string; kid?: string };

// The keyring is resolved once per configuration and kept for the process:
// with an external provider that is the one unwrap call on the startup path,
// and nothing on the request path. The signature catches an env change
// (tests rotate by swapping process.env, as an operator would with a restart).
let cached: { signature: string; keyring: Promise<Keyring> } | null = null;
let loaderOverride: (() => Promise<Keyring>) | null = null;

function signature(): string {
  return [
    process.env.KMS_PROVIDER,
    process.env.KMS_KEY_REF,
    process.env.PROVIDER_CREDS_SECRET,
    process.env.PROVIDER_CREDS_SECRET_OLD,
  ]
    .map((v) => v ?? "")
    .join("|");
}

async function keyring(): Promise<Keyring> {
  if (loaderOverride) return loaderOverride();
  const sig = signature();
  if (cached && cached.signature === sig) return cached.keyring;
  // The deployment's keys wrap the user keys: a different keyring means the
  // unwrapped user keys kept from the old one are not to be trusted either.
  hierarchy?.forgetAll();
  const next = { signature: sig, keyring: resolveKeyring() };
  cached = next;
  // A failed load must not be remembered: the next call retries, so a KMS
  // that was down for a moment does not stay "down" for the process.
  next.keyring.catch(() => {
    if (cached === next) cached = null;
  });
  return next.keyring;
}

/** Forget the resolved keyring — after a data key is created, or in tests. */
export function resetKeyringCache(): void {
  cached = null;
  hierarchy?.forgetAll();
}

/** Tests only: route the keyring through a fake provider and rows. */
export function __setKeyringLoaderForTests(loader: (() => Promise<Keyring>) | null): void {
  loaderOverride = loader;
  cached = null;
  hierarchy = null;
}

// ── User keys and customer keys ──────────────────────────────────────────────

let hierarchy: KeyHierarchy | null = null;
let storeOverride: KeyStore | null = null;
let customerProviderOverride: ((row: CustomerKeyRow) => KeyProvider) | null = null;
const customerProviders = new Map<string, KeyProvider>();

/**
 * A customer key's own KMS, called as the app's identity: the provider its
 * key reference names, built like KMS_KEY_REF's, with the customer vault's
 * endpoint for OCI. Kept per key, so its credentials are fetched once.
 */
export function customerKeyProvider(row: CustomerKeyRow): KeyProvider {
  if (customerProviderOverride) return customerProviderOverride(row);
  const ref = row.key_ref ?? "";
  const cacheKey = `${ref}|${row.endpoint ?? ""}`;
  const hit = customerProviders.get(cacheKey);
  if (hit) return hit;
  if (keyRefProvider(ref) !== row.provider) {
    throw new Error(
      `The customer key "${row.name}" names ${ref}, which is not a ${row.provider} key`,
    );
  }
  const env =
    row.provider === "oci"
      ? {
          ...process.env,
          OCI_KMS_CRYPTO_ENDPOINT: row.endpoint ?? "",
          OCI_KMS_MANAGEMENT_ENDPOINT: "",
        }
      : process.env;
  const provider = providerForKeyRef(ref, env);
  if (!provider) {
    throw new Error(
      `The customer key "${row.name}" names ${ref}, which this server cannot reach: its provider's variables are not set`,
    );
  }
  customerProviders.set(cacheKey, provider);
  return provider;
}

/** The user and customer key layer, over the database. */
export function keyHierarchy(): KeyHierarchy {
  if (!hierarchy) {
    hierarchy = createKeyHierarchy({
      store: storeOverride ?? lazyStore(),
      instance: keyring,
      customerProvider: customerKeyProvider,
      cacheMs: () => dataKeyCacheMs(),
    });
  }
  return hierarchy;
}

// The database store is imported when first used, so a test that never
// touches user keys does not need a database client.
function lazyStore(): KeyStore {
  let real: Promise<KeyStore> | null = null;
  const get = () =>
    (real ??= import("@/utils/kms/keyStore.server").then((m) => m.supabaseKeyStore()));
  return {
    userKeyByKid: async (kid) => (await get()).userKeyByKid(kid),
    activeUserKey: async (id) => (await get()).activeUserKey(id),
    insertUserKey: async (row) => (await get()).insertUserKey(row),
    rewrapUserKey: async (id, from, to) => (await get()).rewrapUserKey(id, from, to),
    customerKey: async (id) => (await get()).customerKey(id),
    memberships: async (id) => (await get()).memberships(id),
  };
}

/** Tests only: user and customer keys over a fake store and fake customer KMS. */
export function __setKeyHierarchyForTests(
  store: KeyStore | null,
  customerProvider: ((row: CustomerKeyRow) => KeyProvider) | null = null,
): void {
  storeOverride = store;
  customerProviderOverride = customerProvider;
  customerProviders.clear();
  hierarchy = null;
}

let warnedMissing = false;

/** Whose key a value is written with: its owner's user key, or the deployment's. */
export type EncryptFor = { owner: string | null };

/**
 * The key a value of `owner` is written with. The deployment's current key
 * when there is no owner, or before the user-key tables exist; otherwise the
 * owner's user key, and an error when that cannot be had. Never the
 * deployment's key in place of a user key that failed: a customer member's
 * value would leave the customer's control without anyone seeing it.
 */
export async function writeKeyFor(owner: string | null): Promise<DataKey> {
  if (!owner) return (await keyring()).current;
  try {
    return await keyHierarchy().writeKey(owner);
  } catch (e) {
    if (!(e instanceof KeyStoreMissingError)) throw e;
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(`[kms] ${e.message}; values are written under the deployment's key until then`);
    }
    return (await keyring()).current;
  }
}

/** The user key with this fingerprint, or null when no user key has it (or there are none yet). */
async function readUserKey(kid: string): Promise<DataKey | null> {
  try {
    return await keyHierarchy().readKey(kid);
  } catch (e) {
    if (e instanceof KeyStoreMissingError) return null;
    throw e;
  }
}

/** Fingerprint of the key new ciphertext is written with. */
export async function currentKid(): Promise<string> {
  return (await keyring()).current.kid;
}

/** Every key fingerprint the deployment currently accepts (current first). */
export async function keyringFingerprints(): Promise<{ current: string; previous: string[] }> {
  const k = await keyring();
  return { current: k.current.kid, previous: k.previous.map((p) => p.kid) };
}

/** Whether this process can encrypt and decrypt right now — the readiness check. */
export async function keyringReady(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await keyring();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function encryptWith(k: DataKey, payload: unknown): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, k.key, data));
  return { ciphertext: bytesToBase64(ct), iv: bytesToBase64(iv), kid: k.kid };
}

/**
 * Encrypt a value for storage under its owner's key. `owner` is the user the
 * stored row belongs to (its `user_id`), not necessarily who is saving it.
 */
export async function encryptJson(payload: unknown, opts: EncryptFor): Promise<EncryptedBlob> {
  return encryptWith(await writeKeyFor(opts.owner), payload);
}

/**
 * Decrypt a blob. The `kid` it carries names its key: a user key's opens it
 * with that key alone. Otherwise the deployment key with that fingerprint is
 * tried first and every other one after it, and because GCM authenticates, a
 * wrong key throws rather than returning garbage, so a blob written before
 * key ids, or under any accepted key (current or previous), decrypts.
 *
 * `kid` is a required argument, undefined for a blob without one: a call
 * without it could not find a user key, and would fail on every value
 * written since user keys exist.
 */
export async function decryptJson<T = unknown>(
  ciphertext: string,
  iv: string,
  kid: string | undefined,
): Promise<T> {
  const k = await keyring();
  const entries = [k.current, ...k.previous];
  if (kid && !entries.some((e) => e.kid === kid)) {
    // Throws DataKeyUnavailableError for an erased, destroyed or refused key:
    // its message is what the caller shows.
    const user = await readUserKey(kid);
    if (user) return decryptWithKey<T>(user.key, ciphertext, iv);
  }
  const ordered = kid
    ? [...entries.filter((e) => e.kid === kid), ...entries.filter((e) => e.kid !== kid)]
    : entries;

  const ct = base64ToBytes(ciphertext);
  const ivBytes = base64ToBytes(iv);
  const ctBuf = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer;
  const ivBuf = ivBytes.buffer.slice(
    ivBytes.byteOffset,
    ivBytes.byteOffset + ivBytes.byteLength,
  ) as ArrayBuffer;

  let lastErr: unknown;
  for (const e of ordered) {
    try {
      const plain = await crypto.subtle.decrypt({ name: ALGO, iv: ivBuf }, e.key, ctBuf);
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  if (kid && !entries.some((e) => e.kid === kid)) {
    throw new DataKeyUnavailableError(
      `This value is on the key ${kid}, which this server does not hold`,
      "unheld",
    );
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Decryption failed under every configured key");
}

async function decryptWithKey<T>(key: CryptoKey, ciphertext: string, iv: string): Promise<T> {
  const ct = base64ToBytes(ciphertext);
  const ivBytes = base64ToBytes(iv);
  const plain = await crypto.subtle.decrypt(
    {
      name: ALGO,
      iv: ivBytes.buffer.slice(
        ivBytes.byteOffset,
        ivBytes.byteOffset + ivBytes.byteLength,
      ) as ArrayBuffer,
    },
    key,
    ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Decrypt a stored blob, by the key its `kid` names. */
export async function decryptBlob<T = unknown>(blob: EncryptedBlob): Promise<T> {
  return decryptJson<T>(blob.ciphertext, blob.iv, blob.kid);
}

/** Whether a value is one of our stored ciphertext blobs. */
export function isEncryptedBlob(v: unknown): v is EncryptedBlob {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as EncryptedBlob).ciphertext === "string" &&
    typeof (v as EncryptedBlob).iv === "string"
  );
}

/**
 * Re-encrypt one blob to its owner's current key (the deployment's when
 * `owner` is null). A blob already on that key is returned unchanged, so this
 * is safe to run repeatedly.
 */
export async function reEncryptBlob(
  blob: EncryptedBlob,
  opts: EncryptFor,
): Promise<{ blob: EncryptedBlob; changed: boolean }> {
  return reEncryptUnder(blob, await writeKeyFor(opts.owner));
}

async function reEncryptUnder(
  blob: EncryptedBlob,
  target: DataKey,
): Promise<{ blob: EncryptedBlob; changed: boolean }> {
  if (blob.kid && blob.kid === target.kid) return { blob, changed: false };
  const payload = await decryptJson<unknown>(blob.ciphertext, blob.iv, blob.kid);
  return { blob: await encryptWith(target, payload), changed: true };
}

export type DeepReEncryptResult<T> = {
  value: T;
  migrated: number;
  alreadyCurrent: number;
  failed: number;
};

/**
 * Walk any JSON value and re-encrypt every ciphertext blob found at any depth to
 * its owner's current key. Used by rotation: the same walker handles a
 * whole-column blob (`user_secrets.value`), a nested one
 * (`integrations.config.api_key_enc`) and a blob inside an object
 * (`{ token: {...} }`) without knowing the shape in advance. The owner's key
 * is looked up once for the value; when it cannot be had, nothing is
 * re-encrypted and every blob counts as failed.
 */
export async function reEncryptDeep<T>(
  value: T,
  opts: EncryptFor | { target: () => Promise<DataKey> },
): Promise<DeepReEncryptResult<T>> {
  let migrated = 0;
  let alreadyCurrent = 0;
  let failed = 0;
  // Looked up at the first blob, so a value with none makes no user key.
  let pending: Promise<DataKey | null> | null = null;
  const targetKey = () =>
    (pending ??= ("target" in opts ? opts.target() : writeKeyFor(opts.owner)).catch(() => null));

  async function walk(v: unknown): Promise<unknown> {
    if (isEncryptedBlob(v)) {
      const target = await targetKey();
      if (!target) {
        failed++;
        return v;
      }
      try {
        const r = await reEncryptUnder(v, target);
        if (r.changed) migrated++;
        else alreadyCurrent++;
        return r.blob;
      } catch {
        failed++;
        return v;
      }
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) out.push(await walk(x));
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x);
      return out;
    }
    return v;
  }

  const out = (await walk(value)) as T;
  return { value: out, migrated, alreadyCurrent, failed };
}

export type BlobKeyStatus = {
  total: number;
  onCurrent: number;
  /**
   * On the deployment's current key, where the owner's own key is current: it
   * decrypts, and a sweep moves it onto the owner's key. Counted apart from
   * onOther: it is not on an older key (found in R438's UI round, where the
   * card called every value written before the migration "on an older key").
   */
  onDeploymentKey: number;
  /** On an older key this server still holds: it decrypts, and a sweep moves it. */
  onOther: number;
  /**
   * On a key this server does not hold — a secret dropped from
   * PROVIDER_CREDS_SECRET_OLD, or another key provider's data key after a
   * switch. It does not decrypt here, and a sweep reports it and leaves it.
   * These used to count as "older" under "These still decrypt" (R432).
   */
  unreadable: number;
  /** The fingerprints those are on, so the card can name the key. */
  unreadableKids: string[];
  legacy: number;
};

/**
 * Count the blobs in a value, by the key each is on. `keys` says which key is
 * current for this value (its owner's user key, null before the owner has
 * one), which is the deployment's current key, and which ones this server can
 * read; without it, the deployment keyring's.
 */
export async function blobKeyStatus(
  value: unknown,
  keys?: { current: string | null; deployment?: string; held: ReadonlySet<string> },
): Promise<BlobKeyStatus> {
  const ring = keys ? null : await keyringFingerprints();
  const cur = keys ? keys.current : ring!.current;
  const deployment = keys ? keys.deployment : undefined;
  const held: ReadonlySet<string> = keys ? keys.held : new Set(ring!.previous);
  let total = 0;
  let onCurrent = 0;
  let onDeploymentKey = 0;
  let onOther = 0;
  let unreadable = 0;
  const unreadableKids = new Set<string>();
  let legacy = 0;
  function walk(v: unknown): void {
    if (isEncryptedBlob(v)) {
      total++;
      if (!v.kid) legacy++;
      else if (v.kid === cur) onCurrent++;
      else if (deployment && v.kid === deployment) onDeploymentKey++;
      else if (held.has(v.kid)) onOther++;
      else {
        unreadable++;
        unreadableKids.add(v.kid);
      }
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  }
  walk(value);
  return {
    total,
    onCurrent,
    onDeploymentKey,
    onOther,
    unreadable,
    unreadableKids: [...unreadableKids],
    legacy,
  };
}

// Mask a secret for display: show last 4 chars only.
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return "••••" + value.slice(-4);
}
