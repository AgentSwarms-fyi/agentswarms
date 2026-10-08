// Response compression for server.mjs.
//
// Moved here from server.mjs in R364 so it can be run against real streams in
// a test, as serverGuards.mjs is. Its history is in the comments below and in
// productionServer.test.ts.

/**
 * Compress responses the client is willing to decompress: the static files,
 * and the app's own pages and JSON, which srvx's static handler hands on to
 * the app and returns through this wrapper.
 *
 * WHY IT MATTERS MORE THAN IT SOUNDS: the browser DuckDB engine is a 32.7 MB
 * WebAssembly module, and every first visit downloaded all of it uncompressed.
 * It gzips to 7.4 MB — a 4.4x saving on the single largest thing this app
 * serves, paid by every new visitor and on every cache-busting deploy.
 * `vite preview` did not compress either, so this is not a regression; it was
 * simply never done, and nothing surfaced it until a slow link made the
 * download fail outright and the Data Catalog quietly showed zero tables.
 *
 * Compressing on the fly rather than at build time keeps this self-contained;
 * assets are content-hashed and immutable, so a browser pays it once.
 */
const COMPRESSIBLE = /^(?:text\/|image\/svg|application\/(?:javascript|json|wasm|xml))/i;

/**
 * A response read as it is written, which compression would hold back (R364).
 *
 * FOUND FROM THE UI (R364). Gzip emits nothing until it has a block's worth of
 * output or its input ends, so an event stream passed through it arrives in
 * one piece at the end. `text/` matched `text/event-stream`, and this wrapper
 * sees the app's responses as well as the static files. Agent Chat's answer
 * appeared all at once when it was done, and an AI-gateway call with
 * `stream: true` sent its first byte when its answer was complete: the
 * gateway's own fetch to the chat route asks for gzip, as Node's fetch does.
 * An event is a few hundred bytes; there is little to save and a stream to
 * lose.
 */
const STREAMED = /^text\/event-stream/i;

/**
 * The same request object, reporting `identity` for Accept-Encoding.
 *
 * A PROXY, not `new Request(request, { headers })`. srvx's static handler reads
 * `req._url` — its own cached parsed URL, not part of the Request interface —
 * and a rebuilt Request does not carry it. Doing that reset the connection
 * mid-response, which looked exactly like the transfer problem this code is
 * here to fix. The proxy changes one header lookup and leaves the object
 * otherwise itself.
 */
function asIdentityRequest(request) {
  const headers = new Proxy(request.headers, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      if (prop !== "get") return bound;
      return (name) =>
        String(name).toLowerCase() === "accept-encoding" ? "identity" : bound(name);
    },
  });
  return new Proxy(request, {
    get(target, prop) {
      if (prop === "headers") return headers;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function compressStatic(handler) {
  return async (request, next) => {
    // ASK THE INNER HANDLER FOR AN UNCOMPRESSED BODY.
    //
    // MEASURED, and the reason this wrapper exists at all: srvx's static
    // handler compresses with `createBrotliCompress()` — brotli at its default
    // quality 11 — whenever the client's Accept-Encoding mentions `br`, which
    // every browser's does. On the 32.7 MB WebAssembly engine that took
    // **157 seconds per request**, so the download never finished, the browser
    // SQL engine never started, and the Data Catalog reported "Local tables: 0"
    // on a workspace holding 33 of them. The same file with Accept-Encoding
    // identity: 644 ms.
    //
    // Brotli at that quality is for build-time compression, not per-request.
    // Stripping the header here keeps srvx out of the compression business and
    // lets the gzip below — fast, and 4.4x on this file — do the job.
    const res = await handler(asIdentityRequest(request), next);

    // 200 only: compressing a 206 would misreport the byte range, and a body
    // that is already encoded must be left alone.
    if (!res?.body || res.status !== 200 || res.headers.get("content-encoding")) return res;
    if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) return res;
    const type = res.headers.get("content-type") ?? "";
    if (STREAMED.test(type) || !COMPRESSIBLE.test(type)) return res;

    const headers = new Headers(res.headers);
    headers.set("content-encoding", "gzip");
    // The compressed length is not known until it is written, and a stale
    // Content-Length is worse than none: the client truncates the body.
    headers.delete("content-length");
    headers.set("vary", "accept-encoding");
    return new Response(res.body.pipeThrough(new CompressionStream("gzip")), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
