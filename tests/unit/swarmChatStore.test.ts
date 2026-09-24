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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { asSentence, openChat, saveChat } from "@/lib/swarmChatStore";

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
  const client = {
    from: (table: string) => {
      calls.push(`from(${table})`);
      return chain;
    },
  };
  return { client: client as never, calls };
}

const turn = [{ role: "user" as const, content: "R109", ts: 1 }];
const saveArgs = (chatId: string | null) => ({
  chatId,
  userId: "owner",
  swarmId: "swarm-1",
  messages: turn,
  state: { topic: "refunds" },
  title: "R109",
});

describe("opening a conversation", () => {
  it("reports a failed read, and never hands back an empty transcript in its place", async () => {
    const { client } = fakeClient({ data: null, error: { message: "R109 injected" } });
    const opened = await openChat(client, "c1");
    expect(opened).toEqual({ ok: false, error: "R109 injected", gone: false });
    expect("messages" in opened).toBe(false);
  });

  it("says a conversation that is not there is gone", async () => {
    const { client } = fakeClient({ data: null, error: null });
    const opened = await openChat(client, "c1");
    expect(opened.ok).toBe(false);
    expect(opened.ok === false && opened.gone).toBe(true);
  });

  it("returns the stored transcript and state", async () => {
    const stored = [
      { role: "user", content: "R109 turn one", ts: 1 },
      { role: "assistant", content: "R109 turn one", ts: 2 },
    ];
    const { client, calls } = fakeClient({
      data: { messages: stored, state: { a: "1" } },
      error: null,
    });
    expect(await openChat(client, "c1")).toEqual({ ok: true, messages: stored, state: { a: "1" } });
    expect(calls).toContain('eq("id", "c1")');
  });
});

describe("saving a conversation that has a row", () => {
  it("updates that row and asks for it back", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "c1" }], error: null });
    expect(await saveChat(client, saveArgs("c1"))).toEqual({ ok: true, id: "c1" });
    expect(calls.some((c) => c.startsWith("update("))).toBe(true);
    expect(calls).toContain('eq("id", "c1")');
    expect(calls).toContain('select("id")');
    expect(calls.some((c) => c.startsWith("insert("))).toBe(false);
  });

  it("reports a refused update", async () => {
    const { client } = fakeClient({ data: null, error: { message: "R109 injected" } });
    expect(await saveChat(client, saveArgs("c1"))).toEqual({
      ok: false,
      error: "R109 injected",
      gone: false,
    });
  });

  it("does not call an update that reached no row a save", async () => {
    const { client } = fakeClient({ data: [], error: null });
    const saved = await saveChat(client, saveArgs("c1"));
    expect(saved.ok).toBe(false);
    expect(saved.ok === false && saved.gone).toBe(true);
  });
});

describe("saving a new conversation", () => {
  it("inserts it for its owner and swarm, and returns its id", async () => {
    const { client, calls } = fakeClient({ data: { id: "c9" }, error: null });
    expect(await saveChat(client, saveArgs(null))).toEqual({ ok: true, id: "c9" });
    const insert = calls.find((c) => c.startsWith("insert("));
    expect(insert).toContain('"user_id":"owner"');
    expect(insert).toContain('"swarm_id":"swarm-1"');
  });

  it("reports a refused insert", async () => {
    const { client } = fakeClient({ data: null, error: { message: "R109 injected" } });
    expect(await saveChat(client, saveArgs(null))).toEqual({
      ok: false,
      error: "R109 injected",
      gone: false,
    });
  });

  it("does not call an insert that returned no id a save", async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect((await saveChat(client, saveArgs(null))).ok).toBe(false);
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
    expect(selectChat).toContain("await openChat(supabase, id)");
    const refused = selectChat.indexOf("if (!opened.ok) {");
    const entered = selectChat.indexOf("chatIdRef.current = id;");
    expect(refused).toBeGreaterThan(-1);
    expect(entered).toBeGreaterThan(refused);
    expect(selectChat.slice(refused, entered)).toMatch(/return;\s*\}/);
  });

  it("says on screen when a save did not land, and offers to save again", () => {
    expect(persist).toContain("await saveChat(supabase,");
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
