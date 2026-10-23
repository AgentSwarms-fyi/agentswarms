// SQL Chat shows the tool calls /api/chat made (R347).
//
// FOUND FROM THE UI. On the Data Catalog's Workbench, SQL Chat answered "The
// `sftest_users` table contains 8 rows." and drew no tool chip, though the
// stream carried the sql_query call and its result. /api/chat sends those as
// `event: tool` blocks ({"type":"tool_call"…}, {"type":"tool_result"…}); the
// page had its own reader, which looked for a `tool_result` property no event
// has. The page now reads the stream with readChatStream and folds the tool
// events with withToolEvent. The stream below is the one captured from that
// answer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readChatStream } from "@/lib/chatStream";
import { settledToolCalls, withToolEvent, type ChatToolCall } from "@/lib/chatToolCalls";
import type { ToolEvent } from "@/utils/tools/loop.server";

const CAPTURED = [
  "event: tool",
  'data: {"type":"tool_call","name":"sql_query","args":"{\\"sql\\":\\"SELECT COUNT(*) FROM sftest_users\\"}","id":"call_3028125"}',
  "",
  "event: tool",
  'data: {"type":"tool_result","name":"sql_query","id":"call_3028125","ok":true,"preview":"{\\"sql\\":\\"SELECT COUNT(*) FROM sftest_users\\",\\"columns\\":[\\"count_star()\\"],\\"rows\\":[{\\"count_star()\\":8}],\\"row_count\\":1,\\"total_matched\\":1,\\"capped\\":false}","sources":[{"kind":"table","title":"sftest_users","detail":"1 row","snippet":"SELECT COUNT(*) FROM sftest_users","tool":"sql_query"}]}',
  "",
  'data: {"choices":[{"delta":{"content":"The `sftest_users` table contains 8 rows."}}]}',
  "",
  "data: [DONE]",
  "",
  "event: cost",
  'data: {"model":"google/gemini-3-flash-preview","costUsd":0.0029695,"tokensIn":5723,"tokensOut":36}',
  "",
].join("\n");

const body = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

const call = (id: string, name: string, args: string): ToolEvent => ({
  type: "tool_call",
  id,
  name,
  args,
});
const result = (id: string, name: string, ok: boolean, preview: string): ToolEvent => ({
  type: "tool_result",
  id,
  name,
  ok,
  preview,
});
const fold = (events: ToolEvent[]) =>
  events.reduce<ChatToolCall[]>((calls, e) => withToolEvent(calls, e), []);

describe("the answer SQL Chat was given", () => {
  it("is one sql_query call with its SQL and result, and the answer's text", async () => {
    let calls: ChatToolCall[] = [];
    let text = "";
    await readChatStream(body(CAPTURED), {
      delta: (d) => (text += d),
      tool: (e) => (calls = withToolEvent(calls, e)),
    });
    expect(text).toBe("The `sftest_users` table contains 8 rows.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: "call_3028125",
      name: "sql_query",
      args: { sql: "SELECT COUNT(*) FROM sftest_users" },
      status: "ok",
    });
    expect(calls[0].preview).toContain('"count_star()":8');
  });
});

describe("folding tool events", () => {
  it("a call runs until its result arrives, then says how it went", () => {
    const running = fold([call("a", "sql_query", '{"sql":"SELECT 1"}')]);
    expect(running[0].status).toBe("running");
    const done = withToolEvent(running, result("a", "sql_query", false, '{"error":"no table"}'));
    expect(done[0]).toMatchObject({ status: "error", preview: '{"error":"no table"}' });
    expect(done[0].args).toEqual({ sql: "SELECT 1" });
  });

  it("matches a result to its call by id, not by name", () => {
    const calls = fold([
      call("a", "sql_query", '{"sql":"SELECT 1"}'),
      call("b", "sql_query", '{"sql":"SELECT 2"}'),
      result("b", "sql_query", true, "two"),
    ]);
    expect(calls.map((c) => [c.args.sql, c.status, c.preview])).toEqual([
      ["SELECT 1", "running", ""],
      ["SELECT 2", "ok", "two"],
    ]);
  });

  it("keeps a result whose call it never saw", () => {
    expect(fold([result("x", "kb_search", true, "found")])).toEqual([
      { id: "x", name: "kb_search", args: {}, status: "ok", preview: "found" },
    ]);
  });

  it("reads arguments that are not a JSON object as none", () => {
    const calls = fold([call("a", "t", "not json"), call("b", "t", "[1,2]"), call("c", "t", "")]);
    expect(calls.map((c) => c.args)).toEqual([{}, {}, {}]);
  });

  it("once the answer ends, a call with no result says so", () => {
    const calls = settledToolCalls(
      fold([
        call("a", "sql_query", "{}"),
        call("b", "sql_query", "{}"),
        result("a", "sql_query", true, ""),
      ]),
    );
    expect(calls.map((c) => c.status)).toEqual(["ok", "none"]);
  });
});

describe("the page", () => {
  const page = readFileSync("src/routes/_authenticated/data-sql.tsx", "utf8");

  it("reads its answer with the shared reader and folds the tool events", () => {
    expect(page).toContain("await readChatStream(resp.body, {");
    expect(page).toContain("toolCalls = withToolEvent(toolCalls, e);");
    expect(page).toContain('show(assistantText || "(no response)", settledToolCalls(toolCalls));');
    // The reader of its own, and the property no event has, are gone.
    expect(page).not.toContain("parsed.tool_result");
    expect(page).not.toContain("resp.body.getReader()");
  });
});
