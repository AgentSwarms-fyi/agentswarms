// Kubernetes backend for the notebook runtime (production scale).
//
// One Pod per interactive session, one Job per batch job — so scale is
// horizontal and native (the scheduler places kernels across the node pool,
// bounded by the namespace ResourceQuota). Talks to the API server with the
// in-pod ServiceAccount; the deployment must set NODE_EXTRA_CA_CERTS to the SA
// ca.crt so global fetch trusts the cluster CA. RBAC for the SA is scoped to
// create/get/delete pods+jobs+logs in one namespace (see deploy/k8s/notebooks).
//
// Hardening (docs/DEVELOPER_WORKSPACE_RUNTIME.md §5.2): runAsNonRoot,
// readOnlyRootFilesystem, drop ALL caps, RuntimeDefault seccomp, resource
// limits, activeDeadlineSeconds, optional gVisor RuntimeClass. Egress is closed
// by a NetworkPolicy + the HTTP(S)_PROXY env injected by the caller.
import { readFileSync } from "node:fs";
import type { KernelKind, KernelSpec, KernelStatus, NotebookOrchestrator } from "./orchestrator";
import { sandboxName, sandboxServing } from "./orchestrator";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function saToken(): string {
  const t = readMaybe(`${SA_DIR}/token`);
  if (!t)
    throw new Error("Kubernetes ServiceAccount token not found (is the app running in-cluster?)");
  return t;
}

function namespace(): string {
  return (
    process.env.NOTEBOOK_K8S_NAMESPACE ||
    readMaybe(`${SA_DIR}/namespace`) ||
    "agentswarms-notebooks"
  );
}

function apiBase(): string {
  const host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  return `https://${host}:${port}`;
}

async function k8sFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${saToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function containerSpec(spec: KernelSpec) {
  return {
    name: "kernel",
    image: spec.image,
    imagePullPolicy: process.env.NOTEBOOK_K8S_PULL_POLICY || "IfNotPresent",
    ports: [{ containerPort: 8888 }],
    env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
    resources: {
      requests: { cpu: "250m", memory: `${Math.min(512, spec.memLimitMb)}Mi` },
      limits: { cpu: spec.cpuLimit, memory: `${spec.memLimitMb}Mi` },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      capabilities: { drop: ["ALL"] },
    },
    volumeMounts: [
      { name: "work", mountPath: "/home/runner/work" },
      { name: "local", mountPath: "/home/runner/.local" },
      { name: "tmp", mountPath: "/tmp" },
    ],
  };
}

function podSpec(spec: KernelSpec) {
  const runtimeClass = process.env.NOTEBOOK_K8S_RUNTIME_CLASS; // e.g. "gvisor"
  return {
    ...(runtimeClass ? { runtimeClassName: runtimeClass } : {}),
    // A service is meant to keep listening: let the kubelet restart it if the
    // user's process dies, and never impose a wall-clock deadline on it.
    restartPolicy: spec.restartOnFailure ? "OnFailure" : "Never",
    automountServiceAccountToken: false, // kernels must not get an API token
    ...(spec.timeoutSeconds > 0 ? { activeDeadlineSeconds: spec.timeoutSeconds } : {}),
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [containerSpec(spec)],
    volumes: [
      { name: "work", emptyDir: { sizeLimit: "512Mi" } },
      { name: "local", emptyDir: { sizeLimit: "512Mi" } },
      { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
    ],
  };
}

function labels(spec: KernelSpec) {
  return {
    "app.kubernetes.io/managed-by": "agentswarms",
    "agentswarms.notebook/session": spec.sessionId,
    "agentswarms.notebook/user": spec.userId,
    "agentswarms.notebook/kind": spec.kind,
  };
}

export class K8sOrchestrator implements NotebookOrchestrator {
  async create(spec: KernelSpec): Promise<{ ref: string }> {
    const name = sandboxName(spec.sessionId);
    const ns = namespace();
    if (spec.kind === "batch") {
      const job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, namespace: ns, labels: labels(spec) },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: spec.timeoutSeconds,
          ttlSecondsAfterFinished: 3600,
          template: { metadata: { labels: labels(spec) }, spec: podSpec(spec) },
        },
      };
      const res = await k8sFetch(`/apis/batch/v1/namespaces/${ns}/jobs`, {
        method: "POST",
        body: JSON.stringify(job),
      });
      if (!res.ok && res.status !== 409)
        throw new Error(`k8s job create (${res.status}): ${await res.text()}`);
      return { ref: `job/${name}` };
    }
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace: ns, labels: labels(spec) },
      spec: podSpec(spec),
    };
    const res = await k8sFetch(`/api/v1/namespaces/${ns}/pods`, {
      method: "POST",
      body: JSON.stringify(pod),
    });
    if (!res.ok && res.status !== 409)
      throw new Error(`k8s pod create (${res.status}): ${await res.text()}`);
    return { ref: `pod/${name}` };
  }

  async status(ref: string, sandboxKind: KernelKind = "interactive"): Promise<KernelStatus> {
    const ns = namespace();
    const [kind, name] = ref.split("/");
    if (kind === "job") {
      const res = await k8sFetch(`/apis/batch/v1/namespaces/${ns}/jobs/${name}`);
      if (res.status === 404) return { state: "gone" };
      if (!res.ok) return { state: "error", message: `k8s get job ${res.status}` };
      const job = (await res.json()) as { status?: { succeeded?: number; failed?: number } };
      if (job.status?.succeeded) return { state: "succeeded" };
      if (job.status?.failed) return { state: "error" };
      return { state: "running" };
    }
    const res = await k8sFetch(`/api/v1/namespaces/${ns}/pods/${name}`);
    if (res.status === 404) return { state: "gone" };
    if (!res.ok) return { state: "error", message: `k8s get pod ${res.status}` };
    const pod = (await res.json()) as {
      status?: {
        phase?: string;
        podIP?: string;
        containerStatuses?: { state?: Record<string, unknown> }[];
      };
    };
    const phase = pod.status?.phase;
    if (phase === "Succeeded") return { state: "succeeded" };
    if (phase === "Failed") return { state: "error" };
    if (phase === "Running" && pod.status?.podIP) {
      const endpoint = `http://${pod.status.podIP}:8888`;
      // Pod Running != process serving; wait for it to answer on its own path.
      if (!(await sandboxServing(endpoint, sandboxKind))) return { state: "starting" };
      return { state: "running", endpoint };
    }
    return { state: "starting" };
  }

  async stop(ref: string): Promise<void> {
    const ns = namespace();
    const [kind, name] = ref.split("/");
    const path =
      kind === "job"
        ? `/apis/batch/v1/namespaces/${ns}/jobs/${name}?propagationPolicy=Background`
        : `/api/v1/namespaces/${ns}/pods/${name}?gracePeriodSeconds=5`;
    await k8sFetch(path, { method: "DELETE" }).catch(() => {});
  }

  async logs(ref: string): Promise<string> {
    const ns = namespace();
    const [kind, name] = ref.split("/");
    // For a Job, find its pod by label; for a Pod, read directly.
    let podName = name;
    if (kind === "job") {
      const res = await k8sFetch(
        `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${name}`)}`,
      );
      if (!res.ok) return "";
      const list = (await res.json()) as { items?: { metadata?: { name?: string } }[] };
      podName = list.items?.[0]?.metadata?.name ?? name;
    }
    const res = await k8sFetch(
      `/api/v1/namespaces/${ns}/pods/${podName}/log?container=kernel&tailLines=2000`,
    );
    return res.ok ? await res.text() : "";
  }
}
