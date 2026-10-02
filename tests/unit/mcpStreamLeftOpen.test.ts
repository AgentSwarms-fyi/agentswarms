// An MCP answer read to the end of its stream, when the stream need not end.
//
// FOUND IN R98. Every place this app reads an MCP server's reply did
// `await res.text()`. On a `text/event-stream` body that resolves only when
// the SERVER closes the stream, and the Streamable HTTP spec says a server
// SHOULD close it after the response: should, not must. Driven in the MCP
// Builder against a server that answers at once and then keeps the stream
// open with keep-alives:
//
//   - Deploy: the sandbox logged `answered initialize` at 22:18:42.44 and the
//     next request came exactly 15 s later; `answered tools/list` came at
//     22:18:57.45 and the deploy reported "The operation was aborted due to
//     timeout" 15 s after that and marked the running server Error.
//   - Test console: the server answered `echo` 5 ms after the click; the
//     server function threw at 61.2 s, and the page, which never caught it,
//     sat on its spinner for good.
//
// The same read sat in three more doors: the public /api/mcp/s/<slug> relay,
// Test connection for a registered server, and agents' MCP tool calls.
//
// The reader is executed here against streams that never close. The doors
// drag in Supabase and the orchestrator, so they are pinned by source, as
// mcpStartHonesty.test.ts explains.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readRpcBody, rpcFailure } from "@/utils/mcpApps/sse";

const RESPONSE = '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo"}]}}';
const EVENT = `event: message\r\ndata: ${RESPONSE}\r\n\r\n`;

/** A reply on a stream the server keeps open. `push` sends more; nothing closes it. */
function heldOpen(first: string[] = [], contentType = "text/event-stream") {
  const enc = new TextEncoder();
  const state = { cancelled: false };
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctl = controller;
      for (const chunk of first) controller.enqueue(enc.encode(chunk));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const res = new Response(stream, { headers: { "content-type": contentType } });
  return { res, state, push: (chunk: string) => ctl.enqueue(enc.encode(chunk)) };
}

/** Fail fast instead of hanging the suite the way the old read hung a deploy. */
async function within<T>(p: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`still reading after ${ms}ms: it waited for the stream to close`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Has this promise settled yet? */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, 50));
  return done;
}

describe("the answer is read, not the stream", () => {
  it("returns the response from a stream that never closes", async () => {
    // The whole bug: this never resolved, so the caller's timer fired.
    const { res } = heldOpen([EVENT]);
    const read = await within(readRpcBody(res));
    expect(read.message?.result?.tools?.[0]?.name).toBe("echo");
    expect(read.oversized).toBe(false);
  });

  it("returns while keep-alives are still arriving", async () => {
    const { res, push } = heldOpen([EVENT]);
    push(": keep-alive\r\n\r\n");
    const read = await within(readRpcBody(res));
    expect(read.message?.id).toBe(2);
  });

  it("lets the connection go once it has the answer", async () => {
    const { res, state } = heldOpen([EVENT]);
    await within(readRpcBody(res));
    expect(state.cancelled).toBe(true);
  });

  it("passes over a notification to the response behind it", async () => {
    const note = 'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\n';
    const { res } = heldOpen([note, EVENT]);
    const read = await within(readRpcBody(res));
    expect(read.message?.result).toBeDefined();
    expect(read.message?.method).toBeUndefined();
  });

  it("returns text that carries the whole response event, for relaying", async () => {
    const { res } = heldOpen([EVENT]);
    const read = await within(readRpcBody(res));
    expect(read.text).toContain(`data: ${RESPONSE}\r\n\r\n`);
  });
});

describe("half an event is not an event", () => {
  it("waits for the blank line that ends the event", async () => {
    // The data line is complete JSON, but the event is still open. Acting on
    // it here would be acting on a frame the server has not finished.
    const { res, push } = heldOpen([`data: ${RESPONSE}`]);
    const pending = readRpcBody(res);
    expect(await settled(pending)).toBe(false);
    push("\r\n\r\n");
    expect((await within(pending)).message?.id).toBe(2);
  });

  it("does not take the end of a line for the end of the event", async () => {
    const { res, push } = heldOpen([`data: ${RESPONSE}\r\n`]);
    const pending = readRpcBody(res);
    expect(await settled(pending)).toBe(false);
    push("\r\n");
    expect((await within(pending)).message?.id).toBe(2);
  });

  it("reassembles a reply split across chunks, CRLF included", async () => {
    const cut = EVENT.length - 3; // splits the final \r\n\r\n between \r and \n
    const { res, push } = heldOpen([EVENT.slice(0, 20), EVENT.slice(20, cut)]);
    const pending = readRpcBody(res);
    push(EVENT.slice(cut));
    expect((await within(pending)).message?.result?.tools).toHaveLength(1);
  });

  it("joins a payload sent as several data lines", async () => {
    const split = 'data: {"jsonrpc":"2.0","id":7,\r\ndata: "result":{}}\r\n\r\n';
    const { res } = heldOpen([split]);
    expect((await within(readRpcBody(res))).message?.id).toBe(7);
  });
});

describe("what did not change", () => {
  it("reads a JSON reply whole, as before", async () => {
    const res = new Response(RESPONSE, { headers: { "content-type": "application/json" } });
    const read = await readRpcBody(res);
    expect(read.message?.result?.tools).toHaveLength(1);
    expect(read.text).toBe(RESPONSE);
  });

  it("still falls back to the first object when a closed stream held no response", async () => {
    const body = 'data: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n';
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const read = await readRpcBody(res);
    expect(read.message?.method).toBe("notifications/message");
  });

  it("caps an endless stream instead of piling it up", async () => {
    const { res, push } = heldOpen([": keep-alive\r\n\r\n"]);
    for (let i = 0; i < 50; i++) push(": keep-alive\r\n\r\n");
    const read = await within(readRpcBody(res, 200));
    expect(read.oversized).toBe(true);
    expect(read.message).toBeNull();
  });
});

describe("a failure names the request and the wait", () => {
  it("says a timed-out step got no answer, and for how long", () => {
    const e = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(rpcFailure("tools/list", e, 15_000)).toBe("tools/list → no answer within 15s");
  });

  it("keeps any other error's own words", () => {
    expect(rpcFailure("initialize", new Error("fetch failed"), 15_000)).toBe(
      "initialize → fetch failed",
    );
  });
});

// ── Every door reads to the answer ───────────────────────────────────────────

const SERVICE = readFileSync("src/utils/mcpApps/service.server.ts", "utf8");
const FUNCTIONS = readFileSync("src/utils/mcpApps.functions.ts", "utf8");
const EDGE = readFileSync("src/routes/api/mcp.s.$slug.ts", "utf8");
const PROBE = readFileSync("src/lib/mcp/probe.functions.ts", "utf8");
const REGISTRY = readFileSync("src/utils/tools/registry.server.ts", "utf8");
const SESSION = readFileSync("src/utils/mcpApps/session.ts", "utf8");
const PAGE = readFileSync("src/routes/_authenticated/mcp-builder_.$appId.tsx", "utf8");

/** A function's source, from its marker to the next top-level close. */
function block(source: string, marker: string, close = "\n}\n"): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`"${marker}" not found: did the module change shape?`);
  const rest = source.slice(start);
  const end = rest.indexOf(close);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("every door reads to the answer", () => {
  it("Deploy's handshake", () => {
    const body = block(SERVICE, "export async function handshake(");
    expect(body).toMatch(/readRpcBody\(init\)/);
    expect(body).toMatch(/readRpcBody\(list\)/);
    expect(body).not.toMatch(/\.text\(\)/);
  });

  it("Deploy's handshake names the step that ran out", () => {
    const body = block(SERVICE, "export async function handshake(");
    expect(body).toMatch(/step = "tools\/list"/);
    expect(body).toMatch(/rpcFailure\(step, e, HANDSHAKE_STEP_MS\)/);
  });

  it("the Builder's test console", () => {
    const body = block(FUNCTIONS, "export const mcpAppTest", "\n  });\n");
    expect(body).toMatch(/readRpcBody\(init\)/);
    expect(body).toMatch(/readRpcBody\(res\)/);
    expect(body).not.toMatch(/\.text\(\)/);
  });

  it("the test console answers a failure instead of throwing it", () => {
    const body = block(FUNCTIONS, "export const mcpAppTest", "\n  });\n");
    expect(body).toMatch(
      /catch \(e\) \{\s*return \{ ok: false, error: rpcFailure\(step, e, waited\) \}/,
    );
  });

  it("the console page leaves its spinner whatever the call does", () => {
    const run = block(PAGE, "const run = async () => {", "\n  };\n");
    expect(run).toMatch(/finally \{\s*setRunning\(false\);\s*\}/);
  });

  it("the public MCP endpoint's relay, with its size cap applied while reading", () => {
    const body = block(EDGE, "async function forward(");
    expect(body).toMatch(/readRpcBody\(res, MAX_RESPONSE_BYTES\)/);
    expect(body).toMatch(/read\.oversized/);
    expect(body).not.toMatch(/res\.text\(\)/);
  });

  it("Test connection for a registered server", () => {
    expect(PROBE).toMatch(/readRpcBody\(initRes\)/);
    expect(PROBE).toMatch(/readRpcBody\(listRes\)/);
    expect(PROBE).not.toMatch(/(initRes|listRes)\.text\(\)/);
  });

  it("an agent's MCP tool call", () => {
    // Since R99 the agent's request goes through a session of its own, and
    // the reads live in mcpApps/session.ts; mcpAgentSession.test.ts runs it.
    const body = block(REGISTRY, "async function mcpRequest(");
    expect(body).toMatch(/requestInSession\(send, body\)/);
    expect(body).not.toMatch(/\.text\(\)/);
    const session = block(SESSION, "export async function requestInSession(");
    expect(session).toMatch(/readRpcBody\(res\)/);
    expect(block(SESSION, "export async function openMcpSession(")).toMatch(/readRpcBody\(init\)/);
    expect(SESSION).not.toMatch(/\.text\(\)/);
  });
});
