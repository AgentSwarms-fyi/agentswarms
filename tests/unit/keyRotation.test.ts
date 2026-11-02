// Credential key rotation: the crypto contract, exercised for real.
//
// This calls the actual crypto module — no re-implementation — and drives it
// through a full rotation by swapping process.env between calls, which is
// exactly what an operator does.
//
// Verified against the live database before this test existed: a value written
// under key A, swept, then read back with key A REMOVED from the keyring
// entirely. That last step is the one that matters. A weaker check leaves the
// old key configured, so everything decrypts whether or not the sweep did
// anything, and a no-op sweep looks identical to a working one.
//
// It also caught a real hazard: reEncryptAllToCurrentKey is GLOBAL. Running it
// with a throwaway key re-encrypts every real credential onto that key, and
// reverting the env afterwards leaves them unreadable. The reverse fails safe —
// an undecryptable blob is counted and left byte-identical, never replaced —
// but the forward direction is a genuine foot-gun and is documented as one.
import { afterEach, describe, expect, it } from "vitest";
import {
  blobKeyStatus,
  currentKid,
  decryptJson,
  encryptJson,
  isEncryptedBlob,
  keyringFingerprints,
  reEncryptBlob,
  reEncryptDeep,
} from "@/utils/providers/crypto.server";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);

function useKeys(current: string, previous: string[] = []) {
  process.env.PROVIDER_CREDS_SECRET = current;
  if (previous.length) process.env.PROVIDER_CREDS_SECRET_OLD = previous.join(",");
  else delete process.env.PROVIDER_CREDS_SECRET_OLD;
}

const original = process.env.PROVIDER_CREDS_SECRET;
afterEach(() => {
  if (original) process.env.PROVIDER_CREDS_SECRET = original;
  else delete process.env.PROVIDER_CREDS_SECRET;
  delete process.env.PROVIDER_CREDS_SECRET_OLD;
});

describe("key fingerprints identify a key without exposing it", () => {
  it("stamps new ciphertext with the writing key's fingerprint", async () => {
    useKeys(KEY_A);
    const blob = await encryptJson("hello", { owner: null });
    expect(blob.kid).toBe(await currentKid());
  });

  it("never derives the fingerprint from the AES key itself", async () => {
    // The AES key is SHA-256(secret); the kid must be SHA-256(domain + secret).
    // If the domain separator were dropped, the kid would be the first 12 hex
    // characters OF THE AES KEY — 48 bits of key material published in every
    // row and in the admin UI.
    //
    // Mutation testing earned this. The first version asserted only that the
    // kid was not a substring of the secret, which is true either way, so
    // removing the domain separator survived. Compute the un-separated
    // derivation and require the kid to differ from it.
    useKeys(KEY_A);
    const kid = await currentKid();
    expect(kid).toHaveLength(12);

    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY_A));
    const rawHex = [...new Uint8Array(raw)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(kid).not.toBe(rawHex.slice(0, 12));
    expect(rawHex).not.toContain(kid);
  });

  it("gives different keys different fingerprints", async () => {
    useKeys(KEY_A);
    const a = await currentKid();
    useKeys(KEY_B);
    expect(await currentKid()).not.toBe(a);
  });

  it("reports the whole keyring, current first", async () => {
    useKeys(KEY_B, [KEY_A]);
    const fp = await keyringFingerprints();
    useKeys(KEY_A);
    const aKid = await currentKid();
    expect(fp.previous).toContain(aKid);
    expect(fp.current).not.toBe(aKid);
  });

  it("ignores a previous key that repeats the current one", async () => {
    useKeys(KEY_A, [KEY_A]);
    expect((await keyringFingerprints()).previous).toEqual([]);
  });
});

describe("decryption spans the keyring", () => {
  it("reads a blob written under a previous key", async () => {
    useKeys(KEY_A);
    const blob = await encryptJson({ token: "secret-value" }, { owner: null });
    useKeys(KEY_B, [KEY_A]);
    expect(await decryptJson(blob.ciphertext, blob.iv, blob.kid)).toEqual({
      token: "secret-value",
    });
  });

  it("still works for callers that pass no kid at all", async () => {
    // Every pre-existing call site is decryptJson(ciphertext, iv, undefined). Those must
    // keep working, which is why kid is advisory rather than required.
    useKeys(KEY_A);
    const blob = await encryptJson("legacy", { owner: null });
    useKeys(KEY_B, [KEY_A]);
    expect(await decryptJson(blob.ciphertext, blob.iv, undefined)).toBe("legacy");
  });

  it("refuses when no configured key can read it", async () => {
    useKeys(KEY_A);
    const blob = await encryptJson("x", { owner: null });
    useKeys(KEY_C);
    await expect(decryptJson(blob.ciphertext, blob.iv, blob.kid)).rejects.toThrow();
  });

  it("throws rather than returning garbage under a wrong key", async () => {
    // AES-GCM authenticates, so a wrong key fails loudly. Without that, rotation
    // could quietly replace a credential with nonsense.
    useKeys(KEY_A);
    const blob = await encryptJson("real", { owner: null });
    useKeys(KEY_B);
    await expect(decryptJson(blob.ciphertext, blob.iv, undefined)).rejects.toThrow();
  });
});

describe("re-encryption moves a blob onto the current key", () => {
  it("rewrites a blob from an old key and keeps the plaintext", async () => {
    useKeys(KEY_A);
    const blob = await encryptJson({ a: 1 }, { owner: null });
    useKeys(KEY_B, [KEY_A]);
    const { blob: next, changed } = await reEncryptBlob(blob, { owner: null });
    expect(changed).toBe(true);
    expect(next.kid).toBe(await currentKid());
    expect(next.ciphertext).not.toBe(blob.ciphertext);

    // The decisive check: retire the old key entirely.
    useKeys(KEY_B);
    expect(await decryptJson(next.ciphertext, next.iv, next.kid)).toEqual({ a: 1 });
  });

  it("skips a blob already on the current key", async () => {
    useKeys(KEY_A);
    const blob = await encryptJson("x", { owner: null });
    const { blob: same, changed } = await reEncryptBlob(blob, { owner: null });
    expect(changed).toBe(false);
    expect(same.ciphertext).toBe(blob.ciphertext);
  });

  it("finds blobs at any depth, which is why no path list is hardcoded", async () => {
    // The real rows differ in shape: user_secrets.value is the blob itself,
    // integrations nests it at config.api_key_enc. A walker handles both.
    useKeys(KEY_A);
    const nested = {
      name: "conn",
      config: { api_key_enc: await encryptJson("k1", { owner: null }), plain: "not-a-secret" },
      list: [{ tok: await encryptJson("k2", { owner: null }) }],
    };
    useKeys(KEY_B, [KEY_A]);
    const r = await reEncryptDeep(nested, { owner: null });
    expect(r.migrated).toBe(2);
    expect(r.failed).toBe(0);

    useKeys(KEY_B);
    const out = r.value as typeof nested;
    expect(
      await decryptJson(out.config.api_key_enc.ciphertext, out.config.api_key_enc.iv, undefined),
    ).toBe("k1");
    expect(await decryptJson(out.list[0].tok.ciphertext, out.list[0].tok.iv, undefined)).toBe("k2");
    expect(out.config.plain).toBe("not-a-secret");
  });

  it("is idempotent — a second pass migrates nothing", async () => {
    useKeys(KEY_A);
    const v = { s: await encryptJson("x", { owner: null }) };
    useKeys(KEY_B, [KEY_A]);
    const first = await reEncryptDeep(v, { owner: null });
    const second = await reEncryptDeep(first.value, { owner: null });
    expect(first.migrated).toBe(1);
    expect(second.migrated).toBe(0);
    expect(second.alreadyCurrent).toBe(1);
  });

  it("LEAVES an undecryptable blob exactly as it was", async () => {
    // The safety property. A blob written under a key nobody has must be
    // reported, never replaced — otherwise a misconfigured keyring destroys
    // credentials instead of failing.
    useKeys(KEY_A);
    const orphan = await encryptJson("unreachable", { owner: null });
    useKeys(KEY_C);
    const r = await reEncryptDeep({ orphan }, { owner: null });
    expect(r.failed).toBe(1);
    expect(r.migrated).toBe(0);
    expect((r.value as { orphan: typeof orphan }).orphan).toEqual(orphan);
  });
});

describe("status counts tell an operator what a sweep would do", () => {
  it("separates current, older and unstamped blobs", async () => {
    useKeys(KEY_A);
    const old = await encryptJson("old", { owner: null });
    const legacy = { ciphertext: old.ciphertext, iv: old.iv }; // no kid
    useKeys(KEY_B, [KEY_A]);
    const fresh = await encryptJson("new", { owner: null });

    const s = await blobKeyStatus({ old, legacy, fresh });
    expect(s.total).toBe(3);
    expect(s.onCurrent).toBe(1);
    expect(s.onOther).toBe(1);
    expect(s.legacy).toBe(1);
  });

  it("counts a blob on a key this server does not hold as unreadable, not as older", async () => {
    // R432: after a switch between key providers, or with a secret dropped
    // from PROVIDER_CREDS_SECRET_OLD, these were "on an older key" under
    // "These still decrypt". They do not, and a sweep cannot move them.
    useKeys(KEY_C);
    const orphan = await encryptJson("on C", { owner: null });
    useKeys(KEY_A);
    const old = await encryptJson("on A", { owner: null });
    useKeys(KEY_B, [KEY_A]);
    const fresh = await encryptJson("on B", { owner: null });

    const s = await blobKeyStatus({ orphan, nested: { old, more: [orphan] }, fresh });
    expect(s).toEqual({
      total: 4,
      onCurrent: 1,
      onOther: 1,
      unreadable: 2,
      unreadableKids: [orphan.kid],
      legacy: 0,
    });
  });

  it("recognises a stored blob by shape", () => {
    expect(isEncryptedBlob({ ciphertext: "a", iv: "b" })).toBe(true);
    expect(isEncryptedBlob({ ciphertext: "a" })).toBe(false);
    expect(isEncryptedBlob("nope")).toBe(false);
    expect(isEncryptedBlob(null)).toBe(false);
  });
});
