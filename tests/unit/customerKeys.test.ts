// R438: user keys and customer keys, through the real crypto module.
//
// Every assertion is about what an owner of data relies on: a value is under
// its owner's key and no other; erasing that key, destroying a customer key,
// or the customer revoking theirs leaves the value unreadable, and nobody
// else's; moving a user re-wraps one key and re-encrypts nothing; a key that
// cannot be had is an error, never a quiet fallback to the deployment's key.
//
// The store is in memory (tests/fixtures/keyStores.ts); the customer's KMS is
// a fake that wraps with its own AES key and can be revoked. The deployment
// key is PROVIDER_CREDS_SECRET, as an operator sets it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DataKeyUnavailableError,
  createKeyHierarchy,
  importDataKey,
  kidOfUserKey,
  unwrapLocal,
  wrapLocal,
  type CustomerKeyRow,
} from "@/utils/kms/keyHierarchy.server";
import type { Keyring } from "@/utils/kms/keyring.server";
import type { KeyProvider } from "@/utils/kms/types";
import {
  __setKeyHierarchyForTests,
  currentKid,
  customerKeyProvider,
  decryptJson,
  encryptJson,
  keyHierarchy,
  reEncryptDeep,
} from "@/utils/providers/crypto.server";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";
const CAROL = "00000000-0000-4000-8000-0000000ca201";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** A customer's KMS: its own AES key, which the customer can revoke. */
async function fakeKms(keyRef = "arn:aws:kms:eu-west-1:111122223333:key/acme") {
  const kek = await importDataKey(random(32));
  const aad = new TextEncoder().encode("fake-kms");
  const state = { revoked: false, unwraps: 0, wraps: 0 };
  const provider: KeyProvider = {
    id: "aws",
    keyRef,
    async wrapDek(dek) {
      state.wraps++;
      if (state.revoked) throw new Error("AccessDeniedException: the key is disabled");
      const w = await wrapLocal(kek, dek, aad, random);
      return { provider: "aws", keyRef, material: `${w.iv}.${w.material}` };
    },
    async unwrapDek(w) {
      state.unwraps++;
      if (state.revoked) throw new Error("AccessDeniedException: the key is disabled");
      const [iv, material] = w.material.split(".");
      return unwrapLocal(kek, material, iv, aad);
    },
    async probe() {
      return state.revoked
        ? { ok: false, detail: "the key is disabled" }
        : { ok: true, detail: "encrypt and decrypt allowed" };
    },
  };
  return { provider, state };
}

let mem: MemoryKeyStore;
let kms: Awaited<ReturnType<typeof fakeKms>>;

function useKeys(current: string, previous: string[] = []) {
  process.env.PROVIDER_CREDS_SECRET = current;
  if (previous.length) process.env.PROVIDER_CREDS_SECRET_OLD = previous.join(",");
  else delete process.env.PROVIDER_CREDS_SECRET_OLD;
}

/** A customer key in the store, made the way the admin card makes one. */
async function customerKey(name: string, where: "app" | "kms"): Promise<CustomerKeyRow> {
  const id = crypto.randomUUID();
  const provider = where === "app" ? "app" : "aws";
  const keyRef = where === "app" ? null : kms.provider.keyRef;
  const material = await keyHierarchy().makeCustomerKeyMaterial({
    id,
    name,
    provider,
    keyRef,
    endpoint: null,
  });
  const row: CustomerKeyRow = {
    id,
    name,
    provider,
    key_ref: keyRef,
    endpoint: null,
    ...material,
    created_at: new Date().toISOString(),
    destroyed_at: null,
  };
  mem.customerKeys.set(id, row);
  return row;
}

const original = {
  secret: process.env.PROVIDER_CREDS_SECRET,
  cache: process.env.DATA_KEY_CACHE_SECONDS,
};

beforeEach(async () => {
  useKeys(KEY_A);
  delete process.env.DATA_KEY_CACHE_SECONDS;
  mem = memoryKeyStore();
  kms = await fakeKms();
  __setKeyHierarchyForTests(mem.store, () => kms.provider);
});

afterEach(() => {
  __setKeyHierarchyForTests(null);
  vi.useRealTimers();
  if (original.secret) process.env.PROVIDER_CREDS_SECRET = original.secret;
  else delete process.env.PROVIDER_CREDS_SECRET;
  delete process.env.PROVIDER_CREDS_SECRET_OLD;
  if (original.cache === undefined) delete process.env.DATA_KEY_CACHE_SECONDS;
  else process.env.DATA_KEY_CACHE_SECONDS = original.cache;
});

const read = (b: { ciphertext: string; iv: string; kid?: string }) =>
  decryptJson(b.ciphertext, b.iv, b.kid);

describe("every user's values are under that user's own key", () => {
  it("stamps a value with its owner's key, one key per owner, not the deployment's", async () => {
    const a1 = await encryptJson({ token: "alice-1" }, { owner: ALICE });
    const a2 = await encryptJson({ token: "alice-2" }, { owner: ALICE });
    const b1 = await encryptJson({ token: "bob-1" }, { owner: BOB });
    expect(a1.kid).toBe(a2.kid);
    expect(a1.kid).not.toBe(b1.kid);
    expect(a1.kid).not.toBe(await currentKid());
    expect(mem.userKeys.map((k) => k.user_id).sort()).toEqual([ALICE, BOB].sort());
    expect(await read(a1)).toEqual({ token: "alice-1" });
    expect(await read(b1)).toEqual({ token: "bob-1" });
    // The deployment's key is not the value's key: without the user key's
    // row nothing opens it, cache or no cache.
    mem.userKeys.length = 0;
    keyHierarchy().forgetAll();
    await expect(read(a1)).rejects.toThrow(/does not hold/);
  });

  it("makes one key for an owner's first saves even when they race", async () => {
    const blobs = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => encryptJson({ n }, { owner: ALICE })),
    );
    expect(new Set(blobs.map((b) => b.kid)).size).toBe(1);
    expect(mem.userKeys.filter((k) => k.user_id === ALICE)).toHaveLength(1);
    for (const [i, b] of blobs.entries()) expect(await read(b)).toEqual({ n: i + 1 });
  });

  it("binds a wrapped user key to its user: moved onto another user's row, it does not unwrap", async () => {
    const a = await encryptJson("alice", { owner: ALICE });
    await encryptJson("bob", { owner: BOB });
    const alice = mem.userKeys.find((k) => k.user_id === ALICE)!;
    // Someone with write access to the table relabels Alice's key as Bob's.
    alice.user_id = BOB;
    keyHierarchy().forgetAll();
    await expect(read(a)).rejects.toMatchObject({ reason: "tampered" });
  });

  it("refuses a user key whose material unwraps to another key", async () => {
    const a = await encryptJson("alice", { owner: ALICE });
    await encryptJson("bob", { owner: BOB });
    const alice = mem.userKeys.find((k) => k.user_id === ALICE)!;
    const bob = mem.userKeys.find((k) => k.user_id === BOB)!;
    // Bob's wrapped key and nonce, under Alice's fingerprint: the AAD binds
    // the fingerprint, so this fails before any fingerprint compare.
    alice.material = bob.material;
    alice.iv = bob.iv;
    keyHierarchy().forgetAll();
    await expect(read(a)).rejects.toBeInstanceOf(DataKeyUnavailableError);
  });
});

describe("erasing a user's key", () => {
  it("leaves every value of theirs unreadable, says why, and gives the next save a new key", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "0";
    const before = await encryptJson({ token: "alice" }, { owner: ALICE });
    const bob = await encryptJson({ token: "bob" }, { owner: BOB });
    mem.erase(ALICE);
    await expect(read(before)).rejects.toThrow(/erased on \d{4}-\d{2}-\d{2}; enter it again/);
    await expect(read(before)).rejects.toMatchObject({ reason: "erased" });
    expect(await read(bob)).toEqual({ token: "bob" });
    const after = await encryptJson({ token: "alice-again" }, { owner: ALICE });
    expect(after.kid).not.toBe(before.kid);
    expect(await read(after)).toEqual({ token: "alice-again" });
    await expect(read(before)).rejects.toMatchObject({ reason: "erased" });
  });

  it("takes effect in another process when its cache runs out, not before", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T10:00:00Z") });
    process.env.DATA_KEY_CACHE_SECONDS = "300";
    const blob = await encryptJson("alice", { owner: ALICE });
    expect(await read(blob)).toBe("alice"); // cached now
    mem.erase(ALICE); // as another process's admin call does
    expect(await read(blob)).toBe("alice"); // this process still has it
    vi.setSystemTime(new Date("2026-11-02T10:05:01Z"));
    await expect(read(blob)).rejects.toMatchObject({ reason: "erased" });
  });
});

describe("rotating the deployment key re-wraps user keys and re-encrypts no value", () => {
  it("keeps values readable after the old secret is gone, once the key is re-wrapped", async () => {
    const blob = await encryptJson({ token: "alice" }, { owner: ALICE });
    const kidA = await currentKid();
    expect(mem.userKeys[0].wrapped_by).toBe(kidA);
    // The operator rotates: B is current, A still accepted.
    useKeys(KEY_B, [KEY_A]);
    expect(await read(blob)).toEqual({ token: "alice" });
    // The next save (or the sweep, which runs the same) re-wraps the key.
    await encryptJson({ token: "alice-2" }, { owner: ALICE });
    expect(mem.userKeys[0].wrapped_by).toBe(await currentKid());
    expect(mem.userKeys).toHaveLength(1);
    // A is dropped. The value written under A's era still reads: its key moved.
    useKeys(KEY_B);
    expect(await read(blob)).toEqual({ token: "alice" });
  });

  it("says which deployment key it needs when the old secret went before the re-wrap", async () => {
    const blob = await encryptJson("alice", { owner: ALICE });
    const kidA = await currentKid();
    useKeys(KEY_B);
    await expect(read(blob)).rejects.toThrow(new RegExp(`deployment key ${kidA}`));
    await expect(read(blob)).rejects.toMatchObject({ reason: "unheld" });
    // And a save does not make a fresh key in its place: that would orphan
    // every value the old one encrypted without anyone deciding to.
    await expect(encryptJson("x", { owner: ALICE })).rejects.toMatchObject({ reason: "unheld" });
    expect(mem.userKeys).toHaveLength(1);
  });
});

describe("before the migration", () => {
  it("writes an owner's values under the deployment key, as before", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    const blob = await encryptJson("x", { owner: ALICE });
    expect(blob.kid).toBe(await currentKid());
    expect(await read(blob)).toBe("x");
  });

  it("does not fall back on any other store failure", async () => {
    __setKeyHierarchyForTests({
      ...mem.store,
      memberships: async () => {
        throw new Error("Could not read the user's customer key: connection reset");
      },
    });
    await expect(encryptJson("x", { owner: ALICE })).rejects.toThrow(/connection reset/);
  });
});

describe("a customer key held by the app", () => {
  it("wraps its members' keys, and destroying it erases theirs and nobody else's", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "0";
    const acme = await customerKey("Acme", "app");
    mem.assignUser(acme.id, ALICE);
    const a = await encryptJson({ token: "alice" }, { owner: ALICE });
    const b = await encryptJson({ token: "bob" }, { owner: BOB });
    const aliceKey = mem.userKeys.find((k) => k.user_id === ALICE)!;
    expect(aliceKey.customer_key_id).toBe(acme.id);
    expect(aliceKey.wrapped_by).toBe(acme.kid);
    expect(await read(a)).toEqual({ token: "alice" });
    mem.destroy(acme.id);
    keyHierarchy().forgetCustomer(acme.id);
    await expect(read(a)).rejects.toMatchObject({ reason: "erased" });
    expect(await read(b)).toEqual({ token: "bob" });
  });

  it("binds its wrapped form to its own row: another customer's, copied in, does not unwrap", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "0";
    const acme = await customerKey("Acme", "app");
    const globex = await customerKey("Globex", "app");
    mem.assignUser(globex.id, BOB);
    const b = await encryptJson("bob", { owner: BOB });
    // Someone with write access swaps Acme's key into Globex's row.
    const g = mem.customerKeys.get(globex.id)!;
    Object.assign(g, { material: acme.material, iv: acme.iv, kid: acme.kid });
    // Refused at the customer key itself, not later at Bob's key.
    await expect(read(b)).rejects.toThrow(/customer key "Globex" did not unwrap/);
  });

  it("is re-wrapped by a rotated deployment key", async () => {
    const acme = await customerKey("Acme", "app");
    mem.assignUser(acme.id, ALICE);
    const a = await encryptJson("alice", { owner: ALICE });
    useKeys(KEY_B, [KEY_A]);
    const next = await keyHierarchy().rewrapAppCustomerKey(mem.customerKeys.get(acme.id)!);
    expect(next?.wrapped_by).toBe(await currentKid());
    Object.assign(mem.customerKeys.get(acme.id)!, next);
    useKeys(KEY_B);
    keyHierarchy().forgetAll();
    expect(await read(a)).toBe("alice");
  });
});

describe("a customer key in the customer's own KMS", () => {
  it("stops every member's values when the customer revokes it, and only theirs", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "0";
    const acme = await customerKey("Acme", "kms");
    mem.assignUser(acme.id, ALICE);
    const a = await encryptJson({ token: "alice" }, { owner: ALICE });
    const b = await encryptJson({ token: "bob" }, { owner: BOB });
    expect(await read(a)).toEqual({ token: "alice" });

    kms.state.revoked = true;
    const refused = read(a);
    await expect(refused).rejects.toMatchObject({ reason: "refused" });
    await expect(read(a)).rejects.toThrow(/"Acme" \(arn:aws:kms:.*\) was refused.*disabled/);
    expect(await read(b)).toEqual({ token: "bob" });
    // A save for a member fails too, and nothing is written under any other key.
    const keysBefore = structuredClone(mem.userKeys);
    await expect(encryptJson("new", { owner: ALICE })).rejects.toMatchObject({
      reason: "refused",
    });
    expect(mem.userKeys).toEqual(keysBefore);

    // The customer turns it back on: nothing was lost.
    kms.state.revoked = false;
    expect(await read(a)).toEqual({ token: "alice" });
  });

  it("calls the KMS once per cache period, not per read, and does not hammer it when it is down", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T10:00:00Z") });
    process.env.DATA_KEY_CACHE_SECONDS = "300";
    const acme = await customerKey("Acme", "kms");
    mem.assignUser(acme.id, ALICE);
    const a = await encryptJson("alice", { owner: ALICE });
    keyHierarchy().forgetAll();
    const start = kms.state.unwraps;
    for (let i = 0; i < 10; i++) expect(await read(a)).toBe("alice");
    expect(kms.state.unwraps - start).toBe(1);

    keyHierarchy().forgetAll();
    kms.state.revoked = true;
    const down = kms.state.unwraps;
    for (let i = 0; i < 10; i++) await expect(read(a)).rejects.toMatchObject({ reason: "refused" });
    expect(kms.state.unwraps - down).toBe(1); // the failure is remembered for a moment
    vi.setSystemTime(new Date("2026-11-02T10:00:16Z"));
    await expect(read(a)).rejects.toMatchObject({ reason: "refused" });
    expect(kms.state.unwraps - down).toBe(2); // and asked again after it
  });

  it("refuses a key the KMS unwraps to other bytes", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "0";
    const acme = await customerKey("Acme", "kms");
    mem.assignUser(acme.id, ALICE);
    const a = await encryptJson("alice", { owner: ALICE });
    const real = kms.provider.unwrapDek.bind(kms.provider);
    kms.provider.unwrapDek = async () => random(32);
    await expect(read(a)).rejects.toThrow(/fingerprint is not/);
    kms.provider.unwrapDek = real;
  });
});

describe("customer keys, made and checked", () => {
  it("forgets a destroyed key in this process at once, cache or no cache", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "300";
    const acme = await customerKey("Acme", "app");
    mem.assignUser(acme.id, ALICE);
    const a = await encryptJson("alice", { owner: ALICE });
    expect(await read(a)).toBe("alice"); // cached
    mem.destroy(acme.id);
    keyHierarchy().forgetCustomer(acme.id); // what the destroy function does
    await expect(read(a)).rejects.toMatchObject({ reason: "erased" });
  });

  it("stores nothing when the KMS does not give back the key it wrapped", async () => {
    kms.provider.unwrapDek = async () => random(32);
    await expect(customerKey("Acme", "kms")).rejects.toThrow(/did not unwrap it to the same bytes/);
    expect(mem.customerKeys.size).toBe(0);
  });

  it("refuses a row whose key reference is another provider's than it says", () => {
    __setKeyHierarchyForTests(mem.store, null);
    const row: CustomerKeyRow = {
      id: crypto.randomUUID(),
      name: "Mislabelled",
      provider: "aws",
      key_ref: "https://acme-vault.vault.azure.net/keys/credentials",
      endpoint: null,
      material: "x",
      iv: null,
      wrapped_by: null,
      kid: "k",
      created_at: new Date().toISOString(),
      destroyed_at: null,
    };
    expect(() => customerKeyProvider(row)).toThrow(/is not a aws key/);
  });
});

describe("moving users between keys", () => {
  it("re-wraps the user's one key on assignment: the same key, its old values now the customer's", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "0";
    const before = await encryptJson({ token: "written before" }, { owner: ALICE });
    const acme = await customerKey("Acme", "kms");
    mem.assignUser(acme.id, ALICE);
    expect(await keyHierarchy().reconcile(ALICE)).toBe("moved");
    const k = mem.userKeys.find((x) => x.user_id === ALICE)!;
    expect(k.kid).toBe(before.kid);
    expect(k.customer_key_id).toBe(acme.id);
    expect(mem.userKeys).toHaveLength(1);
    expect(await read(before)).toEqual({ token: "written before" });
    // Proof the old value is under the customer's control now.
    kms.state.revoked = true;
    await expect(read(before)).rejects.toMatchObject({ reason: "refused" });
    kms.state.revoked = false;

    // Removed again: back under the deployment's key, out of the customer's hands.
    mem.unassign((m) => m.userId === ALICE);
    expect(await keyHierarchy().reconcile(ALICE)).toBe("moved");
    expect(mem.userKeys[0].customer_key_id).toBeNull();
    kms.state.revoked = true;
    expect(await read(before)).toEqual({ token: "written before" });
    expect(await keyHierarchy().reconcile(ALICE)).toBe("unchanged");
  });

  it("follows group membership, and a direct assignment wins over a group's", async () => {
    const acme = await customerKey("Acme", "app");
    const globex = await customerKey("Globex", "app");
    mem.group("g-acme", "acme-staff", [ALICE, CAROL]);
    mem.group("g-globex", "globex-staff", [CAROL]);
    mem.assignGroup(acme.id, "g-acme");
    await encryptJson("alice", { owner: ALICE });
    expect(mem.userKeys.find((k) => k.user_id === ALICE)?.customer_key_id).toBe(acme.id);

    // Carol is in both groups: two customer keys, so nothing new is stored.
    mem.assignGroup(globex.id, "g-globex");
    const clash = encryptJson("carol", { owner: CAROL });
    await expect(clash).rejects.toMatchObject({ reason: "conflict" });
    await expect(encryptJson("carol", { owner: CAROL })).rejects.toThrow(
      /"Acme" \(group acme-staff\).*"Globex" \(group globex-staff\)/,
    );
    expect(mem.userKeys.some((k) => k.user_id === CAROL)).toBe(false);

    // An admin assigns her directly: that decides it.
    mem.assignUser(globex.id, CAROL);
    const c = await encryptJson("carol", { owner: CAROL });
    expect(mem.userKeys.find((k) => k.user_id === CAROL)?.customer_key_id).toBe(globex.id);
    expect(await read(c)).toBe("carol");
  });

  it("refuses to store for a member of a destroyed key rather than quietly use another", async () => {
    const acme = await customerKey("Acme", "app");
    mem.assignUser(acme.id, ALICE);
    mem.customerKeys.get(acme.id)!.destroyed_at = new Date().toISOString();
    await expect(encryptJson("x", { owner: ALICE })).rejects.toMatchObject({ reason: "destroyed" });
    expect(mem.userKeys).toHaveLength(0);
  });
});

describe("the sweep's re-encryption, per owner", () => {
  it("moves a deployment-key value onto its owner's key, and leaves one it cannot read", async () => {
    const legacy = await encryptJson({ token: "old" }, { owner: null });
    expect(legacy.kid).toBe(await currentKid());
    const r = await reEncryptDeep({ api_key_enc: legacy }, { owner: ALICE });
    expect(r).toMatchObject({ migrated: 1, failed: 0 });
    const moved = r.value.api_key_enc;
    expect(moved.kid).toBe(mem.userKeys.find((k) => k.user_id === ALICE)!.kid);
    expect(await read(moved)).toEqual({ token: "old" });
    // Again: already on the owner's key, nothing to do.
    expect(await reEncryptDeep(r.value, { owner: ALICE })).toMatchObject({
      migrated: 0,
      alreadyCurrent: 1,
    });
  });

  it("makes no user key for a value with nothing encrypted in it", async () => {
    await reEncryptDeep({ name: "plain", n: 1 }, { owner: ALICE });
    expect(mem.userKeys).toHaveLength(0);
  });

  it("counts every blob failed when the owner's key cannot be had, and changes none", async () => {
    const acme = await customerKey("Acme", "kms");
    const legacy = await encryptJson("old", { owner: null });
    mem.assignUser(acme.id, ALICE);
    kms.state.revoked = true;
    keyHierarchy().forgetAll();
    const r = await reEncryptDeep({ a: legacy, b: [legacy] }, { owner: ALICE });
    expect(r).toMatchObject({ migrated: 0, failed: 2 });
    expect(r.value.a).toBe(legacy);
  });
});

describe("the hierarchy on its own", () => {
  it("never gives a user key a fingerprint the deployment's keyring uses", async () => {
    const first = random(32);
    const second = random(32);
    const draws = [first, second];
    const clash = await kidOfUserKey(first);
    // Computed now: the hierarchy zeroes a key's bytes once it has used them.
    const expected = await kidOfUserKey(second);
    const deploymentKey = await importDataKey(random(32));
    const ring = {
      config: { provider: "env" },
      current: { key: deploymentKey, kid: clash, source: "env" },
      previous: [],
      activeDek: null,
    } as unknown as Keyring;
    const h = createKeyHierarchy({
      store: mem.store,
      instance: async () => ring,
      customerProvider: () => kms.provider,
      cacheMs: () => 0,
      random: (n) => (n === 32 ? (draws.shift() ?? random(32)) : random(n)),
    });
    const k = await h.writeKey(ALICE);
    expect(k.kid).toBe(expected);
    expect(second.every((x) => x === 0)).toBe(true);
    expect(k.kid).not.toBe(clash);
  });
});
