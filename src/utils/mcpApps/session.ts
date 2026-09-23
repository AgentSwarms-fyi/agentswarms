// One MCP request inside a session of its own: initialize, the request, then
// an end to the session.
//
// FOUND IN R99. The agents' MCP client sent `tools/list` and `tools/call` cold,
// with no initialize and no session id. A stateful Streamable HTTP server —
// FastMCP's default, and so every server the MCP Builder deploys — answers
// that with 400 "Bad Request: Missing session ID". The Builder registered its
// servers for agents with the toast "your agents can call it now", and every
// agent or swarm call to one failed, while Test connection, which does the
// handshake, showed the same server connected.
//
// The transport is passed in so this has no network of its own: the caller
// decides how a request is made (the SSRF guard, timeouts, auth).

import { MCP_PROTOCOL_VERSION } from "./protocol";
import { readRpcBody, type RpcBody } from "./sse";

/** Send one HTTP request to the MCP endpoint with these extra headers. */
export type McpSend = (
  method: "POST" | "DELETE",
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
) => Promise<Response>;

/**
 * Open a session: initialize, then notifications/initialized.
 *
 * Returns the headers every later request in the session must carry: the
 * session id, when the server issued one, and the protocol version it agreed
 * to. A server that refuses initialize at the HTTP level gets no session, and
 * the request goes out bare, which is how every call was made before, so a
 * server that only ever answered bare requests keeps working.
 */
export async function openMcpSession(send: McpSend): Promise<Record<string, string>> {
  const init = await send(
    "POST",
    {},
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agentswarms-agent", version: "1.0.0" },
      },
    },
  );
  if (!init.ok) {
    await init.body?.cancel().catch(() => {});
    return {};
  }
  const sessionId = init.headers.get("mcp-session-id");
  const agreed = (await readRpcBody(init)).message?.result?.protocolVersion;
  const session: Record<string, string> = {
    "MCP-Protocol-Version": typeof agreed === "string" ? agreed : MCP_PROTOCOL_VERSION,
  };
  if (sessionId) session["Mcp-Session-Id"] = sessionId;
  await send("POST", session, { jsonrpc: "2.0", method: "notifications/initialized" })
    .then((r) => r.body?.cancel())
    .catch(() => null);
  return session;
}

/**
 * Send one JSON-RPC request in a session opened for it, and end the session.
 *
 * Ending it is a SHOULD in the spec, and a server keeps every session it has
 * issued until it is ended or expires. This instance's own MCP endpoint writes
 * a row for each one, so an agent calling a Builder server would otherwise
 * leave a row behind per tool call.
 */
export async function requestInSession(
  send: McpSend,
  payload: Record<string, unknown>,
): Promise<{ res: Response; read: RpcBody }> {
  let session: Record<string, string> = {};
  try {
    session = await openMcpSession(send);
    const res = await send("POST", session, payload);
    // Up to the answer, not to the end of the stream (R98).
    const read = await readRpcBody(res);
    return { res, read };
  } finally {
    if (session["Mcp-Session-Id"]) {
      void send("DELETE", session)
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
  }
}
