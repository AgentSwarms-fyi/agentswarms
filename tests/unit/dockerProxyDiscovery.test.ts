// The socket-proxy discovery ping. Seen live: a run failed with "Cannot
// reach the Docker socket-proxy … Start the runtime services" while the
// services were up — the proxy's own log showed that /_ping took 13 s
// because the daemon was busy building an image, and the app gave up at
// 2.5 s. The budget is now long enough for a busy daemon, and a stall is
// reported as a stall, with the fix for a stall, not as stopped services.
import { afterEach, describe, expect, it, vi } from "vitest";

async function fresh() {
  vi.resetModules();
  return await import("@/utils/notebookRuntime/docker.server");
}

/** A fetch that accepts and never answers, honouring the abort signal. */
function stallingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  );
}

/** A fetch that fails at once, the way an unresolvable service name does. */
function refusingFetch() {
  return vi.fn(() => Promise.reject(new TypeError("fetch failed")));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("socket-proxy discovery", () => {
  it("waits ten seconds by default, and the operator can change that", async () => {
    const { dockerPingTimeoutMs } = await fresh();
    expect(dockerPingTimeoutMs()).toBe(10_000);
    vi.stubEnv("DOCKER_PROXY_PING_TIMEOUT_MS", "25000");
    expect(dockerPingTimeoutMs()).toBe(25_000);
    vi.stubEnv("DOCKER_PROXY_PING_TIMEOUT_MS", "not a number");
    expect(dockerPingTimeoutMs()).toBe(10_000);
  });

  it("uses that budget on the ping, not a hard-coded one", async () => {
    vi.stubEnv("DOCKER_PROXY_PING_TIMEOUT_MS", "40");
    const fetch = stallingFetch();
    vi.stubGlobal("fetch", fetch);
    const { dockerBase } = await fresh();
    const t = Date.now();
    await expect(dockerBase()).rejects.toThrow();
    // Three candidates at most, each 40 ms: well under a second. With the
    // old 2.5 s constant this would take several seconds.
    expect(Date.now() - t).toBeLessThan(1000);
    expect(fetch).toHaveBeenCalled();
  });

  it("reports a stall as a stall, with the fix for a stall", async () => {
    vi.stubEnv("DOCKER_PROXY_PING_TIMEOUT_MS", "40");
    vi.stubGlobal("fetch", stallingFetch());
    const { dockerBase } = await fresh();
    const err = await dockerBase().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("Cannot reach the Docker socket-proxy");
    expect(msg).toContain("accepted the connection but did not answer");
    expect(msg).toContain("restart notebook-docker-proxy");
    expect(msg).toContain("no answer within 0.04 s");
    // The wrong advice for this failure is absent.
    expect(msg).not.toContain("Start the runtime services");
  });

  it("still says to start the services when nothing answers at all", async () => {
    vi.stubGlobal("fetch", refusingFetch());
    const { dockerBase } = await fresh();
    const err = await dockerBase().catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain(
      "Start the runtime services with:  docker compose --profile notebooks up -d --build",
    );
    expect(msg).toContain("fetch failed");
    expect(msg).not.toContain("accepted the connection");
  });

  it("caches the first candidate that answers", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("OK", { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    const { dockerBase } = await fresh();
    expect(await dockerBase()).toBe("http://notebook-docker-proxy:2375");
    expect(await dockerBase()).toBe("http://notebook-docker-proxy:2375");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
