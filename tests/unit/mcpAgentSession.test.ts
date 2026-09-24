// An agent's MCP call, made the way the protocol says: in a session.
//
// FOUND IN R99. The agents' MCP client (`mcpRequest` behind `mcp_list_tools`,
// `mcp_call_tool` and the swarm Tool node) sent its request cold: no
// initialize, no session id. A stateful Streamable HTTP server refuses that,
// and stateful is FastMCP's default. Measured against fastmcp 4.0.3 from the
// sandbox image: `tools/list` and `tools/call` sent bare both came back
// `400 {"error":{"code":-32600,"message":"Bad Request: Missing session ID"}}`.
// Driven: MCP Builder → a stock Hello world server → Access → Your agents
// ("Registered — your agents can call it now.") → a swarm Tool node, MCP Tool
// Call, `greet` → Run node → that same 400.
//
// The fake below behaves the way that server did: a request without a live
// session id is a 400; initialize issues one.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openMcpSession, requestInSession, type McpSend } from "@/utils/mcpApps/session";

type Seen = { method: "POST" | "DELETE"; headers: Record<string, string>; rpc?: string };

const sse = (msg: unknown) =>
  new Response(`event: message\r\ndata: ${JSON.stringify(msg)}\r\n\r\n`, {
    headers: { "content-type": "text/event-stream" },
  });

const MISSING_SESSION = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32600, message: "Bad Request: Missing session ID" },
};

/** A stateful server, as FastMCP runs by default. */
function statefulServer(opts: { agreed?: string; failCall?: boolean } = {}) {
  const seen: Seen[] = [];
  const live = new Set<string>();
  let issued = 0;
  const send: McpSend = async (method, headers, payload) => {
    seen.push({ method, headers, rpc: payload?.method as string | undefined });
    const sid = headers["Mcp-Session-Id"];
    if (method === "DELETE") {
      live.delete(sid);
      return new Response(null, { status: 200 });
    }
    if (payload?.method === "initialize") {
      const id = `session-${++issued}`;
      live.add(id);
      const res = sse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { protocolVersion: opts.agreed ?? "2025-06-18", capabilities: { tools: {} } },
      });
      res.headers.set("mcp-session-id", id);
      return res;
    }
    if (!sid || !live.has(sid)) {
      return new Response(JSON.stringify(MISSING_SESSION), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (!("id" in (payload ?? {}))) return new Response(null, { status: 202 });
    if (opts.failCall) throw new Error("connection reset");
    const name = ((payload?.params as any)?.arguments ?? {}).name;
    return sse({
      jsonrpc: "2.0",
      id: payload?.id,
      result: { content: [{ type: "text", text: `Hello, ${name}!` }] },
    });
  };
  return { send, seen, live };
}

const CALL = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "greet", arguments: { name: "r99" } },
};

/** Let the fire-and-forget DELETE land. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("the fake is the server that refused", () => {
  it("answers a cold request with Missing session ID, as FastMCP did", async () => {
    const { send } = statefulServer();
    const res = await send("POST", {}, CALL);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing session ID");
  });
});

describe("a call made in a session", () => {
  it("is answered by a stateful server", async () => {
    // The whole bug: this was the 400 above.
    const { send } = statefulServer();
    const { res, read } = await requestInSession(send, CALL);
    expect(res.status).toBe(200);
    expect(read.message?.result?.content?.[0]?.text).toBe("Hello, r99!");
  });

  it("initializes, announces it, then asks — in that order", async () => {
    const { send, seen } = statefulServer();
    await requestInSession(send, CALL);
    expect(seen.filter((s) => s.method === "POST").map((s) => s.rpc)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("carries the session id the server issued", async () => {
    const { send, seen } = statefulServer();
    await requestInSession(send, CALL);
    const call = seen.find((s) => s.rpc === "tools/call");
    expect(call?.headers["Mcp-Session-Id"]).toBe("session-1");
    const note = seen.find((s) => s.rpc === "notifications/initialized");
    expect(note?.headers["Mcp-Session-Id"]).toBe("session-1");
  });

  it("speaks the protocol version the server agreed to", async () => {
    const { send, seen } = statefulServer({ agreed: "2025-03-26" });
    await requestInSession(send, CALL);
    const call = seen.find((s) => s.rpc === "tools/call");
    expect(call?.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
  });

  it("ends the session afterwards", async () => {
    const { send, seen, live } = statefulServer();
    await requestInSession(send, CALL);
    await settle();
    const del = seen.find((s) => s.method === "DELETE");
    expect(del?.headers["Mcp-Session-Id"]).toBe("session-1");
    expect(live.size).toBe(0);
  });

  it("ends the session even when the request fails", async () => {
    const { send, seen } = statefulServer({ failCall: true });
    await expect(requestInSession(send, CALL)).rejects.toThrow("connection reset");
    await settle();
    expect(seen.some((s) => s.method === "DELETE")).toBe(true);
  });
});

describe("servers that did not need a session keep working", () => {
  it("sends the request bare when initialize is refused", async () => {
    // A bare JSON-RPC endpoint that only ever answered tools/list and
    // tools/call. It was reachable before; it must stay reachable.
    const seen: Seen[] = [];
    const send: McpSend = async (method, headers, payload) => {
      seen.push({ method, headers, rpc: payload?.method as string | undefined });
      if (payload?.method === "initialize") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        headers: { "content-type": "application/json" },
      });
    };
    const { res, read } = await requestInSession(send, { ...CALL, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(read.message?.result?.tools).toEqual([]);
    const call = seen.find((s) => s.rpc === "tools/list");
    expect(call?.headers["Mcp-Session-Id"]).toBeUndefined();
    await settle();
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("has nothing to end for a stateless server that issues no session", async () => {
    const seen: Seen[] = [];
    const send: McpSend = async (method, headers, payload) => {
      seen.push({ method, headers, rpc: payload?.method as string | undefined });
      return sse({
        jsonrpc: "2.0",
        id: payload?.id ?? null,
        result: { protocolVersion: "2025-06-18" },
      });
    };
    const session = await openMcpSession(send);
    expect(session.headers["Mcp-Session-Id"]).toBeUndefined();
    expect(session.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    await requestInSession(send, CALL);
    await settle();
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });
});

// ── The agents' client goes through it ─────────────────────────────────────

const REGISTRY = readFileSync("src/utils/tools/registry.server.ts", "utf8");

function block(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`"${marker}" not found: did the module change shape?`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the agents' MCP client", () => {
  it("makes its request in a session", () => {
    const body = block(REGISTRY, "async function mcpRequest(");
    expect(body).toMatch(/requestInSession\(send, body\)/);
  });

  it("keeps the SSRF guard on every request of the session", () => {
    const body = block(REGISTRY, "async function mcpRequest(");
    expect(body).toMatch(
      /const send: McpSend = \(method, extra, payload\) =>\s*safeFetch\(endpoint,/,
    );
    expect(body).not.toMatch(/[^.]fetch\(/);
  });

  it("is what both agent tools call", () => {
    expect(block(REGISTRY, "export async function runMcpListTools(")).toMatch(/mcpRequest\(/);
    expect(block(REGISTRY, "export async function runMcpCallTool(")).toMatch(/mcpRequest\(/);
  });
});
