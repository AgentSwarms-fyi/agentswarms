// A tapped stream says how it ended exactly once (R363).
//
// FOUND FROM THE UI (R363). An AI-gateway call whose caller hung up left the
// chat turn behind it on the Traces page as "error: Invalid state: Controller
// is already closed", 847 tokens out: the turn had been recorded as a success,
// then twice more as an error. The stream's `cancel` recorded "error: Stream
// cancelled" when its reader left, and its read loop, which did not know, went
// on writing into the cancelled stream, threw, and recorded that too. These
// drive real streams through `tapStream`, which the chat route's trace tap is
// now built on.
import { describe, expect, it } from "vitest";

import { tapStream, type StreamEnd } from "@/lib/tapStream";

const enc = new TextEncoder();

/** An upstream the test feeds by hand, and that says when it was cancelled. */
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
  return {
    stream,
    state,
    push: (text: string) => ctl.enqueue(enc.encode(text)),
    close: () => ctl.close(),
    fail: (e: unknown) => ctl.error(e),
  };
}

/** Lets pending reads and their continuations run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

function tapped(
  upstream: ReadableStream<Uint8Array>,
  onEndExtra?: (end: StreamEnd) => void,
  signal?: AbortSignal,
) {
  const ends: StreamEnd["how"][] = [];
  const chunks: string[] = [];
  const out = tapStream(upstream, {
    signal,
    onChunk: (c) => chunks.push(new TextDecoder().decode(c)),
    onEnd: async (end, send) => {
      ends.push(end.how);
      onEndExtra?.(end);
      if (end.how === "complete") send(enc.encode("event: cost\n\n"));
    },
  });
  return { out, ends, chunks };
}

describe("a stream read to its end", () => {
  it("passes every chunk on, then what `onEnd` adds, and ends once as complete", async () => {
    const up = handFed();
    const { out, ends, chunks } = tapped(up.stream);
    up.push("data: one\n\n");
    up.push("data: two\n\n");
    up.close();
    expect(await new Response(out).text()).toBe("data: one\n\ndata: two\n\nevent: cost\n\n");
    expect(chunks).toEqual(["data: one\n\n", "data: two\n\n"]);
    expect(ends).toEqual(["complete"]);
  });
});

describe("a reader that leaves before the answer ends", () => {
  it("ends it once, as left, and never as a failure", async () => {
    const up = handFed();
    const { out, ends } = tapped(up.stream);
    const reader = out.getReader();
    up.push("data: one\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: one\n\n");
    await reader.cancel("Stop");
    // The upstream had more on its way; it arrives after the reader left.
    try {
      up.push("data: two\n\n");
    } catch {
      /* the tap already let go of it */
    }
    await settle();
    expect(ends).toEqual(["left"]);
  });

  it("lets go of the upstream, so the answer is not produced for nobody", async () => {
    const up = handFed();
    const { out } = tapped(up.stream);
    const reader = out.getReader();
    up.push("data: one\n\n");
    await reader.read();
    await reader.cancel();
    await settle();
    expect(up.state.cancelled).toBe(true);
  });

  it("is left even when the upstream then fails, as an aborted fetch does", async () => {
    const up = handFed();
    const { out, ends } = tapped(up.stream);
    const reader = out.getReader();
    up.push("data: one\n\n");
    await reader.read();
    await reader.cancel();
    try {
      up.fail(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
    } catch {
      /* already cancelled */
    }
    await settle();
    expect(ends).toEqual(["left"]);
  });
});

describe("a reader that leaves after the answer was complete", () => {
  it("keeps the turn complete: a finished answer is not rewritten", async () => {
    const up = handFed();
    let release!: () => void;
    const recording = new Promise<void>((r) => (release = r));
    const ends: StreamEnd["how"][] = [];
    const threw: unknown[] = [];
    const out = tapStream(up.stream, {
      onEnd: async (end, send) => {
        ends.push(end.how);
        // The success is still being written when the reader leaves, and the
        // cost event goes out after it.
        if (end.how !== "complete") return;
        await recording;
        try {
          send(enc.encode("event: cost\n\n"));
        } catch (e) {
          threw.push(e);
        }
      },
    });
    const reader = out.getReader();
    up.push("data: all of it\n\n");
    up.close();
    await reader.read();
    await settle();
    await reader.cancel();
    release();
    await settle();
    expect(ends).toEqual(["complete"]);
    expect(threw).toEqual([]);
  });
});

describe("a request whose caller left before the stream heard of it", () => {
  it("is left, not failed, when a fetch tied to the request fails first", async () => {
    const up = handFed();
    const request = new AbortController();
    const { out, ends } = tapped(up.stream, undefined, request.signal);
    const reader = out.getReader();
    up.push("data: one\n\n");
    await reader.read();
    // srvx aborts the request; the upstream fetch fails with it before the
    // response stream is cancelled.
    request.abort();
    up.fail(new DOMException("This operation was aborted", "AbortError"));
    await expect(reader.read()).rejects.toThrow("aborted");
    expect(ends).toEqual(["left"]);
  });

  it("is failed when the request is still there", async () => {
    const up = handFed();
    const request = new AbortController();
    const { out, ends } = tapped(up.stream, undefined, request.signal);
    up.fail(new Error("provider reset the stream"));
    await expect(new Response(out).text()).rejects.toThrow("provider reset");
    expect(ends).toEqual(["failed"]);
  });
});

describe("an upstream that fails while the reader is there", () => {
  it("ends once as failed, with the error, and the reader is told", async () => {
    const up = handFed();
    let seen: unknown = null;
    const { out, ends } = tapped(up.stream, (end) => {
      if (end.how === "failed") seen = end.error;
    });
    const boom = new Error("provider reset the stream");
    up.push("data: one\n\n");
    up.fail(boom);
    await expect(new Response(out).text()).rejects.toThrow("provider reset the stream");
    expect(ends).toEqual(["failed"]);
    expect(seen).toBe(boom);
  });
});
