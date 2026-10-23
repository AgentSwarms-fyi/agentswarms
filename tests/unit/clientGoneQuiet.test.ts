// A browser that leaves mid-request is not printed as a server fault (R362).
//
// FOUND IN R342, SHOWN IN R362. Reloading a signed-in page while its requests
// were in flight printed "Error: aborted ... code: 'ECONNRESET' ... status:
// 500, unhandled: true" in the app's log. srvx aborts the request's signal
// with Node's error when the connection closes first, TanStack Start throws
// that reason on purpose, and h3 prints any error that is not its own as
// unhandled. These run TanStack's own request handler, the one the built
// server's fetch is made of, so the report is h3's real one.
import { readFileSync } from "node:fs";
import { requestHandler } from "@tanstack/react-start/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quietClientGone, rememberClientAborts } from "../../serverGuards.mjs";

/** Node's error when a client hangs up, which srvx gives the signal as its reason. */
const hangUp = () => Object.assign(new Error("aborted"), { code: "ECONNRESET" });

/** A page whose work takes a moment, and stops if its client left, as TanStack's does. */
const page = requestHandler(async (request: Request) => {
  await new Promise((r) => setTimeout(r, 20));
  request.signal.throwIfAborted();
  return new Response("ok");
});

/** A page that fails with `err` on its own. */
const failing = (err: unknown) =>
  rememberClientAborts(
    requestHandler(async () => {
      throw err;
    }),
  );

const served = rememberClientAborts(page);

let printed: ReturnType<typeof vi.spyOn>;
let undo: () => void;
beforeEach(() => {
  printed = vi.spyOn(console, "error").mockImplementation(() => {});
  undo = quietClientGone();
});
afterEach(() => {
  undo();
  printed.mockRestore();
});

describe("a client that leaves mid-request", () => {
  it("is not printed", async () => {
    const ac = new AbortController();
    const res = served(new Request("http://localhost/settings", { signal: ac.signal }));
    ac.abort(hangUp());
    expect((await res).status).toBe(500);
    expect(printed).not.toHaveBeenCalled();
  });

  it("is not printed when it left before the app was handed the request", async () => {
    const ac = new AbortController();
    ac.abort(hangUp());
    await served(new Request("http://localhost/traces", { signal: ac.signal }));
    expect(printed).not.toHaveBeenCalled();
  });

  it("was printed, as h3's unhandled 500, by a fetch that does not remember", async () => {
    const ac = new AbortController();
    const res = page(new Request("http://localhost/settings", { signal: ac.signal }));
    ac.abort(hangUp());
    await res;
    expect(printed).toHaveBeenCalledTimes(1);
    expect(printed.mock.calls[0][0]).toMatchObject({
      name: "HTTPError",
      status: 500,
      unhandled: true,
    });
  });
});

describe("every other error", () => {
  it("is printed, as before", async () => {
    await failing(new Error("the database did not answer"))(new Request("http://localhost/x"));
    expect(printed).toHaveBeenCalledTimes(1);
  });

  it("is printed when the app raised an abort itself", async () => {
    await failing(new DOMException("This operation was aborted", "AbortError"))(
      new Request("http://localhost/x"),
    );
    expect(printed).toHaveBeenCalledTimes(1);
  });

  it("is printed when it only looks like a hang-up: the request's own client stayed", async () => {
    await failing(hangUp())(new Request("http://localhost/x"));
    expect(printed).toHaveBeenCalledTimes(1);
  });

  it("is printed whole when anything else is logged with it", async () => {
    const ac = new AbortController();
    const res = served(new Request("http://localhost/x", { signal: ac.signal }));
    const reason = hangUp();
    ac.abort(reason);
    console.error("Provider error:", reason);
    await res;
    expect(printed.mock.calls).toEqual([["Provider error:", reason]]);
  });
});

describe("server.mjs", () => {
  const src = readFileSync("server.mjs", "utf8");

  it("serves the app through the fetch that remembers", () => {
    expect(src).toContain("fetch: rememberClientAborts(app.fetch),");
    expect(src).not.toContain("fetch: app.fetch,");
  });

  it("quiets the report before it serves", () => {
    const quiet = src.indexOf("quietClientGone();");
    expect(quiet).toBeGreaterThan(src.indexOf("async function startWorker()"));
    expect(quiet).toBeLessThan(src.indexOf("const server = serve({"));
  });
});
