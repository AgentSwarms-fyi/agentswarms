// Reading a JSON-RPC response off an SSE stream.
//
// THE BUG THESE TESTS EXIST FOR shipped in two hand-written copies of the same
// parser and survived because every test written for it used "\n" frames. Real
// servers send CRLF. The old code split on "\n" and matched /^data:\s*(.+)$/,
// which is handed `data: {…}\r` — and in JavaScript `.` does not match \r while
// `$` without /m matches only the very end of the string, so the pattern could
// not match ANY conformant frame and the parser returned null every time.
//
// Downstream that null was read as "the server has no tools": a deploy against
// a server exposing two tools recorded zero, reported success, and wrote the
// empty-list fingerprint. On the edge proxy it silently disabled a narrowed
// key's tool filtering.
//
// The CRLF cases below are the literal bytes captured from FastMCP 3.4.5 behind
// uvicorn during that investigation, not a reconstruction.
import { describe, expect, it } from "vitest";

import { parseJsonOrSse } from "@/utils/mcpApps/sse";

const SSE = "text/event-stream";
const JSON_CT = "application/json";

/** The exact tools/list body measured on the wire, CRLF and all. */
const REAL_CRLF_BODY =
  'event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[' +
  '{"name":"get_customer","description":"Fetch one customer record by id."},' +
  '{"name":"search_customers","description":"Search customers by name or email."}' +
  "]}}\r\n\r\n";

describe("the frame a real server actually sends", () => {
  it("parses a CRLF-terminated data line", () => {
    // The whole bug in one assertion. This returned null for every user.
    const parsed = parseJsonOrSse(REAL_CRLF_BODY, SSE);
    expect(parsed).not.toBeNull();
    expect(parsed?.result?.tools).toHaveLength(2);
  });

  it("does not leave a stray carriage return inside the payload", () => {
    // A parser that merely widened the regex could capture the trailing \r and
    // survive here only because JSON.parse tolerates trailing whitespace. The
    // names must come back clean.
    const parsed = parseJsonOrSse(REAL_CRLF_BODY, SSE);
    expect(parsed?.result?.tools?.map((t: any) => t.name)).toEqual([
      "get_customer",
      "search_customers",
    ]);
  });

  it("still parses LF-only frames", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
    expect(parseJsonOrSse(body, SSE)?.result?.tools).toEqual([]);
  });

  it("parses bare-CR frames, which the SSE spec also allows", () => {
    const body = 'event: message\rdata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\r\r';
    expect(parseJsonOrSse(body, SSE)?.result?.ok).toBe(true);
  });
});

describe("picking the right frame out of the stream", () => {
  it("returns the response, not a notification that arrived first", () => {
    // This server advertises a `logging` capability, so it may push a log
    // notification onto the same stream before the reply. Taking the first
    // object seen would hand the caller a log line and the tool list would
    // read as empty — the same wrong answer by a different route.
    const body =
      'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\r\n\r\n' +
      'event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"only_tool"}]}}\r\n\r\n';
    const parsed = parseJsonOrSse(body, SSE);
    expect(parsed?.result?.tools?.[0]?.name).toBe("only_tool");
  });

  it("returns an error frame rather than skipping past it", () => {
    // An error IS the response. Skipping it would leave the caller to report
    // "no tools" for a server that told us exactly what went wrong.
    const body =
      'data: {"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}\r\n\r\n';
    expect(parseJsonOrSse(body, SSE)?.error?.message).toBe("Method not found");
  });

  it("joins a payload split across consecutive data lines", () => {
    // Legal SSE framing: one event, several data fields, joined with newlines.
    const body =
      'event: message\r\ndata: {"jsonrpc":"2.0","id":2,\r\ndata: "result":{"n":1}}\r\n\r\n';
    expect(parseJsonOrSse(body, SSE)?.result?.n).toBe(1);
  });

  it("ignores comment/keepalive lines", () => {
    const body = ': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"n":7}}\r\n\r\n';
    expect(parseJsonOrSse(body, SSE)?.result?.n).toBe(7);
  });
});

describe("saying nothing rather than saying something false", () => {
  it("returns null when no frame carries readable JSON", () => {
    // The caller has to be able to tell "I could not read the answer" from
    // "the answer was empty". Everything downstream depends on that.
    expect(parseJsonOrSse("event: ping\r\ndata: not json\r\n\r\n", SSE)).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(parseJsonOrSse("", SSE)).toBeNull();
  });

  it("returns null for a JSON body that is not an object", () => {
    expect(parseJsonOrSse('"a string"', JSON_CT)).toBeNull();
    expect(parseJsonOrSse("42", JSON_CT)).toBeNull();
  });

  it("parses a plain JSON body", () => {
    expect(
      parseJsonOrSse('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}', JSON_CT)?.result,
    ).toEqual({ tools: [] });
  });

  it("returns null for unparseable JSON", () => {
    expect(parseJsonOrSse("{oops", JSON_CT)).toBeNull();
  });
});
