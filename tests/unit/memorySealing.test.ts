// Agent memory under its owner's user key (R445).
//
// Long-term memory items, conversation summaries and scratchpads are sealed by
// the app under the owner's user key. Recall still finds an item by a word in
// Postgres: a sealed item's keywords are its words as the owner's index key
// hashes them. The database derives `keywords` from `content` in a trigger
// that fires on INSERT and on UPDATE OF content, so the tokens are written by
// a second update that names no content. The client here behaves as that
// trigger does, so the order of the writes is what is tested, not assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as null | { from: (t: string) => unknown },
}));
// A server function is its handler, called with its validated input.
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
// Memory extraction's model: a fixed connection whose answer the test sets.
vi.mock("@/utils/observability/recordGatewayUsage.server", () => ({
  recordGatewayCall: async () => {},
}));
vi.mock("@/utils/providers/defaultModel.server", () => ({
  openAiCompatTarget: async () => ({
    ok: true,
    transport: { endpointUrl: "https://model.test/v1/chat/completions", apiKey: "test-key" },
    model: "default/model",
    spec: "openrouter/default/model",
    fellBack: null,
  }),
}));
vi.mock("@/utils/ssrfGuard.server", () => ({
  providerFetch: async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ kind: "preference", content: "Prefers invoices in Norwegian kroner" }],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    ),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) =>
        token === "alice-token"
          ? { data: { user: { id: "00000000-0000-4000-8000-00000000a11c" } }, error: null }
          : { data: { user: null }, error: { message: "invalid JWT" } },
    },
    from: (t: string) => h.db!.from(t),
  },
}));

import {
  createKeyHierarchy,
  DataKeyUnavailableError,
  importDataKey,
  unwrapLocal,
  wrapLocal,
} from "@/utils/kms/keyHierarchy.server";
import type { KeyProvider } from "@/utils/kms/types";
import {
  __setKeyHierarchyForTests,
  blindTokens,
  keyHierarchy,
  openText,
  sealText,
} from "@/utils/providers/crypto.server";
import {
  insertMemoryItems,
  memorySealPerPass,
  openMemoryContent,
  openScratchpad,
  sealOlderMemory,
  SEALED_SCRATCHPAD_KEY,
} from "@/utils/memory/sealed.server";
import { recallMemoryItems } from "@/utils/memory/recall.server";
import { runMemoryGet, runMemoryRemember, runMemorySet } from "@/utils/memory/tools.server";
import { listAgentMemoryItems } from "@/utils/memory.functions";
import { extractMemoriesFromTurn } from "@/utils/memory/extract.server";
import { loadMemoryContext } from "@/utils/memory/memory.server";
import { DEFAULT_MEMORY_CONFIG } from "@/utils/memory/types";
import { sealSummary } from "@/utils/memory/sealed.server";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

void createKeyHierarchy;

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";
const AGENT = "66666666-6666-4666-8666-666666666666";
const CONV = "77777777-7777-4777-8777-777777777777";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// The trigger `derive_memory_keywords()` (migration 20260421221517), as written.
const TRIGGER_STOP = new Set(
  "the and for with this that from have has had are was were will would could should about into your their they them our out not but any all you user users agent agents some one two three".split(
    " ",
  ),
);
function triggerKeywords(content: string): string[] {
  const cleaned = content.replace(/[^a-z0-9 ]+/gi, " ").toLowerCase();
  return [...new Set(cleaned.split(/\s+/).filter((t) => t.length >= 4 && !TRIGGER_STOP.has(t)))];
}

let fake: FakeDb;
let mem: MemoryKeyStore;
let writes: Array<{ table: string; op: string; payload: unknown }>;
let failKeywordWrite = false;

/** The fake database, with agent_memory_items' trigger applied as Postgres would. */
function db() {
  return {
    from(table: string) {
      const b = fake.client.from(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table === "conversation_memory") {
        // ON CONFLICT (conversation_id): the row is replaced, not added.
        const insert = b.insert.bind(b);
        b.upsert = (p: unknown) => {
          const row = p as Record<string, unknown>;
          fake.tables.conversation_memory = fake.tables.conversation_memory.filter(
            (r) => r.conversation_id !== row.conversation_id,
          );
          return insert(row);
        };
        return b;
      }
      if (table !== "agent_memory_items") return b;
      const insert = b.insert.bind(b);
      const update = b.update.bind(b);
      b.insert = (p: unknown) => {
        writes.push({ table, op: "insert", payload: p });
        const rows = (Array.isArray(p) ? p : [p]) as Array<Record<string, unknown>>;
        return insert(rows.map((r) => ({ ...r, keywords: triggerKeywords(String(r.content)) })));
      };
      b.update = (p: unknown) => {
        writes.push({ table, op: "update", payload: p });
        const row = p as Record<string, unknown>;
        if (failKeywordWrite && "keywords" in row && !("content" in row)) {
          const q = update(row) as Record<string, (...a: unknown[]) => unknown>;
          q.eq = () => Promise.resolve({ data: null, error: { message: "statement timeout" } });
          return q;
        }
        // UPDATE OF content fires the trigger; any other update does not.
        return update(
          "content" in row ? { ...row, keywords: triggerKeywords(String(row.content)) } : row,
        );
      };
      return b;
    },
  };
}

async function fakeKms() {
  const kek = await importDataKey(random(32));
  const aad = new TextEncoder().encode("fake-kms");
  const state = { revoked: false };
  const keyRef = "arn:aws:kms:eu-west-1:111122223333:key/acme";
  const provider: KeyProvider = {
    id: "aws",
    keyRef,
    async wrapDek(dek) {
      if (state.revoked) throw new Error("AccessDeniedException: the key is disabled");
      const w = await wrapLocal(kek, dek, aad, random);
      return { provider: "aws", keyRef, material: `${w.iv}.${w.material}` };
    },
    async unwrapDek(w) {
      if (state.revoked) throw new Error("AccessDeniedException: the key is disabled");
      const [iv, material] = w.material.split(".");
      return unwrapLocal(kek, material, iv, aad);
    },
    async probe() {
      return { ok: true, detail: "ok" };
    },
  };
  return { provider, state };
}
let kms: Awaited<ReturnType<typeof fakeKms>>;

beforeEach(async () => {
  process.env.PROVIDER_CREDS_SECRET = "c".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest({ agent_memory_items: [], conversation_memory: [] });
  h.db = db();
  writes = [];
  failKeywordWrite = false;
  mem = memoryKeyStore();
  kms = await fakeKms();
  __setKeyHierarchyForTests(mem.store, () => kms.provider);
});
afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
});

const item = (content: string, userId = ALICE) => ({
  user_id: userId,
  agent_id: AGENT,
  conversation_id: CONV,
  kind: "fact",
  content,
});

describe("sealed text", () => {
  it("opens only where it was sealed, and not once changed", async () => {
    const s = (await sealText("Prefers invoices in Norwegian kroner", {
      owner: ALICE,
      where: "agent_memory_items/a/content",
    }))!;
    expect(s).toMatch(/^ck1:[0-9a-f]{12}:/);
    expect(await openText(s, "agent_memory_items/a/content")).toBe(
      "Prefers invoices in Norwegian kroner",
    );
    await expect(openText(s, "agent_memory_items/b/content")).rejects.toThrow(/did not open/);
    const changed = s.slice(0, -4) + (s.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(openText(changed, "agent_memory_items/a/content")).rejects.toThrow(/did not open/);
    // Text that was never sealed comes back as it is.
    expect(await openText("plain words", "anywhere")).toBe("plain words");
  });

  it("hashes a word the same way for one user, and differently for another", async () => {
    const a1 = await blindTokens(["kroner"], ALICE);
    const a2 = await blindTokens(["kroner"], ALICE);
    const b = await blindTokens(["kroner"], BOB);
    expect(a1).toEqual(a2);
    expect(a1![0]).toMatch(/^#[0-9a-f]{32}$/);
    expect(b![0]).not.toBe(a1![0]);
  });

  it("is not sealed, and stays as it was, before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    expect(await sealText("anything", { owner: ALICE, where: "x" })).toBeNull();
    expect(await blindTokens(["word"], ALICE)).toBeNull();
  });
});

describe("remembering", () => {
  it("seals the item, and writes its blind keywords after the trigger, by an update without content", async () => {
    const r = await insertMemoryItems(h.db, [item("Prefers invoices in Norwegian kroner")]);
    expect(r.error).toBeNull();
    const row = fake.tables.agent_memory_items[0]!;
    expect(row.id).toBe(r.ids[0]);
    expect(row.content).toMatch(/^ck1:/);
    expect((row.keywords as string[]).length).toBe(4); // prefers, invoices, norwegian, kroner
    expect((row.keywords as string[]).every((k) => /^#[0-9a-f]{32}$/.test(k))).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(/invoice|kroner|norwegian|prefers/i);
    // The insert, then the keywords, by an update the trigger does not fire on.
    expect(writes.map((w) => w.op)).toEqual(["insert", "update"]);
    expect(writes[1]!.payload).not.toHaveProperty("content");
  });

  it("stores the item as before when the user-key tables do not exist, the trigger deriving its words", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    await insertMemoryItems(h.db, [item("Prefers invoices in Norwegian kroner")]);
    const row = fake.tables.agent_memory_items[0]!;
    expect(row.content).toBe("Prefers invoices in Norwegian kroner");
    expect(row.keywords).toEqual(["prefers", "invoices", "norwegian", "kroner"]);
    expect(writes.map((w) => w.op)).toEqual(["insert"]);
  });

  it("takes an item back out when its keywords could not be written", async () => {
    failKeywordWrite = true;
    const r = await insertMemoryItems(h.db, [item("Prefers invoices in Norwegian kroner")]);
    expect(r.error).toMatch(/keywords could not be written: statement timeout/);
    expect(fake.tables.agent_memory_items).toHaveLength(0);
  });

  it("remembers nothing for an owner whose key cannot be had, never under another key", async () => {
    const row = await (async () => {
      const id = crypto.randomUUID();
      const material = await keyHierarchy().makeCustomerKeyMaterial({
        id,
        name: "Acme",
        provider: "aws",
        keyRef: kms.provider.keyRef,
        endpoint: null,
      });
      const r = {
        id,
        name: "Acme",
        provider: "aws",
        key_ref: kms.provider.keyRef,
        endpoint: null,
        ...material,
        created_at: new Date().toISOString(),
        destroyed_at: null,
      };
      mem.customerKeys.set(id, r);
      return r;
    })();
    mem.assignUser(row.id, ALICE);
    kms.state.revoked = true;
    await expect(
      insertMemoryItems(h.db, [item("Prefers invoices in Norwegian kroner")]),
    ).rejects.toBeInstanceOf(DataKeyUnavailableError);
    expect(fake.tables.agent_memory_items).toHaveLength(0);
    // The tool says so to the agent rather than throwing.
    const said = JSON.parse(
      await runMemoryRemember(
        { sb: h.db, userId: ALICE, agentId: AGENT, conversationId: CONV } as never,
        { content: "Prefers invoices in Norwegian kroner" },
      ),
    );
    expect(said.error).toMatch(/^not remembered: .*Acme/);
  });

  it("the agent's own memory_remember seals what it keeps", async () => {
    const said = JSON.parse(
      await runMemoryRemember(
        { sb: h.db, userId: ALICE, agentId: AGENT, conversationId: CONV } as never,
        { content: "Quarterly reports go to the board in March", kind: "instruction" },
      ),
    );
    expect(said).toMatchObject({ ok: true, kind: "instruction" });
    expect(fake.tables.agent_memory_items[0]!.content).toMatch(/^ck1:/);
  });
});

describe("recall", () => {
  const recall = (prompt: string, userId = ALICE) =>
    recallMemoryItems({ sb: h.db as never, userId, agentId: AGENT, userPrompt: prompt, topK: 5 });

  beforeEach(async () => {
    await insertMemoryItems(h.db, [item("Prefers invoices in Norwegian kroner")]);
    // An item from before R445: plaintext, its words derived by the trigger.
    fake.tables.agent_memory_items.push({
      id: "88888888-8888-4888-8888-888888888888",
      user_id: ALICE,
      agent_id: AGENT,
      conversation_id: CONV,
      kind: "fact",
      content: "Invoices go to the finance mailbox",
      keywords: triggerKeywords("Invoices go to the finance mailbox"),
      score: 1,
      last_used_at: null,
      created_at: new Date().toISOString(),
    });
  });

  it("finds sealed items and older plaintext ones by a word, and gives back the text", async () => {
    const got = await recall("Which currency should the invoices use?");
    expect(got.map((g) => g.content).sort()).toEqual([
      "Invoices go to the finance mailbox",
      "Prefers invoices in Norwegian kroner",
    ]);
  });

  it("does not find an item by a word it does not have", async () => {
    expect(await recall("What is the weather like in Bergen?")).toEqual([]);
  });

  it("leaves out an item that does not open where it is kept, and recalls the rest", async () => {
    // A sealed item's text and words copied onto another row: found by the
    // word, but bound to the row it was sealed for.
    const sealed = fake.tables.agent_memory_items.find((r) =>
      String(r.content).startsWith("ck1:"),
    )!;
    fake.tables.agent_memory_items.push({
      ...sealed,
      id: "99999999-9999-4999-8999-999999999999",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const got = await recall("Which currency should the invoices use?");
    expect(got.map((g) => g.id).sort()).toEqual(
      [sealed.id as string, "88888888-8888-4888-8888-888888888888"].sort(),
    );
    expect(warn).toHaveBeenCalledWith(
      "[memory.recall] an item did not open:",
      expect.stringMatching(/did not open/),
    );
    warn.mockRestore();
  });

  it("leaves out an item whose key was erased, and recalls the rest", async () => {
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const got = await recall("Which currency should the invoices use?");
    expect(got.map((g) => g.content)).toEqual(["Invoices go to the finance mailbox"]);
  });
});

describe("the scratchpad", () => {
  const ctx = () => ({ sb: h.db, userId: ALICE, agentId: AGENT, conversationId: CONV }) as never;

  it("is sealed as a whole, and reads back", async () => {
    await runMemorySet(ctx(), { key: "step", value: 2 });
    await runMemorySet(ctx(), { key: "region", value: "Nordics" });
    const stored = fake.tables.conversation_memory[0]!.scratchpad as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([SEALED_SCRATCHPAD_KEY]);
    expect(JSON.stringify(stored)).not.toMatch(/Nordics|region|step/);
    expect(JSON.parse(await runMemoryGet(ctx(), {}))).toEqual({
      keys: ["step", "region"],
      values: { step: 2, region: "Nordics" },
    });
  });

  it("an agent cannot write the sealed form's key itself", async () => {
    expect(
      JSON.parse(await runMemorySet(ctx(), { key: SEALED_SCRATCHPAD_KEY, value: "x" })),
    ).toEqual({ error: "key must be alphanumeric + underscore" });
  });

  it("one from before R445 reads as it is", async () => {
    expect(await openScratchpad(CONV, { step: 1 })).toEqual({ step: 1 });
  });
});

describe("the agent form's list", () => {
  it("shows the caller's own items, opened, and why one cannot be read", async () => {
    await insertMemoryItems(h.db, [item("Prefers invoices in Norwegian kroner")]);
    await insertMemoryItems(h.db, [item("Bob's secret project is Aurora", BOB)]);
    const r = await listAgentMemoryItems({
      data: { access_token: "alice-token", agent_id: AGENT },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.items.map((i) => i.content)).toEqual(["Prefers invoices in Norwegian kroner"]);
    expect(r.items[0]!.sealed).toBe(true);
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const after = await listAgentMemoryItems({
      data: { access_token: "alice-token", agent_id: AGENT },
    });
    if (!after.ok) throw new Error(after.error);
    expect(after.items[0]).toMatchObject({ content: null });
    expect(after.items[0]!.unreadable).toMatch(/erased/);
  });

  it("is refused without a signed-in caller", async () => {
    const r = await listAgentMemoryItems({ data: { access_token: "nope", agent_id: AGENT } });
    expect(r.ok).toBe(false);
  });
});

describe("the pass over memory kept before R445", () => {
  const legacy = (id: string, userId: string, content: string) => ({
    id,
    user_id: userId,
    agent_id: AGENT,
    conversation_id: CONV,
    kind: "fact",
    content,
    keywords: triggerKeywords(content),
  });
  const I1 = "11111111-1111-4111-8111-111111111111";
  const I2 = "22222222-2222-4222-8222-222222222222";

  it("seals each item, and its keywords are its owner's tokens, not fragments of the ciphertext", async () => {
    fake.tables.agent_memory_items.push(legacy(I1, ALICE, "Prefers invoices in Norwegian kroner"));
    const r = await sealOlderMemory();
    expect(r).toMatchObject({ items: 1, failed: 0, unreadable: 0 });
    const row = fake.tables.agent_memory_items[0]!;
    expect(row.content).toMatch(/^ck1:/);
    expect(row.keywords).toEqual(
      await blindTokens(["prefers", "invoices", "norwegian", "kroner"], ALICE),
    );
    expect(await openMemoryContent(row as { id: string; content: string })).toBe(
      "Prefers invoices in Norwegian kroner",
    );
    // The content, then the keywords by an update without content.
    expect(
      writes.filter((w) => w.op === "update").map((w) => Object.keys(w.payload as object)),
    ).toEqual([["content"], ["keywords"]]);
  });

  it("seals at most its limit, and says more is left", async () => {
    fake.tables.agent_memory_items.push(legacy(I1, ALICE, "Prefers invoices in Norwegian kroner"));
    fake.tables.agent_memory_items.push(legacy(I2, ALICE, "Quarterly reports go to the board"));
    expect(await sealOlderMemory({ limit: 1 })).toMatchObject({ items: 1, left: true });
    expect(await sealOlderMemory({ limit: 1 })).toMatchObject({ items: 1, left: false });
    expect(await sealOlderMemory()).toMatchObject({ items: 0 });
  });

  it("leaves an owner's memory as it is while their key cannot be had, and seals everyone else's", async () => {
    const id = crypto.randomUUID();
    const material = await keyHierarchy().makeCustomerKeyMaterial({
      id,
      name: "Acme",
      provider: "aws",
      keyRef: kms.provider.keyRef,
      endpoint: null,
    });
    mem.customerKeys.set(id, {
      id,
      name: "Acme",
      provider: "aws",
      key_ref: kms.provider.keyRef,
      endpoint: null,
      ...material,
      created_at: new Date().toISOString(),
      destroyed_at: null,
    });
    mem.assignUser(id, ALICE);
    kms.state.revoked = true;
    fake.tables.agent_memory_items.push(legacy(I1, ALICE, "Prefers invoices in Norwegian kroner"));
    fake.tables.agent_memory_items.push(legacy(I2, BOB, "Quarterly reports go to the board"));
    const r = await sealOlderMemory();
    expect(r).toMatchObject({ items: 1, unreadable: 1, failed: 0 });
    const byId = new Map(fake.tables.agent_memory_items.map((x) => [x.id, x]));
    expect(byId.get(I1)!.content).toBe("Prefers invoices in Norwegian kroner");
    expect(byId.get(I2)!.content).toMatch(/^ck1:/);
  });

  it("does nothing before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    fake.tables.agent_memory_items.push(legacy(I1, ALICE, "Prefers invoices in Norwegian kroner"));
    expect(await sealOlderMemory()).toMatchObject({ items: 0, failed: 0 });
    expect(fake.tables.agent_memory_items[0]!.content).toBe("Prefers invoices in Norwegian kroner");
  });

  it.each([
    [undefined, 1000],
    ["50", 50],
    ["0", 1000],
    ["lots", 1000],
  ])("MEMORY_SEAL_PER_PASS=%s is %d", (raw, want) => {
    expect(memorySealPerPass(raw === undefined ? {} : { MEMORY_SEAL_PER_PASS: raw })).toBe(want);
  });
});

describe("after a turn, and at the next one", () => {
  it("what the agent extracts from a turn is sealed", async () => {
    const n = await extractMemoriesFromTurn({
      sb: h.db as never,
      userId: ALICE,
      agentId: AGENT,
      conversationId: CONV,
      userMessage: "Please send invoices in Norwegian kroner from now on.",
      assistantMessage: "Noted: invoices in NOK.",
      maxItems: 50,
    });
    expect(n).toBe(1);
    const row = fake.tables.agent_memory_items[0]!;
    expect(row.content).toMatch(/^ck1:/);
    expect((row.keywords as string[]).every((k) => k.startsWith("#"))).toBe(true);
  });

  it("a summary that does not open is left out, and the turn goes on", async () => {
    fake.tables.conversation_memory.push({
      conversation_id: CONV,
      user_id: ALICE,
      summary: await sealSummary(ALICE, CONV, "Alice asked about the Halvard renewal"),
      scratchpad: {},
    });
    const cfg = { ...DEFAULT_MEMORY_CONFIG, stm_enabled: true, ltm_enabled: false };
    const opened = await loadMemoryContext({
      sb: h.db as never,
      userId: ALICE,
      agentId: AGENT,
      conversationId: CONV,
      userPrompt: "And the renewal date?",
      config: cfg,
    });
    expect(JSON.stringify(opened)).toMatch(/Halvard renewal/);
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const after = await loadMemoryContext({
      sb: h.db as never,
      userId: ALICE,
      agentId: AGENT,
      conversationId: CONV,
      userPrompt: "And the renewal date?",
      config: cfg,
    });
    expect(JSON.stringify(after)).not.toMatch(/Halvard/);
    expect(warn).toHaveBeenCalledWith(
      "[memory] the conversation summary did not open:",
      expect.stringMatching(/erased/),
    );
    warn.mockRestore();
  });
});
