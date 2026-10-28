// Only the operator's cron or a superadmin can refresh the Model Registry.
//
// VA-2026-10-25-19. POST /api/public/hooks/refresh-model-registry took any
// request — no auth, no throttle — and each one fetched the AIMLAPI catalogue
// and upserted or deleted every registry row. It now answers BI_CRON_TOKEN (the
// bearer /api/bi/cron takes, compared in constant time) or a superadmin's
// session, at most MODEL_REGISTRY_SYNC_PER_MIN times a minute. The GET probe
// stays public and starts nothing.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  superadmin: { ok: false, error: "Superadmin only" } as { ok: boolean; error?: string },
  limited: false,
  limiterCalls: [] as [string, number][],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/utils/modelRegistry.server", () => ({
  syncModelRegistryFromAimlapi: vi.fn(async () => ({ ok: true, upserted: 3, removed: 0 })),
}));
vi.mock("@/utils/iam.server", () => ({
  requireSuperadmin: vi.fn(async () => state.superadmin),
}));
vi.mock("@/utils/rateLimit.server", () => ({
  envInt: (name: string, fallback: number) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  },
  rateLimitedGlobal: vi.fn(async (bucket: string, max: number) => {
    state.limiterCalls.push([bucket, max]);
    return state.limited;
  }),
}));

import { requireSuperadmin } from "@/utils/iam.server";
import { syncModelRegistryFromAimlapi } from "@/utils/modelRegistry.server";

type Handler = (a: { request: Request }) => Promise<Response>;
let POST: Handler;
let GET: () => Promise<Response>;
beforeAll(async () => {
  const { Route } =
    (await import("@/routes/api/public/hooks/refresh-model-registry")) as unknown as {
      Route: { options: { server: { handlers: { POST: Handler; GET: () => Promise<Response> } } } };
    };
  ({ POST, GET } = Route.options.server.handlers);
}, 120_000);

const CRON = "cron-token-for-tests-0123456789";
const post = (bearer?: string) =>
  POST({
    request: new Request("http://app.test/api/public/hooks/refresh-model-registry", {
      method: "POST",
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }),
  });

beforeEach(() => {
  vi.stubEnv("BI_CRON_TOKEN", CRON);
  vi.stubEnv("MODEL_REGISTRY_SYNC_PER_MIN", "");
  state.superadmin = { ok: false, error: "Superadmin only" };
  state.limited = false;
  state.limiterCalls = [];
  vi.mocked(syncModelRegistryFromAimlapi).mockClear();
  vi.mocked(requireSuperadmin).mockClear();
});

describe("who may refresh the registry", () => {
  it("nobody without a bearer — 401, nothing fetched", async () => {
    expect((await post()).status).toBe(401);
    expect(syncModelRegistryFromAimlapi).not.toHaveBeenCalled();
  });

  it("not a signed-in user who is not a superadmin, nor a made-up bearer — 403", async () => {
    const res = await post("some-users-session-token");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Only the operator's cron or a superadmin can refresh the model registry",
    });
    expect(requireSuperadmin).toHaveBeenCalledWith("some-users-session-token");
    expect(syncModelRegistryFromAimlapi).not.toHaveBeenCalled();
  });

  it("not a near miss of the cron token", async () => {
    expect((await post(CRON.slice(0, -1) + "x")).status).toBe(403);
    expect(syncModelRegistryFromAimlapi).not.toHaveBeenCalled();
  });

  it("the operator's cron, by BI_CRON_TOKEN — without a session lookup", async () => {
    const res = await post(CRON);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, upserted: 3, removed: 0 });
    expect(requireSuperadmin).not.toHaveBeenCalled();
    expect(syncModelRegistryFromAimlapi).toHaveBeenCalledTimes(1);
  });

  it("a superadmin's session", async () => {
    state.superadmin = { ok: true };
    expect((await post("superadmin-session")).status).toBe(200);
    expect(syncModelRegistryFromAimlapi).toHaveBeenCalledTimes(1);
  });

  it("no cron token set means no cron access — a guess is just a session", async () => {
    vi.stubEnv("BI_CRON_TOKEN", "");
    expect((await post(CRON)).status).toBe(403);
    expect(syncModelRegistryFromAimlapi).not.toHaveBeenCalled();
  });
});

describe("how often", () => {
  it("at most MODEL_REGISTRY_SYNC_PER_MIN a minute (default 2); then 429 and nothing fetched", async () => {
    await post(CRON);
    expect(state.limiterCalls).toEqual([["model-registry-sync", 2]]);
    vi.stubEnv("MODEL_REGISTRY_SYNC_PER_MIN", "5");
    state.limited = true;
    const res = await post(CRON);
    expect(res.status).toBe(429);
    expect(state.limiterCalls[1]).toEqual(["model-registry-sync", 5]);
    expect(syncModelRegistryFromAimlapi).toHaveBeenCalledTimes(1);
  });

  it("the throttle is asked only after the caller is allowed", async () => {
    await post("some-users-session-token");
    expect(state.limiterCalls).toEqual([]);
  });
});

describe("the probe", () => {
  it("GET stays public and starts nothing", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(syncModelRegistryFromAimlapi).not.toHaveBeenCalled();
  });
});
