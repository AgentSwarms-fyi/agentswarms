// One stored file sealed under a key: what the app keeps in Supabase Storage
// in place of a generated document's or a dataset copy's bytes (R441).
//
// The store holds ciphertext only; the app opens it with the key its header
// names, which is the owner's user key. Moving the owner between customer
// keys re-wraps that one key, so no file is rewritten; erasing it, or
// destroying the customer key that wraps it, leaves the file unreadable.
//
// AES-256-GCM in chunks (1 MiB by default), each under its own nonce (a
// random 8-byte prefix, then the chunk's index) and authenticated with the
// header, the object's place (bucket and path), the chunk's index and whether
// it is the last. So a file cut short, a chunk moved, dropped or reordered,
// or the whole file copied to another path or another owner's folder, does
// not open.
//
// Layout:
//   magic       8 bytes   00 41 53 53 45 41 4c 01  ("\0ASSEAL" and a version)
//   kid length  1 byte
//   kid         that many ASCII bytes: the key's fingerprint
//   prefix      8 bytes, random
//   chunk size  4 bytes, big-endian
//   chunks      each up to chunk-size bytes of plaintext and a 16-byte tag;
//               only the last is shorter, and an empty file is one empty chunk
//
// No document or Parquet file starts with a NUL (Office files are ZIPs, "PK";
// Parquet is "PAR1"), so a file written before R441 is never taken for one.
//
// Pure: the key to seal with, and a lookup for the key to open with, are
// arguments.

export const SEALED_MAGIC = new Uint8Array([0x00, 0x41, 0x53, 0x53, 0x45, 0x41, 0x4c, 0x01]);
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
/** A header naming a larger chunk is refused: it would only make memory spikes. */
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const TAG_BYTES = 16;
const PREFIX_BYTES = 8;
const ALGO = "AES-GCM";

/** A sealed file that is not one, or does not open. */
export class SealedFileError extends Error {
  constructor(
    message: string,
    readonly reason: "malformed" | "tampered",
  ) {
    super(message);
    this.name = "SealedFileError";
  }
}

export type SealingKey = { key: CryptoKey; kid: string };

const buf = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Whether these bytes are a sealed file (by its magic), not whether it opens. */
export function isSealed(bytes: Uint8Array): boolean {
  if (bytes.length < SEALED_MAGIC.length) return false;
  for (let i = 0; i < SEALED_MAGIC.length; i++) if (bytes[i] !== SEALED_MAGIC[i]) return false;
  return true;
}

type Header = { kid: string; prefix: Uint8Array; chunkSize: number; bytes: Uint8Array };

function readHeader(bytes: Uint8Array): Header {
  if (!isSealed(bytes)) throw new SealedFileError("Not a sealed file", "malformed");
  let at = SEALED_MAGIC.length;
  const kidLength = bytes[at];
  at += 1;
  if (kidLength === undefined || kidLength === 0 || at + kidLength > bytes.length) {
    throw new SealedFileError("A sealed file's key fingerprint is cut short", "malformed");
  }
  const kidBytes = bytes.subarray(at, at + kidLength);
  if (kidBytes.some((c) => c < 0x21 || c > 0x7e)) {
    throw new SealedFileError("A sealed file's key fingerprint is not text", "malformed");
  }
  const kid = new TextDecoder().decode(kidBytes);
  at += kidLength;
  if (at + PREFIX_BYTES + 4 > bytes.length) {
    throw new SealedFileError("A sealed file's header is cut short", "malformed");
  }
  const prefix = bytes.slice(at, at + PREFIX_BYTES);
  at += PREFIX_BYTES;
  const chunkSize = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, false);
  at += 4;
  if (chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new SealedFileError(`A sealed file names a chunk of ${chunkSize} bytes`, "malformed");
  }
  return { kid, prefix, chunkSize, bytes: bytes.slice(0, at) };
}

/** The fingerprint of the key a sealed file is under, or null when it is not one. */
export function sealedKid(bytes: Uint8Array): string | null {
  try {
    return readHeader(bytes).kid;
  } catch {
    return null;
  }
}

function header(kid: string, prefix: Uint8Array, chunkSize: number): Uint8Array {
  const kidBytes = new TextEncoder().encode(kid);
  if (kidBytes.length < 1 || kidBytes.length > 255 || kidBytes.some((c) => c < 0x21 || c > 0x7e)) {
    throw new Error(`A key fingerprint must be 1 to 255 printable characters, not "${kid}"`);
  }
  return concat([
    SEALED_MAGIC,
    new Uint8Array([kidBytes.length]),
    kidBytes,
    prefix,
    u32(chunkSize),
  ]);
}

function nonce(prefix: Uint8Array, index: number): Uint8Array {
  return concat([prefix, u32(index)]);
}

/** What each chunk is authenticated with: the header, the place, its index, whether last. */
function aad(head: Uint8Array, where: Uint8Array, index: number, last: boolean): Uint8Array {
  return concat([head, u32(where.length), where, u32(index), new Uint8Array([last ? 1 : 0])]);
}

/**
 * Seal `plain` under `key`, for the object at `where` (its bucket and path).
 * The same bytes sealed twice differ: the nonce prefix is random.
 */
export async function sealFile(
  plain: Uint8Array,
  key: SealingKey,
  where: string,
  opts: { chunkSize?: number; random?: (n: number) => Uint8Array } = {},
): Promise<Uint8Array> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error(`A chunk is 1 to ${MAX_CHUNK_SIZE} bytes`);
  }
  const random = opts.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const prefix = random(PREFIX_BYTES);
  const head = header(key.kid, prefix, chunkSize);
  const place = new TextEncoder().encode(where);
  const count = Math.max(1, Math.ceil(plain.length / chunkSize));
  if (count > 0xffffffff) throw new Error("This file is too large to seal");
  const parts: Uint8Array[] = [head];
  for (let i = 0; i < count; i++) {
    const chunk = plain.subarray(i * chunkSize, Math.min(plain.length, (i + 1) * chunkSize));
    const sealed = await crypto.subtle.encrypt(
      {
        name: ALGO,
        iv: buf(nonce(prefix, i)),
        additionalData: buf(aad(head, place, i, i === count - 1)),
      },
      key.key,
      buf(chunk),
    );
    parts.push(new Uint8Array(sealed));
  }
  return concat(parts);
}

/**
 * Open a sealed file at `where`. `keyFor` gets the key its header names, and
 * throws (with the reason a caller shows) when that key cannot be had.
 */
export async function openFile(
  sealed: Uint8Array,
  keyFor: (kid: string) => Promise<CryptoKey>,
  where: string,
): Promise<Uint8Array> {
  const head = readHeader(sealed);
  const key = await keyFor(head.kid);
  const place = new TextEncoder().encode(where);
  const body = sealed.subarray(head.bytes.length);
  if (body.length < TAG_BYTES) {
    throw new SealedFileError("A sealed file has no content", "malformed");
  }
  const stride = head.chunkSize + TAG_BYTES;
  const parts: Uint8Array[] = [];
  for (let at = 0, i = 0; at < body.length; at += stride, i++) {
    const piece = body.subarray(at, Math.min(body.length, at + stride));
    const last = at + piece.length === body.length;
    if (piece.length < TAG_BYTES) {
      throw new SealedFileError("A sealed file ends inside a chunk", "malformed");
    }
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: ALGO,
          iv: buf(nonce(head.prefix, i)),
          additionalData: buf(aad(head.bytes, place, i, last)),
        },
        key,
        buf(piece),
      );
      parts.push(new Uint8Array(plain));
    } catch {
      throw new SealedFileError(
        "This file does not open under its key: it was changed, cut short or moved",
        "tampered",
      );
    }
  }
  return concat(parts);
}
