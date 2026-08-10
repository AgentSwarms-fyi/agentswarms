// Server-only AES-256-GCM helpers for encrypting per-user provider credentials.
// Uses Web Crypto (works in the Worker runtime) — never import this from client code.
//
// KEY ROTATION. The app supports more than one credential key at a time so a
// deployment can rotate the master secret without downtime and without a
// dangerous cutover:
//
//   PROVIDER_CREDS_SECRET       the CURRENT key — everything new is encrypted
//                               with it.
//   PROVIDER_CREDS_SECRET_OLD   zero or more PREVIOUS keys (comma-separated),
//                               still accepted for DECRYPTION while old rows are
//                               migrated. Remove once nothing is left on them.
//
// Every ciphertext is stamped with a `kid` — a short fingerprint of the key that
// wrote it. The fingerprint is a DOMAIN-SEPARATED hash of the secret, never the
// key material itself, so publishing it in the row (and the admin UI) leaks
// nothing. Decryption picks the key whose kid matches and, failing that, tries
// every configured key — so blobs written before this scheme existed (no kid)
// and callers that pass only (ciphertext, iv) keep working unchanged.

const ALGO = "AES-GCM";

// Domain separation: the kid must be independent of the AES key, which is
// SHA-256(secret). Hashing a prefixed string gives a value that reveals nothing
// about the key even though it is derived from the same secret.
const KID_DOMAIN = "agentswarms/creds-kid/v1|";

/** A blob as stored: base64 ciphertext + iv, plus the writing key's fingerprint. */
export type EncryptedBlob = { ciphertext: string; iv: string; kid?: string };

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function deriveKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle
    .digest("SHA-256", enc.encode(secret))
    .then((hash) =>
      crypto.subtle.importKey("raw", hash, { name: ALGO }, false, ["encrypt", "decrypt"]),
    );
}

async function deriveKid(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const h = await crypto.subtle.digest("SHA-256", enc.encode(KID_DOMAIN + secret));
  return bytesToHex(new Uint8Array(h)).slice(0, 12);
}

// Derived key + kid are pure functions of the secret string, so memoise by it.
const keyCache = new Map<string, { key: Promise<CryptoKey>; kid: Promise<string> }>();
function keyFor(secret: string) {
  let e = keyCache.get(secret);
  if (!e) {
    e = { key: deriveKey(secret), kid: deriveKid(secret) };
    keyCache.set(secret, e);
  }
  return e;
}

/** The current secret plus any previous secrets still accepted for decryption. */
function readKeyring(): { current: string; previous: string[] } {
  const current = process.env.PROVIDER_CREDS_SECRET;
  if (!current) throw new Error("PROVIDER_CREDS_SECRET is not configured");
  const previous = (process.env.PROVIDER_CREDS_SECRET_OLD ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== current);
  return { current, previous };
}

/** Fingerprint of the key new ciphertext is written with. */
export async function currentKid(): Promise<string> {
  return keyFor(readKeyring().current).kid;
}

/** Every key fingerprint the deployment currently accepts (current first). */
export async function keyringFingerprints(): Promise<{ current: string; previous: string[] }> {
  const { current, previous } = readKeyring();
  return {
    current: await keyFor(current).kid,
    previous: await Promise.all(previous.map((s) => keyFor(s).kid)),
  };
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
  const { current } = readKeyring();
  const { key, kid } = keyFor(current);
  const k = await key;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, k, data));
  return { ciphertext: bytesToBase64(ct), iv: bytesToBase64(iv), kid: await kid };
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
  const { current, previous } = readKeyring();
  const secrets = [current, ...previous];

  let ordered = secrets;
  if (kid) {
    const preferred: string[] = [];
    for (const s of secrets) if ((await keyFor(s).kid) === kid) preferred.push(s);
    if (preferred.length)
      ordered = [...preferred, ...secrets.filter((s) => !preferred.includes(s))];
  }

  const ct = base64ToBytes(ciphertext);
  const ivBytes = base64ToBytes(iv);
  const ctBuf = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer;
  const ivBuf = ivBytes.buffer.slice(
    ivBytes.byteOffset,
    ivBytes.byteOffset + ivBytes.byteLength,
  ) as ArrayBuffer;

  let lastErr: unknown;
  for (const s of ordered) {
    try {
      const k = await keyFor(s).key;
      const plain = await crypto.subtle.decrypt({ name: ALGO, iv: ivBuf }, k, ctBuf);
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    } catch (e) {
      lastErr = e;
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
