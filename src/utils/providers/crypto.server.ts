// Server-only AES-256-GCM helpers for encrypting per-user provider credentials.
// Uses Web Crypto (works in the Worker runtime) — never import this from client code.
//
// WHERE THE KEY COMES FROM is the keyring's business (src/utils/kms): with
// KMS_PROVIDER=env it is SHA-256(PROVIDER_CREDS_SECRET) plus any previous
// secrets in PROVIDER_CREDS_SECRET_OLD; with an external provider it is a
// data-encryption key the provider unwraps once per process. This module
// only knows a current key to write with and a list of keys to read under.
//
// Every ciphertext is stamped with a `kid` — a short fingerprint of the key that
// wrote it. The fingerprint is a DOMAIN-SEPARATED hash, never key material, so
// publishing it in the row (and the admin UI) leaks nothing. Decryption picks
// the key whose kid matches and, failing that, tries every configured key — so
// blobs written before this scheme existed (no kid) and callers that pass only
// (ciphertext, iv) keep working unchanged.
import { resolveKeyring, type Keyring } from "@/utils/kms/keyring.server";

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
}

/** Tests only: route the keyring through a fake provider and rows. */
export function __setKeyringLoaderForTests(loader: (() => Promise<Keyring>) | null): void {
  loaderOverride = loader;
  cached = null;
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

export async function encryptJson(payload: unknown): Promise<EncryptedBlob> {
  const { current } = await keyring();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, current.key, data));
  return { ciphertext: bytesToBase64(ct), iv: bytesToBase64(iv), kid: current.kid };
}

/**
 * Decrypt a blob. `kid` is optional and advisory: when given, the key with that
 * fingerprint is tried first; either way every configured key is attempted, and
 * because GCM authenticates, a wrong key throws rather than returning garbage.
 * So a two-argument call still works, and a blob written under any accepted key
 * (current or previous) decrypts.
 */
export async function decryptJson<T = unknown>(
  ciphertext: string,
  iv: string,
  kid?: string,
): Promise<T> {
  const k = await keyring();
  const entries = [k.current, ...k.previous];
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
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Decryption failed under every configured key");
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
 * Re-encrypt one blob to the current key. A blob already on the current kid is
 * returned unchanged, so this is safe to run repeatedly.
 */
export async function reEncryptBlob(
  blob: EncryptedBlob,
): Promise<{ blob: EncryptedBlob; changed: boolean }> {
  const cur = await currentKid();
  if (blob.kid && blob.kid === cur) return { blob, changed: false };
  const payload = await decryptJson<unknown>(blob.ciphertext, blob.iv, blob.kid);
  return { blob: await encryptJson(payload), changed: true };
}

export type DeepReEncryptResult<T> = {
  value: T;
  migrated: number;
  alreadyCurrent: number;
  failed: number;
};

/**
 * Walk any JSON value and re-encrypt every ciphertext blob found at any depth to
 * the current key. Used by rotation: the same walker handles a whole-column blob
 * (`user_secrets.value`), a nested one (`integrations.config.api_key_enc`) and a
 * blob inside an object (`{ token: {...} }`) without knowing the shape in
 * advance.
 */
export async function reEncryptDeep<T>(value: T): Promise<DeepReEncryptResult<T>> {
  let migrated = 0;
  let alreadyCurrent = 0;
  let failed = 0;

  async function walk(v: unknown): Promise<unknown> {
    if (isEncryptedBlob(v)) {
      try {
        const r = await reEncryptBlob(v);
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

/** Count the blobs in a value and how many are already on the current key. */
export async function blobKeyStatus(
  value: unknown,
): Promise<{ total: number; onCurrent: number; onOther: number; legacy: number }> {
  const cur = await currentKid();
  let total = 0;
  let onCurrent = 0;
  let onOther = 0;
  let legacy = 0;
  function walk(v: unknown): void {
    if (isEncryptedBlob(v)) {
      total++;
      if (!v.kid) legacy++;
      else if (v.kid === cur) onCurrent++;
      else onOther++;
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  }
  walk(value);
  return { total, onCurrent, onOther, legacy };
}

// Mask a secret for display: show last 4 chars only.
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return "••••" + value.slice(-4);
}
