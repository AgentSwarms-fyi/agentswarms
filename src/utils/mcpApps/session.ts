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

/** An opened session, or the answer of a server that failed to open one. */
export type McpSession = { headers: Record<string, string>; failed?: Response };

/**
 * Open a session: initialize, then notifications/initialized.
 *
 * `headers` are what every later request in the session must carry: the
 * session id, when the server issued one, and the protocol version it agreed
 * to. A server that REFUSES initialize (4xx) gets no session, and the request
 * goes out bare, which is how every call was made before R99, so a server
 * that only ever answered bare requests keeps working.
 *
 * A server that FAILS initialize (5xx) is not one that does without sessions.
 * Its answer is handed back as `failed` and nothing more is sent. Sending the
 * request again bare would only fail again, and behind this instance's own
 * endpoint it would start a second sandbox after the first one's cold start
 * had just been given up on (R100).
 */
export async function openMcpSession(send: McpSend): Promise<McpSession> {
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
    if (init.status >= 500) return { headers: {}, failed: init };
    await init.body?.cancel().catch(() => {});
    return { headers: {} };
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
  return { headers: session };
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
  let session: McpSession = { headers: {} };
  try {
    session = await openMcpSession(send);
    const res = session.failed ?? (await send("POST", session.headers, payload));
    // Up to the answer, not to the end of the stream (R98).
    const read = await readRpcBody(res);
    return { res, read };
  } finally {
    if (session.headers["Mcp-Session-Id"]) {
      void send("DELETE", session.headers)
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
  }
}
