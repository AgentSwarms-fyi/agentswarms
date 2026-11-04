// Agent Chat history under its owner's user key (R446).
//
// Messages (text and metadata) and conversation titles are sealed under the
// user's key, and the chat page reads and writes them through the server
// (chatHistory.functions). A generated document's storage path stays readable
// so chat retention can still find the file to delete; its name and thumbnail
// are sealed with the rest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";

const h = vi.hoisted(() => ({
  db: null as null | { from: (t: string) => unknown },
  turnsSent: [] as string[],
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
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) =>
        token === "alice-token"
          ? { data: { user: { id: "00000000-0000-4000-8000-00000000a11c" } }, error: null }
          : token === "bob-token"
            ? { data: { user: { id: "00000000-0000-4000-8000-000000000b0b" } }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT" } },
    },
    from: (t: string) => h.db!.from(t),
  },
}));
// The summary fold's model: it records the turns it was given.
vi.mock("@/utils/observability/recordGatewayUsage.server", () => ({
  recordGatewayCall: async () => {},
}));
vi.mock("@/utils/providers/defaultModel.server", () => ({
  openAiCompatTarget: async () => ({
    ok: true,
    transport: { endpointUrl: "https://model.test/v1/chat/completions", apiKey: "k" },
    model: "m",
    spec: "openrouter/m",
    fellBack: null,
  }),
}));
vi.mock("@/utils/ssrfGuard.server", () => ({
  providerFetch: async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    h.turnsSent.push(body.messages.map((m) => m.content).join("\n"));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "A summary of the older turns." } }] }),
      { status: 200 },
    );
  },
}));

import { keyHierarchy, __setKeyHierarchyForTests } from "@/utils/providers/crypto.server";
import {
  chatSealPerPass,
  DEFAULT_TITLE,
  openMessage,
  openTitle,
  SEALED_METADATA_KEY,
  sealMessage,
  sealOlderChats,
  sealTitle,
} from "@/utils/chat/sealedChat.server";
import {
  listConversations,
  listMessages,
  saveMessage,
  setConversationTitle,
  startConversation,
} from "@/utils/chatHistory.functions";
import { summarizeIfNeeded } from "@/utils/memory/summarize.server";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const AGENT = "66666666-6666-4666-8666-666666666666";
const DOC_PATH = `${ALICE}/11111111-1111-4111-8111-111111111111.docx`;

let fake: FakeDb;
let mem: MemoryKeyStore;

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "d".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest({
    conversations: [],
    messages: [],
    conversation_memory: [],
    swarm_chats: [],
    ai_analyst_threads: [],
  });
  h.db = fake.client as never;
  h.turnsSent = [];
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store);
});
afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
});

const ok = <T>(r: T): Exclude<T, { ok: false }> => {
  const v = r as { ok: boolean; error?: string };
  if (!v.ok) throw new Error(`expected ok: ${v.error}`);
  return r as Exclude<T, { ok: false }>;
};

describe("a sealed message", () => {
  const META = {
    doc: {
      format: "docx",
      filename: "Halvard renewal terms.docx",
      thumb: "data:image/png;base64,AAAA",
      path: DOC_PATH,
    },
    citations: [{ index: 1, snippet: "The Halvard contract renews on 1 March" }],
  };

  it("keeps nothing readable but the document's storage path, and opens where it was sealed", async () => {
    const s = await sealMessage(ALICE, "m1", "When does the Halvard contract renew?", META);
    expect(s.sealed).toBe(true);
    expect(s.content).toMatch(/^ck1:/);
    expect(s.metadata).toEqual({
      doc: { path: DOC_PATH },
      [SEALED_METADATA_KEY]: expect.stringMatching(/^ck1:/),
    });
    expect(JSON.stringify(s)).not.toMatch(/Halvard|renew|thumb|base64/);
    const opened = await openMessage({ id: "m1", content: s.content, metadata: s.metadata });
    expect(opened).toEqual({
      content: "When does the Halvard contract renew?",
      metadata: META,
      unreadable: null,
    });
  });

  it("does not open on another row, and says so instead of failing the conversation", async () => {
    const s = await sealMessage(ALICE, "m1", "When does the Halvard contract renew?", META);
    const moved = await openMessage({ id: "m2", content: s.content, metadata: s.metadata });
    expect(moved.content).toBe("");
    expect(moved.unreadable).toMatch(/did not open/);
  });

  it("whose key was erased reads as such", async () => {
    const s = await sealMessage(ALICE, "m1", "When does the Halvard contract renew?", null);
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const opened = await openMessage({ id: "m1", content: s.content, metadata: s.metadata });
    expect(opened.unreadable).toMatch(/erased/);
  });

  it("from before R446 reads as it is, and nothing is sealed before the user-key tables exist", async () => {
    expect(await openMessage({ id: "m1", content: "plain words", metadata: { a: 1 } })).toEqual({
      content: "plain words",
      metadata: { a: 1 },
      unreadable: null,
    });
    __setKeyHierarchyForTests(missingKeyStore());
    const s = await sealMessage(ALICE, "m1", "plain words", { a: 1 });
    expect(s).toEqual({ content: "plain words", metadata: { a: 1 }, sealed: false });
  });
});

describe("a title", () => {
  it("is sealed, except the one every conversation starts with", async () => {
    expect(await sealTitle(ALICE, "c1", DEFAULT_TITLE)).toBe(DEFAULT_TITLE);
    const s = await sealTitle(ALICE, "c1", "Halvard renewal");
    expect(s).toMatch(/^ck1:/);
    expect(await openTitle({ id: "c1", title: s })).toEqual({
      title: "Halvard renewal",
      unreadable: null,
    });
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const gone = await openTitle({ id: "c1", title: s });
    expect(gone.title).toBe("Cannot be read");
    expect(gone.unreadable).toMatch(/erased/);
  });
});

describe("the chat page's server functions", () => {
  async function aliceConversation(): Promise<string> {
    const c = ok(
      await startConversation({ data: { access_token: "alice-token", agent_id: AGENT } }),
    );
    expect(c.conversation.title).toBe(DEFAULT_TITLE);
    return c.conversation.id;
  }

  it("save a message sealed, and give it back opened", async () => {
    const convo = await aliceConversation();
    const saved = ok(
      await saveMessage({
        data: {
          access_token: "alice-token",
          conversation_id: convo,
          role: "user",
          content: "When does the Halvard contract renew?",
          metadata: { docRequest: "docx" },
        },
      }),
    );
    const row = fake.tables.messages.find((m) => m.id === saved.id)!;
    expect(row.user_id).toBe(ALICE);
    expect(JSON.stringify(row)).not.toMatch(/Halvard|docRequest/);
    const list = ok(
      await listMessages({ data: { access_token: "alice-token", conversation_id: convo } }),
    );
    expect(list.messages).toEqual([
      expect.objectContaining({
        id: saved.id,
        role: "user",
        content: "When does the Halvard contract renew?",
        metadata: { docRequest: "docx" },
        unreadable: null,
      }),
    ]);
  });

  it("keep a document's path where chat retention looks for it", async () => {
    const convo = await aliceConversation();
    await saveMessage({
      data: {
        access_token: "alice-token",
        conversation_id: convo,
        role: "assistant",
        content: "Here's your Word document — **Halvard renewal terms.docx**",
        metadata: {
          doc: { format: "docx", filename: "Halvard renewal terms.docx", path: DOC_PATH },
        },
      },
    });
    const row = fake.tables.messages[0]!;
    // chatRetention.server selects `metadata` where `metadata->doc->>path` is not null.
    expect((row.metadata as { doc?: { path?: string } }).doc?.path).toBe(DOC_PATH);
  });

  it("write only into the caller's own conversation, and read only the caller's", async () => {
    const convo = await aliceConversation();
    const r = await saveMessage({
      data: { access_token: "bob-token", conversation_id: convo, role: "user", content: "hello" },
    });
    expect(r).toEqual({ ok: false, error: "There is no such conversation of yours" });
    await saveMessage({
      data: { access_token: "alice-token", conversation_id: convo, role: "user", content: "mine" },
    });
    const bobRead = ok(
      await listMessages({ data: { access_token: "bob-token", conversation_id: convo } }),
    );
    expect(bobRead.messages).toEqual([]);
    expect(
      await setConversationTitle({ data: { access_token: "bob-token", id: convo, title: "x" } }),
    ).toEqual({ ok: false, error: "There is no such conversation of yours" });
    expect(
      await listMessages({ data: { access_token: "nope", conversation_id: convo } }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("name a conversation sealed, and list it opened", async () => {
    const convo = await aliceConversation();
    ok(
      await setConversationTitle({
        data: { access_token: "alice-token", id: convo, title: "Halvard renewal" },
      }),
    );
    expect(fake.tables.conversations[0]!.title).toMatch(/^ck1:/);
    const list = ok(
      await listConversations({ data: { access_token: "alice-token", agent_id: AGENT } }),
    );
    expect(list.conversations.map((c) => c.title)).toEqual(["Halvard renewal"]);
    const bobList = ok(
      await listConversations({ data: { access_token: "bob-token", agent_id: AGENT } }),
    );
    expect(bobList.conversations).toEqual([]);
  });

  it("say why a message cannot be read, and still load the conversation", async () => {
    const convo = await aliceConversation();
    await saveMessage({
      data: {
        access_token: "alice-token",
        conversation_id: convo,
        role: "user",
        content: "secret plans",
      },
    });
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const list = ok(
      await listMessages({ data: { access_token: "alice-token", conversation_id: convo } }),
    );
    expect(list.messages[0]).toMatchObject({ content: "" });
    expect(list.messages[0]!.unreadable).toMatch(/erased/);
  });
});

describe("the conversation summary", () => {
  it("is folded from the opened messages, never from ciphertext", async () => {
    const convo = "77777777-7777-4777-8777-777777777777";
    fake.tables.conversations.push({
      id: convo,
      user_id: ALICE,
      agent_id: AGENT,
      title: DEFAULT_TITLE,
    });
    const t0 = Date.parse("2026-11-04T10:00:00Z");
    for (let i = 0; i < 4; i++) {
      const id = `00000000-0000-4000-8000-00000000000${i}`;
      const s = await sealMessage(ALICE, id, `turn ${i}: the Halvard renewal`, null);
      fake.tables.messages.push({
        id,
        conversation_id: convo,
        user_id: ALICE,
        role: i % 2 ? "assistant" : "user",
        content: s.content,
        metadata: s.metadata,
        created_at: new Date(t0 + i * 1000).toISOString(),
      });
    }
    await summarizeIfNeeded({
      sb: fake.client as never,
      userId: ALICE,
      conversationId: convo,
      windowMessages: 2,
      summaryModel: null,
    });
    expect(h.turnsSent.join("\n")).toContain("turn 0: the Halvard renewal");
    expect(h.turnsSent.join("\n")).not.toContain("ck1:");
  });
});

describe("the pass over chats kept before R446", () => {
  const legacy = (id: string, userId: string, content: string, metadata: unknown = {}) => ({
    id,
    conversation_id: "77777777-7777-4777-8777-777777777777",
    user_id: userId,
    role: "user",
    content,
    metadata,
  });
  const M1 = "11111111-1111-4111-8111-111111111111";
  const M2 = "22222222-2222-4222-8222-222222222222";

  it("seals messages and titles, leaves the starting title, and has nothing left after", async () => {
    fake.tables.messages.push(
      legacy(M1, ALICE, "When does the Halvard contract renew?", {
        doc: { path: DOC_PATH, filename: "Halvard.docx" },
      }),
    );
    // The starting title first: it must not end the pass early.
    fake.tables.conversations.push(
      { id: "c0", user_id: ALICE, agent_id: AGENT, title: DEFAULT_TITLE },
      { id: "c1", user_id: ALICE, agent_id: AGENT, title: "Halvard renewal" },
    );
    const r = await sealOlderChats();
    expect(r).toMatchObject({ messages: 1, titles: 1, failed: 0, unreadable: 0 });
    const m = fake.tables.messages[0]!;
    expect(JSON.stringify(m)).not.toMatch(/Halvard/);
    expect((m.metadata as { doc: { path: string } }).doc.path).toBe(DOC_PATH);
    expect((await openMessage(m as never)).content).toBe("When does the Halvard contract renew?");
    expect(fake.tables.conversations.find((c) => c.id === "c0")!.title).toBe(DEFAULT_TITLE);
    expect(fake.tables.conversations.find((c) => c.id === "c1")!.title).toMatch(/^ck1:/);
    expect(await sealOlderChats()).toMatchObject({ messages: 0, titles: 0 });
  });

  it("seals at most its limit, and says more is left", async () => {
    fake.tables.messages.push(legacy(M1, ALICE, "one"), legacy(M2, ALICE, "two"));
    expect(await sealOlderChats({ limit: 1 })).toMatchObject({ messages: 1, left: true });
    expect(await sealOlderChats({ limit: 1 })).toMatchObject({ messages: 1, left: false });
  });

  it("leaves an owner's chat as it is while their key cannot be had, and seals everyone else's", async () => {
    const id = crypto.randomUUID();
    const material = await keyHierarchy().makeCustomerKeyMaterial({
      id,
      name: "Acme",
      provider: "app",
      keyRef: null,
      endpoint: null,
    });
    mem.customerKeys.set(id, {
      id,
      name: "Acme",
      provider: "app",
      key_ref: null,
      endpoint: null,
      ...material,
      created_at: new Date().toISOString(),
      destroyed_at: new Date().toISOString(),
    });
    mem.assignUser(id, ALICE);
    fake.tables.messages.push(legacy(M1, ALICE, "alice's words"), legacy(M2, BOB, "bob's words"));
    const r = await sealOlderChats();
    expect(r).toMatchObject({ messages: 1, unreadable: 1, failed: 0 });
    expect(fake.tables.messages.find((m) => m.id === M1)!.content).toBe("alice's words");
    expect(fake.tables.messages.find((m) => m.id === M2)!.content).toMatch(/^ck1:/);
  });

  it("does nothing before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    fake.tables.messages.push(legacy(M1, ALICE, "plain"));
    expect(await sealOlderChats()).toMatchObject({ messages: 0, failed: 0 });
    expect(fake.tables.messages[0]!.content).toBe("plain");
  });

  it.each([
    [undefined, 2000],
    ["50", 50],
    ["0", 2000],
    ["many", 2000],
  ])("CHAT_SEAL_PER_PASS=%s is %d", (raw, want) => {
    expect(chatSealPerPass(raw === undefined ? {} : { CHAT_SEAL_PER_PASS: raw })).toBe(want);
  });
});
