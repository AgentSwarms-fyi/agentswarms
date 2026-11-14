// A slow chat turn's headers sent early, behind CloudFront (R481): the fast
// path is untouched, a slow answer is streamed after keep-alive comments, and
// a slow failure arrives as an event every reader of /api/chat understands.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readChatStream } from "@/lib/chatStream";
import { earlyHeadersAfterMs, withEarlyHeaders } from "@/utils/http/earlyHeaders.server";

const later = <T>(ms: number, v: () => T) =>
  new Promise<T>((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(v());
      } catch (e) {
        reject(e);
      }
    }, ms),
  );

const sse = (text: string) =>
  new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("the setting", () => {
  it("is off unless a positive number of milliseconds", () => {
    expect(earlyHeadersAfterMs({})).toBeNull();
    expect(earlyHeadersAfterMs({ EARLY_HEADERS_AFTER_MS: "" })).toBeNull();
    expect(earlyHeadersAfterMs({ EARLY_HEADERS_AFTER_MS: "0" })).toBeNull();
    expect(earlyHeadersAfterMs({ EARLY_HEADERS_AFTER_MS: "soon" })).toBeNull();
    expect(earlyHeadersAfterMs({ EARLY_HEADERS_AFTER_MS: " 45000 " })).toBe(45000);
  });
});

describe("an answer in time", () => {
  it("is the answer itself, its status and headers untouched", async () => {
    const res = await withEarlyHeaders(
      later(5, () => json(429, { error: "slow down" })),
      {
        afterMs: 500,
      },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("x-early-headers")).toBeNull();
    expect(await res.json()).toEqual({ error: "slow down" });
  });

  it("throws what the turn threw", async () => {
    await expect(
      withEarlyHeaders(
        later(5, () => {
          throw new Error("boom");
        }),
        { afterMs: 500 },
      ),
    ).rejects.toThrow("boom");
  });
});

describe("an answer that is late", () => {
  it("gets its headers at once, keeps the line alive, then streams the answer", async () => {
    const started = Date.now();
    const res = await withEarlyHeaders(
      later(120, () => sse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')),
      {
        afterMs: 20,
        heartbeatMs: 30,
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
    expect(Date.now() - started).toBeLessThan(110);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-early-headers")).toBe("1");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const text = await res.text();
    expect(text.startsWith(": waiting\n\n")).toBe(true);
    expect(text.match(/: waiting/g)!.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('data: {"choices":[{"delta":{"content":"hi"}}]}');
  });

  it("is read as the answer by the chat stream reader", async () => {
    const res = await withEarlyHeaders(
      later(60, () => sse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')),
      {
        afterMs: 10,
        heartbeatMs: 20,
      },
    );
    expect(await readChatStream(res.body!)).toBe("hi");
  });

  it("says a late failure as an event with the status it would have had", async () => {
    const res = await withEarlyHeaders(
      later(60, () => json(429, { error: "AI credits exhausted" })),
      {
        afterMs: 10,
      },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error\ndata: {"error":"AI credits exhausted","status":429}');
    await expect(
      readChatStream(
        (
          await withEarlyHeaders(
            later(60, () => json(502, { error: "provider down" })),
            { afterMs: 10 },
          )
        ).body!,
      ),
    ).rejects.toThrow("provider down");
  });

  it("says so when the turn threw", async () => {
    const res = await withEarlyHeaders(
      later(60, () => {
        throw new Error("lost the database");
      }),
      { afterMs: 10 },
    );
    expect(await res.text()).toContain('"error":"lost the database","status":500');
  });
});

describe("the readers of /api/chat", () => {
  it("each handle the error event", () => {
    expect(readFileSync("src/lib/swarmRuntime.ts", "utf8")).toContain(
      'if (currentEvent === "error")',
    );
    expect(readFileSync("src/routes/_authenticated/playground.tsx", "utf8")).toContain(
      'if (currentEvent === "error")',
    );
  });

  it("are behind a POST that uses the wrapper only when it is set", () => {
    const chat = readFileSync("src/routes/api/chat.ts", "utf8").replace(/\s+/g, " ");
    expect(chat).toContain("async function chatPost(request: Request): Promise<Response>");
    expect(chat).toContain(
      "return after === null ? chatPost(request) : withEarlyHeaders(chatPost(request), { afterMs: after, headers: corsHeaders });",
    );
  });
});
