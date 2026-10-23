// The server survives undici closing a response stream twice, and nothing else (R325).
//
// FOUND IN R325, by the browser checks' first full run: the server under test
// died mid-run with "TypeError [ERR_INVALID_STATE]: Invalid state:
// ReadableStream is already closed", thrown from undici (the fetch inside
// Node) in a microtask, and every later request was refused. In a cluster
// that is a worker and everything it held; alone, it is the server.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isUndiciDoubleClose, uncaughtExceptionHandler } from "../../serverGuards.mjs";

/** The error as the run threw it. */
function doubleClose() {
  const e = new TypeError("Invalid state: ReadableStream is already closed") as TypeError & {
    code?: string;
  };
  e.code = "ERR_INVALID_STATE";
  e.stack = `${e.name}: ${e.message}
    at ReadableByteStreamController.close (node:internal/webstreams/readablestream:1187:13)
    at node:internal/deps/undici/undici:1573:30
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)`;
  return e;
}

describe("which error is survived", () => {
  it("undici's double close is", () => {
    expect(isUndiciDoubleClose(doubleClose())).toBe(true);
  });

  it("the same message from somewhere other than undici is not", () => {
    const e = doubleClose();
    e.stack = `${e.name}: ${e.message}\n    at myCode (file:///app/x.mjs:1:1)`;
    expect(isUndiciDoubleClose(e)).toBe(false);
  });

  it("any other error is not", () => {
    expect(isUndiciDoubleClose(new Error("boom"))).toBe(false);
    expect(isUndiciDoubleClose(undefined)).toBe(false);
  });
});

describe("the handler", () => {
  const run = (err: unknown) => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const exit = vi.fn();
    uncaughtExceptionHandler({ log, exit })(err, "uncaughtException");
    return { log, exit };
  };

  it("logs the double close and keeps the process", () => {
    const { log, exit } = run(doubleClose());
    expect(exit).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("survived undici closing a response stream twice"),
    );
  });

  it("ends the process on anything else, as Node would", () => {
    const { log, exit } = run(new Error("boom"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalled();
  });
});

describe("a real process", () => {
  const guards = pathToFileURL(path.resolve("serverGuards.mjs")).href;
  const script = (install: boolean, which: "undici" | "other") => `
    ${install ? `const { installServerGuards } = await import(${JSON.stringify(guards)}); installServerGuards();` : ""}
    const e = ${which === "undici" ? `Object.assign(new TypeError("Invalid state: ReadableStream is already closed"), { code: "ERR_INVALID_STATE" })` : `new Error("boom")`};
    ${which === "undici" ? `e.stack += "\\n    at node:internal/deps/undici/undici:1573:30";` : ""}
    queueMicrotask(() => { throw e; });
    setTimeout(() => { console.log("still serving"); process.exit(0); }, 50);
  `;
  const node = (code: string) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });

  it("survives the double close with the guards, and dies of it without them", () => {
    const guarded = node(script(true, "undici"));
    expect(guarded.status).toBe(0);
    expect(guarded.stdout).toContain("still serving");

    const bare = node(script(false, "undici"));
    expect(bare.status).not.toBe(0);
  });

  it("still dies of any other uncaught exception", () => {
    const r = node(script(true, "other"));
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("still serving");
  });
});

describe("server.mjs", () => {
  it("installs the guards before it forks or serves", () => {
    const src = readFileSync("server.mjs", "utf8");
    const install = src.indexOf("installServerGuards();");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(src.indexOf("cluster.fork()"));
    expect(install).toBeLessThan(src.indexOf("async function startWorker()"));
  });
});
