// A deploy whose server does not answer as an MCP server stops its sandbox (R366).
//
// FOUND FROM THE UI (R366, queued since R98). MCP Builder → a new server,
// "R366 not MCP", whose source served a plain HTTP 404 on the sandbox's port:
// it starts, the readiness probe accepts any answer short of a 5xx, and the
// handshake's initialize gets 404. Deploy said "initialize → HTTP 404" and
// the app read Error, but its sandbox (nb-6c925617…) was still up on the host
// a minute later, holding its CPU and memory until the idle reaper came for
// it, and listed nowhere an owner could see: Running kernels leaves MCP
// servers out. The failed-start path already kept the logs and stopped the
// sandbox; this path set Error and returned.
//
// Pinned by source, as the module's other rules are (mcpStartHonesty explains
// why: the alternative is mocking the whole runtime).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SERVICE = readFileSync("src/utils/mcpApps/service.server.ts", "utf8");
const deploy = SERVICE.slice(
  SERVICE.indexOf("export async function deploy("),
  SERVICE.indexOf("/** Append an immutable version row for this deploy. */"),
);
const failed = deploy.slice(
  deploy.indexOf("if (!shook.ok) {"),
  deploy.indexOf("const hash = toolsFingerprint("),
);

describe("a deploy whose handshake fails", () => {
  it("stops the sandbox it started, before it says Error", () => {
    expect(failed.length).toBeGreaterThan(0);
    const stop = failed.indexOf("await stopSession(started.session)");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(
      failed.indexOf('await setAppStatus(app.id, "error", shook.message);'),
    );
  });

  it("keeps the logs first, for the Logs tab once the sandbox is gone", () => {
    const read = failed.indexOf("const logs = await logsOf(app.id)");
    const kept = failed.indexOf("await persistLogs(started.session.id, logs);");
    expect(read).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(read);
    expect(kept).toBeLessThan(failed.indexOf("await stopSession(started.session)"));
    // And answers with what it read, not a second read of a sandbox now gone.
    expect(failed).toContain("return { ok: false, error: shook.message, logs };");
    expect(failed.match(/logsOf\(/g)).toHaveLength(1);
  });

  it("does what a failed start already did", () => {
    const start = SERVICE.slice(
      SERVICE.indexOf("const outcome = await waitReady(session, deadline);"),
    );
    expect(start).toMatch(
      /if \(logs\) await persistLogs\(session\.id, logs\);\s*await stopSession\(session\)\.catch/,
    );
  });
});
