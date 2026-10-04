// A notebook kernel, and a Spark query's poll, live longer than the render
// that started them (R271). Each captured the session token it started with,
// so after the hourly refresh its calls carried a token that would expire;
// and the kernel's stop swallowed a failure and said "stopped" anyway, while
// the container ran on until the idle reaper.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerRuntime } from "@/lib/serverRuntime";

/** A runtime with a session to stop, without starting a container. */
function runtimeWith(getToken: () => string | null) {
  const rt = new ServerRuntime(getToken, null);
  (rt as unknown as { sessionId: string }).sessionId = "session-1";
  return rt;
}

afterEach(() => vi.unstubAllGlobals());

/** A websocket that closes a moment after it is asked to, as a browser's does. */
class FakeSocket {
  static last: FakeSocket | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { reason: string; code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  close() {
    setTimeout(() => this.onclose?.({ reason: "", code: 1000 }), 0);
  }
}

/** A runtime connected to a FakeSocket, as start() leaves it. */
async function connectedRuntime() {
  vi.stubGlobal("WebSocket", FakeSocket);
  const rt = runtimeWith(() => "tok");
  Object.assign(rt as unknown as Record<string, unknown>, {
    token: "session-token",
    gatewayUrl: "ws://gateway",
  });
  const connected = (rt as unknown as { connect(): Promise<void> }).connect();
  FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: "ready" }) });
  await connected;
  return rt;
}

describe("ServerRuntime.stop", () => {
  it("resolves to null when the server stopped the kernel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const statuses: string[] = [];
    const rt = runtimeWith(() => "tok");
    rt.onStatus = (s) => statuses.push(s);
    await expect(rt.stop()).resolves.toBeNull();
    expect(statuses).toEqual(["stopped"]);
  });

  it("resolves to why, when the server's stop failed, instead of swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "JWT expired" }), { status: 401 })),
    );
    await expect(runtimeWith(() => "old").stop()).resolves.toBe("JWT expired");
  });

  it("reports an error, not 'stopped', when the stop failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const statuses: { s: string; msg?: string }[] = [];
    const rt = runtimeWith(() => "tok");
    rt.onStatus = (s, msg) => statuses.push({ s, msg });
    await rt.stop();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].s).toBe("error");
    expect(statuses[0].msg).toMatch(/^Could not stop the kernel \(Failed to fetch\)\. /);
  });

  it("resolves to why when the request itself failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(runtimeWith(() => "tok").stop()).resolves.toBe("Failed to fetch");
  });

  it("is not overruled by the socket closing after it: an error stays an error", async () => {
    const rt = await connectedRuntime();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const statuses: string[] = [];
    rt.onStatus = (s) => statuses.push(s);
    await rt.stop();
    await new Promise((r) => setTimeout(r, 10)); // the socket's close lands
    expect(statuses).toEqual(["error"]);
  });

  it("says stopped once when it stopped, the socket closing included", async () => {
    const rt = await connectedRuntime();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const statuses: string[] = [];
    rt.onStatus = (s) => statuses.push(s);
    await rt.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(statuses).toEqual(["stopped"]);
  });

  it("sends the token the getter returns when it calls, not when it was built", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let token = "token-at-start";
    const rt = runtimeWith(() => token);
    token = "token-after-refresh";
    await rt.stop();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-after-refresh",
    );
  });
});

describe("the pages", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("give each notebook kernel a getter over the live token", () => {
    for (const p of [
      "src/routes/_authenticated/notebooks.py.$pyNotebookId.tsx",
      "src/routes/_authenticated/notebooks.sample.$sampleSlug.tsx",
    ]) {
      const src = read(p);
      expect(src, p).toMatch(/new ServerRuntime\(\(\) => tokenRef\.current \|\| null,/);
      expect(src, p).not.toContain("new ServerRuntime(() => session?.access_token");
    }
  });

  it("poll a Spark query with the live token", () => {
    const src = read("src/routes/_authenticated/lakehouse.tsx");
    expect(src).toContain("() => getSparkFn({ data: { access_token: tokenRef.current, id } }),");
  });
});
