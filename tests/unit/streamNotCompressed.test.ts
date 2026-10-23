// An event stream is not compressed, so it arrives as it is written (R364).
//
// FOUND FROM THE UI (R364). In the production server, Agent Chat's answer
// appeared all at once when it was done: the R347 agent's 29 tokens, streamed
// by the model over two seconds, reached the page in one step, and the
// /api/chat response was gzipped (545 bytes for 1,893). An AI-gateway call
// with `stream: true` sent its first byte at 3.70 s of 3.70 s, and one cut at
// 7 s had received nothing while 576 tokens were already written behind it.
// Gzip emits nothing until it has a block's worth of output or its input ends,
// and server.mjs's compressor matched `text/` for the app's responses too.
// These run the compressor itself on real streams.
import { describe, expect, it } from "vitest";

import { compressStatic } from "../../serverCompression.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A request as a browser, or Node's fetch, sends it: it accepts gzip. */
const asked = (path: string) =>
  new Request(`http://localhost:8080${path}`, {
    headers: { "accept-encoding": "gzip, deflate, br, zstd" },
  });

/** srvx's static handler finding no file and handing the request on to the app. */
const served = (answer: Response) =>
  compressStatic(async (_req: Request, next: () => Promise<Response>) => next())(
    asked("/api/chat"),
    async () => answer,
  ) as Promise<Response>;

function eventStream(type = "text/event-stream") {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": type } }),
    send: (event: string) => ctl.enqueue(enc.encode(event)),
    end: () => ctl.close(),
  };
}

describe("an event stream", () => {
  it("is passed on as it is written, not held for compression", async () => {
    const stream = eventStream();
    const res = await served(stream.response);
    expect(res.headers.get("content-encoding")).toBeNull();
    const reader = res.body!.getReader();
    stream.send("data: one\n\n");
    // Read before the second event exists: a compressed stream has nothing
    // to give here but its 10-byte header.
    expect(dec.decode((await reader.read()).value)).toBe("data: one\n\n");
    stream.send("data: two\n\n");
    expect(dec.decode((await reader.read()).value)).toBe("data: two\n\n");
    stream.end();
    expect((await reader.read()).done).toBe(true);
  });

  it("is passed on with a charset too", async () => {
    const stream = eventStream("text/event-stream; charset=utf-8");
    const res = await served(stream.response);
    expect(res.headers.get("content-encoding")).toBeNull();
    stream.end();
  });
});

describe("everything else compressible", () => {
  const gunzip = async (res: Response) =>
    new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();

  it("is still gzipped, as the app's pages are", async () => {
    const html = "<!doctype html><title>Agent Chat</title>" + "<p>x</p>".repeat(200);
    const res = await served(
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(await gunzip(res)).toBe(html);
  });

  it("is still gzipped, as the static assets are", async () => {
    const js = "export const answer = 42;\n".repeat(100);
    const res = await served(
      new Response(js, { status: 200, headers: { "content-type": "application/javascript" } }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzip(res)).toBe(js);
  });
});
