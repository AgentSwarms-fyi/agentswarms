// R438: the database store, the card's counts and the sweep, over tables.
//
// keyStore.server, keyRotation.server and the crypto module run as they do in
// the app; only the PostgREST client is an in-memory fake with the
// migration's unique constraints (tests/fixtures/fakePostgrest.ts). The
// customer's KMS is never called here: these customer keys are held by the
// app.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as null | { from: unknown; rpc: unknown } }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (db.current as Record<string | symbol, unknown>)[prop] },
  ),
}));

import { KeyStoreMissingError, type CustomerKeyRow } from "@/utils/kms/keyHierarchy.server";
import { supabaseKeyStore } from "@/utils/kms/keyStore.server";
import {
  __setKeyHierarchyForTests,
  currentKid,
  decryptJson,
  encryptJson,
  keyHierarchy,
} from "@/utils/providers/crypto.server";
import {
  ENCRYPTED_TABLES,
  expectedCustomerKeys,
  keyContext,
  keyEncryptionStatus,
  reEncryptAllToCurrentKey,
  reEncryptOwners,
  statusTotals,
} from "@/utils/providers/keyRotation.server";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";
const CAROL = "00000000-0000-4000-8000-0000000ca201";
const DAVE = "00000000-0000-4000-8000-00000000da7e";

let fake: FakeDb;

function useKeys(current: string, previous: string[] = []) {
  process.env.PROVIDER_CREDS_SECRET = current;
  if (previous.length) process.env.PROVIDER_CREDS_SECRET_OLD = previous.join(",");
  else delete process.env.PROVIDER_CREDS_SECRET_OLD;
}

function emptyTables() {
  const t: Record<string, Record<string, unknown>[]> = {
    user_keys: [],
    customer_keys: [],
    customer_key_members: [],
    iam_group_members: [],
    iam_groups: [],
  };
  for (const name of ENCRYPTED_TABLES) t[name] = [];
  return t;
}

async function appCustomerKey(name: string): Promise<CustomerKeyRow> {
  const id = crypto.randomUUID();
  const m = await keyHierarchy().makeCustomerKeyMaterial({
    id,
    name,
    provider: "app",
    keyRef: null,
    endpoint: null,
  });
  const row = {
    id,
    name,
    provider: "app" as const,
    key_ref: null,
    endpoint: null,
    ...m,
    created_at: new Date().toISOString(),
    destroyed_at: null,
  };
  fake.tables.customer_keys.push(row);
  return row;
}

beforeEach(() => {
  useKeys(KEY_A);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest(emptyTables());
  db.current = fake.client;
  __setKeyHierarchyForTests(null);
});

afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.PROVIDER_CREDS_SECRET_OLD;
  delete process.env.DATA_KEY_CACHE_SECONDS;
});

describe("the database store", () => {
  it("keeps one live key per user and unique fingerprints, and says conflict", async () => {
    const store = supabaseKeyStore();
    const row = {
      user_id: ALICE,
      kid: "k1",
      material: "m",
      iv: "i",
      customer_key_id: null,
      wrapped_by: "w",
    };
    expect(await store.insertUserKey(row)).toMatchObject({ user_id: ALICE, kid: "k1" });
    expect(await store.insertUserKey({ ...row, kid: "k2" })).toBe("conflict");
    expect(await store.insertUserKey({ ...row, user_id: BOB })).toBe("conflict");
    expect((await store.activeUserKey(ALICE))?.kid).toBe("k1");
    expect((await store.userKeyByKid("k1"))?.user_id).toBe(ALICE);
  });

  it("re-wraps only from the wrapper it was read with", async () => {
    const store = supabaseKeyStore();
    const made = await store.insertUserKey({
      user_id: ALICE,
      kid: "k1",
      material: "m",
      iv: "i",
      customer_key_id: null,
      wrapped_by: "old",
    });
    if (made === "conflict") throw new Error("unexpected");
    const to = { material: "m2", iv: "i2", wrapped_by: "new", customer_key_id: null };
    expect(
      await store.rewrapUserKey(made.id, { wrapped_by: "stale", customer_key_id: null }, to),
    ).toBe(false);
    expect(
      await store.rewrapUserKey(made.id, { wrapped_by: "old", customer_key_id: null }, to),
    ).toBe(true);
    expect(
      await store.rewrapUserKey(made.id, { wrapped_by: "old", customer_key_id: null }, to),
    ).toBe(false);
  });

  it("reads a user's memberships, direct and through groups, with names", async () => {
    const acme = await appCustomerKey("Acme");
    fake.tables.iam_groups.push({ id: "g1", name: "acme-staff" });
    fake.tables.iam_group_members.push({ group_id: "g1", user_id: ALICE });
    fake.tables.customer_key_members.push({
      id: "m1",
      customer_key_id: acme.id,
      group_id: "g1",
      user_id: null,
    });
    fake.tables.customer_key_members.push({
      id: "m2",
      customer_key_id: acme.id,
      user_id: BOB,
      group_id: null,
    });
    expect(await supabaseKeyStore().memberships(ALICE)).toEqual([
      {
        via: "group",
        customerKeyId: acme.id,
        customerKeyName: "Acme",
        groupId: "g1",
        groupName: "acme-staff",
      },
    ]);
    expect(await supabaseKeyStore().memberships(BOB)).toEqual([
      { via: "user", customerKeyId: acme.id, customerKeyName: "Acme" },
    ]);
    expect(await supabaseKeyStore().memberships(CAROL)).toEqual([]);
  });

  it("tells a missing table from any other failure", async () => {
    delete fake.tables.user_keys;
    await expect(supabaseKeyStore().activeUserKey(ALICE)).rejects.toBeInstanceOf(
      KeyStoreMissingError,
    );
    db.current = {
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => ({
              maybeSingle: async () => ({
                data: null,
                error: { code: "08006", message: "connection lost" },
              }),
            }),
          }),
        }),
      }),
      rpc: fake.client.rpc,
    };
    const err = await supabaseKeyStore()
      .activeUserKey(ALICE)
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(KeyStoreMissingError);
    expect(String(err)).toMatch(/connection lost/);
  });
});

describe("who should be under which key", () => {
  it("lets a direct assignment win and calls two groups' keys a conflict", () => {
    const usersOf = new Map([
      ["g1", [ALICE, CAROL]],
      ["g2", [CAROL, BOB]],
    ]);
    const exp = expectedCustomerKeys(
      [
        { customer_key_id: "acme", group_id: "g1", user_id: null },
        { customer_key_id: "globex", group_id: "g2", user_id: null },
        // Bob's group is Globex's, but he is assigned to Acme himself.
        { customer_key_id: "acme", group_id: null, user_id: BOB },
        // Dave is in no group: his direct assignment alone.
        { customer_key_id: "globex", group_id: null, user_id: DAVE },
      ],
      usersOf,
    );
    expect(exp.get(ALICE)).toEqual({ customerKeyId: "acme" });
    expect(exp.get(BOB)).toEqual({ customerKeyId: "acme" });
    expect(exp.get(DAVE)).toEqual({ customerKeyId: "globex" });
    expect(exp.get(CAROL)).toEqual({ conflict: ["acme", "globex"] });
  });
});

describe("the card's counts", () => {
  it("count a value as current only on its owner's live key, and name an erased one", async () => {
    const onAlice = await encryptJson("a", { owner: ALICE });
    const onDeployment = await encryptJson("b", { owner: null });
    const onBob = await encryptJson("c", { owner: BOB });
    // Bob's key is erased; his value no longer reads.
    const bobKey = fake.tables.user_keys.find((k) => k.user_id === BOB)!;
    Object.assign(bobKey, { material: null, iv: null, erased_at: "2026-11-02T09:00:00Z" });
    fake.tables.user_secrets.push(
      { id: "s1", user_id: ALICE, value: onAlice },
      { id: "s2", user_id: ALICE, value: onDeployment },
      { id: "s3", user_id: BOB, value: onBob },
    );
    fake.tables.slack_workspaces.push({ id: "w1", user_id: CAROL, bot_token_enc: onDeployment });
    const ctx = await keyContext();
    expect(ctx.summary).toMatchObject({ enabled: true, live: 1, erased: 1 });
    expect(ctx.summary.notes[onBob.kid!]).toBe("a user key erased on 2026-11-02");
    const totals = statusTotals(await keyEncryptionStatus(ctx));
    // Alice's own key: current. Alice's on the deployment key, and Carol's
    // (who has no key yet): still to move. Bob's: unreadable, by its key.
    expect(totals).toMatchObject({
      blobs: 4,
      onCurrent: 1,
      onOther: 2,
      unreadable: 1,
      unreadableKids: [onBob.kid],
    });
  });

  it("are the deployment key's, as before, while the tables are not there", async () => {
    delete fake.tables.user_keys;
    const blob = await encryptJson("x", { owner: ALICE });
    expect(blob.kid).toBe(await currentKid());
    fake.tables.user_secrets.push({ id: "s1", user_id: ALICE, value: blob });
    const ctx = await keyContext();
    expect(ctx.summary.enabled).toBe(false);
    expect(statusTotals(await keyEncryptionStatus(ctx))).toMatchObject({ blobs: 1, onCurrent: 1 });
  });
});

describe("the sweep", () => {
  it("moves values onto owners' keys, re-wraps keys after a rotation, and covers every encrypted table", async () => {
    const legacy = await encryptJson({ token: "t" }, { owner: null });
    for (const [i, table] of ENCRYPTED_TABLES.entries()) {
      fake.tables[table].push({ id: `r${i}`, user_id: ALICE, secret_enc: legacy });
    }
    const first = await reEncryptAllToCurrentKey();
    expect(first.totalMigrated).toBe(ENCRYPTED_TABLES.length);
    expect(first.totalFailed).toBe(0);
    const alice = fake.tables.user_keys.find((k) => k.user_id === ALICE)!;
    for (const table of ENCRYPTED_TABLES) {
      const v = fake.tables[table][0].secret_enc as { kid: string };
      expect(v.kid).toBe(alice.kid);
    }

    // Rotation: the sweep re-wraps Alice's key and re-encrypts nothing.
    const kidA = await currentKid();
    useKeys(KEY_B, [KEY_A]);
    const second = await reEncryptAllToCurrentKey();
    expect(second).toMatchObject({ totalMigrated: 0, userKeysRewrapped: 1, totalFailed: 0 });
    expect(alice.wrapped_by).not.toBe(kidA);
    useKeys(KEY_B);
    keyHierarchy().forgetAll();
    const v = fake.tables.user_secrets[0].secret_enc as {
      ciphertext: string;
      iv: string;
      kid: string;
    };
    expect(await decryptJson(v.ciphertext, v.iv, v.kid)).toEqual({ token: "t" });
  });

  it("moves a member under their customer key, re-wraps an app-held customer key, and reports a conflict", async () => {
    const acme = await appCustomerKey("Acme");
    const globex = await appCustomerKey("Globex");
    await encryptJson("alice", { owner: ALICE });
    await encryptJson("carol", { owner: CAROL });
    fake.tables.iam_groups.push({ id: "g1", name: "acme" }, { id: "g2", name: "globex" });
    fake.tables.iam_group_members.push(
      { group_id: "g1", user_id: ALICE },
      { group_id: "g1", user_id: CAROL },
      { group_id: "g2", user_id: CAROL },
    );
    fake.tables.customer_key_members.push(
      { id: "m1", customer_key_id: acme.id, group_id: "g1", user_id: null },
      { id: "m2", customer_key_id: globex.id, group_id: "g2", user_id: null },
    );
    useKeys(KEY_B, [KEY_A]);
    const r = await reEncryptAllToCurrentKey();
    expect(r.customerKeysRewrapped).toBe(2);
    expect(r.userKeysRewrapped).toBe(1);
    expect(fake.tables.user_keys.find((k) => k.user_id === ALICE)!.customer_key_id).toBe(acme.id);
    expect(r.ownerFailures).toEqual([
      { userId: CAROL, error: expect.stringMatching(/different customer keys/) },
    ]);
    // Carol's key is where it was: readable, and not moved by a guess.
    expect(fake.tables.user_keys.find((k) => k.user_id === CAROL)!.customer_key_id).toBeNull();
    for (const c of fake.tables.customer_keys) expect(c.wrapped_by).toBe(await currentKid());
  });

  it("for some owners only: theirs, and nobody else's", async () => {
    const legacy = await encryptJson("x", { owner: null });
    fake.tables.user_secrets.push(
      { id: "s1", user_id: ALICE, value: legacy },
      { id: "s2", user_id: BOB, value: legacy },
    );
    const r = await reEncryptOwners([ALICE]);
    expect(r.totalMigrated).toBe(1);
    expect((fake.tables.user_secrets[1].value as { kid: string }).kid).toBe(legacy.kid);
    expect(fake.tables.user_keys.map((k) => k.user_id)).toEqual([ALICE]);
  });
});
