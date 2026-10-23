// A warm scorer asking for its model's artifact (R310).
//
// FOUND IN R310. R231 moved every ML sandbox's artifact download onto a URL
// the app signs, asked for with {"part":"lake_artifact"}. The batch branch of
// /api/notebook/runtime/source serves that part; the warm scorer's branch
// never read the part and answered every call with its bundle, so the scorer
// read a "url" the answer did not have. Driven: Deploy on a model's warm
// endpoint failed, every time, with "KeyError: 'url'".
//
// The route's own POST handler runs here, with the session store, the token
// and the lake gateway stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ artifact: [] as unknown[], bundle: 0 }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/utils/notebookRuntime/token.server", () => ({
  verifySessionToken: async () => ({ sid: "session-1", sub: "user-1" }),
}));
const manifest = { artifacts: { get: ["models/m1/v1.joblib"] } };
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const b = {
        select: () => b,
        update: () => b,
        eq: () => b,
        maybeSingle: async () => ({
          data: {
            notebook_id: null,
            mcp_app_id: null,
            etl_run_id: null,
            entrypoint: null,
            inputs: { __ml_score: { model_id: "m1", version_id: "v1" }, __lake: manifest },
          },
          error: null,
        }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
      };
      return b;
    },
  },
}));
vi.mock("@/utils/ml/serve.server", () => ({
  mlScoreStashOf: (inputs: { __ml_score?: unknown } | null) => inputs?.__ml_score ?? null,
  mlScoreBundleFor: async () => {
    calls.bundle++;
    return { program: "print('score')", config: {}, lake: manifest };
  },
}));
vi.mock("@/utils/lakehouse/sandboxLake.server", () => ({
  lakeManifestOf: (inputs: { __lake?: unknown } | null) => inputs?.__lake ?? null,
  lakeArtifact: (args: unknown) => {
    calls.artifact.push(args);
    return { url: "https://minio.test/models/m1/v1.joblib?signed" };
  },
}));

const { Route } = await import("@/routes/api/notebook.runtime.source");
const post = (
  Route as unknown as {
    options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } };
  }
).options.server.handlers.POST;

const ask = (body: unknown) =>
  post({
    request: new Request("http://app.test/api/notebook/runtime/source", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  });

beforeEach(() => {
  calls.artifact = [];
  calls.bundle = 0;
});

describe("a warm scorer's session", () => {
  it("gets a signed URL for its model's artifact", async () => {
    const res = await ask({
      part: "lake_artifact",
      which: "get",
      uri: "s3://lake/models/m1/v1.joblib",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://minio.test/models/m1/v1.joblib?signed" });
    expect(calls.artifact).toEqual([
      { manifest, which: "get", uri: "s3://lake/models/m1/v1.joblib" },
    ]);
    expect(calls.bundle).toBe(0);
  });

  it("may not ask to write one", async () => {
    const res = await ask({
      part: "lake_artifact",
      which: "put",
      uri: "s3://lake/models/m1/v1.joblib",
    });
    expect(res.status).toBe(403);
    expect(calls.artifact).toEqual([]);
  });

  it("still gets its bundle when it asks for nothing in particular", async () => {
    const res = await ask(undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ program: "print('score')", config: {} });
    expect(calls.bundle).toBe(1);
  });
});
