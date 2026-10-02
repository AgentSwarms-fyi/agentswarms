// A client's patience against a server's cold start.
//
// FOUND IN R100. MCP Builder servers scale to zero after 15 idle minutes by
// default, and the first call wakes them. This instance's MCP endpoint gives
// that start up to 90 s. Its clients gave the first request, initialize, 15 s
// (agents and swarm Tool nodes) and 12 s (Test connection). Measured cold
// starts took 17.7 s and 35.5 s. Driven:
//
//   - a swarm Tool node calling `greet` on a stopped `R99 hello`:
//     "The operation was aborted due to timeout" at about 13 s; the endpoint
//     answered initialize 200 at 17.7 s, to nobody, and no DELETE ever came
//     for the session it had opened;
//   - MCP Servers → Refresh on the same stopped server: the toast "Probe
//     failed: The operation was aborted due to timeout", and the card went
//     from Active to Error for a server that was only asleep.
//
// And once the wait is long enough for the endpoint to answer, its 503 must
// be the answer. Retrying bare, as a server without sessions is retried, would
// only start a second sandbox behind the first failed one.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MCP_COLD_START_MS, MCP_CONNECT_BUDGET_MS } from "@/utils/mcpApps/budgets";
import { requestInSession, type McpSend } from "@/utils/mcpApps/session";

const CALL = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "greet", arguments: { name: "r100" } },
};

/** The slowest cold start measured while driving R99 and R100. */
const MEASURED_COLD_START_MS = 35_500;

describe("the budget", () => {
  it("outlasts the endpoint's own cold-start budget, so its answer arrives", () => {
    expect(MCP_CONNECT_BUDGET_MS).toBeGreaterThan(MCP_COLD_START_MS);
  });

  it("covers every cold start measured", () => {
    expect(MCP_CONNECT_BUDGET_MS).toBeGreaterThan(MEASURED_COLD_START_MS);
  });
});

describe("a server that fails to start is not asked twice", () => {
  it("hands back the endpoint's 503 and sends nothing more", async () => {
    const seen: string[] = [];
    const send: McpSend = async (method, _headers, payload) => {
      seen.push(`${method} ${String(payload?.method ?? "")}`.trim());
      if (payload?.method === "initialize") {
        return new Response(
          JSON.stringify({
            error: "start_timeout",
            message: "The MCP server did not finish starting within 90s.",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("a second start was triggered", { status: 503 });
    };
    const { res, read } = await requestInSession(send, CALL);
    expect(res.status).toBe(503);
    expect(read.text).toContain("did not finish starting within 90s");
    expect(seen).toEqual(["POST initialize"]);
  });

  it("still carries on bare past a refusal, which is a server without sessions", async () => {
    const seen: string[] = [];
    const send: McpSend = async (method, _headers, payload) => {
      seen.push(`${method} ${String(payload?.method ?? "")}`.trim());
      if (payload?.method === "initialize") return new Response("no", { status: 405 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    };
    const { res } = await requestInSession(send, CALL);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["POST initialize", "POST tools/call"]);
  });
});

// ── Every client waits that long for initialize ─────────────────────────────

const REGISTRY = readFileSync("src/utils/tools/registry.server.ts", "utf8");
const PROBE = readFileSync("src/lib/mcp/probe.functions.ts", "utf8");
const SERVICE = readFileSync("src/utils/mcpApps/service.server.ts", "utf8");
const PAGE = readFileSync("src/routes/_authenticated/mcp-builder_.$appId.tsx", "utf8");
const DOCS = readFileSync("src/routes/docs.mcp.tsx", "utf8");

describe("every client waits that long for initialize", () => {
  it("agents and swarm Tool nodes", () => {
    expect(REGISTRY).toMatch(/payload\?\.method === "initialize"\s*\?\s*MCP_CONNECT_BUDGET_MS/);
    expect(REGISTRY).toMatch(/AbortSignal\.timeout\(timeoutFor\(method, payload\)\)/);
  });

  it("Test connection", () => {
    const init = PROBE.slice(PROBE.indexOf('method: "initialize"'));
    expect(init.slice(0, 400)).toMatch(/null,\s*MCP_CONNECT_BUDGET_MS,\s*\)/);
    expect(PROBE).toMatch(/signal: AbortSignal\.timeout\(timeoutMs\)/);
  });

  it("and the endpoint's budget is the same number, from one place", () => {
    expect(SERVICE).toMatch(/const COLD_START_MS = MCP_COLD_START_MS;/);
    expect(SERVICE).not.toMatch(/const COLD_START_MS = \d/);
  });
});

describe("what the owner is told about a cold start", () => {
  it("no longer promises a few seconds", () => {
    expect(PAGE).not.toMatch(/first call \(a few seconds\)/);
    expect(DOCS).not.toMatch(/pays a\s+few seconds of start-up/);
    expect(PAGE).toMatch(/waits around half a minute/);
  });
});
