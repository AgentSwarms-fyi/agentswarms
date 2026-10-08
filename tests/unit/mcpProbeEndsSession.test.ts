// Test connection and Refresh end the MCP session they open (R360).
//
// FOUND IN R100, SHOWN IN R360. The probe (`probeMcpServer`) opens a session
// (initialize, then notifications/initialized), lists the tools, and returned
// without ending it. A server keeps a session until it is ended or expires,
// and this instance's own endpoint for Builder servers keeps a row per
// session, so every press left one. On the R359 build, a Refresh of the "R99
// hello" Builder server reached its sandbox as POST /mcp 200, 202 and 200, and
// no DELETE. The agents' client already ends its sessions
// (mcpApps/session.ts); this was the other client. Pinned by source, as the
// probe's other rules are (mcpColdStartBudget, mcpStreamLeftOpen).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/lib/mcp/probe.functions.ts", "utf8");

describe("the MCP probe's session", () => {
  it("is remembered for the whole probe, not only inside the try", () => {
    const declared = SRC.indexOf("let sessionId: string | null = null;");
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(SRC.indexOf("// 1) initialize"));
    expect(SRC).toContain('sessionId = initRes.headers.get("Mcp-Session-Id");');
    expect(SRC).not.toContain('const sessionId = initRes.headers.get("Mcp-Session-Id");');
  });

  it("is ended in a finally, on every way out, with its own id", () => {
    const fin = SRC.slice(SRC.indexOf("} finally {"));
    expect(fin).toMatch(
      /if \(sessionId\) \{\s*void guardedFetch\(probeUrl, \{\s*method: "DELETE",/,
    );
    expect(fin).toContain('headers: { ...baseHeaders, "Mcp-Session-Id": sessionId },');
    // After the catch, so an error on the way still ends the session.
    expect(SRC.indexOf("} finally {")).toBeGreaterThan(SRC.indexOf("} catch (err) {"));
  });
});
