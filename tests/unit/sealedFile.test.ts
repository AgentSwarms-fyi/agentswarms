// R441: a stored file sealed under a key. What has to hold: it opens to the
// same bytes under the same key at the same place, and to nothing otherwise:
// not cut short, not with a chunk dropped, moved or reordered, not copied to
// another path, not under another key; and a file from before R441 is never
// taken for a sealed one.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHUNK_SIZE,
  isSealed,
  MAX_CHUNK_SIZE,
  openFile,
  SEALED_MAGIC,
  SealedFileError,
  sealedKid,
  sealFile,
} from "@/utils/storage/sealedFile";

const WHERE =
  "chat-docs/00000000-0000-4000-8000-00000000a11c/11111111-1111-4111-8111-111111111111.docx";

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

const bytes = (n: number, seed = 7) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

async function setup() {
  const key = await aesKey();
  const keys = new Map([["kid-alice-1", key]]);
  const keyFor = async (kid: string) => {
    const k = keys.get(kid);
    if (!k) throw new Error(`no key ${kid}`);
    return k;
  };
  return { key: { key, kid: "kid-alice-1" }, keyFor, keys };
}

/** Where each chunk of a sealed file sits, so a test can cut or move one. */
function layout(sealed: Uint8Array, chunkSize: number) {
  const kidLength = sealed[SEALED_MAGIC.length]!;
  const head = SEALED_MAGIC.length + 1 + kidLength + 8 + 4;
  const stride = chunkSize + 16;
  const chunks: Array<[number, number]> = [];
  for (let at = head; at < sealed.length; at += stride) {
    chunks.push([at, Math.min(sealed.length, at + stride)]);
  }
  return { head, chunks };
}

describe("a sealed file opens to what was sealed", () => {
  it.each([
    ["an empty file", 0, 64],
    ["one byte", 1, 64],
    ["less than a chunk", 50, 64],
    ["exactly one chunk", 64, 64],
    ["exactly three chunks", 192, 64],
    ["three chunks and a bit", 200, 64],
    ["the default chunk size", DEFAULT_CHUNK_SIZE + 3, undefined],
  ])("%s", async (_label, size, chunkSize) => {
    const { key, keyFor } = await setup();
    const plain = bytes(size);
    const sealed = await sealFile(plain, key, WHERE, { chunkSize });
    expect(isSealed(sealed)).toBe(true);
    expect(sealedKid(sealed)).toBe("kid-alice-1");
    // Compared as buffers: a deep equal walks a megabyte one element at a time.
    expect(Buffer.from(await openFile(sealed, keyFor, WHERE)).equals(Buffer.from(plain))).toBe(
      true,
    );
  });

  it("keeps none of the plaintext, and differs each time it is sealed", async () => {
    const { key } = await setup();
    const plain = new TextEncoder().encode("Quarterly forecast: confidential ".repeat(40));
    const a = await sealFile(plain, key, WHERE);
    const b = await sealFile(plain, key, WHERE);
    const text = new TextDecoder("latin1").decode(a);
    expect(text).not.toContain("Quarterly forecast");
    expect(a).not.toEqual(b);
  });
});

describe("a sealed file does not open when it was changed", () => {
  it("one byte of content changed", async () => {
    const { key, keyFor } = await setup();
    const sealed = await sealFile(bytes(100), key, WHERE, { chunkSize: 64 });
    sealed[sealed.length - 20] ^= 1;
    await expect(openFile(sealed, keyFor, WHERE)).rejects.toMatchObject({ reason: "tampered" });
  });

  it("the header's nonce prefix changed", async () => {
    const { key, keyFor } = await setup();
    const sealed = await sealFile(bytes(100), key, WHERE, { chunkSize: 64 });
    const at = SEALED_MAGIC.length + 1 + "kid-alice-1".length;
    sealed[at] ^= 1;
    await expect(openFile(sealed, keyFor, WHERE)).rejects.toMatchObject({ reason: "tampered" });
  });

  it("cut short at a chunk boundary", async () => {
    const { key, keyFor } = await setup();
    const sealed = await sealFile(bytes(192), key, WHERE, { chunkSize: 64 });
    const { chunks } = layout(sealed, 64);
    expect(chunks).toHaveLength(3);
    const cut = sealed.slice(0, chunks[1]![1]);
    await expect(openFile(cut, keyFor, WHERE)).rejects.toMatchObject({ reason: "tampered" });
  });

  it("a middle chunk dropped", async () => {
    const { key, keyFor } = await setup();
    const sealed = await sealFile(bytes(200), key, WHERE, { chunkSize: 64 });
    const { chunks } = layout(sealed, 64);
    const dropped = new Uint8Array([
      ...sealed.slice(0, chunks[1]![0]),
      ...sealed.slice(chunks[2]![0]),
    ]);
    await expect(openFile(dropped, keyFor, WHERE)).rejects.toMatchObject({ reason: "tampered" });
  });

  it("two chunks swapped", async () => {
    const { key, keyFor } = await setup();
    const sealed = await sealFile(bytes(200), key, WHERE, { chunkSize: 64 });
    const { chunks } = layout(sealed, 64);
    const [a, b] = [chunks[0]!, chunks[1]!];
    const swapped = new Uint8Array([
      ...sealed.slice(0, a[0]),
      ...sealed.slice(b[0], b[1]),
      ...sealed.slice(a[0], a[1]),
      ...sealed.slice(b[1]),
    ]);
    await expect(openFile(swapped, keyFor, WHERE)).rejects.toMatchObject({ reason: "tampered" });
  });

  it("copied to another path, as another owner's file", async () => {
    const { key, keyFor } = await setup();
    const sealed = await sealFile(bytes(100), key, WHERE);
    const elsewhere = WHERE.replace("00000000a11c", "000000000b0b");
    await expect(openFile(sealed, keyFor, elsewhere)).rejects.toMatchObject({
      reason: "tampered",
    });
  });

  it("under another key with the same fingerprint", async () => {
    const { key, keyFor, keys } = await setup();
    const sealed = await sealFile(bytes(100), key, WHERE);
    keys.set("kid-alice-1", await aesKey());
    await expect(openFile(sealed, keyFor, WHERE)).rejects.toBeInstanceOf(SealedFileError);
  });

  it("the key lookup's own refusal is what the caller gets", async () => {
    const { key } = await setup();
    const sealed = await sealFile(bytes(10), key, WHERE);
    const erased = Object.assign(new Error("This was stored under a user key that was erased"), {
      reason: "erased",
    });
    await expect(openFile(sealed, async () => Promise.reject(erased), WHERE)).rejects.toBe(erased);
  });
});

describe("what is and is not a sealed file", () => {
  it("an Office document, a Parquet file and an empty file are not", () => {
    expect(isSealed(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]))).toBe(false);
    expect(isSealed(new TextEncoder().encode("PAR1....PAR1"))).toBe(false);
    expect(isSealed(new Uint8Array())).toBe(false);
    expect(sealedKid(new TextEncoder().encode("PAR1....PAR1"))).toBeNull();
  });

  it.each([
    ["the magic alone", () => SEALED_MAGIC.slice()],
    ["a zero-length key fingerprint", () => new Uint8Array([...SEALED_MAGIC, 0])],
    ["a fingerprint longer than the file", () => new Uint8Array([...SEALED_MAGIC, 40, 0x61, 0x62])],
    [
      "a fingerprint that is not text",
      () => new Uint8Array([...SEALED_MAGIC, 2, 0x61, 0x0a, ...new Uint8Array(12)]),
    ],
    [
      "a chunk size of zero",
      () => new Uint8Array([...SEALED_MAGIC, 1, 0x61, ...new Uint8Array(8), 0, 0, 0, 0]),
    ],
    [
      "a chunk size above the most there is",
      () => {
        const n = MAX_CHUNK_SIZE + 1;
        return new Uint8Array([
          ...SEALED_MAGIC,
          1,
          0x61,
          ...new Uint8Array(8),
          (n >>> 24) & 0xff,
          (n >>> 16) & 0xff,
          (n >>> 8) & 0xff,
          n & 0xff,
        ]);
      },
    ],
    [
      "a header and no content",
      () => new Uint8Array([...SEALED_MAGIC, 1, 0x61, ...new Uint8Array(8), 0, 0, 0, 64]),
    ],
  ])("%s is malformed", async (_label, make) => {
    await expect(openFile(make(), async () => aesKey(), WHERE)).rejects.toMatchObject({
      reason: "malformed",
    });
  });

  it.each([
    ["zero", 0],
    ["above the most there is", MAX_CHUNK_SIZE + 1],
  ])("a header naming a chunk of %s is refused before a key is asked for", async (_label, n) => {
    // With content after it, so only the header's own check can refuse it.
    const file = new Uint8Array([
      ...SEALED_MAGIC,
      1,
      0x61,
      ...new Uint8Array(8),
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
      ...new Uint8Array(64),
    ]);
    let asked = 0;
    const err = await openFile(
      file,
      async () => {
        asked++;
        return aesKey();
      },
      WHERE,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "malformed" });
    expect((err as Error).message).toBe(`A sealed file names a chunk of ${n} bytes`);
    expect(asked).toBe(0);
  });

  it("a file ending inside a chunk's tag is malformed, not tampered", async () => {
    const { key, keyFor } = await setup();
    const sealed = await sealFile(bytes(100), key, WHERE, { chunkSize: 64 });
    const { chunks } = layout(sealed, 64);
    const cut = sealed.slice(0, chunks[1]![0] + 10);
    await expect(openFile(cut, keyFor, WHERE)).rejects.toMatchObject({ reason: "malformed" });
  });

  it("refuses to seal under a fingerprint the header cannot carry", async () => {
    const { key } = await setup();
    await expect(sealFile(bytes(4), { ...key, kid: "" }, WHERE)).rejects.toThrow(/fingerprint/);
    await expect(sealFile(bytes(4), { ...key, kid: "a b" }, WHERE)).rejects.toThrow(/fingerprint/);
    await expect(sealFile(bytes(4), key, WHERE, { chunkSize: 0 })).rejects.toThrow(/chunk/);
  });
});
