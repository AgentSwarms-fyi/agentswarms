// AI Analyst threads and swarm chats under their owner's user key (R447).
//
// An analysis's title and turns (the question, the SQL, the narrative, samples
// of the rows it read) and a swarm chat's title, transcript and state are
// sealed under the user's key. The pages read and write them through the
// server; a scheduled analysis opens and seals on the server; a pass seals
// what was kept before. (swarmChatStore.test.ts drives the swarm side's reads
// and writes.)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";

const h = vi.hoisted(() => ({
  db: null as null | { from: (t: string) => unknown },
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
// A refresh's own query: what the pinned step reads now.
vi.mock("@/utils/bi/refresh.server", () => ({
  computeNextRun: () => new Date(),
  runLocalSqlForUser: async () => ({ columns: ["total"], rows: [{ total: 120 }], rowCount: 1 }),
}));

import { __setKeyHierarchyForTests, keyHierarchy } from "@/utils/providers/crypto.server";
import {
  isSealedJson,
  openAnalystTurns,
  sealAnalystThread,
  sealSwarmChat,
  SEALED_JSON_KEY,
} from "@/utils/chat/sealedThreads.server";
import { sealOlderChats } from "@/utils/chat/sealedChat.server";
import {
  getAnalystThread,
  listAnalystThreads,
  saveAnalystThread,
} from "@/utils/analystThreads.functions";
import { listSwarmChats } from "@/utils/swarmChats.functions";
import { refreshAnalysisServer } from "@/utils/analyst/schedule.server";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const ANALYST = "66666666-6666-4666-8666-666666666666";
const SWARM = "55555555-5555-4555-8555-555555555555";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

let fake: FakeDb;
let mem: MemoryKeyStore;

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "f".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest({
    ai_analyst_threads: [],
    ai_analysts: [{ id: ANALYST, source: { kind: "local", tables: [] } }],
    swarm_chats: [],
    messages: [],
    conversations: [],
  });
  h.db = fake.client as never;
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

const TURN = {
  question: "What is headcount at Halvard?",
  answer: "100 people (step 1).",
  status: "done",
  steps: [
    {
      goal: "Headcount",
      sql: "SELECT SUM(headcount) AS total FROM hr",
      status: "done",
      columns: ["total"],
      rows: [{ total: 100 }],
      rowCount: 1,
    },
  ],
};

const save = (id: string | null, token = "alice-token", turns: unknown[] = [TURN]) =>
  saveAnalystThread({
    data: {
      access_token: token,
      id,
      analyst_id: ANALYST,
      title: "What is headcount at Halvard?",
      turns,
    },
  });

describe("an analysis", () => {
  it("is stored with nothing readable, and comes back opened", async () => {
    const saved = ok(await save(null));
    const row = fake.tables.ai_analyst_threads[0]!;
    expect(row.user_id).toBe(ALICE);
    expect(row.title).toMatch(/^ck1:/);
    expect(isSealedJson(row.turns)).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(/Halvard|headcount|SELECT|100 people/i);
    expect(saved.thread).toMatchObject({
      title: "What is headcount at Halvard?",
      turns: [TURN],
      unreadable: null,
    });
    const list = ok(
      await listAnalystThreads({
        data: { access_token: "alice-token", analyst_id: ANALYST, limit: 50 },
      }),
    );
    expect(list.threads.map((t) => t.title)).toEqual(["What is headcount at Halvard?"]);
    expect(list.threads[0]!.turns).toEqual([TURN]);
  });

  it("is saved over its own row, and a save seals the title of one from before R447", async () => {
    fake.tables.ai_analyst_threads.push({
      id: T1,
      analyst_id: ANALYST,
      user_id: ALICE,
      title: "Older analysis of Halvard",
      turns: [TURN],
      updated_at: "2026-10-01T00:00:00Z",
    });
    // It reads as it is.
    const before = ok(await getAnalystThread({ data: { access_token: "alice-token", id: T1 } }));
    expect(before.thread).toMatchObject({ title: "Older analysis of Halvard", turns: [TURN] });
    const after = ok(await save(T1, "alice-token", [TURN, TURN]));
    expect(after.thread.turns).toEqual([TURN, TURN]);
    expect(after.thread.title).toBe("Older analysis of Halvard");
    const row = fake.tables.ai_analyst_threads[0]!;
    expect(row.title).toMatch(/^ck1:/);
    expect(JSON.stringify(row)).not.toMatch(/Halvard/);
    expect(fake.tables.ai_analyst_threads).toHaveLength(1);
  });

  it("is the caller's alone", async () => {
    const saved = ok(await save(null));
    const id = saved.thread.id;
    expect(await save(id, "bob-token")).toEqual({
      ok: false,
      error: "This analysis is no longer in the database",
    });
    expect(
      ok(await getAnalystThread({ data: { access_token: "bob-token", id } })).thread,
    ).toBeNull();
    expect(
      ok(
        await listAnalystThreads({
          data: { access_token: "bob-token", analyst_id: ANALYST, limit: 50 },
        }),
      ).threads,
    ).toEqual([]);
    expect(await getAnalystThread({ data: { access_token: "nope", id } })).toMatchObject({
      ok: false,
    });
  });

  it("whose key is gone says so, and the list still loads", async () => {
    ok(await save(null));
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const list = ok(
      await listAnalystThreads({
        data: { access_token: "alice-token", analyst_id: ANALYST, limit: 50 },
      }),
    );
    expect(list.threads[0]).toMatchObject({ title: "Cannot be read", turns: [] });
    expect(list.threads[0]!.unreadable).toMatch(/erased/);
  });

  it("copied onto another row does not open", async () => {
    const sealed = await sealAnalystThread(ALICE, T1, { title: "x", turns: [TURN] });
    await expect(openAnalystTurns({ id: T2, turns: sealed.turns })).rejects.toThrow(/did not open/);
  });

  it("is stored as before when the user-key tables do not exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    ok(await save(null));
    expect(fake.tables.ai_analyst_threads[0]).toMatchObject({
      title: "What is headcount at Halvard?",
      turns: [TURN],
    });
  });
});

describe("a scheduled refresh", () => {
  it("opens the analysis, runs it, and seals what it stores", async () => {
    const saved = ok(await save(null));
    const res = await refreshAnalysisServer(saved.thread.id);
    // The digest needs the title as a person wrote it, not as it is stored.
    expect(res.title).toBe("What is headcount at Halvard?");
    expect(res.userId).toBe(ALICE);
    const row = fake.tables.ai_analyst_threads[0]!;
    expect(isSealedJson(row.turns)).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(/Halvard|headcount|SELECT/i);
    const after = ok(
      await getAnalystThread({ data: { access_token: "alice-token", id: saved.thread.id } }),
    );
    const steps = (after.thread!.turns as Array<{ steps: Array<{ rows: unknown }> }>)[0]!.steps;
    expect(steps[0]!.rows).toEqual([{ total: 120 }]);
  });

  it("whose key is gone fails, and says why, rather than store anything", async () => {
    const saved = ok(await save(null));
    const before = JSON.stringify(fake.tables.ai_analyst_threads[0]);
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    await expect(refreshAnalysisServer(saved.thread.id)).rejects.toThrow(/erased/);
    expect(JSON.stringify(fake.tables.ai_analyst_threads[0])).toBe(before);
  });
});

describe("a swarm chat's list", () => {
  it("opens titles, is the caller's alone, and survives a title that does not open", async () => {
    const sealed = await sealSwarmChat(ALICE, T1, {
      title: "Refund the Halvard order",
      messages: [],
      state: {},
    });
    fake.tables.swarm_chats.push({
      id: T1,
      user_id: ALICE,
      swarm_id: SWARM,
      updated_at: "2026-11-04T00:00:00Z",
      ...sealed,
    });
    const list = ok(
      await listSwarmChats({ data: { access_token: "alice-token", swarm_id: SWARM } }),
    );
    expect(list.chats.map((c) => c.title)).toEqual(["Refund the Halvard order"]);
    expect(
      ok(await listSwarmChats({ data: { access_token: "bob-token", swarm_id: SWARM } })).chats,
    ).toEqual([]);
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const after = ok(
      await listSwarmChats({ data: { access_token: "alice-token", swarm_id: SWARM } }),
    );
    expect(after.chats.map((c) => c.title)).toEqual(["Cannot be read"]);
  });
});

describe("the pass over what was kept before R447", () => {
  const chat = (id: string, userId: string, title = "New chat") => ({
    id,
    user_id: userId,
    swarm_id: SWARM,
    title,
    messages: [{ role: "user", content: "Refund the Halvard order", ts: 1 }],
    state: { customer: "Halvard" },
  });
  const thread = (id: string, userId: string, title = "Analysis") => ({
    id,
    analyst_id: ANALYST,
    user_id: userId,
    title,
    turns: [TURN],
  });

  it("seals swarm chats and analyses, the starting titles too, and has nothing left after", async () => {
    fake.tables.swarm_chats.push(chat(T1, ALICE));
    fake.tables.ai_analyst_threads.push(thread(T2, ALICE));
    const r = await sealOlderChats();
    expect(r).toMatchObject({ swarmChats: 1, analystThreads: 1, failed: 0, unreadable: 0 });
    const c = fake.tables.swarm_chats[0]!;
    const t = fake.tables.ai_analyst_threads[0]!;
    // The title is how the pass knows a row is done.
    expect(c.title).toMatch(/^ck1:/);
    expect(t.title).toMatch(/^ck1:/);
    expect(JSON.stringify(c)).not.toMatch(/Halvard|Refund|customer/);
    expect(JSON.stringify(t)).not.toMatch(/Halvard|headcount/i);
    expect(Object.keys(c.messages as object)).toEqual([SEALED_JSON_KEY]);
    expect(await openAnalystTurns(t as never)).toEqual([TURN]);
    expect(await sealOlderChats()).toMatchObject({ swarmChats: 0, analystThreads: 0 });
  });

  it("does not seal twice the turns a save already sealed", async () => {
    const sealed = await sealAnalystThread(ALICE, T2, { title: "x", turns: [TURN] });
    fake.tables.ai_analyst_threads.push({
      id: T2,
      analyst_id: ANALYST,
      user_id: ALICE,
      title: "A title from before",
      turns: sealed.turns,
    });
    expect(await sealOlderChats()).toMatchObject({ analystThreads: 1 });
    expect(await openAnalystTurns(fake.tables.ai_analyst_threads[0] as never)).toEqual([TURN]);
  });

  it("seals at most its limit across the stores, and says more is left", async () => {
    fake.tables.swarm_chats.push(chat(T1, ALICE), chat(T2, ALICE));
    expect(await sealOlderChats({ limit: 1 })).toMatchObject({ swarmChats: 1, left: true });
    fake.tables.ai_analyst_threads.push(thread(T1, ALICE));
    const r = await sealOlderChats({ limit: 1 });
    expect(r.swarmChats + r.analystThreads).toBe(1);
  });

  it("leaves an owner's row as it is while their key cannot be had, and seals everyone else's", async () => {
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
    fake.tables.swarm_chats.push(chat(T1, ALICE), chat(T2, BOB));
    const r = await sealOlderChats();
    expect(r).toMatchObject({ swarmChats: 1, unreadable: 1, failed: 0 });
    expect(fake.tables.swarm_chats.find((c) => c.id === T1)!.title).toBe("New chat");
    expect(fake.tables.swarm_chats.find((c) => c.id === T2)!.title).toMatch(/^ck1:/);
  });

  it("does nothing before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    fake.tables.swarm_chats.push(chat(T1, ALICE));
    fake.tables.ai_analyst_threads.push(thread(T2, ALICE));
    expect(await sealOlderChats()).toMatchObject({ swarmChats: 0, analystThreads: 0, failed: 0 });
    expect(fake.tables.swarm_chats[0]!.title).toBe("New chat");
  });
});

describe("the pages", () => {
  const analyst = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
  const dialog = readFileSync("src/components/swarms/SwarmChatDialog.tsx", "utf8");
  const store = readFileSync("src/lib/swarmChatStore.ts", "utf8");

  it("read and write no thread themselves; a swarm chat's delete stays in the dialog", () => {
    expect(analyst).not.toContain('"ai_analyst_threads"');
    expect(store).not.toMatch(/\.from\(/);
    const direct = [...dialog.matchAll(/\.from\("swarm_chats"\)\s*\.(\w+)\(/g)].map((m) => m[1]);
    expect(direct).toEqual(["delete"]);
  });

  it("do not save over an analysis that could not be read", () => {
    expect(analyst).toContain('if (thread && !thread.unreadable && thread.id !== "unsaved") {');
    expect(analyst).toContain("This analysis cannot be read: {thread.unreadable}");
  });
});

describe("a key named like an object's own method", () => {
  // Analyses, chat metadata and Visual BI rows reach the browser through
  // server functions, keyed by the user's column names. An older seroval threw
  // on a key named `constructor` and the whole response was a 500 (the F1
  // sample's column was renamed for it). This pins the installed version's
  // round trip, by the calls TanStack's handler and fetcher make.
  it("survives the server function round trip", async () => {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const seroval = require("seroval") as {
      toCrossJSONAsync: (v: unknown, o: unknown) => Promise<unknown>;
      fromCrossJSON: (v: unknown, o: unknown) => unknown;
      toJSONAsync: (v: unknown, o: unknown) => Promise<unknown>;
      fromJSON: (v: unknown, o: unknown) => unknown;
    };
    const value = {
      ok: true,
      turns: [{ rows: [{ constructor: "McLaren", toString: "x", valueOf: "y", points: 833 }] }],
    };
    const response = await seroval.toCrossJSONAsync(value, { refs: new Map(), plugins: [] });
    expect(seroval.fromCrossJSON(response, { refs: new Map(), plugins: [] })).toEqual(value);
    const request = await seroval.toJSONAsync(value, { plugins: [] });
    expect(seroval.fromJSON(request, { plugins: [] })).toEqual(value);
  });
});
