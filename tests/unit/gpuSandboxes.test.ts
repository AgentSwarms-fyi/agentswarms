// GPU sandboxes (R537): what each backend is asked for, and what it says when
// it cannot give one.
//
// Nothing here has a GPU. What a real GPU node does is driven on AWS
// (docs/deploy/AWS.md, "GPU training"); this pins every part the app owns:
// the Job a GPU trainer becomes, how a Job waiting for a GPU node reports
// itself, the sentence Docker's refusal becomes, and the fields that carry a
// sandbox's GPU from the start of a job to its version.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const SA = "/var/run/secrets/kubernetes.io/serviceaccount/";
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const p = String(path);
    if (p === `${SA}namespace`) return "agentswarms";
    if (p.startsWith(SA)) return "sa-token";
    return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

import { K8sOrchestrator, unschedulableMessage } from "@/utils/notebookRuntime/k8s.server";
import { dockerGpuProblem } from "@/utils/notebookRuntime/docker.server";
import type { KernelSpec } from "@/utils/notebookRuntime/orchestrator";
import { mlJobStashOf } from "@/utils/ml/types";

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const saved = { ...process.env };

beforeEach(() => {
  process.env.NOTEBOOK_K8S_NAMESPACE = "agentswarms-sandboxes";
  process.env.NOTEBOOK_K8S_NODE_SELECTOR = '{"agentswarms.io/pool":"sandboxes"}';
  process.env.NOTEBOOK_K8S_TOLERATIONS =
    '[{"key":"agentswarms.io/sandbox","operator":"Exists","effect":"NoSchedule"}]';
  process.env.NOTEBOOK_K8S_GPU_NODE_SELECTOR = '{"agentswarms.io/pool":"gpu"}';
  process.env.NOTEBOOK_K8S_GPU_TOLERATIONS =
    '[{"key":"nvidia.com/gpu","operator":"Exists","effect":"NoSchedule"}]';
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

const spec = (over: Partial<KernelSpec> = {}): KernelSpec => ({
  sessionId: "6f0d3c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f",
  userId: "u1",
  kind: "batch",
  image: "ghcr.io/agentswarms-fyi/notebook-runtime:1.8.0",
  cpuLimit: "2",
  memLimitMb: 8192,
  timeoutSeconds: 3600,
  env: {},
  ...over,
});

function capture() {
  const bodies: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 201 });
    }),
  );
  return bodies;
}

type PodSpec = {
  nodeSelector?: Record<string, string>;
  tolerations?: { key: string }[];
  containers: { resources: { limits: Record<string, string> } }[];
};

describe("the Job a GPU trainer becomes (k8s)", () => {
  it("asks for nvidia.com/gpu and goes to the GPU pool, tolerating both taints", async () => {
    const sent = capture();
    await new K8sOrchestrator().create(spec({ gpus: 1 }));
    const pod = (sent[0].body as { spec: { template: { spec: PodSpec } } }).spec.template.spec;
    expect(sent[0].url).toContain("/apis/batch/v1/namespaces/agentswarms-sandboxes/jobs");
    expect(pod.containers[0].resources.limits["nvidia.com/gpu"]).toBe("1");
    // One selector: the GPU pool's. Two pools' labels together match no node.
    expect(pod.nodeSelector).toEqual({ "agentswarms.io/pool": "gpu" });
    expect(pod.tolerations?.map((t) => t.key).sort()).toEqual([
      "agentswarms.io/sandbox",
      "nvidia.com/gpu",
    ]);
  });

  it("leaves a CPU sandbox on the sandbox pool, with no GPU and no GPU toleration", async () => {
    const sent = capture();
    await new K8sOrchestrator().create(spec());
    const pod = (sent[0].body as { spec: { template: { spec: PodSpec } } }).spec.template.spec;
    expect(pod.containers[0].resources.limits["nvidia.com/gpu"]).toBeUndefined();
    expect(pod.nodeSelector).toEqual({ "agentswarms.io/pool": "sandboxes" });
    expect(pod.tolerations?.map((t) => t.key)).toEqual(["agentswarms.io/sandbox"]);
  });
});

describe("a Job waiting for a GPU node says so (k8s)", () => {
  const unschedulable = {
    items: [
      {
        status: {
          phase: "Pending",
          conditions: [
            {
              type: "PodScheduled",
              status: "False",
              reason: "Unschedulable",
              message:
                "0/3 nodes are available: 1 Insufficient nvidia.com/gpu, 2 node(s) had untolerated taint {agentswarms.io/pool: app}.",
            },
          ],
        },
      },
    ],
  };

  function cluster(job: unknown, pods: unknown) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.includes("/pods?") ? pods : job;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    return urls;
  }

  it("running, with the scheduler's reason, while its pod waits for a GPU", async () => {
    const urls = cluster({ status: { active: 1 } }, unschedulable);
    const st = await new K8sOrchestrator().status("job/nb-6f0d3c1e", "batch");
    expect(st.state).toBe("running");
    expect(st.message).toContain("Waiting for a node with a free GPU");
    expect(st.message).toContain("1 Insufficient nvidia.com/gpu");
    expect(st.message).toContain("GPU instance quota");
    expect(urls[1]).toContain(encodeURIComponent("job-name=nb-6f0d3c1e"));
  });

  it("plain running once its pod is up, without asking about pods at all", async () => {
    const urls = cluster({ status: { active: 1, ready: 1 } }, unschedulable);
    const st = await new K8sOrchestrator().status("job/nb-6f0d3c1e", "batch");
    expect(st).toEqual({ state: "running" });
    expect(urls).toHaveLength(1);
  });

  it("plain running while its pod is merely pulling the image", async () => {
    cluster(
      { status: { active: 1 } },
      { items: [{ status: { phase: "Pending", conditions: [] } }] },
    );
    expect(await new K8sOrchestrator().status("job/nb-6f0d3c1e", "batch")).toEqual({
      state: "running",
    });
  });

  it("keeps the old sentence for a pod waiting for anything but a GPU", () => {
    const m = unschedulableMessage("0/2 nodes are available: 2 Insufficient memory.");
    expect(m).toContain(
      "Waiting for room in the cluster: 0/2 nodes are available: 2 Insufficient memory.",
    );
    expect(m).not.toContain("GPU");
  });

  it("is carried to the session's pending reason and the job's log", () => {
    const service = src("src/utils/notebookRuntime/service.server.ts");
    const running = service.slice(service.indexOf('if (st.state === "running")'));
    expect(running.slice(0, running.indexOf("} else if"))).toContain(
      "patch.pending_reason = st.message ?? null;",
    );
    const train = src("src/utils/ml/train.server.ts");
    const refresh = train.slice(train.indexOf("export async function refreshMlJob"));
    expect(refresh).toContain("── waiting to start: ${fresh.pending_reason} ──");
  });
});

describe("Docker without an NVIDIA runtime", () => {
  it("turns its refusal into what to do, keeping Docker's own words", () => {
    const said = dockerGpuProblem(
      '{"message":"could not select device driver \\"nvidia\\" with capabilities: [[gpu]]"}',
      1,
    );
    expect(said).toContain("This Docker host cannot give a sandbox a GPU (it asked for 1)");
    expect(said).toContain("NVIDIA driver and Container Toolkit");
    // What to do is inside the 200 characters the Jobs table shows.
    expect(said!.slice(0, 200)).toContain("set Training GPUs to 0 in Admin → Developer runtime.");
    expect(said).toContain(
      'Docker said: could not select device driver "nvidia" with capabilities: [[gpu]]',
    );
    expect(
      dockerGpuProblem(
        "OCI runtime create failed: nvidia-container-cli: initialization error: nvml error: driver not loaded",
        2,
      ),
    ).toContain("(it asked for 2)");
  });

  it("leaves every other start failure alone", () => {
    expect(dockerGpuProblem('{"message":"No such image: nope"}', 1)).toBeNull();
    expect(src("src/utils/notebookRuntime/docker.server.ts")).toContain(
      "const gpu = spec.gpus ? dockerGpuProblem(detail, spec.gpus) : null;",
    );
  });
});

describe("a sandbox's GPU, from the job's start to its version", () => {
  it("survives the stash, which is rebuilt field by field", () => {
    const stash = mlJobStashOf({
      __ml_job: { job_id: "j1", shard: 1, shards: 3, gpus: 1, gpu_search: true },
    });
    expect(stash).toEqual({
      job_id: "j1",
      kind: "train",
      shard: 1,
      shards: 3,
      gpus: 1,
      gpu_search: true,
    });
    // Anything else is no GPU, never a guess.
    expect(mlJobStashOf({ __ml_job: { job_id: "j1", gpus: "1", gpu_search: "yes" } })).toEqual({
      job_id: "j1",
      kind: "train",
    });
    expect(mlJobStashOf({ __ml_job: { job_id: "j1", gpus: 0 } })).toEqual({
      job_id: "j1",
      kind: "train",
    });
  });

  it("lands on the version bounded, because it is the sandbox's own JSON", async () => {
    vi.resetModules();
    const { boundedGpu } = await import("@/utils/ml/train.server");
    const g = boundedGpu({
      requested: 1,
      seen: Array.from({ length: 40 }, () => ({
        name: "N".repeat(500),
        memory_mb: 23034,
        driver: "580.95.05",
      })),
      device: "cuda",
      note: "x".repeat(2000),
      used_by: ["xgboost", 7 as unknown as string],
    });
    expect(g.seen).toHaveLength(16);
    expect(g.seen[0].name).toHaveLength(80);
    expect(g.note).toHaveLength(400);
    expect(g.used_by).toEqual(["xgboost"]);
    expect(boundedGpu({ requested: -3, seen: [], device: "rocm" as "cuda" })).toEqual({
      requested: 0,
      seen: [],
      device: null,
    });
  });
});

describe("the Lineage card's GPU line", () => {
  it("names the GPU and what trained on it, or why none could be used", async () => {
    const { gpuLine, gpuReportOf } = await import("@/lib/mlGpu");
    const used = gpuReportOf({
      gpu: {
        requested: 1,
        seen: [{ name: "NVIDIA L4", memory_mb: 23034, driver: "580.95.05" }],
        device: "cuda",
        used_by: ["xgboost"],
      },
    });
    expect(gpuLine(used!)).toBe("1× NVIDIA L4 (22 GiB); xgboost trained on it");
    const unusable = gpuReportOf({
      gpu: {
        requested: 1,
        seen: [],
        device: null,
        note: "nvidia-smi is not in the sandbox, so no NVIDIA driver was mounted into it",
      },
    });
    expect(gpuLine(unusable!)).toBe(
      "1 requested but not usable (nvidia-smi is not in the sandbox, so no NVIDIA driver was mounted into it); trained on the CPU",
    );
    // No GPU asked for and none seen: no line at all.
    expect(gpuReportOf({ gpu: { requested: 0, seen: [] } })).toBeNull();
    expect(gpuReportOf({ runtime: {} })).toBeNull();
    expect(gpuReportOf({ gpu: "cuda" })).toBeNull();
  });
});
