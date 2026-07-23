// Pluggable orchestrator that launches, inspects, and tears down per-session
// kernel sandboxes. The app never runs user code itself — it asks an
// orchestrator to create an isolated container/pod and then proxies to it.
//
// Backends:
//   - docker : Docker Engine API via a least-privilege socket-proxy (dev / single host)
//   - k8s    : one Pod (interactive) or Job (batch) per session (production scale)
//   - e2b    : managed Firecracker microVMs (optional)
//
// All backends are stateless and talk over HTTP(S), so any app replica can
// create/reconcile any session — the source of truth is the DB row, not memory.
import type { RuntimeBackend, RuntimeSettings } from "./config.server";

export type KernelKind = "interactive" | "batch";

export type KernelSpec = {
  sessionId: string;
  userId: string;
  kind: KernelKind;
  image: string;
  cpuLimit: string;
  memLimitMb: number;
  /** hard wall-clock ceiling for the sandbox */
  timeoutSeconds: number;
  /** injected into the container environment (session token, callback URL, proxy…) */
  env: Record<string, string>;
};

export type KernelState = "starting" | "running" | "succeeded" | "gone" | "error";

export type KernelStatus = {
  state: KernelState;
  /** cluster-internal base URL of the kernel (Jupyter Kernel Gateway), once ready */
  endpoint?: string;
  exitCode?: number;
  message?: string;
};

export interface NotebookOrchestrator {
  /** Create + start the sandbox. Returns an opaque handle ref (container id / pod name). */
  create(spec: KernelSpec): Promise<{ ref: string }>;
  /** Current state (+ endpoint once reachable). Safe to poll. */
  status(ref: string): Promise<KernelStatus>;
  /** Best-effort teardown; must not throw if already gone. */
  stop(ref: string): Promise<void>;
  /** Captured stdout/stderr (batch jobs). */
  logs(ref: string): Promise<string>;
}

/** Resolve the configured backend to an orchestrator instance. */
export async function getOrchestrator(
  settings: Pick<RuntimeSettings, "backend">,
): Promise<NotebookOrchestrator> {
  const backend: RuntimeBackend = settings.backend;
  switch (backend) {
    case "k8s": {
      const { K8sOrchestrator } = await import("./k8s.server");
      return new K8sOrchestrator();
    }
    case "e2b": {
      const { E2BOrchestrator } = await import("./e2b.server");
      return new E2BOrchestrator();
    }
    case "docker":
    default: {
      const { DockerOrchestrator } = await import("./docker.server");
      return new DockerOrchestrator();
    }
  }
}

/** Standard label/name for a session's sandbox, shared by all backends. */
export function sandboxName(sessionId: string): string {
  return `nb-${sessionId}`;
}
