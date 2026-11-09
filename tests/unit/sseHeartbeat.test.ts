// R463: streamed replies keep the connection alive through long silences.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readChatStream } from "@/lib/chatStream";
import { sseHeartbeatMs, withSseHeartbeat } from "@/utils/sse.server";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A source whose chunks arrive at the given times (ms from start). */
function timedSource(parts: { at: number; text: string }[]) {
  let cancelled: unknown = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      let t = 0;
      for (const p of parts) {
        await new Promise((r) => setTimeout(r, p.at - t));
        t = p.at;
        c.enqueue(enc.encode(p.text));
      }
      c.close();
    },
    cancel(reason) {
      cancelled = reason ?? "cancelled";
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}

afterEach(() => vi.useRealTimers());

describe("the heartbeat", () => {
  it("writes `: ka` into a silence longer than the interval, and nothing otherwise", async () => {
    vi.useFakeTimers();
    const { stream } = timedSource([
      { at: 0, text: 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' },
      { at: 47_000, text: 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' },
      { at: 50_000, text: "data: [DONE]\n\n" },
    ]);
    const out = drain(withSseHeartbeat(stream, 15_000)!);
    await vi.advanceTimersByTimeAsync(60_000);
    const text = await out;
    // 47 s of silence at 15 s: three comments; 3 s of silence: none.
    expect(text.match(/: ka\n\n/g)?.length).toBe(3);
    expect(text.indexOf(": ka")).toBeGreaterThan(text.indexOf('"a"'));
    expect(text.lastIndexOf(": ka")).toBeLessThan(text.indexOf('"b"'));
  });

  it("never splices a comment into the middle of an event", async () => {
    vi.useFakeTimers();
    const { stream } = timedSource([
      { at: 0, text: "event: tool\n" }, // half an event, then a long pause
      { at: 40_000, text: 'data: {"type":"tool_call"}\n\n' },
      { at: 72_000, text: "data: [DONE]\n\n" },
    ]);
    const out = drain(withSseHeartbeat(stream, 15_000)!);
    await vi.advanceTimersByTimeAsync(80_000);
    const text = await out;
    expect(text.startsWith('event: tool\ndata: {"type":"tool_call"}\n\n')).toBe(true);
    // After the event closed, 32 s of silence: comments at 55 s and 70 s.
    expect(text.match(/: ka\n\n/g)?.length).toBe(2);
  });

  it("is invisible to the app's own stream reader", async () => {
    vi.useFakeTimers();
    const usages: number[] = [];
    const { stream } = timedSource([
      { at: 0, text: 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' },
      { at: 31_000, text: 'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' },
      { at: 32_000, text: 'data: [DONE]\n\nevent: cost\ndata: {"costUsd":0.01}\n\n' },
    ]);
    const reading = readChatStream(withSseHeartbeat(stream, 15_000)!, {
      usage: (u) => usages.push(u.costUsd),
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await reading).toBe("Hello world");
    expect(usages).toEqual([0.01]);
  });

  it("passes the stream through untouched when turned off", () => {
    const { stream } = timedSource([]);
    expect(withSseHeartbeat(stream, 0)).toBe(stream);
    expect(withSseHeartbeat(null)).toBeNull();
  });

  it("cancelling the reply cancels the source (Stop stops the upstream call)", async () => {
    const { stream, wasCancelled } = timedSource([{ at: 5_000, text: "data: x\n\n" }]);
    const wrapped = withSseHeartbeat(stream, 15_000)!;
    await wrapped.cancel("user pressed Stop");
    expect(wasCancelled()).toBe("user pressed Stop");
  });

  it("defaults to 15 s, under CloudFront's 30 s origin read timeout", () => {
    expect(sseHeartbeatMs({})).toBe(15_000);
    expect(sseHeartbeatMs({ SSE_HEARTBEAT_MS: "0" })).toBe(0);
    expect(sseHeartbeatMs({ SSE_HEARTBEAT_MS: "x" })).toBe(15_000);
  });
});

describe("every live event stream the app serves is wrapped", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("chat: both the tool-loop reply and the plain reply", () => {
    expect(
      read("src/routes/api/chat.ts").match(/new Response\(withSseHeartbeat\(guarded\)/g)?.length,
    ).toBe(2);
  });

  it("the embedded chat and analyst, A2A, and the AI gateway's live stream", () => {
    expect(read("src/routes/api/embed.chat.ts")).toContain(
      "new Response(withSseHeartbeat(stream), {",
    );
    expect(read("src/routes/api/embed.analyst.ts")).toContain(
      "new Response(withSseHeartbeat(stream), {",
    );
    expect(read("src/routes/api/a2a.ts")).toContain(
      "new Response(withSseHeartbeat(upstream.body), {",
    );
    expect(read("src/utils/gateway/api.server.ts")).toContain(
      "new Response(withSseHeartbeat(out), {",
    );
  });
});
