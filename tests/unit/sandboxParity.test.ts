// The same user snippet runs in TWO sandboxes: the browser Worker on the
// canvas (src/lib/sandbox/jsSandbox.ts) and the JS sandbox service for
// headless runs (services/js-sandbox/worker.mjs). If their contracts drift,
// "it worked when I tested it" stops meaning anything — a component tested on
// the canvas would behave differently the moment it is deployed.
//
// Two definitions is a deliberate, unavoidable duplication (one runs in a
// Worker realm, the other in a Node vm), so this file is the thing that keeps
// them honest. It reads both sources and asserts the contract they share.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source with comments removed.
 *
 * Both files DOCUMENT the contract in prose that quotes it verbatim, so a
 * naive substring check passes on the comment alone: a mutation that renamed
 * the real wrapper to `userFn(context, log)` survived this suite until the
 * comments were stripped. Assertions must see code.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const BROWSER = codeOnly(readFileSync(resolve("src/lib/sandbox/jsSandbox.ts"), "utf-8"));
const SERVER = codeOnly(readFileSync(resolve("services/js-sandbox/worker.mjs"), "utf-8"));
const SERVICE = codeOnly(readFileSync(resolve("services/js-sandbox/server.mjs"), "utf-8"));
const EXECUTOR = codeOnly(readFileSync(resolve("src/utils/swarmExecute.server.ts"), "utf-8"));
const COMPOSE = readFileSync(resolve("docker-compose.yml"), "utf-8");

describe("sandbox parity: the snippet sees the same thing in both", () => {
  it("wraps user code as the same async userFn(ctx, console)", () => {
    for (const [name, src] of [
      ["browser", BROWSER],
      ["server", SERVER],
    ] as const) {
      expect(src, `${name} sandbox lost the userFn wrapper`).toContain(
        "async function userFn(ctx, console)",
      );
    }
  });

  it("runs the snippet in strict mode on both sides", () => {
    // Sloppy mode silently ignores writes to the frozen ctx; strict throws.
    // The server sandbox shipped without this once and the probe caught it.
    expect(BROWSER).toContain('"use strict"');
    expect(SERVER).toContain('"use strict"');
  });

  it("exposes exactly input, vars and params — all frozen", () => {
    for (const [name, src] of [
      ["browser", BROWSER],
      ["server", SERVER],
    ] as const) {
      expect(src, `${name}: ctx.input missing`).toMatch(/input:\s*(ctx\??\.input|raw\.input)/);
      expect(src, `${name}: vars not frozen`).toMatch(/vars:\s*Object\.freeze/);
      expect(src, `${name}: params not frozen`).toMatch(/params:\s*Object\.freeze/);
    }
  });

  it("captures console at the same four levels with the same prefixes", () => {
    for (const [name, src] of [
      ["browser", BROWSER],
      ["server", SERVER],
    ] as const) {
      for (const level of ["log", "info", "warn", "error"]) {
        expect(src, `${name}: console.${level} not captured`).toContain(level);
      }
      expect(src, `${name}: warn prefix drifted`).toContain('"[warn] "');
      expect(src, `${name}: error prefix drifted`).toContain('"[error] "');
    }
  });

  it("JSON round-trips the return value on both sides", () => {
    for (const [name, src] of [
      ["browser", BROWSER],
      ["server", SERVER],
    ] as const) {
      expect(src, `${name}: return value not JSON round-tripped`).toMatch(
        /JSON\.stringify\(\s*(value|v)\s*===\s*undefined\s*\?\s*null\s*:\s*(value|v)\s*\)/,
      );
    }
  });

  it("reports a timeout rather than hanging, on both sides", () => {
    expect(BROWSER).toMatch(/timed out after/i);
    expect(SERVER).toMatch(/timed out after/i);
  });
});

describe("sandbox isolation invariants", () => {
  it("the server sandbox puts NOTHING from the host realm into the vm", () => {
    // The escape that made this rule: a host `console` carries the HOST
    // Function constructor, and console.log.constructor("return process")()
    // then yields process.env — this container's INTERNAL_RUN_SECRET.
    expect(SERVER).toMatch(/vm\.createContext\(\s*Object\.create\(null\)/);
    // A context built from an object literal holding host functions is the
    // exact regression this guards.
    expect(SERVER).not.toMatch(/vm\.createContext\(\s*\{[^}]*console/);
    expect(SERVER).toMatch(/codeGeneration:\s*\{\s*strings:\s*false/);
  });

  it("the service refuses to start without a shared secret", () => {
    expect(SERVICE).toMatch(/if\s*\(!SECRET\)/);
    expect(SERVICE).toMatch(/process\.exit\(1\)/);
  });

  it("the service enforces its own timeout ceiling, not the caller's", () => {
    expect(SERVICE).toMatch(
      /Math\.min\(Number\(payload\?\.timeoutMs\)\s*\|\|\s*2000,\s*MAX_TIMEOUT_MS\)/,
    );
  });

  it("the compose service is hardened and has no egress", () => {
    const block = COMPOSE.slice(
      COMPOSE.indexOf("  js-sandbox:"),
      COMPOSE.indexOf("# Network topology"),
    );
    expect(block).toContain("read_only: true");
    expect(block).toContain("no-new-privileges:true");
    expect(block).toContain("cap_drop: [ALL]");
    expect(block).toMatch(/networks:\s*\[js-internal\]/);
    // Loopback publish only: this endpoint executes code.
    expect(block).toContain('"127.0.0.1:8091:8091"');
    // …and the network it sits on must be internal (no route out).
    const netBlock = COMPOSE.slice(COMPOSE.indexOf("  js-internal:"));
    expect(netBlock.slice(0, 200)).toContain("internal: true");
  });
});

describe("headless custom code", () => {
  it("the executor calls the sandbox service and never eval()s in-process", () => {
    expect(EXECUTOR).toContain("runSandboxedServer");
    // The app process holds the service-role key; anything that compiles user
    // code here would put it one prototype-chain trick away.
    expect(EXECUTOR).not.toMatch(/new Function\(/);
    expect(EXECUTOR).not.toMatch(/\beval\(/);
    expect(EXECUTOR).not.toMatch(/require\(["']node:vm["']\)/);
  });

  it("refuses with a single shared message when the sandbox is not deployed", () => {
    expect(EXECUTOR).toContain("JS_SANDBOX_UNAVAILABLE");
    const client = codeOnly(readFileSync(resolve("src/utils/jsSandbox.server.ts"), "utf-8"));
    expect(client).toContain("--profile sandbox");
  });

  it("checks required component params before running, like the canvas does", () => {
    expect(EXECUTOR).toContain("missingRequired");
    const runtime = codeOnly(readFileSync(resolve("src/lib/swarmRuntime.ts"), "utf-8"));
    expect(runtime).toContain("missingRequired");
  });
});
