// Model call traces under their owner's user key (R448).
//
// A trace's prompt, payloads and tool calls are sealed under the user's key.
// What budgets, the reprice sweep and the list ask Postgres about stays
// readable; any other payload key is sealed, one nobody has added yet too. A
// key that cannot be had costs a row its text and never the row: it is what
// budgets add up. The Traces page and the Agent Chat panel read through the
// server, a decision's chain does not read the bodies, and a pass seals what
// was kept before.
import { readFileSync } from "node:fs";
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
// recordGatewayCall's budget mail, which runs after every traced call.
vi.mock("@/lib/email/budgetAlertTrigger.server", () => ({
  checkAndNotifyBudget: async () => undefined,
  checkAndNotifyGroupBudgets: async () => undefined,
}));

import { __setKeyHierarchyForTests, keyHierarchy } from "@/utils/providers/crypto.server";
import { isSealedJson } from "@/utils/chat/sealedThreads.server";
import {
  openTracePrompts,
  openTraceRow,
  sealOlderTraces,
  sealTraceBodies,
  sealTraceRow,
  TRACE_CLEAR_KEYS,
  traceSealPerPass,
} from "@/utils/observability/sealedTraces.server";
import { tracePassDetail } from "@/utils/observability/tracePass";
import { recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { repriceRow } from "@/utils/observability/reprice.server";
import { getExecutionTraceDetail, getExecutionTraces } from "@/utils/traceLog.functions";
import { storedFilesPassLine } from "@/utils/storage/storedFiles";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

let fake: FakeDb;
let mem: MemoryKeyStore;

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "f".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest({ execution_traces: [] });
  h.db = fake.client as never;
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store);
});
afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
  delete process.env.PERSIST_PROMPT_BODIES;
  vi.restoreAllMocks();
});

const ok = <T>(r: T): Exclude<T, { ok: false }> => {
  const v = r as { ok: boolean; error?: string };
  if (!v.ok) throw new Error(`expected ok: ${v.error}`);
  return r as Exclude<T, { ok: false }>;
};

const CREATED = new Date().toISOString();
const TOOLS = [{ type: "tool_call", name: "search_kb", args: { q: "Halvard salaries" } }];
const row = (over: Record<string, unknown> = {}) => ({
  id: ID1,
  user_id: ALICE,
  agent_name: "Chat",
  llm_provider: "openrouter",
  llm_model: "acme/one",
  tokens_in: 10,
  tokens_out: 20,
  cost_usd: 0.25,
  status: "success",
  error_message: null as string | null,
  created_at: CREATED,
  prompt: "What do the Halvard salaries come to?",
  request_payload: {
    surface: "chat",
    price_source: "provider",
    systemPrompt: "You are the Halvard payroll helper",
    messages: [{ role: "user", content: "What do the Halvard salaries come to?" }],
  } as unknown,
  response_payload: { preview: "They come to 4.2m at Halvard" } as unknown,
  tool_calls: TOOLS as unknown,
  ...over,
});

const noText = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(/Halvard/);

describe("a trace, as it is stored", () => {
  it("holds none of what was said, and opens to what it was", async () => {
    const stored = await sealTraceRow(row());
    noText(stored);
    expect(stored.prompt).toMatch(/^ck1:/);
    expect(isSealedJson(stored.response_payload)).toBe(true);
    expect(isSealedJson(stored.tool_calls)).toBe(true);
    expect(isSealedJson(stored.request_payload)).toBe(true);

    const opened = await openTraceRow(stored);
    expect(opened).toMatchObject({
      prompt: row().prompt,
      request_payload: row().request_payload,
      response_payload: row().response_payload,
      tool_calls: TOOLS,
      body_sealed: true,
      body_dropped: false,
      body_unreadable: null,
    });
    // The sealed form leaves nothing of itself in what a page shows.
    expect(Object.keys(opened.request_payload as object).sort()).toEqual(
      Object.keys(row().request_payload as object).sort(),
    );
  });

  it("keeps readable exactly what budgets, the reprice sweep and the list ask about", async () => {
    const clear = Object.fromEntries([...TRACE_CLEAR_KEYS].map((k) => [k, `v-${k}`]));
    const stored = await sealTraceRow(row({ request_payload: clear }));
    const p = stored.request_payload as Record<string, unknown>;
    for (const k of TRACE_CLEAR_KEYS) expect(p[k]).toBe(`v-${k}`);
    // The keys the rest of the code reads from Postgres, by name.
    for (const k of ["pricing_missing", "price_source", "model_fallback", "tokens_estimated"]) {
      expect(TRACE_CLEAR_KEYS.has(k)).toBe(true);
    }
  });

  it("seals a payload key nobody has thought of yet", async () => {
    const stored = await sealTraceRow(
      row({ request_payload: { surface: "chat", a_new_key: "Halvard" } }),
    );
    noText(stored);
    expect(stored.request_payload).not.toHaveProperty("a_new_key");
    const opened = await openTraceRow(stored);
    expect(opened.request_payload).toEqual({ surface: "chat", a_new_key: "Halvard" });
  });

  it("does not take a marker in a payload for the row being sealed", async () => {
    const stored = await sealTraceRow(
      row({
        request_payload: { body_sealed: true, "ck1:sealed": "Halvard", note: "Halvard" },
        prompt: "Halvard",
      }),
    );
    noText(stored);
    expect(stored.prompt).toMatch(/^ck1:/);
    expect((await openTraceRow(stored)).body_unreadable).toBeNull();
  });

  it("does not open on another row, each column alone", async () => {
    const a = await sealTraceRow(row());
    const b = await sealTraceRow(row({ id: ID2 }));
    for (const column of ["prompt", "request_payload", "response_payload", "tool_calls"] as const) {
      const moved = await openTraceRow({ ...b, [column]: a[column] });
      expect(moved.body_unreadable, column).toMatch(/It did not open/);
      noText(moved);
    }
  });

  it("leaves a row whose bodies were not kept, and one with no owner", async () => {
    const redacted = row({
      prompt: null,
      request_payload: { redacted: true },
      response_payload: { redacted: true },
      tool_calls: { redacted: true },
    });
    expect(await sealTraceRow(redacted)).toEqual(redacted);
    const ownerless = row({ user_id: null });
    expect(await sealTraceRow(ownerless)).toEqual(ownerless);
  });

  it("stays as it was before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    expect(await sealTraceRow(row())).toEqual(row());
  });
});

describe("a key that cannot be had when a trace is written", () => {
  const refuse = () => {
    mem.erase(ALICE);
    __setKeyHierarchyForTests({
      ...mem.store,
      activeUserKey: async () => {
        throw new Error("the key service is down");
      },
    });
    keyHierarchy().forgetAll();
  };

  it("costs the row its text and never the row, and nothing goes under another key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    refuse();
    const stored = await sealTraceRow(row());
    noText(stored);
    expect(stored).toMatchObject({
      prompt: null,
      cost_usd: 0.25,
      tokens_in: 10,
      tokens_out: 20,
      response_payload: {},
      tool_calls: [],
      request_payload: {
        surface: "chat",
        price_source: "provider",
        body_sealed: true,
        body_dropped: true,
      },
    });
    expect(JSON.stringify(stored)).not.toMatch(/ck1:/);
  });

  it("says so when it is opened", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    refuse();
    const opened = await openTraceRow(await sealTraceRow(row()));
    expect(opened).toMatchObject({
      prompt: null,
      body_sealed: true,
      body_dropped: true,
      body_unreadable: null,
    });
    expect(opened.request_payload).toEqual({ surface: "chat", price_source: "provider" });
  });

  it("still records the cost of a gateway call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    refuse();
    await recordGatewayCall({
      userId: ALICE,
      surface: "bi",
      model: "acme/one",
      promptText: "Halvard",
      responsePreview: "Halvard",
      tokensIn: 5,
      tokensOut: 5,
      providerCostUsd: 0.5,
    } as never);
    const [stored] = fake.tables.execution_traces;
    expect(stored).toMatchObject({ user_id: ALICE, cost_usd: 0.5, prompt: null });
    noText(stored);
  });
});

describe("a gateway call's trace", () => {
  it("is sealed and bound to the id it is stored under", async () => {
    await recordGatewayCall({
      userId: ALICE,
      surface: "bi",
      model: "acme/one",
      promptText: "Halvard prompt",
      requestPreview: "Halvard request",
      responsePreview: "Halvard reply",
      tokensIn: 5,
      tokensOut: 5,
    } as never);
    const [stored] = fake.tables.execution_traces;
    noText(stored);
    // Its own id, not the database's default: the bodies are bound to it.
    expect(stored!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(stored!.request_payload).toMatchObject({
      surface: "bi",
      kind: "text",
      body_sealed: true,
    });
    const opened = await openTraceRow(stored as ReturnType<typeof row>);
    expect(opened).toMatchObject({
      prompt: "Halvard prompt",
      response_payload: { preview: "Halvard reply" },
      body_unreadable: null,
    });
    expect(opened.request_payload).toMatchObject({ preview: "Halvard request" });
  });

  it("drops its bodies, as ever, with PERSIST_PROMPT_BODIES=false", async () => {
    process.env.PERSIST_PROMPT_BODIES = "false";
    await recordGatewayCall({
      userId: ALICE,
      surface: "bi",
      model: "acme/one",
      promptText: "Halvard",
      tokensIn: 5,
      tokensOut: 5,
    } as never);
    expect(fake.tables.execution_traces[0]).toMatchObject({
      prompt: null,
      request_payload: { redacted: true },
    });
  });
});

describe("the chat route's trace", () => {
  const SRC = readFileSync(path.resolve("src/routes/api/chat.ts"), "utf8");

  it("is sealed before it is written", () => {
    const at = SRC.indexOf('(supabaseAdmin.from("execution_traces") as any).upsert(insertRow)');
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(0, at)).toMatch(
      /const insertRow = await sealTraceRow\(\{\s+id: trace\.traceId/,
    );
  });

  it("does not send a null for a column that refuses one, which lost a generated image's cost", () => {
    const migration = readFileSync(
      path.resolve("supabase/migrations/20260416211055_d42dd9c5-7a9f-465d-b043-991410672f9c.sql"),
      "utf8",
    );
    expect(migration).toMatch(/response_payload JSONB NOT NULL/);
    expect(SRC).toContain("skipResponsePayload ? {} : { preview:");
    expect(SRC).not.toContain("skipResponsePayload ? null");
  });
});

describe("the Traces page's reads", () => {
  const seed = async () => {
    fake.tables.execution_traces.push(
      await sealTraceRow(row()),
      await sealTraceRow(
        row({
          id: ID2,
          user_id: BOB,
          prompt: "Bob asked about Halvard",
          response_payload: {},
          tool_calls: [],
        }),
      ),
      // One from before R448.
      row({ id: ID3, prompt: "An older question" }),
    );
  };

  it("lists the caller's traces with their prompts, older ones as they are", async () => {
    await seed();
    const r = ok(await getExecutionTraces({ data: { accessToken: "alice-token", days: 30 } }));
    expect(r.traces.map((t) => t.prompt).sort()).toEqual([
      "An older question",
      "What do the Halvard salaries come to?",
    ]);
    expect(r.traces.every((t) => t.body_unreadable === null)).toBe(true);
  });

  it("opens one with everything it holds, and its figures as they were", async () => {
    fake.tables.execution_traces.push(
      await sealTraceRow(
        row({
          request_payload: {
            pricing_missing: true,
            model_fallback: { from: "acme/two", reason: "not known" },
            messages: [{ role: "user", content: "Halvard" }],
          },
        }),
      ),
    );
    const r = ok(await getExecutionTraceDetail({ data: { accessToken: "alice-token", id: ID1 } }));
    expect(r.trace).toMatchObject({
      prompt: row().prompt,
      response_payload: row().response_payload,
      tool_calls: TOOLS,
      pricing_missing: "true",
      fell_back_from: "acme/two",
      body_sealed: true,
    });
    expect(r.trace!.request_payload).toMatchObject({
      messages: [{ role: "user", content: "Halvard" }],
    });
  });

  it("does not open another user's trace", async () => {
    await seed();
    const r = ok(await getExecutionTraceDetail({ data: { accessToken: "bob-token", id: ID1 } }));
    expect(r.trace).toBeNull();
    const list = ok(await getExecutionTraces({ data: { accessToken: "bob-token", days: 30 } }));
    expect(list.traces.map((t) => t.id)).toEqual([ID2]);
  });

  it("refuses a caller with no session", async () => {
    await seed();
    expect(await getExecutionTraces({ data: { accessToken: "nope", days: 30 } })).toMatchObject({
      ok: false,
    });
    expect(await getExecutionTraceDetail({ data: { accessToken: "nope", id: ID1 } })).toMatchObject(
      { ok: false },
    );
  });

  it("with the key gone still loads, and says why, asking for the key once", async () => {
    await seed();
    fake.tables.execution_traces.push(
      await sealTraceRow(row({ id: "44444444-4444-4444-8444-444444444444" })),
    );
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const before = mem.calls.userKeyByKid;
    const list = ok(await getExecutionTraces({ data: { accessToken: "alice-token", days: 30 } }));
    expect(mem.calls.userKeyByKid - before).toBe(1);
    const sealedOnes = list.traces.filter((t) => t.id !== ID3);
    expect(sealedOnes).toHaveLength(2);
    for (const t of sealedOnes) {
      expect(t.prompt).toBeNull();
      expect(t.body_unreadable).toMatch(/erased/);
    }
    // One from before R448 is not under the key.
    expect(list.traces.find((t) => t.id === ID3)).toMatchObject({
      prompt: "An older question",
      body_unreadable: null,
    });

    const one = ok(
      await getExecutionTraceDetail({ data: { accessToken: "alice-token", id: ID1 } }),
    );
    expect(one.trace).toMatchObject({
      prompt: null,
      cost_usd: 0.25,
      tokens_in: 10,
      response_payload: {},
      tool_calls: [],
    });
    expect(one.trace!.body_unreadable).toMatch(/erased/);
    expect(one.trace!.request_payload).toEqual({ surface: "chat", price_source: "provider" });
  });

  it("a value that does not open costs one row of a list, not the page", async () => {
    const a = await sealTraceRow(row());
    const b = await sealTraceRow(row({ id: ID2 }));
    const [first, second] = await openTracePrompts([{ ...a, prompt: b.prompt }, b]);
    expect(first!.body_unreadable).toMatch(/It did not open/);
    expect(second!.prompt).toBe(row().prompt);
  });
});

describe("what reads the table without the key", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");

  it("the Agent Chat panel asks the server", () => {
    const src = read("src/routes/_authenticated/playground.tsx");
    expect(src).not.toContain('.from("execution_traces")');
    expect(read("src/lib/traceReads.ts")).toContain("getExecutionTraceDetail");
  });

  it("the Traces page's direct read leaves the prompt out", () => {
    const src = read("src/routes/_authenticated/traces.tsx");
    const at = src.indexOf('.from("execution_traces")');
    const select = src.slice(at, src.indexOf(".gte(", at));
    expect(select).toContain("cost_usd");
    expect(select).not.toMatch(/\bprompt\b/);
  });

  it("a decision's chain reads no body", () => {
    const src = read("src/utils/provenance/decision.server.ts");
    const at = src.indexOf('from("execution_traces")');
    const select = src.slice(at, src.indexOf(".eq(", at));
    expect(select).toContain("cost_usd");
    expect(select).not.toMatch(/\bprompt\b|tool_calls|_payload/);
  });

  it("the OpenTelemetry export reads no body", () => {
    const src = read("src/utils/observability/otelExport.server.ts");
    const at = src.indexOf('.from("execution_traces")');
    const select = src.slice(at, src.indexOf(".lte(", at));
    expect(select).toContain("cost_usd");
    expect(select).not.toMatch(/\bprompt\b|tool_calls|_payload/);
  });
});

describe("the reprice sweep over a sealed row", () => {
  it("prices it, and the row still opens with the new figures", async () => {
    const stored = await sealTraceRow(
      row({
        llm_provider: "anthropic",
        llm_model: "claude-opus-4-1",
        request_payload: { pricing_missing: true, kind: "text", messages: ["Halvard"] },
      }),
    );
    const priced = repriceRow(stored as never);
    expect(priced).not.toBeNull();
    expect(JSON.stringify(priced)).not.toMatch(/Halvard/);
    const opened = await openTraceRow({ ...stored, request_payload: priced!.request_payload });
    expect(opened.body_unreadable).toBeNull();
    const p = opened.request_payload as Record<string, unknown>;
    expect(p.messages).toEqual(["Halvard"]);
    expect(p).not.toHaveProperty("pricing_missing");
    expect(p.repriced_at).toBeTruthy();
  });

  it("is still found by the filter it uses, on a sealed row", async () => {
    fake.tables.execution_traces.push(
      await sealTraceRow(row({ request_payload: { pricing_missing: true, messages: ["x"] } })),
    );
    const { data } = await (
      fake.client.from("execution_traces") as never as {
        select: (c: string) => { eq: (c: string, v: unknown) => Promise<{ data: unknown[] }> };
      }
    )
      .select("id")
      .eq("request_payload->>pricing_missing", "true");
    expect(data).toHaveLength(1);
  });
});

describe("the pass over traces kept before R448", () => {
  it("seals them, says how many, and has nothing left the second time", async () => {
    fake.tables.execution_traces.push(row(), row({ id: ID2, user_id: BOB }));
    expect(await sealOlderTraces()).toEqual({
      traces: 2,
      unreadable: 0,
      left: false,
      failed: 0,
      errors: [],
    });
    noText(fake.tables.execution_traces);
    const opened = await openTraceRow(fake.tables.execution_traces[0] as ReturnType<typeof row>);
    expect(opened).toMatchObject({ prompt: row().prompt, tool_calls: TOOLS, body_sealed: true });
    expect((await sealOlderTraces()).traces).toBe(0);
  });

  it("puts each owner's traces under that owner's key", async () => {
    fake.tables.execution_traces.push(row(), row({ id: ID2, user_id: BOB }));
    await sealOlderTraces();
    mem.erase(BOB);
    keyHierarchy().forgetAll();
    const [a, b] = fake.tables.execution_traces as ReturnType<typeof row>[];
    expect((await openTraceRow(a!)).body_unreadable).toBeNull();
    expect((await openTraceRow(b!)).body_unreadable).toMatch(/erased/);
  });

  it("leaves what it has nothing to do with", async () => {
    const ownerless = row({ user_id: null });
    const redacted = row({
      id: ID2,
      prompt: null,
      request_payload: { redacted: true },
      response_payload: { redacted: true },
      tool_calls: { redacted: true },
    });
    const done = await sealTraceRow(row({ id: ID3 }));
    // Each one first, so that one stopping the pass leaves the plain row unsealed.
    const plain = row({ id: "44444444-4444-4444-8444-444444444444" });
    fake.tables.execution_traces.push(ownerless, redacted, done, plain);
    expect((await sealOlderTraces()).traces).toBe(1);
    expect(fake.tables.execution_traces.slice(0, 3)).toEqual([ownerless, redacted, done]);
    expect(fake.tables.execution_traces[3]!.prompt).toMatch(/^ck1:/);
    // Nothing was tried on them: not even a write the guard would refuse.
    expect(fake.log.filter((l: string) => l === "update execution_traces")).toHaveLength(1);
  });

  it("does not seal twice a column a racing reprice left sealed beside a plain payload", async () => {
    const sealed = await sealTraceRow(row());
    fake.tables.execution_traces.push({ ...sealed, request_payload: row().request_payload });
    expect((await sealOlderTraces()).traces).toBe(1);
    const opened = await openTraceRow(fake.tables.execution_traces[0] as ReturnType<typeof row>);
    expect(opened).toMatchObject({
      prompt: row().prompt,
      response_payload: row().response_payload,
      tool_calls: TOOLS,
      body_unreadable: null,
    });
  });

  it("stops at its limit and says more is left", async () => {
    fake.tables.execution_traces.push(row(), row({ id: ID2 }), row({ id: ID3 }));
    const r = await sealOlderTraces({ limit: 2 });
    expect(r).toMatchObject({ traces: 2, left: true });
    expect(await sealOlderTraces({ limit: 2 })).toMatchObject({ traces: 1, left: false });
  });

  it("counts and leaves a row whose owner's key is refused, and goes on", async () => {
    fake.tables.execution_traces.push(row(), row({ id: ID2, user_id: BOB }));
    const { DataKeyUnavailableError } = await import("@/utils/kms/keyHierarchy.server");
    __setKeyHierarchyForTests({
      ...mem.store,
      activeUserKey: async (u: string) => {
        if (u === ALICE) throw new DataKeyUnavailableError("revoked", "denied");
        return mem.store.activeUserKey(u);
      },
    });
    const r = await sealOlderTraces();
    expect(r).toMatchObject({ traces: 1, unreadable: 1, failed: 0 });
    expect(fake.tables.execution_traces[0]).toEqual(row());
  });

  it("does nothing before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    fake.tables.execution_traces.push(row());
    expect((await sealOlderTraces()).traces).toBe(0);
    expect(fake.tables.execution_traces[0]).toEqual(row());
  });

  it("does not write over a row sealed while it was working", async () => {
    fake.tables.execution_traces.push(row());
    const raced = await sealTraceRow(row());
    const real = fake.client.from.bind(fake.client);
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        const update = q.update.bind(q);
        q.update = (p: unknown) => {
          Object.assign(fake.tables.execution_traces[0]!, raced);
          return update(p);
        };
        return q;
      },
    } as never;
    expect((await sealOlderTraces()).traces).toBe(0);
    expect(fake.tables.execution_traces[0]).toMatchObject({ prompt: raced.prompt });
  });

  it("reports a read that failed", async () => {
    h.db = fakePostgrest({}).client as never;
    const r = await sealOlderTraces();
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toMatch(/^traces: /);
  });

  it("reports a write that failed, and goes on", async () => {
    fake.tables.execution_traces.push(row(), row({ id: ID2 }));
    const real = fake.client.from.bind(fake.client);
    let writes = 0;
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        const update = q.update.bind(q);
        q.update = (p: unknown) => {
          if (++writes > 1) return update(p);
          const refused = {
            eq: () => refused,
            is: () => refused,
            select: async () => ({ data: null, error: { message: "refused" } }),
          };
          return refused;
        };
        return q;
      },
    } as never;
    const r = await sealOlderTraces();
    expect(r).toMatchObject({ traces: 1, failed: 1 });
    expect(r.errors[0]).toBe(`trace ${ID1}: refused`);
  });
});

describe("what the pass reports", () => {
  it("TRACE_SEAL_PER_PASS has a default and refuses nonsense", () => {
    expect(traceSealPerPass("")).toBe(2000);
    expect(traceSealPerPass("50")).toBe(50);
    expect(traceSealPerPass("0")).toBe(2000);
    expect(traceSealPerPass("-2")).toBe(2000);
    expect(traceSealPerPass("1.5")).toBe(2000);
    expect(traceSealPerPass("lots")).toBe(2000);
    // With no argument it reads the setting itself.
    process.env.TRACE_SEAL_PER_PASS = "7";
    try {
      expect(traceSealPerPass()).toBe(7);
    } finally {
      delete process.env.TRACE_SEAL_PER_PASS;
    }
    expect(traceSealPerPass()).toBe(2000);
  });

  it("is in the audit row only when it has something to say", () => {
    expect(
      tracePassDetail({ traces: 0, unreadable: 0, left: false, failed: 0, errors: [] }),
    ).toEqual({});
    expect(
      tracePassDetail({ traces: 3, unreadable: 1, left: true, failed: 2, errors: ["x"] }),
    ).toEqual({
      traces_sealed: 3,
      traces_unreadable: 1,
      traces_left: true,
      traces_failed: 2,
      traces_errors: ["x"],
    });
  });

  it("reads as a line on the card", () => {
    const line = storedFilesPassLine({
      files: 0,
      documents: 0,
      dataset_copies: 0,
      traces_sealed: 2,
      traces_unreadable: 1,
      traces_left: true,
      traces_failed: 1,
    });
    expect(line).toContain("2 model call traces encrypted under their owner's key");
    expect(line).toContain("1 model call trace whose owner's key cannot be had now");
    expect(line).toContain("more model call traces left for the next pass");
    expect(line).toContain("1 model call trace failed");
  });

  it("has an index that matches what it asks", () => {
    const sql = readFileSync(
      path.resolve("supabase/migrations/20261106000000_trace_seal_index.sql"),
      "utf8",
    );
    expect(sql).toContain("request_payload ->> 'body_sealed' IS NULL");
    expect(sql).toContain("request_payload ->> 'redacted' IS NULL");
    expect(sql).toContain("user_id IS NOT NULL");
  });
});

describe("sealing the bodies directly", () => {
  it("gives null before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    expect(await sealTraceBodies(ALICE, ID1, row())).toBeNull();
  });
});
