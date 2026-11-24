// The KServe client (R532) at the HTTP level: what the app sends the API
// server, and what it makes of the answers. The API server is a stub that
// records every call; the kind rig (deploy/kind/kserve) drives a real one.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/notebookRuntime/sandboxAuth.server", () => ({
  sandboxToken: async (id: string) => `test-port-token-for-${id}`,
}));

const dir = mkdtempSync(path.join(tmpdir(), "kserve-sa-"));
writeFileSync(path.join(dir, "token"), "test-sa-token\n");
const saved = { ...process.env };
process.env.KUBERNETES_API_URL = "https://k8s.test:6443/";
process.env.KUBERNETES_TOKEN_FILE = path.join(dir, "token");
afterAll(() => {
  process.env = saved;
});

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
const calls: Call[] = [];
let answer: (c: Call) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });

vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
  const c: Call = {
    method: init.method ?? "GET",
    url,
    headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
    body: typeof init.body === "string" ? JSON.parse(init.body) : null,
  };
  calls.push(c);
  const a = answer(c);
  return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
});

const k = await import("@/utils/ml/kserve.server");
const { kserveConfigFrom, INSTALL_LABEL } = await import("@/lib/kserve");
const config = kserveConfigFrom({
  ML_SERVING_BACKEND: "kserve",
  KSERVE_SCORER_IMAGE: "scorer:1",
  KSERVE_NAMESPACE: "serving",
  KSERVE_APP_URL: "http://app.test",
}).config;

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ status: 200, body: {} });
});

describe("applying an endpoint", () => {
  const args = {
    config,
    name: "ml-0123456789abcdef0123",
    minReplicas: 1,
    maxReplicas: 3,
    labels: { "agentswarms.dev/role": "primary" },
  };

  it("applies the token Secret, then the InferenceService, server-side, as the app", async () => {
    expect(await k.applyInferenceService(args)).toBe(null);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["PATCH", "/api/v1/namespaces/serving/secrets/ml-0123456789abcdef0123-token"],
      [
        "PATCH",
        "/apis/serving.kserve.io/v1beta1/namespaces/serving/inferenceservices/ml-0123456789abcdef0123",
      ],
    ]);
    for (const c of calls) {
      expect(c.url.startsWith("https://k8s.test:6443/")).toBe(true);
      expect(new URL(c.url).search).toBe("?fieldManager=agentswarms&force=true");
      expect(c.headers["Content-Type"]).toBe("application/apply-patch+yaml");
      expect(c.headers.Authorization).toBe("Bearer test-sa-token");
    }
    type Obj = {
      stringData: { token: string };
      metadata: { labels: Record<string, string> };
      spec: { predictor: Record<string, unknown> };
    };
    const [secret, isvc] = calls.map((c) => c.body as Obj);
    expect(secret.stringData.token).toBe(
      "test-port-token-for-kserve:serving/ml-0123456789abcdef0123",
    );
    // The token is in the Secret alone, never in the InferenceService.
    expect(JSON.stringify(isvc)).not.toContain(secret.stringData.token);
    // This installation's label on both, from its secret, not the secret itself.
    const install = (await k.installLabel()) as string;
    expect(install).toHaveLength(16);
    expect(secret.metadata.labels[INSTALL_LABEL]).toBe(install);
    expect(isvc.metadata.labels[INSTALL_LABEL]).toBe(install);
    expect(isvc.spec.predictor).toMatchObject({ minReplicas: 1, maxReplicas: 3 });
  });

  it("says when the cluster has no KServe, or the app may not use it", async () => {
    answer = (c) =>
      c.url.includes("inferenceservices")
        ? { status: 404, body: { message: "the server could not find the requested resource" } }
        : { status: 200, body: {} };
    expect(await k.applyInferenceService(args)).toMatch(/This cluster has no KServe/);

    answer = () => ({ status: 403, body: { message: 'secrets "x" is forbidden' } });
    expect(await k.applyInferenceService(args)).toMatch(
      /may not manage Secrets in the namespace serving/,
    );
  });

  it("changes only the pod range on a resize", async () => {
    expect(
      await k.resizeInferenceService({ config, ns: "serving", name: "ml-x", min: 0, max: 5 }),
    ).toBe(null);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].headers["Content-Type"]).toBe("application/merge-patch+json");
    // Standard mode cannot hold zero pods.
    expect(calls[0].body).toEqual({ spec: { predictor: { minReplicas: 1, maxReplicas: 5 } } });
  });
});

describe("reaching a predictor", () => {
  it("goes to the in-cluster Service directly, with the token in its own header", async () => {
    expect(k.predictorEndpoint(config, "ml-x")).toBe(
      "http://ml-x-predictor.serving.svc.cluster.local",
    );
    expect(await k.predictorHeaders("serving", "ml-x", config)).toEqual({
      "X-Port-Token": "test-port-token-for-kserve:serving/ml-x",
    });
  });

  it("through the API server, carries the app's own credential for the API server", async () => {
    const via = { ...config, access: "apiserver" as const };
    expect(k.predictorEndpoint(via, "ml-x")).toBe(
      "https://k8s.test:6443/api/v1/namespaces/serving/services/ml-x-predictor:80/proxy",
    );
    expect(await k.predictorHeaders("serving", "ml-x", via)).toEqual({
      "X-Port-Token": "test-port-token-for-kserve:serving/ml-x",
      Authorization: "Bearer test-sa-token",
    });
  });
});

describe("reading and removing", () => {
  it("reads state and pods, and an absent one as absent", async () => {
    answer = (c) =>
      c.url.includes("/pods?")
        ? {
            status: 200,
            body: {
              items: [
                { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
                { status: { phase: "Running", conditions: [{ type: "Ready", status: "False" }] } },
              ],
            },
          }
        : { status: 200, body: { status: { conditions: [{ type: "Ready", status: "True" }] } } };
    expect(await k.readInferenceService("serving", "ml-x")).toEqual({
      exists: true,
      ready: true,
      reason: null,
      url: null,
      pods: { ready: 1, total: 2, reason: null },
    });
    expect(decodeURIComponent(calls[1].url)).toContain(
      "labelSelector=serving.kserve.io/inferenceservice=ml-x",
    );

    answer = () => ({ status: 404, body: {} });
    expect(await k.readInferenceService("serving", "ml-x")).toEqual({ exists: false });
  });

  it("deletes in the foreground and waits until it is gone", async () => {
    let gets = 0;
    answer = (c) => {
      if (c.method === "GET") return ++gets < 3 ? { status: 200, body: {} } : { status: 404 };
      return { status: 200, body: {} };
    };
    expect(await k.deleteInferenceService("serving", "ml-x", 10_000)).toBe(null);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      body: { kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Foreground" },
    });
    expect(new URL(calls[1].url).pathname).toBe("/api/v1/namespaces/serving/secrets/ml-x-token");
    expect(gets).toBe(3);
  });

  it("says when it could not delete, and when the object outlives the wait", async () => {
    answer = () => ({ status: 403, body: { message: "forbidden" } });
    expect(await k.deleteInferenceService("serving", "ml-x", 0)).toMatch(/Could not delete/);
    answer = () => ({ status: 200, body: {} });
    expect(await k.deleteInferenceService("serving", "ml-x", 0)).toMatch(/still being removed/);
  });

  it("lists only what this installation made", async () => {
    answer = () => ({
      status: 200,
      body: { items: [{ metadata: { name: "ml-a", creationTimestamp: "2026-11-24T00:00:00Z" } }] },
    });
    expect(await k.listManagedInferenceServices("serving")).toEqual([
      { name: "ml-a", createdAt: "2026-11-24T00:00:00Z" },
    ]);
    expect(decodeURIComponent(calls[0].url)).toContain(
      `labelSelector=app.kubernetes.io/managed-by=agentswarms,${INSTALL_LABEL}=${await k.installLabel()}`,
    );
  });
});

describe("the scorer's own words", () => {
  it("names the load failure from the pod's log", async () => {
    answer = (c) =>
      c.url.includes("/log?")
        ? {
            status: 200,
            body: undefined,
          }
        : { status: 200, body: { items: [{ metadata: { name: "ml-x-predictor-abc" } }] } };
    // A plain-text log body.
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/log?")) {
        return new Response(
          [
            "[score] listening on :8080",
            "[score] load failed: Traceback (most recent call last):",
            '  File "<ml_program>", line 1977, in _download_artifact',
            "RuntimeError: Artifact digest mismatch: the registry recorded aaa but the stored file hashes to bbb.",
            "",
          ].join("\n"),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ items: [{ metadata: { name: "ml-x-predictor-abc" } }] }),
        {
          status: 200,
        },
      );
    });
    expect(await k.predictorLogLine("serving", "ml-x")).toBe(
      "[score] load failed: Traceback (most recent call last): RuntimeError: Artifact digest mismatch: the registry recorded aaa but the stored file hashes to bbb.",
    );
  });
});
