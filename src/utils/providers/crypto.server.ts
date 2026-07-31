// Server-only AES-256-GCM helpers for encrypting per-user provider credentials.
// Uses Web Crypto (works in the Worker runtime) — never import this from client code.

const ALGO = "AES-GCM";

function getKeyMaterial(): Promise<CryptoKey> {
  const secret = process.env.PROVIDER_CREDS_SECRET;
  if (!secret) throw new Error("PROVIDER_CREDS_SECRET is not configured");
  // Derive a 256-bit key by SHA-256 hashing the secret.
  const enc = new TextEncoder();
  return crypto.subtle
    .digest("SHA-256", enc.encode(secret))
    .then((hash) =>
      crypto.subtle.importKey("raw", hash, { name: ALGO }, false, ["encrypt", "decrypt"]),
    );
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

export async function encryptJson(payload: unknown): Promise<{ ciphertext: string; iv: string }> {
  const key = await getKeyMaterial();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, key, data));
  return { ciphertext: bytesToBase64(ct), iv: bytesToBase64(iv) };
}

export async function decryptJson<T = unknown>(ciphertext: string, iv: string): Promise<T> {
  const key = await getKeyMaterial();
  const ct = base64ToBytes(ciphertext);
  const ivBytes = base64ToBytes(iv);
  const ctBuf = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer;
  const ivBuf = ivBytes.buffer.slice(
    ivBytes.byteOffset,
    ivBytes.byteOffset + ivBytes.byteLength,
  ) as ArrayBuffer;
  const plain = await crypto.subtle.decrypt({ name: ALGO, iv: ivBuf }, key, ctBuf);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

// Mask a secret for display: show last 4 chars only.
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return "••••" + value.slice(-4);
}
