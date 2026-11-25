// An MLflow tracking server as a connection (R534): where its credential may
// go, that the database takes the type, what its test says, and that only the
// model's owner can send a model to one.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  answer: (_path: string): { status: number; body: string } => ({ status: 200, body: "{}" }),
  urls: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/ssrfGuard.server", () => ({
  safeFetch: async (url: string) => {
    fake.urls.push(url);
    const u = new URL(url);
    const a = fake.answer(u.pathname);
    return new Response(a.body, { status: a.status });
  },
  providerFetch: async () => new Response("{}"),
  withPrivatePathScope: async (fn: (p: unknown) => unknown) => fn({}),
  PrivatePathRequiredError: class extends Error {},
}));

const { integrationSecretFields, integrationShareableFields } =
  await import("@/utils/providers/integrationConfig.server");
const { integrationHosts } = await import("@/utils/providers/integrationHosts");
const { testMlflowCore } = await import("@/utils/integrations/testAdapters.server");

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  fake.urls = [];
});

describe("the MLflow connection type", () => {
  it("keeps its token and password encrypted, and sends them only to the tracking URL", () => {
    expect(integrationSecretFields("mlflow")).toEqual(["token", "password"]);
    // A secret shared with the owner may fill either: both are credentials
    // sent to a server, neither names the server.
    expect(integrationShareableFields("mlflow")).toEqual(["token", "password"]);
    expect(integrationHosts("mlflow")({ tracking_uri: "https://mlflow.example.com" })).toEqual([
      "https://mlflow.example.com",
    ]);
    expect(integrationHosts("mlflow")({})).toBeUndefined();
  });

  it("is a type the database takes, beside every type it already took", () => {
    // The CHECK is REPLACED by each migration that changes it, so the newest
    // one must list every type the app writes.
    const dir = join(process.cwd(), "supabase/migrations");
    // Newest first, stopping at the first that sets it: reading all ~300
    // migrations timed this test out on a loaded machine.
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse()
      .find((f) =>
        /ADD CONSTRAINT integrations_type_check/.test(readFileSync(join(dir, f), "utf8")),
      )!;
    const sql = readFileSync(join(dir, newest), "utf8");
    const listed = /CHECK \(type IN \(([^)]*)\)\)/
      .exec(sql)![1]
      .match(/'([a-z0-9_]+)'/g)!
      .map((s) => s.slice(1, -1));
    for (const t of ["llm_provider", "llm_gateway", "n8n", "firecrawl", "notification", "mlflow"]) {
      expect(listed, `${newest} lists ${t}`).toContain(t);
    }
  });
});

describe("Test connection", () => {
  it("says the server's version and whether it stores artifacts itself", async () => {
    fake.answer = (p) =>
      p === "/version"
        ? { status: 200, body: "3.18.0" }
        : {
            status: 200,
            body: p.includes("mlflow-artifacts") ? '{"files":[]}' : '{"experiments":[]}',
          };
    const out = await testMlflowCore({
      tracking_uri: "http://mlflow:5000/",
      auth: "token",
      token: "test-key-1",
    });
    expect(out).toMatchObject({ ok: true, version: "3.18.0", artifacts: true });
    expect(out.detail).toMatch(
      /Reached MLflow 3\.18\.0 at http:\/\/mlflow:5000\. It stores artifacts itself/,
    );
  });

  it("says when versions can be sent as runs only", async () => {
    fake.answer = (p) =>
      p.includes("mlflow-artifacts")
        ? { status: 503, body: '{"error_code":"ENDPOINT_NOT_FOUND"}' }
        : { status: 200, body: "{}" };
    const out = await testMlflowCore({ tracking_uri: "http://mlflow:5000" });
    expect(out).toMatchObject({ ok: true, artifacts: false });
    expect(out.detail).toMatch(/does not serve artifacts/);
  });

  it("says, in words, why it could not connect", async () => {
    fake.answer = () => ({ status: 401, body: "{}" });
    expect((await testMlflowCore({ tracking_uri: "http://mlflow:5000" })).detail).toMatch(
      /refused the credentials/,
    );
    fake.answer = () => ({ status: 404, body: "<html>not found</html>" });
    expect((await testMlflowCore({ tracking_uri: "http://mlflow:5000/nope" })).detail).toMatch(
      /does not answer MLflow's API/,
    );
  });

  it("names what went wrong when nothing answers, not 'fetch failed'", async () => {
    // Found in the UI test, with the server stopped: the version said only
    // "Could not reach the MLflow server: fetch failed".
    const failing = (code: string) => () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
    };
    fake.answer = failing("ECONNREFUSED");
    expect((await testMlflowCore({ tracking_uri: "http://mlflow:5000" })).detail).toBe(
      "Nothing is answering at mlflow:5000: the MLflow server is not running there.",
    );
    fake.answer = failing("ENOTFOUND");
    expect((await testMlflowCore({ tracking_uri: "http://mlflow:5000" })).detail).toMatch(
      /mlflow:5000 does not resolve from this server/,
    );
    fake.answer = failing("UND_ERR_CONNECT_TIMEOUT");
    expect((await testMlflowCore({ tracking_uri: "http://mlflow:5000" })).detail).toMatch(
      /cannot be reached from this server \(UND_ERR_CONNECT_TIMEOUT\)/,
    );
  });

  it("refuses an address with credentials in it before calling anything", async () => {
    const out = await testMlflowCore({ tracking_uri: "https://ann:pw@mlflow.example.com" });
    expect(out.ok).toBe(false);
    expect(fake.urls).toEqual([]);
  });
});

describe("who can send a model to MLflow", () => {
  const fns = read("src/utils/mlTracking.functions.ts");

  it("is the model's owner, with one of their own MLflow connections", () => {
    expect(fns).toContain("if (model.user_id !== userId)");
    // The connection id comes from the page: it must be the caller's, and an MLflow one.
    expect(fns).toMatch(
      /\.eq\("id", next\.integration_id\)\s*\.eq\("user_id", userId\)\s*\.eq\("type", "mlflow"\)/,
    );
  });

  it("is sent from the app after training and after a promotion, never from model code", () => {
    expect(read("src/utils/ml/train.server.ts")).toContain("m.afterVersionReady(versionId)");
    expect(read("src/utils/ml/promote.server.ts")).toContain("m.afterPromotion(model.id)");
    // The training sandbox gets no MLflow credential.
    expect(read("src/utils/ml/pyTrain.ts")).not.toMatch(/MLFLOW_TRACKING_TOKEN|mlflow_token/);
  });
});
