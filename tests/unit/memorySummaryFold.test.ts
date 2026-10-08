// The rolling conversation summary keeps up with a long conversation (R350).
//
// An agent with short-term memory sees the last N messages (20 by default)
// and a summary of everything older, which summarizeIfNeeded folds forward
// after each turn. It read the conversation as
// `.order("created_at", { ascending: true }).limit(500)`: the OLDEST 500
// messages. Past 500 messages it folded up to message 480 once, and from then
// on found nothing new in those 500, so it never folded again. Every message
// between 480 and the live window dropped out of what the agent was given,
// a few more each turn, without a word. Its reads also ignored their errors: a
// failed read of the memory row looked like "no summary yet", so the next fold
// started from nothing and its upsert replaced the stored summary.
//
// These drive summarizeIfNeeded over an in-memory conversation through a
// client that applies eq, gt, order and limit as Postgres would, with the
// summary model stubbed to say which turns it was given.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/observability/recordGatewayUsage.server", () => ({
  recordGatewayCall: async () => {},
}));

import { summarizeIfNeeded } from "@/utils/memory/summarize.server";

type Row = Record<string, unknown>;

/** A conversation of `n` messages, m1…mn, a second apart. */
function conversation(n: number): Row[] {
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    conversation_id: "c1",
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i + 1}`,
    created_at: new Date(t0 + i * 1000).toISOString(),
  }));
}

/** A Supabase stand-in over in-memory tables, with reads and writes that can be made to fail. */
function client(tables: Record<string, Row[]>, failing: Record<string, string> = {}) {
  const writes: Row[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    // `messages:id` fails only a read of one message by its id.
    let byId = false;
    const failed = () => {
      const why = failing[table] ?? (byId ? failing[`${table}:id`] : undefined);
      return why ? { message: why } : null;
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        if (c === "id") byId = true;
        rows = rows.filter((r) => r[c] === v);
        return q;
      },
      gt: (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) > v)), q),
      order: (c: string, o?: { ascending?: boolean }) => {
        const dir = o?.ascending === false ? -1 : 1;
        rows.sort((a, b) =>
          String(a[c]) < String(b[c]) ? -dir : String(a[c]) > String(b[c]) ? dir : 0,
        );
        return q;
      },
      limit: (n: number) => ((rows = rows.slice(0, n)), q),
      maybeSingle: async () => ({ data: failed() ? null : (rows[0] ?? null), error: failed() }),
      upsert: async (row: Row) => {
        if (failing[`${table}.upsert`]) return { error: { message: failing[`${table}.upsert`] } };
        writes.push(row);
        const kept = (tables[table] ?? []).filter((r) => r.conversation_id !== row.conversation_id);
        tables[table] = [...kept, row];
        return { error: null };
      },
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: failed() ? null : rows, error: failed() }).then(res),
    };
    return q;
  };
  return { sb: { from } as never, writes };
}

/** The summary model, stubbed: it answers with the ids of the turns it was given. */
let folded: string[][] = [];
beforeEach(() => {
  folded = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const prompt = JSON.parse(init.body).messages[1].content as string;
      const ids = [...prompt.matchAll(/: message (\d+)/g)].map((m) => `m${m[1]}`);
      folded.push(ids);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `summary through ${ids.at(-1)}` } }],
        }),
      };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const run = (sb: never) =>
  summarizeIfNeeded({
    sb,
    userId: "u1",
    conversationId: "c1",
    windowMessages: 20,
    summaryModel: "openai/gpt-4o-mini",
    apiKey: "test-key",
  });

describe("a conversation longer than one read", () => {
  it("is folded forward a batch at a time until only the live window is left", async () => {
    const tables: Record<string, Row[]> = { messages: conversation(600), conversation_memory: [] };
    const { sb } = client(tables);
    for (let turn = 0; turn < 10; turn++) await run(sb);
    const memory = tables.conversation_memory[0];
    // 600 messages, the last 20 live: the summary covers m1…m580.
    expect(memory.last_summarized_message_id).toBe("m580");
    expect(folded.flat()).toEqual(conversation(580).map((m) => m.id));
    // Each fold was bounded, and once caught up a turn folds nothing.
    expect(Math.max(...folded.map((f) => f.length))).toBeLessThanOrEqual(100);
    const before = folded.length;
    await run(sb);
    expect(folded.length).toBe(before);
  });

  it("after catching up, folds just the messages that left the window", async () => {
    const tables: Record<string, Row[]> = { messages: conversation(40), conversation_memory: [] };
    const { sb } = client(tables);
    await run(sb);
    expect(tables.conversation_memory[0].last_summarized_message_id).toBe("m20");
    tables.messages = conversation(42);
    await run(sb);
    expect(folded.at(-1)).toEqual(["m21", "m22"]);
    expect(tables.conversation_memory[0].last_summarized_message_id).toBe("m22");
  });

  it("a conversation within the window is not summarized", async () => {
    const tables: Record<string, Row[]> = { messages: conversation(20), conversation_memory: [] };
    const { sb, writes } = client(tables);
    expect(await run(sb)).toEqual({ summary: null, foldedCount: 0 });
    expect(writes).toEqual([]);
    expect(folded).toEqual([]);
  });
});

describe("a read or write that fails", () => {
  const stored = () => ({
    conversation_id: "c1",
    user_id: "u1",
    summary: "Ana prefers invoices in EUR.",
    last_summarized_message_id: "m30",
  });

  it("a failed read of the summary stops the fold, rather than replacing the summary", async () => {
    const tables: Record<string, Row[]> = {
      messages: conversation(60),
      conversation_memory: [stored()],
    };
    const { sb, writes } = client(tables, { conversation_memory: "timeout" });
    await expect(run(sb)).rejects.toThrow(/timeout/);
    expect(writes).toEqual([]);
    expect(folded).toEqual([]);
  });

  it("a failed read of the messages stops the fold", async () => {
    // No summary yet, so the messages read is the only one that can fail:
    // taken as "no messages", it would look like a short conversation.
    const tables: Record<string, Row[]> = { messages: conversation(60), conversation_memory: [] };
    const { sb, writes } = client(tables, { messages: "connection reset" });
    await expect(run(sb)).rejects.toThrow(/connection reset/);
    expect(writes).toEqual([]);
  });

  it("a failed read of where the summary stops stops the fold, rather than starting over", async () => {
    const tables: Record<string, Row[]> = {
      messages: conversation(60),
      conversation_memory: [stored()],
    };
    const { sb, writes } = client(tables, { "messages:id": "statement timeout" });
    await expect(run(sb)).rejects.toThrow(/statement timeout/);
    expect(writes).toEqual([]);
    expect(folded).toEqual([]);
  });

  it("a failed write of the new summary is reported, not passed off as saved", async () => {
    const tables: Record<string, Row[]> = {
      messages: conversation(60),
      conversation_memory: [stored()],
    };
    const { sb } = client(tables, { "conversation_memory.upsert": "permission denied" });
    await expect(run(sb)).rejects.toThrow(/permission denied/);
  });

  it("with everything read, the fold continues from the stored summary", async () => {
    const tables: Record<string, Row[]> = {
      messages: conversation(60),
      conversation_memory: [stored()],
    };
    const { sb } = client(tables);
    await run(sb);
    expect(folded).toEqual([
      conversation(40)
        .slice(30)
        .map((m) => m.id),
    ]);
  });
});
