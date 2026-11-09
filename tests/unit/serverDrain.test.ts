// R463: a SIGTERM must let open requests finish, within a bound.
//
// These run a REAL srvx server and a real streamed response, and drive the
// drain directly (Windows cannot deliver a SIGTERM to a child process, so the
// signal itself is the one thing not exercised here; the measurement that
// found the bug was taken on Linux, see serverDrain.mjs).
import http from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "srvx";

import {
  DRAINING,
  applyKeepAlive,
  createDrain,
  drainDelayMs,
  drainTimeoutMs,
  keepAliveSettings,
} from "../../serverDrain.mjs";
import { isDraining } from "@/utils/drain";

type Ticked = { ticks: number; outcome: "ended" | "cut" };

/** A server that streams `ticks` SSE events, one every `everyMs`. */
async function streamingServer(ticks: number, everyMs: number) {
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    gracefulShutdown: false,
    silent: true,
    fetch: () =>
      new Response(
        new ReadableStream({
          async start(c) {
            for (let i = 0; i < ticks; i++) {
              c.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
              await new Promise((r) => setTimeout(r, everyMs));
            }
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await server.ready();
  const port = Number(new URL(server.url!).port);
  return { server, port };
}

function readStream(port: number): Promise<Ticked> {
  return new Promise((resolve) => {
    let ticks = 0;
    const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      res.on("data", (d) => (ticks += String(d).split("data:").length - 1));
      res.on("end", () => resolve({ ticks, outcome: "ended" }));
      res.on("error", () => resolve({ ticks, outcome: "cut" }));
      res.on("aborted", () => resolve({ ticks, outcome: "cut" }));
    });
    req.on("error", () => resolve({ ticks, outcome: "cut" }));
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

const quiet = { log() {}, warn() {} } as unknown as Console;

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[DRAINING];
});

describe("draining a real server", () => {
  it("lets an open stream finish, refuses new connections, then exits 0", async () => {
    const { server, port } = await streamingServer(8, 80);
    const exited = new Promise<number>((resolve) => {
      const drain = createDrain({ server, log: quiet, exit: resolve, env: {} });
      setTimeout(() => drain("SIGTERM"), 150);
    });
    const reading = readStream(port);
    await new Promise((r) => setTimeout(r, 300));
    expect(isDraining()).toBe(true);
    expect(await canConnect(port)).toBe(false);
    expect(await reading).toEqual({ ticks: 8, outcome: "ended" });
    expect(await exited).toBe(0);
  });

  it("cuts what is still open once DRAIN_TIMEOUT_MS has passed, and still exits 0", async () => {
    const { server, port } = await streamingServer(40, 100);
    const warnings: string[] = [];
    const t0 = Date.now();
    const exited = new Promise<number>((resolve) => {
      const drain = createDrain({
        server,
        log: { log() {}, warn: (m: string) => warnings.push(m) } as unknown as Console,
        exit: resolve,
        env: { DRAIN_TIMEOUT_MS: "400" },
      });
      setTimeout(() => drain("SIGTERM"), 150);
    });
    const result = await readStream(port);
    expect(await exited).toBe(0);
    expect(result.outcome).toBe("cut");
    expect(result.ticks).toBeLessThan(40);
    // Exited at the timeout, not at the end of the 4 s stream.
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(warnings.join("\n")).toMatch(/drain timed out/);
  });

  it("keeps accepting during DRAIN_DELAY_MS while already reporting draining", async () => {
    const { server, port } = await streamingServer(1, 10);
    const exited = new Promise<number>((resolve) => {
      createDrain({ server, log: quiet, exit: resolve, env: { DRAIN_DELAY_MS: "600" } })("SIGTERM");
    });
    expect(isDraining()).toBe(true);
    expect(await canConnect(port)).toBe(true);
    expect(await exited).toBe(0);
  });

  it("drains once, however many signals arrive", async () => {
    const { server } = await streamingServer(1, 10);
    let exits = 0;
    const drain = createDrain({ server, log: quiet, exit: () => exits++, env: {} });
    drain("SIGTERM");
    drain("SIGINT");
    drain("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    expect(exits).toBe(1);
  });
});

// The bug and the fix, with a real SIGTERM. Windows cannot deliver one to a
// child process (it terminates it outright), so this runs on Linux and macOS,
// which is where CI and every container runs.
describe.skipIf(process.platform === "win32")("a real SIGTERM", () => {
  async function streamThenSigterm(
    mode: "drain" | "legacy",
  ): Promise<Ticked & { code: number | null }> {
    const { fork } = await import("node:child_process");
    const child = fork("tests/fixtures/drainServer.mjs", [mode, "15", "100"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, CI: "", TEST: "" },
    });
    const port = await new Promise<number>((resolve) =>
      child.once("message", (m) => resolve((m as { port: number }).port)),
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    const reading = readStream(port);
    await new Promise((r) => setTimeout(r, 250));
    child.kill("SIGTERM");
    const result = await reading;
    return { ...result, code: await exited };
  }

  it("before R463 (srvx's handler and ours both on): the stream was cut at the signal", async () => {
    const r = await streamThenSigterm("legacy");
    expect(r.outcome).toBe("cut");
    expect(r.ticks).toBeLessThan(15);
  });

  it("now: the stream finishes, then the process exits 0", async () => {
    const r = await streamThenSigterm("drain");
    expect(r).toEqual({ ticks: 15, outcome: "ended", code: 0 });
  });
});

describe("settings", () => {
  it("defaults: 25 s to drain, no delay, keep-alive past an ALB's 60 s", () => {
    expect(drainTimeoutMs({})).toBe(25_000);
    expect(drainDelayMs({})).toBe(0);
    expect(keepAliveSettings({})).toEqual({ keepAliveTimeout: 75_000, headersTimeout: 80_000 });
  });

  it("reads the environment, and ignores nonsense", () => {
    expect(drainTimeoutMs({ DRAIN_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(drainTimeoutMs({ DRAIN_TIMEOUT_MS: "soon" })).toBe(25_000);
    expect(drainTimeoutMs({ DRAIN_TIMEOUT_MS: "-1" })).toBe(25_000);
    expect(keepAliveSettings({ HTTP_KEEPALIVE_TIMEOUT_MS: "125000" })).toEqual({
      keepAliveTimeout: 125_000,
      headersTimeout: 130_000,
    });
  });

  it("applies the keep-alive window to a node server", () => {
    const s = http.createServer();
    applyKeepAlive(s, {});
    expect(s.keepAliveTimeout).toBe(75_000);
    expect(s.headersTimeout).toBeGreaterThan(s.keepAliveTimeout);
  });

  it("the app and the server agree on one draining flag", () => {
    expect(DRAINING).toBe(Symbol.for("agentswarms.draining"));
    expect(isDraining()).toBe(false);
    (globalThis as Record<symbol, unknown>)[DRAINING] = true;
    expect(isDraining()).toBe(true);
  });
});

describe("server.mjs uses it, and srvx's own handler is off", () => {
  const src = readFileSync("server.mjs", "utf8");

  it("turns off srvx's SIGTERM handler, which raced ours and cut every response", () => {
    expect(src).toContain("gracefulShutdown: false,");
  });

  it("drains through serverDrain.mjs and installs no SIGTERM handler of its own in the worker", () => {
    expect(src).toContain("installDrain({ server, who });");
    const worker = src.slice(
      src.indexOf("async function startWorker()"),
      src.indexOf("const workers = workerCount();"),
    );
    expect(worker).not.toMatch(/process\.on\(signal/);
  });

  it("sets the keep-alive window before it listens", () => {
    expect(src.indexOf("applyKeepAlive(server.node?.server);")).toBeLessThan(
      src.indexOf("await server.ready?.();"),
    );
  });
});
