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
  storage: null as null | { client: unknown },
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
          : prop === "storage"
            ? h.storage?.client
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
  sealStoredFilesNow,
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
import { fakeStorage } from "../fixtures/fakeStorage";
import { isSealed, sealedKid } from "@/utils/storage/sealedFile";

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
  // Agent memory (R445), which the stored-files pass also seals.
  t.agent_memory_items = [];
  t.conversation_memory = [];
  // And Agent Chat history (R446).
  t.messages = [];
  t.conversations = [];
  t.swarm_chats = [];
  t.ai_analyst_threads = [];
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
    // R440: what the key does for lakehouse files is a fact of its own; with
    // no lakehouse here, it says so rather than staying silent.
    expect(c.facts).toEqual([
      { label: "Key", value: ARN },
      { label: "Lakehouse files", value: "The lakehouse is not configured." },
    ]);
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
      error: expect.stringMatching(/^1 of this group's members is already covered .* "Acme"/),
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

describe("an assignment on Cloud Storage (R443)", () => {
  // Found in R443's round: the trigger for moving a member's lakehouse files
  // asked for a live key in AWS KMS, so on Cloud Storage an assignment to a
  // Cloud KMS key moved nothing and its toast did not say they follow.
  const GKEY = "projects/acme-prod/locations/europe-west1/keyRings/lake/cryptoKeys/acme";
  const env = {
    LAKEHOUSE_CATALOG_URL: "postgres://lake:pw@catalog:5432/lake",
    LAKEHOUSE_DATA_URL: "s3://lake-bucket/lake",
    LAKEHOUSE_S3_ENDPOINT: "storage.googleapis.com",
    LAKEHOUSE_S3_KEY_ID: "GOOGTEST",
    LAKEHOUSE_S3_SECRET: "test-secret-value",
  };
  beforeEach(() => {
    Object.assign(process.env, env);
    // The pass the assignment starts waits for the workers' sync; it is not run here.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const k of Object.keys(env)) delete process.env[k];
  });

  it("says a Cloud KMS key's members' files follow it", async () => {
    const acme = ok(await create({ name: "Acme GCP", where: "kms", key_ref: GKEY }));
    expect(fake.tables.customer_keys[0]).toMatchObject({ provider: "gcp" });
    const r = ok(
      await assignCustomerKey({
        data: { access_token: T, id: acme.id, principal_type: "user", principal_id: ALICE },
      }),
    );
    expect(r.lakehouseFilesFollow).toBe(true);
  });

  it("does not say so for a key in AWS KMS, which Cloud Storage cannot use", async () => {
    const globex = ok(await create({ name: "Globex", where: "kms", key_ref: ARN }));
    const r = ok(
      await assignCustomerKey({
        data: { access_token: T, id: globex.id, principal_type: "user", principal_id: ALICE },
      }),
    );
    expect(r.lakehouseFilesFollow).toBe(false);
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

  it("says what of its members' lakehouse files stays under the customer's KMS key (R442: models too)", async () => {
    const env = {
      LAKEHOUSE_CATALOG_URL: "postgres://lake:pw@catalog:5432/lake",
      LAKEHOUSE_DATA_URL: "s3://lake-bucket/lake",
      LAKEHOUSE_S3_KEY_ID: "AKIDEXAMPLE",
      LAKEHOUSE_S3_SECRET: "test-secret-value",
      LAKEHOUSE_S3_REGION: "eu-west-1",
    };
    Object.assign(process.env, env);
    try {
      fake.tables.lakehouse_schemas = [
        { id: "s1", name: "acme", user_id: ALICE, lake_source_id: null, iceberg_catalog_id: null },
      ];
      fake.tables.lakehouse_share_tables = [];
      fake.tables.ml_models = [
        { id: "m1", user_id: ALICE },
        { id: "m2", user_id: ALICE },
        { id: "m3", user_id: BOB },
      ];
      const globex = ok(await create({ name: "Globex", where: "kms", key_ref: ARN }));
      ok(
        await assignCustomerKey({
          data: { access_token: T, id: globex.id, principal_type: "user", principal_id: ALICE },
        }),
      );
      const r = ok(
        await destroyCustomerKey({
          data: { access_token: T, id: globex.id, confirm_name: "Globex" },
        }),
      );
      expect(r).toMatchObject({ lakehouseSchemasLeft: 1, lakehouseModelsLeft: 2 });
      expect(h.audits.at(-1)).toMatchObject({
        action: "security.customer_key.destroy",
        detail: { lakehouse_schemas_left_under_key: 1, models_left_under_key: 2 },
      });
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
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

describe("Encrypt stored files (R441)", () => {
  const DOC = `${ALICE}/11111111-1111-4111-8111-111111111111.docx`;
  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

  beforeEach(() => {
    h.storage = fakeStorage();
  });

  it("is a superadmin's alone, and touches nothing for anyone else", async () => {
    const store = h.storage as ReturnType<typeof fakeStorage>;
    store.put("chat-docs", DOC, docx);
    h.superadmin = false;
    expect(await sealStoredFilesNow({ data: { access_token: T } })).toEqual({
      ok: false,
      error: "Superadmin only",
    });
    expect(store.calls.list).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it("puts every stored file under its owner's key, and audits the pass with its counts", async () => {
    const store = h.storage as ReturnType<typeof fakeStorage>;
    store.put("chat-docs", DOC, docx);
    const r = ok(await sealStoredFilesNow({ data: { access_token: T } }));
    expect(r).toMatchObject({ files: 1, documents: 1, sealedNow: 1, failed: 0 });
    const obj = store.get("chat-docs", DOC)!;
    expect(isSealed(obj.bytes)).toBe(true);
    expect(sealedKid(obj.bytes)).toBe(
      fake.tables.user_keys!.find((k) => k.user_id === ALICE && !k.erased_at)!.kid,
    );
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: "security.stored_files.seal",
        actorEmail: "admin@example.test",
        detail: expect.objectContaining({
          trigger: "Encrypt stored files",
          files: 1,
          files_sealed_now: 1,
          files_failed: 0,
        }),
      }),
    ]);
    expect(h.audits[0]!.detail).not.toHaveProperty("memory_failed");
    expect(h.audits[0]!.detail).not.toHaveProperty("chat_failed");
  });

  it("also seals what agents kept before R445, under each owner's key, in the same row", async () => {
    const ITEM = "33333333-3333-4333-8333-333333333333";
    const CONV = "44444444-4444-4444-8444-444444444444";
    fake.tables.agent_memory_items.push({
      id: ITEM,
      user_id: ALICE,
      agent_id: "55555555-5555-4555-8555-555555555555",
      content: "Prefers quarterly revenue reports in euros",
      keywords: ["prefers", "quarterly", "revenue", "reports", "euros"],
    });
    fake.tables.conversation_memory.push({
      conversation_id: CONV,
      user_id: ALICE,
      summary: "Alice asked about the Halvard contract renewal",
      scratchpad: { step: 2 },
    });
    const r = ok(await sealStoredFilesNow({ data: { access_token: T } }));
    expect(r.memory).toMatchObject({ items: 1, summaries: 1, scratchpads: 1, failed: 0 });
    const item = fake.tables.agent_memory_items[0]!;
    const conv = fake.tables.conversation_memory[0]!;
    // Nothing readable is left: not the text, not its words.
    expect(item.content).toMatch(/^ck1:/);
    expect(JSON.stringify(item)).not.toMatch(/quarterly|euros/);
    expect((item.keywords as string[]).every((k) => /^#[0-9a-f]{32}$/.test(k))).toBe(true);
    expect(conv.summary).toMatch(/^ck1:/);
    expect(JSON.stringify(conv)).not.toMatch(/Halvard|step/);
    // Each under Alice's own key, and each opens where it is kept.
    const aliceKid = fake.tables.user_keys!.find((k) => k.user_id === ALICE && !k.erased_at)!.kid;
    expect(String(item.content).split(":")[1]).toBe(aliceKid);
    const sealed = await import("@/utils/memory/sealed.server");
    expect(await sealed.openMemoryContent({ id: ITEM, content: String(item.content) })).toBe(
      "Prefers quarterly revenue reports in euros",
    );
    expect(await sealed.openSummary(CONV, String(conv.summary))).toBe(
      "Alice asked about the Halvard contract renewal",
    );
    expect(await sealed.openScratchpad(CONV, conv.scratchpad)).toEqual({ step: 2 });
    // Moved onto another row, a sealed value does not open.
    await expect(
      sealed.openMemoryContent({ id: CONV, content: String(item.content) }),
    ).rejects.toThrow(/did not open/);
    // Recall finds it by a word: the prompt's word, as Alice's key hashes it.
    const terms = await sealed.recallTerms(ALICE, ["euros"]);
    expect((item.keywords as string[]).some((k) => terms.includes(k))).toBe(true);
    // Bob's tokens for the same word are not Alice's.
    const bobTerms = await sealed.recallTerms(BOB, ["euros"]);
    expect((item.keywords as string[]).some((k) => bobTerms.includes(k))).toBe(false);
    expect(h.audits.at(-1)).toMatchObject({
      detail: { memory_items_sealed: 1, summaries_sealed: 1, scratchpads_sealed: 1 },
    });
    // A second pass has nothing left to do.
    const again = ok(await sealStoredFilesNow({ data: { access_token: T } }));
    expect(again.memory).toMatchObject({ items: 0, summaries: 0, scratchpads: 0, failed: 0 });
  });

  it("the card reads the last pass from the audit trail, and says when it cannot", async () => {
    expect(ok(await getCustomerKeys({ data: { access_token: T } })).storedFiles.error).toMatch(
      /^The last pass could not be read from the audit trail: /,
    );
    fake.tables.audit_events = [
      {
        action: "security.stored_files.seal",
        created_at: "2026-11-03T08:38:00.000Z",
        actor_email: "system:kms",
        detail: { trigger: "scheduled", files: 3, files_sealed_now: 3, errors: ["kept out"] },
      },
    ];
    expect(ok(await getCustomerKeys({ data: { access_token: T } })).storedFiles).toEqual({
      lastPass: {
        at: "2026-11-03T08:38:00.000Z",
        by: "system:kms",
        detail: { trigger: "scheduled", files: 3, files_sealed_now: 3 },
      },
    });
  });
});
