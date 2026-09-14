// A headless step records what its agent called — see src/lib/chatStream.ts.
//
// The canvas and a schedule ran the same node; the canvas step carried its
// tool events and the scheduled step carried `[]`. The server's stream
// reader is now this pure one, fed bytes here, and a tool node's own call
// takes the agent loop's event shape so one Traces reader serves both.
import { describe, expect, it } from "vitest";

import { readChatStream, TOOL_NODE_PREVIEW_CHARS, toolNodeEvents } from "@/lib/chatStream";

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });

const sse = (event: string | null, data: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;

describe("readChatStream", () => {
  it("returns the text and hands over the cost and every tool event, in order", async () => {
    const usage: unknown[] = [];
    const tools: { type: string; name: string }[] = [];
    const body = stream([
      sse(
        "tool",
        JSON.stringify({ type: "tool_call", name: "ml_list_models", args: "{}", id: "c1" }),
      ),
      sse(
        "tool",
        JSON.stringify({
          type: "tool_result",
          name: "ml_list_models",
          id: "c1",
          ok: true,
          preview: '{"models":[…]}',
        }),
      ),
      sse(null, JSON.stringify({ choices: [{ delta: { content: "One " } }] })),
      sse(null, JSON.stringify({ choices: [{ delta: { content: "model." } }] })),
      sse(
        "cost",
        JSON.stringify({ model: "openai/gpt-4o-mini", costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      ),
      "data: [DONE]\n\n",
    ]);
    const text = await readChatStream(body, {
      usage: (u) => usage.push(u),
      tool: (e) => tools.push(e),
    });
    expect(text).toBe("One model.");
    expect(tools.map((t) => `${t.type}:${t.name}`)).toEqual([
      "tool_call:ml_list_models",
      "tool_result:ml_list_models",
    ]);
    expect(usage).toEqual([
      { model: "openai/gpt-4o-mini", costUsd: 0.001, tokensIn: 10, tokensOut: 5 },
    ]);
  });

  it("survives a chunk boundary inside a line, CRLF, and a malformed tool event", async () => {
    const tools: unknown[] = [];
    const call = JSON.stringify({
      type: "tool_call",
      name: "calculator",
      args: '{"expr":"1+1"}',
      id: "x",
    });
    const body = stream([
      "event: tool\r\ndata: " + call.slice(0, 10),
      call.slice(10) + "\r\n\r\n",
      sse("tool", "{not json"),
      sse("tool", JSON.stringify({ type: "something_else" })),
      sse(null, JSON.stringify({ choices: [{ message: { content: "2" } }] })),
    ]);
    const text = await readChatStream(body, { tool: (e) => tools.push(e) });
    expect(text).toBe("2");
    expect(tools).toHaveLength(1);
  });

  it("reads the text alone when no handlers are given", async () => {
    const body = stream([
      sse("tool", JSON.stringify({ type: "tool_call", name: "x", args: "{}", id: "1" })),
      sse(null, JSON.stringify({ choices: [{ delta: { content: "hi" } }] })),
    ]);
    expect(await readChatStream(body)).toBe("hi");
  });
});

describe("toolNodeEvents", () => {
  it("records a tool node's call and result in the agent loop's shape, with the ML table", () => {
    const args = { model: "plan", keys: '[{"order_id":1001}]' };
    const ev = toolNodeEvents({
      id: "n1",
      name: "ml_predict",
      args,
      result: {
        ok: true,
        result: JSON.stringify({
          model: "plan",
          version: 7,
          task: "classification",
          predictions: [{ order_id: 1001, prediction: "enterprise" }],
          row_count: 1,
        }),
      },
    });
    expect(ev[0]).toEqual({
      type: "tool_call",
      name: "ml_predict",
      args: JSON.stringify(args),
      id: "n1",
    });
    expect(ev[1]).toMatchObject({ type: "tool_result", name: "ml_predict", id: "n1", ok: true });
    // The same person-readable table the Playground panel gets.
    expect(ev[1]).toMatchObject({
      data: {
        kind: "predict",
        model: "plan",
        rows: [{ order_id: 1001, prediction: "enterprise" }],
      },
    });
  });

  it("records a failure as a failed result with the error as its preview, capped", () => {
    const ev = toolNodeEvents({
      id: "n2",
      name: "kb_search",
      args: { query: "q" },
      result: { ok: false, error: "x".repeat(1000) },
    });
    expect(ev[1]).toMatchObject({ type: "tool_result", ok: false });
    expect((ev[1] as { preview: string }).preview).toHaveLength(TOOL_NODE_PREVIEW_CHARS);
    expect("data" in ev[1]).toBe(false);
  });

  it("marks an ML refusal as not ok even though the node's call returned", () => {
    const ev = toolNodeEvents({
      id: "n3",
      name: "ml_predict",
      args: {},
      result: { ok: true, result: JSON.stringify({ error: 'No model named "x" is available.' }) },
    });
    expect(ev[1]).toMatchObject({ ok: false, data: { kind: "error" } });
  });
});
