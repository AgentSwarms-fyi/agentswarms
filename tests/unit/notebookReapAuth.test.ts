// The notebook kernel reaper compares its cron bearer in constant time.
//
// VA-2026-10-25-20. /api/notebook/runtime/reap accepted NOTEBOOK_CRON_TOKEN (or
// BI_CRON_TOKEN) with `bearer === cronToken`, which returns at the first
// differing character. It now goes through staticCronCaller — the
// timingSafeEqual check /api/bi/cron uses — and still lets any signed-in user
// trigger a best-effort sweep.
import { readFileSync } from "node:fs";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })),
    },
  },
}));
vi.mock("@/utils/notebookRuntime/service.server", () => ({
  reapSessions: vi.fn(async () => 2),
}));

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reapSessions } from "@/utils/notebookRuntime/service.server";

type Handler = (a: { request: Request }) => Promise<Response>;
let POST: Handler;
beforeAll(async () => {
  const { Route } = (await import("@/routes/api/notebook.runtime.reap")) as unknown as {
    Route: { options: { server: { handlers: { POST: Handler } } } };
  };
  POST = Route.options.server.handlers.POST;
}, 120_000);

const reap = (bearer?: string) =>
  POST({
    request: new Request("http://app.test/api/notebook/runtime/reap", {
      method: "POST",
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }),
  });

const TOKEN = "notebook-cron-token-0123456789";

beforeEach(() => {
  vi.stubEnv("NOTEBOOK_CRON_TOKEN", TOKEN);
  vi.stubEnv("BI_CRON_TOKEN", "");
  state.user = null;
  vi.mocked(reapSessions).mockClear();
  vi.mocked(supabaseAdmin.auth.getUser).mockClear();
});

describe("who may reap", () => {
  it("the cron token, without a session lookup", async () => {
    const res = await reap(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reaped: 2 });
    expect(supabaseAdmin.auth.getUser).not.toHaveBeenCalled();
  });

  it("not a near miss of it — that is looked up as a session, and refused", async () => {
    const res = await reap(TOKEN.slice(0, -1) + "x");
    expect(res.status).toBe(401);
    expect(reapSessions).not.toHaveBeenCalled();
  });

  it("BI_CRON_TOKEN when NOTEBOOK_CRON_TOKEN is not set", async () => {
    vi.stubEnv("NOTEBOOK_CRON_TOKEN", "");
    vi.stubEnv("BI_CRON_TOKEN", "bi-cron-token-0123456789");
    expect((await reap("bi-cron-token-0123456789")).status).toBe(200);
  });

  it("no cron access at all when neither token is set", async () => {
    vi.stubEnv("NOTEBOOK_CRON_TOKEN", "");
    expect((await reap(TOKEN)).status).toBe(401);
    expect(reapSessions).not.toHaveBeenCalled();
  });

  it("any signed-in user, for a best-effort sweep; nobody without a bearer", async () => {
    state.user = { id: "u1" };
    expect((await reap("a-users-session")).status).toBe(200);
    state.user = null;
    expect((await reap()).status).toBe(401);
  });

  it("compares through the constant-time helper, never with ===", () => {
    const src = readFileSync("src/routes/api/notebook.runtime.reap.ts", "utf8");
    expect(src).toMatch(/staticCronCaller\(bearer, \{ cronToken \}\) === "cron"/);
    expect(src).not.toMatch(/bearer\s*===\s*cronToken|cronToken\s*===\s*bearer/);
  });
});
