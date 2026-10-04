// A runtime settings row that could not be read is not a missing one.
//
// FOUND IN R249, closing two sweep-7 rows at once ("notebook runtime limits
// fall back to the permissive defaults" and "the MCP reaper stops every
// published server"). Both are one statement in one module: a read of runtime
// state that failed was taken as a fact about that state.
//
//   getRuntimeSettings  `require_grant ?? false`: with the runtime kept on by
//                       NOTEBOOK_RUNTIME_ENABLED, a failed read let EVERY user
//                       start a server kernel on a deployment that requires a
//                       grant. The idle TTL and session limits fell back too,
//                       and the reaper applied them to live kernels.
//   idleServiceSessions a failed mcp_apps read made "no app row means the app
//                       was deleted" true of every app: each published MCP
//                       server was stopped, keep_warm ones included.
//   ensurePlatformEgress a failed read came back as an empty list (supabase-js
//                       returns errors, so its catch never fired) and the proxy
//                       file was rewritten without the operator's hosts.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  settings: { data: null, error: null } as Resp,
  rpc: { data: false, error: null } as { data: boolean | null; error: unknown },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () => Promise.resolve(db.settings);
    return b;
  };
  return {
    supabaseAdmin: {
      from: () => chain(),
      rpc: async () => db.rpc,
    },
  };
});

vi.mock("@/utils/notebookRuntime/token.server", () => ({
  runtimeSecretConfigured: async () => true,
}));

const GRANT_REQUIRED = {
  data: { server_runtime_enabled: true, require_grant: true, idle_ttl_minutes: 240 },
  error: null,
};

beforeEach(() => {
  db.settings = GRANT_REQUIRED;
  db.rpc = { data: false, error: null };
  // The documented "force-enable" path: the runtime stays on whatever the row says.
  vi.stubEnv("NOTEBOOK_RUNTIME_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("getRuntimeSettings and canUseRuntime", () => {
  it("refuses a user without a grant when the row reads (the baseline)", async () => {
    const { canUseRuntime } = await import("@/utils/notebookRuntime/config.server");
    expect(await canUseRuntime("no-grant")).toBe(false);
  });

  it("does not open server kernels to everyone when the row cannot be read", async () => {
    db.settings = { data: null, error: { message: "connection reset" } };
    const { canUseRuntime } = await import("@/utils/notebookRuntime/config.server");
    // Before R249 this resolved true: require_grant ?? false.
    await expect(canUseRuntime("no-grant")).rejects.toThrow(
      /Could not read the developer runtime settings/,
    );
  });

  it("still uses the defaults for a fresh install, where there is no row at all", async () => {
    db.settings = { data: null, error: null };
    const { getRuntimeSettings } = await import("@/utils/notebookRuntime/config.server");
    const s = await getRuntimeSettings();
    expect(s.requireGrant).toBe(false);
    expect(s.idleTtlMinutes).toBe(30);
  });

  it("keeps the operator's idle TTL rather than a default the reaper would apply", async () => {
    const { getRuntimeSettings } = await import("@/utils/notebookRuntime/config.server");
    expect((await getRuntimeSettings()).idleTtlMinutes).toBe(240);
  });
});

describe("the reaper and the egress file", () => {
  const svc = readFileSync("src/utils/notebookRuntime/service.server.ts", "utf8");
  const idle = svc.slice(svc.indexOf("async function idleServiceSessions"));
  const idleBody = idle.slice(0, idle.indexOf("\n}\n"));

  it("reaps no MCP server on a pass whose apps read failed", () => {
    // The rule that made every app an orphan is still there, and must stay
    // BEHIND the error check.
    const check = idleBody.indexOf("if (appsErr) {");
    const orphan = idleBody.indexOf("if (!app) return true;");
    expect(check).toBeGreaterThan(-1);
    expect(orphan).toBeGreaterThan(check);
    expect(idleBody.slice(check, orphan)).toMatch(/if \(appsErr\) \{[\s\S]*?return \[\];/);
  });

  it("reaps nothing from a sessions list it could not read", () => {
    // The sessions read's own check, before the apps read is even made.
    const sessionsCheck = idleBody.indexOf("if (error) {");
    expect(sessionsCheck).toBeGreaterThan(-1);
    expect(sessionsCheck).toBeLessThan(idleBody.indexOf('.from("mcp_apps")'));
    expect(idleBody.slice(sessionsCheck)).toMatch(/^if \(error\) \{[\s\S]*?return \[\];/);
    const reap = svc.slice(svc.indexOf("export async function reapSessions"));
    expect(reap).toContain("{ data: idle, error: idleErr }, { data: expired, error: expiredErr }");
  });

  it("leaves the egress file alone when the saved list cannot be read", () => {
    const eg = readFileSync("src/utils/notebookRuntime/egressApply.server.ts", "utf8");
    const fn = eg.slice(eg.indexOf("export async function ensurePlatformEgress"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const check = body.indexOf("if (error) {");
    expect(check).toBeGreaterThan(-1);
    // The refusal comes before anything is written.
    expect(check).toBeLessThan(body.indexOf("return applyEgressAllowlist(stored);"));
    expect(body.slice(check)).toMatch(
      /applied: false,\s*reason: `The egress allowlist was left as it is/,
    );
  });
});
