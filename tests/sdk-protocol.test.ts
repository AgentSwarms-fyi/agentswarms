// The React SDK's protocol layer (sdk/react/src/protocol.ts) must decode the
// embed endpoints' SSE streams byte-for-byte correctly — it is the one part
// of the SDK a consumer cannot see failing except as silently-wrong output.
// These tests pin the tokenizer against the exact frame shapes the servers
// emit (src/routes/api/embed.chat.ts and embed.analyst.ts) plus the hostile
// cases: frames split mid-line across network chunks, CRLF, multi-line data,
// comments/keep-alives, and malformed JSON that must be skipped, not thrown.
import { describe, expect, it } from "vitest";

import {
  createSseParser,
  mapAnalystFrame,
  mapChatFrame,
  type SseFrame,
} from "../sdk/react/src/protocol";

function collect(chunks: string[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const parser = createSseParser((f) => frames.push(f));
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return frames;
}

describe("createSseParser", () => {
  it("parses the exact chat stream shape the server emits", () => {
    // Mirrors embed.chat.ts: citations preamble, deltas, widget, [DONE].
    const stream =
      `event: citations\ndata: {"citations":[{"index":1}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
      `event: widget\ndata: {"widget":{"type":"bar"}}\n\n` +
      `data: [DONE]\n\n`;
    const frames = collect([stream]);
    expect(frames).toEqual([
      { event: "citations", data: '{"citations":[{"index":1}]}' },
      { event: null, data: '{"choices":[{"delta":{"content":"Hel"}}]}' },
      { event: null, data: '{"choices":[{"delta":{"content":"lo"}}]}' },
      { event: "widget", data: '{"widget":{"type":"bar"}}' },
      { event: null, data: "[DONE]" },
    ]);
  });

  it("reassembles frames split at arbitrary chunk boundaries", () => {
    const stream = `data: {"choices":[{"delta":{"content":"split"}}]}\n\ndata: [DONE]\n\n`;
    // Split at every possible position — the tokenizer must be split-proof.
    for (let cut = 1; cut < stream.length; cut++) {
      const frames = collect([stream.slice(0, cut), stream.slice(cut)]);
      expect(frames).toHaveLength(2);
      expect(frames[0].data).toBe('{"choices":[{"delta":{"content":"split"}}]}');
      expect(frames[1].data).toBe("[DONE]");
    }
  });

  it("handles CRLF line endings and comment keep-alives", () => {
    const frames = collect([`: keep-alive\r\nevent: turn\r\ndata: {"turn":1}\r\n\r\n`]);
    expect(frames).toEqual([{ event: "turn", data: '{"turn":1}' }]);
  });

  it("joins multi-line data fields with newlines per the SSE spec", () => {
    const frames = collect(["data: line1\ndata: line2\n\n"]);
    expect(frames).toEqual([{ event: null, data: "line1\nline2" }]);
  });

  it("strips exactly one leading space after the data colon", () => {
    const frames = collect(["data:  two spaces\ndata:none\n\n"]);
    // First: one space stripped, second preserved as-is.
    expect(frames[0].data).toBe(" two spaces\nnone");
  });

  it("event name does not leak into the following frame", () => {
    const frames = collect([`event: widget\ndata: {"widget":1}\n\ndata: [DONE]\n\n`]);
    expect(frames[0].event).toBe("widget");
    expect(frames[1].event).toBeNull();
  });

  it("flush() delivers a final unterminated frame, and only then", () => {
    const withTail: SseFrame[] = [];
    const parser = createSseParser((f) => withTail.push(f));
    parser.push("data: tail");
    expect(withTail).toHaveLength(0); // nothing until terminator or flush
    parser.flush();
    expect(withTail).toEqual([{ event: null, data: "tail" }]);
  });
});

describe("mapChatFrame", () => {
  it("maps every server frame type to its typed event", () => {
    expect(mapChatFrame({ event: null, data: '{"choices":[{"delta":{"content":"hi"}}]}' })).toEqual(
      { type: "delta", text: "hi" },
    );
    expect(mapChatFrame({ event: "citations", data: '{"citations":[{"index":2}]}' })).toEqual({
      type: "citations",
      citations: [{ index: 2 }],
    });
    expect(mapChatFrame({ event: "widget", data: '{"widget":{"a":1}}' })).toEqual({
      type: "widget",
      widget: { a: 1 },
    });
    expect(mapChatFrame({ event: null, data: "[DONE]" })).toEqual({ type: "done" });
  });

  it("returns null (never throws) on malformed or empty frames", () => {
    expect(mapChatFrame({ event: null, data: "not json {" })).toBeNull();
    expect(mapChatFrame({ event: "citations", data: "oops" })).toBeNull();
    expect(mapChatFrame({ event: "widget", data: "{}" })).toBeNull();
    expect(mapChatFrame({ event: null, data: '{"choices":[{"delta":{}}]}' })).toBeNull();
    expect(
      mapChatFrame({ event: null, data: '{"choices":[{"delta":{"content":""}}]}' }),
    ).toBeNull();
  });
});

describe("mapAnalystFrame", () => {
  it("maps turn / done / failed and ignores everything else", () => {
    expect(mapAnalystFrame({ event: "turn", data: '{"turn":{"id":1}}' })).toEqual({
      type: "turn",
      turn: { id: 1 },
    });
    expect(mapAnalystFrame({ event: "done", data: '{"turn":{"id":1}}' })).toEqual({
      type: "done",
      turn: { id: 1 },
    });
    expect(
      mapAnalystFrame({ event: "failed", data: '{"error":"Budget reached","status":402}' }),
    ).toEqual({ type: "failed", error: "Budget reached", status: 402 });
    expect(mapAnalystFrame({ event: null, data: "[DONE]" })).toBeNull();
    expect(mapAnalystFrame({ event: "other", data: "{}" })).toBeNull();
  });

  it("failed without a usable error string gets a fallback message", () => {
    expect(mapAnalystFrame({ event: "failed", data: "{}" })).toEqual({
      type: "failed",
      error: "Analysis failed",
      status: undefined,
    });
  });

  it("turn/done frames without a turn payload are skipped, not fabricated", () => {
    expect(mapAnalystFrame({ event: "turn", data: "{}" })).toBeNull();
    expect(mapAnalystFrame({ event: "done", data: "not json" })).toBeNull();
  });
});
