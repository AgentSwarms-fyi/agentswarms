// Reading a JSON-RPC response off the wire, whether it arrived as JSON or as a
// Streamable-HTTP SSE frame.
//
// This lives in its own module with NO imports because three callers need it
// and they cannot all reach the same place: protocol.ts pulls in node:crypto,
// and src/lib/mcp/probe.functions.ts is bundled into a client route. That
// mismatch is why a second copy of this parser was hand-written there, and why
// the two then had the same bug twice. One copy, no imports, importable by
// anything.
//
// THE BUG THIS FILE EXISTS TO KILL. Both copies split the body on "\n" and
// matched /^data:\s*(.+)$/. Real servers end SSE lines with CRLF, so the line
// handed to the regex was `data: {…}\r`. In JavaScript `.` does not match \r,
// and `$` without the /m flag only matches the very end of the string — so the
// pattern could not match, the parser returned null, and EVERY response from a
// conformant server was silently unreadable. Measured against FastMCP 3.4.5
// behind uvicorn: a tools/list carrying two tools parsed as null.

/** A JSON value, as a body parses to. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * A JSON-RPC message as read off the wire (R344). Only the envelope is known:
 * an MCP result is an object whose fields depend on the method, and each is
 * checked where it is read.
 */
export type RpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonValue;
  result?: JsonObject;
  error?: { code?: number; message?: string; data?: JsonValue };
};

/** A parsed JSON-RPC message, or null if the body carried none we could read. */
export type SseParseResult = RpcMessage | null;

/** A tool as `tools/list` describes it, in our own shape. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
};

/**
 * A list of tools in our own shape: an entry without a name is left out, and
 * anything but a list is no tools. Here, with no imports, so the probe
 * (bundled into a client route) shares this copy with the server: the same
 * reason the parser below lives here.
 */
export function toolsFromArray(arr: unknown): McpTool[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (t): t is JsonObject =>
        !!t && typeof t === "object" && !Array.isArray(t) && typeof t.name === "string",
    )
    .map((t) => ({
      name: t.name as string,
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as JsonObject)
          : undefined,
    }));
}

/** Normalise whatever `tools/list` returned into our own shape. */
export function toolsFromListResult(parsed: SseParseResult | undefined): McpTool[] {
  return toolsFromArray(parsed?.result?.tools);
}

/**
 * SSE line terminators, per the spec: CRLF, LF or a bare CR — all three, in
 * that order so a CRLF is consumed as one break rather than two.
 */
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Is this object a JSON-RPC *response* rather than a notification?
 *
 * A server may interleave notifications (progress, logging — this one
 * advertises a `logging` capability) on the same stream as the reply. Taking
 * the first object seen would hand the caller a log line in place of its
 * result, which reads downstream as "the server returned nothing".
 */
function isResponse(msg: unknown): boolean {
  return typeof msg === "object" && msg !== null && ("result" in msg || "error" in msg);
}

/**
 * Every `data:` payload in an SSE body, in order, as raw strings.
 *
 * With `completeOnly`, an event still arriving — the tail after the last blank
 * line — is left out. A stream read in pieces must not act on half an event.
 */
function dataPayloads(text: string, completeOnly = false): string[] {
  const out: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length) out.push(current.join("\n"));
    current = [];
  };

  const lines = text.split(LINE_BREAK);
  // The last piece of a split is the line still being written, or the "" after
  // a final terminator. Neither is a blank line: `data: {…}\r\n` has ended
  // its line, not its event.
  if (completeOnly) lines.pop();
  for (const line of lines) {
    // A blank line ends the event; consecutive `data:` lines within one event
    // are joined with a newline, which is how a JSON body may legally be split
    // across frames.
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue; // comment / keepalive
    if (line.startsWith("data:")) {
      // Exactly one optional leading space is part of the framing; anything
      // beyond that belongs to the payload.
      const value = line.slice(5);
      current.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (!completeOnly) flush();
  return out;
}

/**
 * The first JSON-RPC response among these payloads, and the first object of
 * any kind — the fallback for a stream that carries no response at all.
 */
function pick(payloads: string[]): { response: SseParseResult; first: SseParseResult } {
  let first: SseParseResult = null;
  for (const payload of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue; // keep scanning: a stream can carry partial or non-JSON frames
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (isResponse(parsed)) return { response: parsed as RpcMessage, first };
    if (!first) first = parsed as RpcMessage;
  }
  return { response: null, first };
}

/**
 * Parse an MCP response body, which may be JSON or a Streamable-HTTP SSE frame.
 *
 * Servers are free to answer either way for the same request, so a caller that
 * only handles `application/json` works until the day the user's server decides
 * to stream — hence one parser used everywhere.
 *
 * Returns null when nothing readable was found. Callers MUST distinguish that
 * from a successfully-parsed empty result: "I could not read the answer" and
 * "the answer was empty" are different facts, and only one of them is safe to
 * show a user as a tool count.
 */
export function parseJsonOrSse(text: string, contentType: string): SseParseResult {
  if (contentType.includes("text/event-stream")) {
    // The first object stands in when the stream carries no response at all —
    // returning it preserves the old behaviour for odd servers rather than
    // regressing them to null.
    const { response, first } = pick(dataPayloads(text));
    return response ?? first;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** What {@link readRpcBody} took off the wire. */
export type RpcBody = {
  /**
   * The body as read: all of it for JSON, and for a stream everything up to
   * the chunk that completed the response event.
   */
  text: string;
  /** The JSON-RPC message, picked as {@link parseJsonOrSse} picks it. */
  message: SseParseResult;
  /** The body passed `maxChars` before an answer arrived; nothing else is set. */
  oversized: boolean;
};

/**
 * Read an MCP response body, and stop at the answer.
 *
 * FOUND IN R98. Every caller did `await res.text()`, which on an event stream
 * resolves only when the SERVER closes it. The Streamable HTTP spec says a
 * server SHOULD close the stream once the response is sent: should, not must.
 * A stream left open, with keep-alives or behind a proxy, held the caller
 * until its abort timer fired. An answer that came back in milliseconds was
 * then reported as "The operation was aborted due to timeout", and a deploy
 * marked a healthy server Error that way.
 *
 * A JSON body is read whole, as before. A stream is read as it arrives and
 * released the moment a complete event carries a JSON-RPC response; nothing
 * after that on a request's stream is addressed to the caller. A stream that
 * ends without one is parsed the old way, so odd servers keep their fallback.
 */
export async function readRpcBody(res: Response, maxChars = Infinity): Promise<RpcBody> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    const text = await res.text();
    if (text.length > maxChars) return { text: "", message: null, oversized: true };
    return { text, message: parseJsonOrSse(text, contentType), oversized: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) return { text: "", message: null, oversized: true };
      const { response } = pick(dataPayloads(text, true));
      if (response) return { text, message: response, oversized: false };
    }
    text += decoder.decode();
    return { text, message: parseJsonOrSse(text, contentType), oversized: false };
  } finally {
    // Either way the stream is finished with: let the connection go rather
    // than leave it open until the server gets round to closing it.
    reader.cancel().catch(() => {});
  }
}

/**
 * A request's failure, in words that name the request and the wait.
 *
 * An abort timer surfaces as "The operation was aborted due to timeout",
 * which says neither which request ran out nor how long it had. Since R98 a
 * timeout here means the server really sent no answer in time, so say that.
 */
export function rpcFailure(step: string, e: unknown, waitedMs: number): string {
  if (e instanceof Error && e.name === "TimeoutError") {
    return `${step} → no answer within ${Math.round(waitedMs / 1000)}s`;
  }
  return `${step} → ${e instanceof Error ? e.message : String(e)}`;
}
