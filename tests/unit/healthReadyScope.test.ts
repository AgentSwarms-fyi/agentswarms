// R463: a load balancer whose health decides REPLACEMENT (ECS with a target
// group) must not fail every node during a database failover. `?scope=local`
// leaves the database out; both scopes answer 503 while the process drains.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dbHealthy = true;
let dbTouched = 0;

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => {
        dbTouched++;
        return Promise.resolve(
          dbHealthy ? { error: null } : { error: { message: "connection refused" } },
        );
      },
    }),
  },
}));
vi.mock("@/utils/providers/crypto.server", () => ({
  keyringReady: async () => ({ ok: true }),
}));

const { Route } = await import("@/routes/api/health.ready");
const DRAINING = Symbol.for("agentswarms.draining");
type Handlers = {
  GET: (a: { request: Request }) => Promise<Response>;
  HEAD: (a: { request: Request }) => Promise<Response>;
};
const handlers = (Route.options as unknown as { server: { handlers: Handlers } }).server.handlers;
const get = (q = "") => handlers.GET({ request: new Request(`http://x/api/health/ready${q}`) });
const head = (q = "") => handlers.HEAD({ request: new Request(`http://x/api/health/ready${q}`) });

beforeEach(() => {
  dbHealthy = true;
  dbTouched = 0;
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[DRAINING];
  delete process.env.APP_ROLE;
});

describe("readiness during a database failover", () => {
  it("the full check reports the database, as before", async () => {
    dbHealthy = false;
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      checks: { db: false, keys: true },
    });
  });

  it("?scope=local stays ready and never touches the database", async () => {
    dbHealthy = false;
    const res = await get("?scope=local");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", scope: "local", checks: { keys: true } });
    expect((await head("?scope=local")).status).toBe(200);
    expect(dbTouched).toBe(0);
  });
});

describe("while draining", () => {
  it("both scopes answer 503, so a balancer stops sending new work", async () => {
    (globalThis as Record<symbol, unknown>)[DRAINING] = true;
    for (const q of ["", "?scope=local"]) {
      const res = await get(q);
      expect(res.status).toBe(503);
      expect((await res.json()).reason).toMatch(/draining/);
      expect((await head(q)).status).toBe(503);
    }
    expect(dbTouched).toBe(0);
  });
});

describe("an analytics node", () => {
  it("declines traffic in both scopes without probing the database", async () => {
    process.env.APP_ROLE = "analytics";
    expect((await get()).status).toBe(503);
    expect((await get("?scope=local")).status).toBe(503);
    expect((await head()).status).toBe(503);
    expect(dbTouched).toBe(0);
  });
});
