// An AI-gateway call whose caller leaves is audited once, as cancelled (R363).
//
// FOUND FROM THE UI (R363), with a test key ("R363 hang-up": openrouter/*, one
// fallback model) and curl cutting its own calls:
//
// - Cut before the answer started (1.5 s): the audit log showed a
//   `gateway.fallback` ("This operation was aborted") and `gateway.chat`
//   ERROR. The aborted fetch was taken for a network failure, so the next
//   model was tried for a caller who had gone.
// - Cut mid-answer, streamed (7 s): no `gateway.chat` row at all for a call
//   that cost $0.0021. The adapter's failure path wrote into the cancelled
//   stream, threw, and never reached `onDone`.
// - And behind both, the chat turn's trace was rewritten as "error: Invalid
//   state: Controller is already closed" (tapStream.test.ts).
//
// The adapter is driven with real streams; the call sites in
// `runGatewayCompletion` are pinned by source, as the gateway's other rules
// are (aiGateway, gatewayAllowList).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { adaptUpstreamSse } from "@/utils/gateway/api.server";

const enc = new TextEncoder();
const META = {
  id: "chatcmpl-r363",
  model: "openrouter/google/gemini-2.5-flash",
  created: 1,
  includeUsage: true,
  traceId: "t363",
  fallbackFrom: null,
};
const frame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

function handFed() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const quietly = (f: () => void) => {
    try {
      f();
    } catch {
      /* the adapter already let go */
    }
  };
  return {
    stream,
    state,
    push: (text: string) => quietly(() => ctl.enqueue(enc.encode(text))),
    close: () => quietly(() => ctl.close()),
    fail: (e: unknown) => quietly(() => ctl.error(e)),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

type Summary = { text: string; ended: string };

function adapted(signal?: AbortSignal) {
  const up = handFed();
  const summaries: Summary[] = [];
  const out = adaptUpstreamSse(up.stream, META, (s) => summaries.push(s), signal);
  return { up, out, summaries };
}

describe("a streamed call whose caller leaves mid-answer", () => {
  it("is summed up once, as left, when the next frame arrives", async () => {
    const { up, out, summaries } = adapted();
    const reader = out.getReader();
    up.push(frame("one "));
    await reader.read();
    await reader.cancel();
    up.push(frame("two "));
    await settle();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].ended).toBe("left");
    expect(summaries[0].text).toBe("one ");
  });

  it("lets go of the upstream, so the rest is not produced for nobody", async () => {
    const { up, out } = adapted();
    const reader = out.getReader();
    up.push(frame("one "));
    await reader.read();
    await reader.cancel();
    up.push(frame("two "));
    await settle();
    expect(up.state.cancelled).toBe(true);
  });

  it("is summed up once, as left, when its aborted fetch fails the upstream", async () => {
    const { up, out, summaries } = adapted();
    const reader = out.getReader();
    up.push(frame("one "));
    await reader.read();
    await reader.cancel();
    up.fail(new DOMException("This operation was aborted", "AbortError"));
    await settle();
    expect(summaries.map((s) => s.ended)).toEqual(["left"]);
  });
});

describe("a streamed call whose request was aborted before its stream was cancelled", () => {
  it("is left, not failed, when its upstream fetch fails first", async () => {
    const request = new AbortController();
    const { up, out, summaries } = adapted(request.signal);
    const reader = out.getReader();
    up.push(frame("one "));
    await reader.read();
    request.abort();
    up.fail(new DOMException("This operation was aborted", "AbortError"));
    await reader.read().catch(() => {});
    await settle();
    expect(summaries.map((s) => s.ended)).toEqual(["left"]);
  });
});

describe("a streamed call whose caller stays", () => {
  it("ends complete when the upstream does", async () => {
    const { up, out, summaries } = adapted();
    up.push(frame("whole answer"));
    up.close();
    const text = await new Response(out).text();
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect(summaries.map((s) => s.ended)).toEqual(["complete"]);
  });

  it("ends failed when the upstream fails, and the caller is told", async () => {
    const { up, out, summaries } = adapted();
    up.push(frame("half "));
    up.fail(new Error("provider reset the stream"));
    const text = await new Response(out).text();
    expect(text).toContain("provider reset the stream");
    expect(summaries.map((s) => s.ended)).toEqual(["failed"]);
  });
});

describe("runGatewayCompletion", () => {
  const SRC = readFileSync("src/utils/gateway/api.server.ts", "utf8");
  const fn = SRC.slice(SRC.indexOf("export async function runGatewayCompletion("));

  it("takes a caller who left before the answer for no failure, and tries nothing else", () => {
    const caught = fn.slice(fn.indexOf("} catch (e) {"));
    const left = caught.indexOf("if (args.request.signal.aborted) {");
    expect(left).toBeGreaterThan(0);
    // Asked before the failure is recorded, and before any fallback.
    expect(left).toBeLessThan(caught.indexOf("lastFailure = {"));
    expect(left).toBeLessThan(caught.indexOf("auditFallback("));
    const branch = caught.slice(left, caught.indexOf("lastFailure = {"));
    expect(branch).toContain('action: "gateway.chat"');
    expect(branch).toContain('status: "cancelled"');
    expect(branch).toContain("return new Response(null, { status: 499 });");
  });

  it("audits a streamed call whose caller left as cancelled, and caches only a whole answer", () => {
    const at = fn.indexOf("const out = adaptUpstreamSse(");
    expect(at).toBeGreaterThan(0);
    const done = fn.slice(at, fn.indexOf("return new Response(out", at));
    expect(done).toMatch(
      /s\.ended === "left" \? "cancelled" : s\.ended === "complete" \? "success"/,
    );
    expect(done).toContain('if (s.ended === "complete") maybeStore(s.text, s.extras);');
    // Handed the request, so a failure after its caller left is not a failure.
    expect(done).toMatch(/\},\s*args\.request\.signal,\s*\);\s*$/);
  });

  it("audits a collected call that stopped, once, whichever way it stopped", () => {
    const collect = fn.slice(fn.indexOf("collected = await collectUpstreamSse(res.body, meta);"));
    const caught = collect.slice(
      collect.indexOf("} catch (e) {"),
      collect.indexOf("audit(collected"),
    );
    expect(caught).toMatch(
      /if \(args\.request\.signal\.aborted\) \{\s*audit\("cancelled", null\);\s*return new Response\(null, \{ status: 499 \}\);/,
    );
    expect(caught).toMatch(/audit\("error", null\);\s*return gatewayFail\(502/);
  });
});

describe("the chat route's trace tap", () => {
  const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");
  const tap = CHAT.slice(
    CHAT.indexOf("function withTraceTap("),
    CHAT.indexOf("// Wrap an SSE stream so the assistant's accumulated text"),
  );

  it("is handed the turn's request at both of its call sites", () => {
    expect(
      CHAT.match(/withTraceTap\(upstreamWithTools\.body, trace, \{\s*signal: request\.signal,/g),
    ).toHaveLength(1);
    expect(CHAT).toContain("withTraceTap(upstream.body, trace, { signal: request.signal });");
    expect(CHAT.match(/withTraceTap\(/g)).toHaveLength(3); // the definition and the two calls
    expect(tap).toContain("signal: opts?.signal,");
  });

  it("is built on tapStream, with no cancel of its own to record a second time", () => {
    expect(tap).toContain("return tapStream(upstream, {");
    expect(tap).not.toContain("async cancel(");
    expect(tap).not.toContain("Stream cancelled");
  });

  it("records a caller who left as cancelled, and every record carries the turn's spend", () => {
    expect(tap).toMatch(
      /if \(end\.how === "left"\) \{[\s\S]*?await record\("cancelled", "The caller left before the answer ended"\);/,
    );
    const record = tap.slice(tap.indexOf("const record = ("), tap.indexOf("return tapStream("));
    for (const field of ["upstreamTokensOut", "upstreamCostUsd", "replayedFinal", "loopUsage"]) {
      expect(record, field).toContain(field);
    }
    expect(tap.match(/recordTrace\(\{/g)).toHaveLength(2); // "Empty upstream", and `record`
  });
});

describe("the audit log", () => {
  it("says a call was stopped, as the Traces page does, rather than leave it reading as a success", () => {
    const ui = readFileSync("src/components/observability/AuditLog.tsx", "utf8");
    const summary = ui.slice(ui.indexOf("function describeDetail("));
    expect(summary).toContain('if (d.status === "cancelled") bits.push("STOPPED");');
    const traces = readFileSync("src/routes/_authenticated/traces.tsx", "utf8");
    expect(traces).toContain('t.status === "cancelled" ? "stopped"');
  });
});
