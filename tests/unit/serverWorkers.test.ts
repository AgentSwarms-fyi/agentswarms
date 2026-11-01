// The primary's worker pool (serverWorkers.mjs), R430.
//
// FOUND FROM THE UI: with KMS_PROVIDER=aws and the KMS out of reach, every
// worker logged "refusing to start" and the primary replaced it at once, for
// ever, behind a container Docker reported as running. A refusal before any
// worker is up now stops the process with the refusal's own code; one after
// is a replacement meeting an outage, and waits.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXIT_KEYRING,
  LISTENING,
  reportListening,
  superviseWorkers,
} from "../../serverWorkers.mjs";

type FakeWorker = { process: { pid: number }; killed: string[]; kill: (s: string) => void };

function fakeCluster() {
  const bus = new EventEmitter();
  const workers: Record<string, FakeWorker> = {};
  let pid = 100;
  let forks = 0;
  const fork = () => {
    forks++;
    const w: FakeWorker = {
      process: { pid: ++pid },
      killed: [],
      kill: (s: string) => w.killed.push(s),
    };
    workers[String(pid)] = w;
    return w;
  };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const cluster = Object.assign(bus, { workers, fork });
  const pool = superviseWorkers({
    cluster,
    log: {
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
    },
    exit: (code: number) => exits.push(code),
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  });
  const die = (w: FakeWorker, code: number | null, signal?: string) => {
    delete workers[String(w.process.pid)];
    bus.emit("exit", w, code, signal ?? null);
  };
  const message = (w: FakeWorker, msg: unknown) => bus.emit("message", w, msg);
  const listening = (w: FakeWorker) => message(w, { type: LISTENING });
  return {
    pool,
    fork,
    die,
    message,
    listening,
    timers,
    logs,
    exits,
    workers,
    forks: () => forks,
  };
}

describe("the worker pool", () => {
  it("replaces a worker that crashes, at once", () => {
    const c = fakeCluster();
    const a = c.fork();
    c.listening(a);
    c.die(a, 1);
    expect(c.forks()).toBe(2);
    expect(c.timers).toEqual([]);
    expect(c.logs).toEqual([`warn [agentswarms] worker ${a.process.pid} exited (1) — restarting`]);
  });

  it("does not refill the pool while shutting down, and passes the signal on", () => {
    const c = fakeCluster();
    const a = c.fork();
    const b = c.fork();
    c.pool.shutdown("SIGTERM");
    expect(a.killed).toEqual(["SIGTERM"]);
    expect(b.killed).toEqual(["SIGTERM"]);
    c.die(a, 0);
    c.die(b, 78);
    expect(c.forks()).toBe(2);
    expect(c.exits).toEqual([]);
  });

  it("stops the whole process when the keyring refuses before any worker is up", () => {
    const c = fakeCluster();
    const a = c.fork();
    const b = c.fork();
    const d = c.fork();
    c.die(a, EXIT_KEYRING);
    expect(c.exits).toEqual([78]);
    expect(b.killed).toEqual(["SIGTERM"]);
    expect(d.killed).toEqual(["SIGTERM"]);
    expect(c.forks()).toBe(3); // no replacement
    expect(c.logs).toEqual([
      "error [agentswarms] no worker could load the credential keyring; stopping with exit code 78 so the container runtime restarts it",
    ]);
    // The others dying under the kill change nothing more.
    c.die(b, EXIT_KEYRING);
    c.die(d, null, "SIGTERM");
    expect(c.exits).toEqual([78]);
    expect(c.forks()).toBe(3);
  });

  it("once a worker serves, a refusal waits, doubling to a minute, and serving resets it", () => {
    const c = fakeCluster();
    const a = c.fork();
    const b = c.fork();
    c.listening(a);
    c.die(b, EXIT_KEYRING);
    expect(c.exits).toEqual([]);
    expect(a.killed).toEqual([]);
    expect(c.forks()).toBe(2); // not yet
    expect(c.timers.map((t) => t.ms)).toEqual([1000]);
    expect(c.logs.at(-1)).toBe(
      `warn [agentswarms] worker ${b.process.pid} could not load the credential keyring; the other workers keep serving, and a replacement starts in 1 s`,
    );
    c.timers[0].fn();
    expect(c.forks()).toBe(3);

    for (let i = 0; i < 8; i++) {
      const w = c.fork();
      c.die(w, EXIT_KEYRING);
    }
    expect(c.timers.map((t) => t.ms)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);

    c.listening(a);
    c.die(c.fork(), EXIT_KEYRING);
    expect(c.timers.at(-1)!.ms).toBe(1000);
  });

  it("a replacement due after shutdown began is not started", () => {
    const c = fakeCluster();
    const a = c.fork();
    c.listening(a);
    c.die(c.fork(), EXIT_KEYRING);
    c.pool.shutdown("SIGTERM");
    c.timers[0].fn();
    expect(c.forks()).toBe(2);
  });

  it("counts only the listening report as a worker being up", () => {
    const c = fakeCluster();
    const a = c.fork();
    c.fork();
    // A worker's other messages (or none) are not "up": the boot rule holds.
    c.message(a, { type: "something-else" });
    c.message(a, "agentswarms:listening");
    c.message(a, null);
    c.die(a, EXIT_KEYRING);
    expect(c.exits).toEqual([78]);
  });

  it("reportListening sends the message the primary counts, and is a no-op without IPC", () => {
    const sent: unknown[] = [];
    reportListening({ send: (m: unknown) => sent.push(m) } as unknown as NodeJS.Process);
    expect(sent).toEqual([{ type: LISTENING }]);
    expect(() => reportListening({} as NodeJS.Process)).not.toThrow();
  });
});

describe("with a real node:cluster", () => {
  it("a pool whose every worker refuses exits with 78, not a respawn loop", () => {
    const dir = mkdtempSync(join(tmpdir(), "r430-pool-"));
    try {
      const mod = pathToFileURL(resolve(process.cwd(), "serverWorkers.mjs")).href;
      const script = join(dir, "pool.mjs");
      writeFileSync(
        script,
        [
          'import cluster from "node:cluster";',
          `import { EXIT_KEYRING, superviseWorkers } from ${JSON.stringify(mod)};`,
          "if (cluster.isPrimary) {",
          "  superviseWorkers({ cluster });",
          "  for (let i = 0; i < 3; i++) cluster.fork();",
          "} else {",
          "  console.error(`worker ${process.pid} refusing to start: test`);",
          "  process.exit(EXIT_KEYRING);",
          "}",
        ].join("\n"),
      );
      const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20_000 });
      expect(r.signal).toBeNull(); // it ended by itself, inside the timeout
      expect(r.status).toBe(EXIT_KEYRING);
      expect(r.stderr).toContain("no worker could load the credential keyring");
      expect(r.stderr).not.toContain("restarting");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
