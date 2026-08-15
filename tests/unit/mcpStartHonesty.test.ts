// What the MCP Builder is allowed to tell its owner about a failed start.
//
// All three bugs pinned here shared one shape: code that could not tell two
// situations apart, and picked the reassuring one.
//
//   1. waitReady() returned a bare `null` whether the sandbox DIED or the
//      deadline expired, so the caller printed "did not start in time" for a
//      container that had crashed seconds in — sending the owner to wait
//      longer when they needed to read a traceback. Measured on a real app:
//      session created 17:52:54, app marked failed 17:53:51, session row
//      status "stopped" with error null and logs "".
//   2. handshake() turned an unreadable tools/list into { ok: true, tools: [] },
//      so a server exposing two tools deployed "successfully" with 0 tools and
//      wrote the empty-list fingerprint to tools_hash.
//   3. The failure path fetched the container's logs, scanned them for one
//      line, dropped them, and THEN destroyed the container — while telling
//      the owner to go and read those logs.
//
// These live in the server module, which drags in Supabase and the container
// orchestrator, so they are pinned by reading the source. That is weaker than
// executing it and is chosen deliberately: the alternative is mocking the whole
// runtime, and a mock proves the mock.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SERVICE = readFileSync("src/utils/mcpApps/service.server.ts", "utf8");
const PROXY = readFileSync("src/routes/api/mcp.s.$slug.ts", "utf8");

/** Body of a named function/const in the service module, up to the next top-level close. */
function block(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`"${marker}" not found — did the module change shape?`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return end < 0 ? rest : rest.slice(0, end);
}

describe("a failed start says which failure it was", () => {
  it("waitReady reports a reason, not a bare null", () => {
    const body = block(SERVICE, "async function waitReady(");
    expect(body).toMatch(/why:\s*"died"/);
    expect(body).toMatch(/why:\s*"deadline"/);
  });

  it("waitReady hands back the row so the caller can read its error", () => {
    // The session's own `error` column was discarded, so a sandbox that
    // recorded exactly what went wrong still produced a generic message.
    const body = block(SERVICE, "async function waitReady(");
    expect(body).toMatch(/return\s*\{\s*ready:\s*false,\s*why:\s*"died",\s*row\s*\}/);
  });

  it("the caller branches on the reason", () => {
    expect(SERVICE).toMatch(/outcome\.why === "died"/);
  });

  it("a crash is not described as a timeout", () => {
    // The died branch must not reach for time-based wording.
    const died = SERVICE.slice(SERVICE.indexOf('outcome.why === "died"'));
    const branch = died.slice(0, died.indexOf("// Deadline"));
    expect(branch).toMatch(/started and then stopped/);
    expect(branch).not.toMatch(/in time|did not finish starting/);
  });

  it("the deadline branch does not claim to know why", () => {
    // "Still starting" is all we actually observed. Asserting a crash, or
    // naming a Python error we never saw, would be inventing a cause.
    const tail = SERVICE.slice(SERVICE.indexOf("// Deadline"));
    expect(tail).toMatch(/Still starting after/);
  });

  it("no longer tells the owner to read logs that may not exist", () => {
    // The old message was "Check its logs for the Python error." — unactionable
    // whenever the logs were empty, which was the common case.
    expect(SERVICE).not.toContain("Check its logs for the Python error");
  });

  it("says the log was empty instead of implying one is waiting", () => {
    expect(SERVICE).toMatch(/logged no error/);
  });
});

describe("the logs outlive the container that held them", () => {
  it("a persistLogs helper exists and writes the session's logs column", () => {
    const body = block(SERVICE, "async function persistLogs(");
    expect(body).toContain("notebook_runtime_sessions");
    expect(body).toMatch(/logs:/);
  });

  it("logs are captured BEFORE the container is torn down", () => {
    // stopSession removes the container. Reading after it is reading nothing,
    // which is how the Logs tab came to be permanently empty for a failed app.
    const tail = SERVICE.slice(
      SERVICE.indexOf("const outcome = await waitReady(session, deadline)"),
    );
    const persistAt = tail.indexOf("persistLogs(");
    const stopAt = tail.indexOf("stopSession(session)");
    expect(persistAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(stopAt);
  });
});

describe("an unreadable handshake is a failure, not an empty toolset", () => {
  it("a null parse is refused", () => {
    const body = block(SERVICE, "export async function handshake(");
    expect(body).toMatch(/if \(!parsed\)/);
    expect(body).toMatch(/could not read the server's response/);
  });

  it("a result without a tools array is refused", () => {
    const body = block(SERVICE, "export async function handshake(");
    expect(body).toMatch(/Array\.isArray\(parsed\?\.result\?\.tools\)/);
  });

  it("the success return is reached only after both checks", () => {
    // The -1 guards matter: indexOf returns -1 for a check that is ABSENT, and
    // -1 is less than any real index, so an ordering assertion alone passes
    // vacuously once the thing it is ordering has been deleted. Caught by
    // mutation — this test survived removing both checks until the guards
    // were added.
    const body = block(SERVICE, "export async function handshake(");
    const nullCheck = body.indexOf("if (!parsed)");
    const arrayCheck = body.indexOf("Array.isArray(parsed?.result?.tools)");
    const success = body.indexOf("return { ok: true, tools: toolsFromListResult(parsed) }");
    expect(nullCheck).toBeGreaterThan(-1);
    expect(arrayCheck).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(-1);
    expect(nullCheck).toBeLessThan(success);
    expect(arrayCheck).toBeLessThan(success);
  });
});

describe("a narrowed key is never handed the full tool list", () => {
  it("fails closed when the list cannot be parsed", () => {
    // This filter is the enforcement point for a key restricted to specific
    // tools. It used to fall through to the unfiltered upstream body whenever
    // the parse failed — and with the CRLF bug the parse ALWAYS failed against
    // a conformant server, so the restriction silently did nothing.
    const start = PROXY.indexOf('if (method === "tools/list" && allowed.length > 0)');
    expect(start).toBeGreaterThan(-1);
    const branch = PROXY.slice(start, start + 1400);
    expect(branch).toMatch(/if \(!parsed\?\.result\)/);
    expect(branch).toMatch(/rpcError\(/);
    expect(branch).toMatch(/restricted to specific tools/);
  });

  it("still filters to the allow-list when it can read the list", () => {
    const start = PROXY.indexOf('if (method === "tools/list" && allowed.length > 0)');
    const branch = PROXY.slice(start, start + 1400);
    expect(branch).toMatch(/\.filter\(\(t\) => allowed\.includes\(t\.name\)\)/);
  });
});

describe("the cold-start budget", () => {
  it("is longer than the measured healthy start with real headroom", () => {
    // Measured on an idle machine with the image present: container visible at
    // 3s, session ready at 23s. The old 45s budget left one healthy start of
    // slack, and pip-installing the app's declared packages happens inside it.
    const m = /const COLD_START_MS = ([\d_]+);/.exec(SERVICE);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeGreaterThanOrEqual(90_000);
  });

  it("keeps the start lease longer than the budget", () => {
    // If the lease expired first, a second caller could steal it from a start
    // that was still legitimately running and race it into a duplicate
    // container. Tying one to the other stops them drifting apart.
    expect(SERVICE).toMatch(/const LEASE_TTL_MS = COLD_START_MS \* 2;/);
  });
});
