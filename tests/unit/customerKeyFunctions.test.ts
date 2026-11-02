// R438: the Customer keys card's server functions, end to end over tables.
//
// The framework's builder, the superadmin gate and the audit writer are
// faked; the key code, the store and the sweep are the real ones, over the
// in-memory PostgREST fake. What is checked is what an admin relies on: a
// bad key reference or a clash is refused with a reason and changes nothing;
// an assignment moves what its members stored at once; destroying and
// erasing ask for the name or the email, and do what they say.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as null | Record<string, unknown>,
  audits: [] as Array<Record<string, unknown>>,
  superadmin: true,
  users: new Map<string, string>(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));
vi.mock("@/utils/iam.server", () => ({
  requireSuperadmin: async () =>
    h.superadmin
      ? { ok: true, userId: "00000000-0000-4000-8000-0000000ad111", email: "admin@example.test" }
      : { ok: false, error: "Superadmin only" },
}));
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => h.audits.push(e),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "auth"
          ? {
              admin: {
                getUserById: async (id: string) =>
                  h.users.has(id)
                    ? { data: { user: { id, email: h.users.get(id) } }, error: null }
                    : { data: { user: null }, error: { message: "User not found" } },
              },
            }
          : (h.db as Record<string | symbol, unknown>)[prop],
    },
  ),
}));

import { importDataKey, unwrapLocal, wrapLocal } from "@/utils/kms/keyHierarchy.server";
import type { KeyProvider } from "@/utils/kms/types";
import {
  assignCustomerKey,
  checkCustomerKey,
  createCustomerKey,
  destroyCustomerKey,
  eraseUserKey,
  getCustomerKeys,
  unassignCustomerKey,
} from "@/utils/providers/customerKeys.functions";
import {
  __setKeyHierarchyForTests,
  decryptJson,
  encryptJson,
  keyHierarchy,
} from "@/utils/providers/crypto.server";
import { ENCRYPTED_TABLES } from "@/utils/providers/keyRotation.server";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";

const T = "test-access-token";
const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";
const CAROL = "00000000-0000-4000-8000-0000000ca201";
const G_ACME = "00000000-0000-4000-8000-00000000a001";
const G_GLOBEX = "00000000-0000-4000-8000-00000000a002";
const ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

let fake: FakeDb;
const kmsState = { revoked: false };
let kmsProvider: KeyProvider;

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

beforeEach(async () => {
  process.env.PROVIDER_CREDS_SECRET = "a".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  delete process.env.KMS_KEY_REF;
  h.audits = [];
  h.superadmin = true;
  h.users = new Map([
    [ALICE, "alice@example.test"],
    [BOB, "bob@example.test"],
    [CAROL, "carol@example.test"],
  ]);
  const t: Record<string, Record<string, unknown>[]> = {
    user_keys: [],
    customer_keys: [],
    customer_key_members: [],
    iam_groups: [
      { id: G_ACME, name: "acme-staff" },
      { id: G_GLOBEX, name: "globex-staff" },
    ],
    iam_group_members: [
      { group_id: G_ACME, user_id: ALICE },
      { group_id: G_ACME, user_id: CAROL },
      { group_id: G_GLOBEX, user_id: CAROL },
    ],
  };
  for (const name of ENCRYPTED_TABLES) t[name] = [];
  fake = fakePostgrest(t);
  h.db = fake.client;
  const kek = await importDataKey(crypto.getRandomValues(new Uint8Array(32)));
  const aad = new TextEncoder().encode("fake");
  kmsState.revoked = false;
  kmsProvider = {
    id: "aws",
    keyRef: ARN,
    async wrapDek(dek) {
      if (kmsState.revoked) throw new Error("AccessDeniedException");
      const w = await wrapLocal(kek, dek, aad, (n) => crypto.getRandomValues(new Uint8Array(n)));
      return { provider: "aws", keyRef: ARN, material: `${w.iv}.${w.material}` };
    },
    async unwrapDek(w) {
      if (kmsState.revoked) throw new Error("AccessDeniedException");
      const [iv, m] = w.material.split(".");
      return unwrapLocal(kek, m, iv, aad);
    },
    async probe() {
      return {
        ok: true,
        detail: "Encrypt and decrypt allowed",
        facts: [{ label: "Key", value: ARN }],
      };
    },
  };
  __setKeyHierarchyForTests(null, () => kmsProvider);
});

afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
});

const create = (data: Record<string, unknown>) =>
  createCustomerKey({ data: { access_token: T, ...data } });

describe("creating a customer key", () => {
  it("held by the app: stored, proven, audited, and listed", async () => {
    const r = ok(await create({ name: "Acme", where: "app" }));
    expect(fake.tables.customer_keys).toHaveLength(1);
    expect(fake.tables.customer_keys[0]).toMatchObject({
      name: "Acme",
      provider: "app",
      kid: r.kid,
    });
    expect(h.audits[0]).toMatchObject({
      action: "security.customer_key.create",
      resourceName: "Acme",
      detail: { provider: "app", kid: r.kid },
    });
    const list = ok(await getCustomerKeys({ data: { access_token: T } }));
    expect(list.keys.map((k) => k.name)).toEqual(["Acme"]);
    expect(ok(await checkCustomerKey({ data: { access_token: T, id: r.id } })).detail).toMatch(
      /Unwrapped under the deployment key/,
    );
  });

  it("in the customer's KMS: the provider wraps it, and Check reads the provider's facts", async () => {
    const r = ok(await create({ name: "Globex", where: "kms", key_ref: ARN }));
    expect(fake.tables.customer_keys[0]).toMatchObject({ provider: "aws", key_ref: ARN });
    const c = ok(await checkCustomerKey({ data: { access_token: T, id: r.id } }));
    expect(c.facts).toEqual([{ label: "Key", value: ARN }]);
    kmsState.revoked = true;
    expect(await checkCustomerKey({ data: { access_token: T, id: r.id } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/"Globex".*refused.*AccessDenied/),
    });
  });

  it("refuses what is not a customer's key, and stores nothing", async () => {
    expect(await create({ name: "X", where: "kms", key_ref: "my-key" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/AWS KMS key ARN/),
    });
    process.env.KMS_KEY_REF = ARN;
    expect(await create({ name: "X", where: "kms", key_ref: ARN })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/this deployment's own key/),
    });
    expect(
      await create({
        name: "X",
        where: "kms",
        key_ref: "ocid1.key.oc1.iad.abcdefgh.aaaabbbbccccdddd",
        endpoint: "https://evil.example/path",
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/cryptographic endpoint/) });
    ok(await create({ name: "Acme", where: "app" }));
    expect(await create({ name: "acme", where: "app" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already exists/),
    });
    expect(fake.tables.customer_keys).toHaveLength(1);
    h.superadmin = false;
    expect(await create({ name: "Y", where: "app" })).toEqual({
      ok: false,
      error: "Superadmin only",
    });
  });
});

describe("assigning", () => {
  it("moves a member's key and what they stored under the customer key at once", async () => {
    const acme = ok(await create({ name: "Acme", where: "kms", key_ref: ARN }));
    // Alice saved before Acme existed: her value is on her deployment-wrapped key,
    // and one older value is on the deployment key itself.
    const own = await encryptJson({ token: "mine" }, { owner: ALICE });
    const legacy = await encryptJson({ token: "older" }, { owner: null });
    fake.tables.user_secrets.push(
      { id: "s1", user_id: ALICE, value: own },
      { id: "s2", user_id: ALICE, value: legacy },
      { id: "s3", user_id: BOB, value: legacy },
    );
    const r = ok(
      await assignCustomerKey({
        data: { access_token: T, id: acme.id, principal_type: "user", principal_id: ALICE },
      }),
    );
    expect(r).toMatchObject({
      users: 1,
      userKeysRewrapped: 1,
      valuesReEncrypted: 1,
      valuesFailed: 0,
    });
    const aliceKey = fake.tables.user_keys.find((k) => k.user_id === ALICE)!;
    expect(aliceKey.customer_key_id).toBe(acme.id);
    // Both of Alice's values now need Acme's KMS; Bob's does not.
    kmsState.revoked = true;
    keyHierarchy().forgetAll();
    for (const row of fake.tables.user_secrets.filter((s) => s.user_id === ALICE)) {
      const v = row.value as { ciphertext: string; iv: string; kid: string };
      await expect(decryptJson(v.ciphertext, v.iv, v.kid)).rejects.toMatchObject({
        reason: "refused",
      });
    }
    const bob = fake.tables.user_secrets[2].value as {
      ciphertext: string;
      iv: string;
      kid: string;
    };
    expect(await decryptJson(bob.ciphertext, bob.iv, bob.kid)).toEqual({ token: "older" });
    expect(h.audits.at(-1)).toMatchObject({
      action: "security.customer_key.assign",
      detail: { user_id: ALICE, users: 1, user_keys_rewrapped: 1, values_reencrypted: 1 },
    });

    // Removing the assignment hands them back to the deployment's key.
    kmsState.revoked = false;
    const memberId = fake.tables.customer_key_members[0].id as string;
    ok(await unassignCustomerKey({ data: { access_token: T, member_id: memberId } }));
    expect(fake.tables.user_keys.find((k) => k.user_id === ALICE)!.customer_key_id).toBeNull();
    kmsState.revoked = true;
    keyHierarchy().forgetAll();
    const v = fake.tables.user_secrets[0].value as { ciphertext: string; iv: string; kid: string };
    expect(await decryptJson(v.ciphertext, v.iv, v.kid)).toEqual({ token: "mine" });
  });

  it("refuses a group assignment that would put a member under two keys, naming the other", async () => {
    const acme = ok(await create({ name: "Acme", where: "app" }));
    const globex = ok(await create({ name: "Globex", where: "app" }));
    ok(
      await assignCustomerKey({
        data: { access_token: T, id: acme.id, principal_type: "group", principal_id: G_ACME },
      }),
    );
    const clash = await assignCustomerKey({
      data: { access_token: T, id: globex.id, principal_type: "group", principal_id: G_GLOBEX },
    });
    expect(clash).toMatchObject({
      ok: false,
      error: expect.stringMatching(/1 of this group's members .* "Acme"/),
    });
    expect(fake.tables.customer_key_members).toHaveLength(1);
    // A direct assignment settles Carol, and then the group is fine.
    ok(
      await assignCustomerKey({
        data: { access_token: T, id: globex.id, principal_type: "user", principal_id: CAROL },
      }),
    );
    ok(
      await assignCustomerKey({
        data: { access_token: T, id: globex.id, principal_type: "group", principal_id: G_GLOBEX },
      }),
    );
    const list = ok(await getCustomerKeys({ data: { access_token: T } }));
    expect(list.conflicts).toEqual([]);
    expect(list.keys.find((k) => k.name === "Acme")?.coveredUsers).toBe(1);
    expect(list.keys.find((k) => k.name === "Globex")?.coveredUsers).toBe(1);
  });
});

describe("destroying and erasing", () => {
  it("destroys a customer key only by its name, and its members' values stop reading", async () => {
    // With the cache on: the process that destroys the key must not keep it.
    process.env.DATA_KEY_CACHE_SECONDS = "300";
    const acme = ok(await create({ name: "Acme", where: "app" }));
    ok(
      await assignCustomerKey({
        data: { access_token: T, id: acme.id, principal_type: "user", principal_id: ALICE },
      }),
    );
    const v = await encryptJson({ token: "alice" }, { owner: ALICE });
    expect(
      await destroyCustomerKey({ data: { access_token: T, id: acme.id, confirm_name: "acme" } }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Type the key's name, Acme/) });
    expect(fake.tables.customer_keys[0].destroyed_at).toBeNull();
    const r = ok(
      await destroyCustomerKey({ data: { access_token: T, id: acme.id, confirm_name: "Acme" } }),
    );
    expect(r.userKeysErased).toBe(1);
    expect(fake.tables.customer_key_members).toHaveLength(0);
    await expect(decryptJson(v.ciphertext, v.iv, v.kid)).rejects.toMatchObject({
      reason: "erased",
    });
    expect(h.audits.at(-1)).toMatchObject({
      action: "security.customer_key.destroy",
      detail: { user_keys_erased: 1 },
    });
    // Alice saves again: a new key, under the deployment's.
    const next = await encryptJson("again", { owner: ALICE });
    expect(next.kid).not.toBe(v.kid);
  });

  it("erases one user's key only by their email", async () => {
    process.env.DATA_KEY_CACHE_SECONDS = "300";
    const v = await encryptJson("bob", { owner: BOB });
    expect(
      await eraseUserKey({
        data: { access_token: T, user_id: BOB, confirm_email: "alice@example.test" },
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/bob@example.test/) });
    expect(await decryptJson(v.ciphertext, v.iv, v.kid)).toBe("bob");
    const r = ok(
      await eraseUserKey({
        data: { access_token: T, user_id: BOB, confirm_email: " BOB@example.test " },
      }),
    );
    expect(r.kid).toBe(v.kid);
    await expect(decryptJson(v.ciphertext, v.iv, v.kid)).rejects.toMatchObject({
      reason: "erased",
    });
    expect(h.audits.at(-1)).toMatchObject({
      action: "security.user_key.erase",
      resourceName: "bob@example.test",
      detail: { kid: v.kid },
    });
    expect(
      await eraseUserKey({
        data: { access_token: T, user_id: BOB, confirm_email: "bob@example.test" },
      }),
    ).toMatchObject({ ok: false, error: "This user has no key to erase" });
  });

  it("says the migration is needed rather than failing, before it is applied", async () => {
    delete fake.tables.user_keys;
    delete fake.tables.customer_keys;
    delete fake.tables.customer_key_members;
    expect(ok(await getCustomerKeys({ data: { access_token: T } }))).toMatchObject({
      enabled: false,
      keys: [],
    });
  });
});
