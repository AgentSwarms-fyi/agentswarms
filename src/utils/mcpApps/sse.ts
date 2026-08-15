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

/** A parsed JSON-RPC message, or null if the body carried none we could read. */
export type SseParseResult = Record<string, any> | null;

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
function isResponse(msg: any): boolean {
  return Boolean(msg) && typeof msg === "object" && ("result" in msg || "error" in msg);
}

/** Every `data:` payload in an SSE body, in order, as raw strings. */
function dataPayloads(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length) out.push(current.join("\n"));
    current = [];
  };

  for (const line of text.split(LINE_BREAK)) {
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
  flush();
  return out;
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
    let fallback: SseParseResult = null;
    for (const payload of dataPayloads(text)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // keep scanning: a stream can carry partial or non-JSON frames
      }
      if (!parsed || typeof parsed !== "object") continue;
      if (isResponse(parsed)) return parsed as Record<string, any>;
      // Remember the first object in case this stream carries no response at
      // all — returning it preserves the old behaviour for odd servers rather
      // than regressing them to null.
      if (!fallback) fallback = parsed as Record<string, any>;
    }
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
