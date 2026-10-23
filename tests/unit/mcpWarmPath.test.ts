// A warm request to a Builder MCP server does not re-prove what the last one
// proved (R367).
//
// MEASURED FROM THE UI (R367). MCP Integrations → "R99 hello" → Refresh, warm:
// each of its requests through /api/mcp/s/<slug> took 1.2 to 1.46 s in the
// app's own log (`[mcp-endpoint] … duration_ms`), and the sandbox's log showed
// a readiness GET before every POST. The sandbox answers in milliseconds; the
// time was about eleven database round trips one after another, seven of them
// in ensureRunning.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SERVING_FOR_MS,
  TOUCH_EVERY_MS,
  forgetServing,
  recentlyServing,
  sawServing,
  touchDue,
} from "@/utils/mcpApps/warmPath";

describe("a sandbox seen serving", () => {
  it("is taken as serving for a while, then proved again", () => {
    sawServing("s1", 1_000);
    expect(recentlyServing("s1", 1_000 + SERVING_FOR_MS - 1)).toBe(true);
    expect(recentlyServing("s1", 1_000 + SERVING_FOR_MS)).toBe(false);
  });

  it("is never assumed for a session this process has not seen", () => {
    expect(recentlyServing("never-seen", 5_000)).toBe(false);
  });

  it("is forgotten when a request to it fails", () => {
    sawServing("s2", 1_000);
    forgetServing("s2");
    expect(recentlyServing("s2", 1_001)).toBe(false);
  });
});

describe("its activity", () => {
  it("is written when it is old enough for the idle reaper to need it", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(touchDue(new Date(now - TOUCH_EVERY_MS + 1).toISOString(), now)).toBe(false);
    expect(touchDue(new Date(now - TOUCH_EVERY_MS).toISOString(), now)).toBe(true);
  });

  it("is written when none was recorded, or what was recorded will not parse", () => {
    expect(touchDue(null, 0)).toBe(true);
    expect(touchDue("not a date", 0)).toBe(true);
  });

  it("is written well inside the shortest idle limit anyone would set", () => {
    // The idle TTL is set in minutes; half a minute leaves it room.
    expect(TOUCH_EVERY_MS).toBeLessThanOrEqual(30_000);
  });
});

const SERVICE = readFileSync("src/utils/mcpApps/service.server.ts", "utf8");
const PROXY = readFileSync("src/routes/api/mcp.s.$slug.ts", "utf8");
const ensure = SERVICE.slice(
  SERVICE.indexOf("export async function ensureRunning("),
  SERVICE.indexOf("if (!(await acquireStartLease(app.id))) {"),
);

describe("ensureRunning", () => {
  it("reads the settings, the owner's grant and the live session at once", () => {
    expect(ensure).toMatch(
      /await Promise\.all\(\[\s*getRuntimeSettings\(\),\s*canUseRuntime\(app\.user_id\),\s*liveSession\(app\.id\),\s*\]\)/,
    );
    // And still refuses on either before it serves anything.
    const served = ensure.indexOf("recentlyServing(");
    for (const refusal of ["if (!settings.enabled) {", "if (!permitted) {"]) {
      const at = ensure.indexOf(refusal);
      expect(at, refusal).toBeGreaterThan(0);
      expect(at, refusal).toBeLessThan(served);
    }
  });

  it("takes a sandbox only as serving when it is ready, has an endpoint, and was seen", () => {
    expect(ensure).toContain(
      'if (existing?.status === "ready" && existing.endpoint && recentlyServing(existing.id)) {',
    );
    expect(ensure).toContain("if (touchDue(existing.last_active_at)) await touch(existing.id);");
  });

  it("remembers every sandbox it proved serving", () => {
    expect(SERVICE.match(/sawServing\(outcome\.row\.id\);/g)).toHaveLength(3);
  });
});

describe("the proxy", () => {
  it("forgets a sandbox a forward to it failed on", () => {
    expect(PROXY).toMatch(
      /if \(!upstream\.ok\) \{[\s\S]{0,200}?forgetServing\(started\.session\.id\);[\s\S]{0,40}?return json\(\{ error: "upstream_unreachable"/,
    );
  });

  it("reads the app and the key at once, and judges them in the old order", () => {
    const auth = PROXY.slice(PROXY.indexOf("async function authenticate("));
    expect(auth).toMatch(/const \[\{ data: app \}, \{ data: key \}\] = await Promise\.all\(\[/);
    const notFound = auth.indexOf(
      'if (!app) return { ok: false, response: json({ error: "Not found" }, 404) };',
    );
    const malformed = auth.indexOf("if (!wellFormed) {");
    const invalid = auth.indexOf(
      "if (!key || key.app_id !== app.id || !key.is_active || key.revoked_at) {",
    );
    expect(notFound).toBeGreaterThan(0);
    expect(malformed).toBeGreaterThan(notFound);
    expect(invalid).toBeGreaterThan(malformed);
  });
});
