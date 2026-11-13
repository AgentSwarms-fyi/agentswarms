// What the AWS deploys (deploy/aws, deploy/helm) need of the app (R479):
// sandboxes on a node pool of their own, and a lakehouse catalog whose
// password arrives apart from its address.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) =>
    String(path).startsWith("/var/run/secrets/kubernetes.io/serviceaccount/")
      ? "sa-token"
      : (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

import { K8sOrchestrator } from "@/utils/notebookRuntime/k8s.server";
import type { KernelSpec } from "@/utils/notebookRuntime/orchestrator";
import { catalogUrlToLibpq, catalogUrlWithPassword } from "@/utils/lakehouse/core.server";

const spec = (over: Partial<KernelSpec> = {}): KernelSpec => ({
  sessionId: "6f0d3c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f",
  userId: "u1",
  kind: "interactive",
  image: "ghcr.io/agentswarms-fyi/notebook-runtime:1.7.0",
  cpuLimit: "1",
  memLimitMb: 2048,
  timeoutSeconds: 3600,
  env: {},
  ...over,
});

describe("sandboxes on a node pool of their own (k8s backend)", () => {
  const saved = { ...process.env };
  let posted: { url: string; body: Record<string, unknown> }[];
  beforeEach(() => {
    posted = [];
    process.env.NOTEBOOK_K8S_NAMESPACE = "agentswarms-sandboxes";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ metadata: { name: "x" } }), { status: 201 });
      }),
    );
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  const podSpecOf = (b: Record<string, unknown>) =>
    ((b.kind === "Job" ? (b.spec as { template: { spec: unknown } }).template.spec : b.spec) ??
      {}) as { nodeSelector?: unknown; tolerations?: unknown };

  const pool = { "agentswarms.io/pool": "sandboxes" };
  const taint = [{ key: "agentswarms.io/sandbox", operator: "Exists", effect: "NoSchedule" }];

  it("places every sandbox, pod or Job, where the deploy says", async () => {
    process.env.NOTEBOOK_K8S_NODE_SELECTOR = JSON.stringify(pool);
    process.env.NOTEBOOK_K8S_TOLERATIONS = JSON.stringify(taint);
    const k8s = new K8sOrchestrator();
    await k8s.create(spec());
    await k8s.create(spec({ kind: "batch" }));
    for (const p of posted) {
      expect(podSpecOf(p.body).nodeSelector, p.url).toEqual(pool);
      expect(podSpecOf(p.body).tolerations, p.url).toEqual(taint);
    }
    expect(posted.map((p) => p.body.kind)).toEqual(["Pod", "Job"]);
  });

  it("sends a GPU sandbox to the GPU pool alone, tolerating both taints", async () => {
    process.env.NOTEBOOK_K8S_NODE_SELECTOR = JSON.stringify(pool);
    process.env.NOTEBOOK_K8S_TOLERATIONS = JSON.stringify(taint);
    const gpuPool = { "agentswarms.io/pool": "gpu" };
    const gpuTaint = [{ key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" }];
    process.env.NOTEBOOK_K8S_GPU_NODE_SELECTOR = JSON.stringify(gpuPool);
    process.env.NOTEBOOK_K8S_GPU_TOLERATIONS = JSON.stringify(gpuTaint);
    await new K8sOrchestrator().create(spec({ kind: "batch", gpus: 1 }));
    const s = podSpecOf(posted[0].body);
    expect(s.nodeSelector).toEqual(gpuPool);
    expect(s.tolerations).toEqual([...taint, ...gpuTaint]);
  });

  it("places nothing when nothing is set, as before", async () => {
    delete process.env.NOTEBOOK_K8S_NODE_SELECTOR;
    delete process.env.NOTEBOOK_K8S_TOLERATIONS;
    await new K8sOrchestrator().create(spec());
    const s = podSpecOf(posted[0].body);
    expect(s).not.toHaveProperty("nodeSelector");
    expect(s).not.toHaveProperty("tolerations");
  });
});

describe("the lakehouse catalog's password, apart from its address", () => {
  const url =
    "postgres://lakehouse@db.abc.us-east-1.rds.amazonaws.com:5432/lakehouse_catalog?sslmode=require";

  it("goes into a URL that has none, and comes out exactly", () => {
    const pw = "p@ss:w/rd%41 x";
    const joined = catalogUrlWithPassword(url, pw);
    expect(catalogUrlToLibpq(joined)).toContain(`password=${pw}`);
    expect(catalogUrlToLibpq(joined)).toContain("sslmode=require");
  });

  it("never replaces a password the URL has (Compose sets both)", () => {
    const withPw = "postgres://lakehouse:compose@lakehouse-catalog:5432/lakehouse_catalog";
    expect(catalogUrlWithPassword(withPw, "other")).toBe(withPw);
  });

  it("leaves the URL alone without a password, or when it is not a URL", () => {
    expect(catalogUrlWithPassword(url, undefined)).toBe(url);
    expect(catalogUrlWithPassword(url, "")).toBe(url);
    expect(catalogUrlWithPassword("not a url", "x")).toBe("not a url");
  });
});
