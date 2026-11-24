// Who /api/ml/serving answers (R532). A KServe predictor pod asks the app for
// its model; the pod runs the model's own code, so this is the boundary that
// keeps one endpoint from reading another's model. It answers the endpoint a
// pod proves it is, with that endpoint's token, for the model the LIVE copy
// naming that endpoint holds, and nothing a request names can widen that.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ replicas: [] as Row[], deployments: [] as Row[] }));

vi.mock("@/utils/notebookRuntime/sandboxAuth.server", () => ({
  sandboxToken: async (id: string) => `test-token-${id}`,
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const table = (rows: () => Row[]) => {
    const filters: ((r: Row) => boolean)[] = [];
    const run = () => rows().filter((r) => filters.every((f) => f(r)));
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      order: () => b,
      limit: (n: number) => Promise.resolve({ data: run().slice(0, n), error: null }),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
    };
    return b;
  };
  return {
    supabaseAdmin: {
      from: (t: string) =>
        table(() => (t === "ml_deployment_replicas" ? db.replicas : db.deployments)),
    },
  };
});

const { servingCaller } = await import("@/utils/ml/kserve.server");

const ask = (endpoint: string | null, token: string | null) => {
  const headers: Record<string, string> = {};
  if (endpoint !== null) headers["X-Endpoint"] = endpoint;
  if (token !== null) headers["X-Port-Token"] = token;
  return servingCaller(new Request("http://app.test/api/ml/serving/bundle", { headers }));
};
const A = "agentswarms-serving/ml-aaaaaaaaaaaaaaaaaaaa";
const B = "agentswarms-serving/ml-bbbbbbbbbbbbbbbbbbbb";

beforeEach(() => {
  db.deployments = [
    { id: "dep-a", model_id: "model-a" },
    { id: "dep-b", model_id: "model-b" },
  ];
  db.replicas = [
    {
      isvc_namespace: "agentswarms-serving",
      isvc_name: "ml-aaaaaaaaaaaaaaaaaaaa",
      status: "ready",
      user_id: "owner-a",
      version_id: "version-a3",
      deployment_id: "dep-a",
    },
    {
      isvc_namespace: "agentswarms-serving",
      isvc_name: "ml-bbbbbbbbbbbbbbbbbbbb",
      status: "ready",
      user_id: "owner-b",
      version_id: "version-b1",
      deployment_id: "dep-b",
    },
  ];
});

describe("a predictor asking for its model", () => {
  it("gets its own endpoint's model, as its owner", async () => {
    expect(await ask(A, `test-token-kserve:${A}`)).toEqual({
      ok: true,
      userId: "owner-a",
      modelId: "model-a",
      versionId: "version-a3",
      ns: "agentswarms-serving",
      name: "ml-aaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("cannot ask as another endpoint with its own token", async () => {
    // A's pod knows A's token, and names B.
    expect(await ask(B, `test-token-kserve:${A}`)).toMatchObject({ ok: false, status: 401 });
  });

  it("is refused without a token, with a near miss, or with no endpoint", async () => {
    expect(await ask(A, null)).toMatchObject({ ok: false, status: 401 });
    expect(await ask(A, `test-token-kserve:${A}x`)).toMatchObject({ ok: false, status: 401 });
    expect(await ask(null, `test-token-kserve:${A}`)).toMatchObject({ ok: false, status: 401 });
    expect(await ask("../ml-a", "t")).toMatchObject({ ok: false, status: 401 });
  });

  it("gets nothing once the endpoint is stopped", async () => {
    db.replicas[0].status = "stopped";
    expect(await ask(A, `test-token-kserve:${A}`)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the routes", () => {
  for (const f of [
    "src/routes/api/ml.serving.bundle.ts",
    "src/routes/api/ml.serving.artifact.ts",
  ]) {
    const src = readFileSync(f, "utf8");
    it(`${f.split("/").pop()} checks the caller first and takes nothing else from the request`, () => {
      const check = src.indexOf("await servingCaller(request)");
      expect(check).toBeGreaterThan(-1);
      expect(src.indexOf("if (!caller.ok)")).toBeGreaterThan(check);
      // The model comes from the caller check, never from the URL or a body.
      expect(src).not.toMatch(/searchParams|request\.json|request\.text|formData/);
      expect(src).toContain('"Cache-Control": "no-store"');
    });
  }
});
