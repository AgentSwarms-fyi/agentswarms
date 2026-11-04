// A swarm chat that a failed read emptied, and saves that failed in silence.
//
// FOUND IN R109. The chat dialog read and wrote swarm_chats without reading
// the answers. Driven on a swarm made for it ("R109 chat echo", Input →
// Output, so every reply is the message itself): chat c7a47254 held "R109
// turn one" and "R109 turn two". Opened while its read was refused, it was
// selected over "Start the conversation below."; one message later the
// stored chat held that message and its reply, and nothing else. A refused
// update and a refused insert each left the turn on screen, with nothing
// said, and gone from the stored chat.
//
// Since R447 the store goes through the server, which seals a transcript under
// the user's key: these drive it end to end, over a client that can refuse.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as null | { from: (t: string) => unknown },
  signedIn: true,
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
      getUser: async () => ({
        data: { user: { id: "00000000-0000-4000-8000-00000000a11c" } },
        error: null,
      }),
    },
    from: (t: string) => h.db!.from(t),
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: h.signedIn ? { access_token: "t" } : null },
      }),
    },
  },
}));

import { __setKeyHierarchyForTests, keyHierarchy } from "@/utils/providers/crypto.server";
import { asSentence, openChat, saveChat } from "@/lib/swarmChatStore";
import { memoryKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const OWNER = "00000000-0000-4000-8000-00000000a11c";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const SWARM = "33333333-3333-4333-8333-333333333333";

type Answer = { data: unknown; error: { message: string } | null };

function fakeClient(answer: Answer) {
  const calls: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "update", "insert", "eq"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push(`${m}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
      return chain;
    };
  }
  chain.maybeSingle = async () => answer;
  chain.single = async () => answer;
  chain.then = (ok: (v: Answer) => unknown, fail: (e: unknown) => unknown) =>
    Promise.resolve(answer).then(ok, fail);
  h.db = {
    from: (table: string) => {
      calls.push(`from(${table})`);
      return chain;
    },
  };
  return { calls };
}

let mem: MemoryKeyStore;

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "e".repeat(64);
  h.signedIn = true;
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store);
});
afterEach(() => __setKeyHierarchyForTests(null));

const turn = [{ role: "user" as const, content: "R109", ts: 1 }];
const saveArgs = (chatId: string | null) => ({
  chatId,
  swarmId: SWARM,
  messages: turn,
  state: { topic: "refunds" },
  title: "R109",
});

describe("opening a conversation", () => {
  it("reports a failed read, and never hands back an empty transcript in its place", async () => {
    fakeClient({ data: null, error: { message: "R109 injected" } });
    const opened = await openChat(C1);
    expect(opened).toEqual({ ok: false, error: "R109 injected", gone: false });
    expect("messages" in opened).toBe(false);
  });

  it("says a conversation that is not there is gone", async () => {
    fakeClient({ data: null, error: null });
    const opened = await openChat(C1);
    expect(opened.ok).toBe(false);
    expect(opened.ok === false && opened.gone).toBe(true);
  });

  it("returns a transcript and state stored before R447 as they are", async () => {
    const stored = [
      { role: "user", content: "R109 turn one", ts: 1 },
      { role: "assistant", content: "R109 turn one", ts: 2 },
    ];
    const { calls } = fakeClient({ data: { messages: stored, state: { a: "1" } }, error: null });
    expect(await openChat(C1)).toEqual({ ok: true, messages: stored, state: { a: "1" } });
    expect(calls).toContain(`eq("id", "${C1}")`);
    // The caller's own, as the table's policy kept it.
    expect(calls).toContain(`eq("user_id", "${OWNER}")`);
  });

  it("is not read when no one is signed in", async () => {
    h.signedIn = false;
    fakeClient({ data: null, error: null });
    expect(await openChat(C1)).toEqual({ ok: false, error: "You are signed out", gone: false });
  });
});

describe("a sealed transcript (R447)", () => {
  /** The row a save wrote, from the call that wrote it. */
  const written = (calls: string[], verb: "update" | "insert") =>
    JSON.parse(calls.find((c) => c.startsWith(`${verb}(`))!.slice(verb.length + 1, -1));

  it("is stored with nothing readable, and opens where it was saved", async () => {
    const { calls } = fakeClient({ data: [{ id: C1 }], error: null });
    await saveChat({
      ...saveArgs(C1),
      messages: [{ role: "user", content: "Refund the Halvard order", ts: 1 }],
      state: { customer: "Halvard" },
      title: "Refund the Halvard order",
    });
    const row = written(calls, "update");
    expect(JSON.stringify(row)).not.toMatch(/Halvard|Refund|customer/);
    expect(row.title).toMatch(/^ck1:/);
    fakeClient({ data: { messages: row.messages, state: row.state }, error: null });
    expect(await openChat(C1)).toEqual({
      ok: true,
      messages: [{ role: "user", content: "Refund the Halvard order", ts: 1 }],
      state: { customer: "Halvard" },
    });
  });

  it("that does not open is an error, never an empty transcript a next turn could save over", async () => {
    const { calls } = fakeClient({ data: [{ id: C1 }], error: null });
    await saveChat(saveArgs(C1));
    const row = written(calls, "update");
    // Moved onto another row, neither the transcript nor the state opens.
    for (const onOtherRow of [
      { messages: row.messages, state: {} },
      { messages: [], state: row.state },
    ]) {
      fakeClient({ data: onOtherRow, error: null });
      const moved = await openChat(C2);
      expect(moved).toMatchObject({ ok: false, gone: false });
      expect(moved.ok === false && moved.error).toMatch(/cannot be read: It did not open/);
    }
    // Its key erased, it says so.
    mem.erase(OWNER);
    keyHierarchy().forgetAll();
    fakeClient({ data: { messages: row.messages, state: row.state }, error: null });
    const erased = await openChat(C1);
    expect(erased.ok === false && erased.error).toMatch(/erased/);
  });
});

describe("saving a conversation that has a row", () => {
  it("updates that row and asks for it back", async () => {
    const { calls } = fakeClient({ data: [{ id: C1 }], error: null });
    expect(await saveChat(saveArgs(C1))).toEqual({ ok: true, id: C1 });
    expect(calls.some((c) => c.startsWith("update("))).toBe(true);
    expect(calls).toContain(`eq("id", "${C1}")`);
    expect(calls).toContain(`eq("user_id", "${OWNER}")`);
    expect(calls).toContain('select("id")');
    expect(calls.some((c) => c.startsWith("insert("))).toBe(false);
  });

  it("reports a refused update", async () => {
    fakeClient({ data: null, error: { message: "R109 injected" } });
    expect(await saveChat(saveArgs(C1))).toEqual({
      ok: false,
      error: "R109 injected",
      gone: false,
    });
  });

  it("does not call an update that reached no row a save", async () => {
    fakeClient({ data: [], error: null });
    const saved = await saveChat(saveArgs(C1));
    expect(saved.ok).toBe(false);
    expect(saved.ok === false && saved.gone).toBe(true);
  });
});

describe("saving a new conversation", () => {
  it("inserts it for its owner and swarm, and returns its id", async () => {
    const { calls } = fakeClient({ data: { id: C2 }, error: null });
    expect(await saveChat(saveArgs(null))).toEqual({ ok: true, id: C2 });
    const insert = calls.find((c) => c.startsWith("insert("));
    expect(insert).toContain(`"user_id":"${OWNER}"`);
    expect(insert).toContain(`"swarm_id":"${SWARM}"`);
  });

  it("reports a refused insert", async () => {
    fakeClient({ data: null, error: { message: "R109 injected" } });
    expect(await saveChat(saveArgs(null))).toEqual({
      ok: false,
      error: "R109 injected",
      gone: false,
    });
  });

  it("does not call an insert that returned no id a save", async () => {
    fakeClient({ data: null, error: null });
    expect((await saveChat(saveArgs(null))).ok).toBe(false);
  });
});

describe("the words around an error", () => {
  it("end the error before the next sentence starts", () => {
    // Driven: "…did not reach the database What you see here…"
    expect(asSentence("R109 injected: the PATCH did not reach the database")).toBe(
      "R109 injected: the PATCH did not reach the database.",
    );
    expect(asSentence("That conversation no longer exists.")).toBe(
      "That conversation no longer exists.",
    );
  });
});

describe("the chat dialog", () => {
  const dialog = readFileSync("src/components/swarms/SwarmChatDialog.tsx", "utf8");
  const selectChat = dialog.slice(
    dialog.indexOf("const selectChat = async"),
    dialog.indexOf("const deleteChat = async"),
  );
  const persist = dialog.slice(
    dialog.indexOf("const persist = useCallback("),
    dialog.indexOf("const send = async"),
  );

  it("enters a conversation only once it has been read", () => {
    expect(selectChat).toContain("await openChat(id)");
    const refused = selectChat.indexOf("if (!opened.ok) {");
    const entered = selectChat.indexOf("chatIdRef.current = id;");
    expect(refused).toBeGreaterThan(-1);
    expect(entered).toBeGreaterThan(refused);
    expect(selectChat.slice(refused, entered)).toMatch(/return;\s*\}/);
  });

  it("says on screen when a save did not land, and offers to save again", () => {
    expect(persist).toContain("await saveChat({");
    expect(dialog).toMatch(/\{asSentence\(unsaved\)\} What you\s+see here/);
    expect(persist).toMatch(/if \(!saved\.ok\) \{[\s\S]*setUnsaved\([\s\S]*return false;/);
    expect(dialog).toMatch(
      /onClick=\{\(\) => void persist\(messages, carriedState\)\}\s*>\s*Save again/,
    );
  });

  it("does not read a list it could not load as an empty one", () => {
    expect(dialog).toContain("if (listErr) return setChatsError(listErr.message);");
    expect(dialog).toContain("Could not load conversations: {chatsError}");
  });
});
