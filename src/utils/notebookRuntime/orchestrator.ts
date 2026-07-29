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

/**
 * `service` is a long-lived sandbox that keeps listening instead of running to
 * completion — today that means one published MCP server (MCP Builder). It uses
 * exactly the same hardening as the other two kinds; only the readiness probe
 * and the restart policy differ.
 */
export type KernelKind = "interactive" | "batch" | "service";

export type KernelSpec = {
  sessionId: string;
  userId: string;
  kind: KernelKind;
  image: string;
  cpuLimit: string;
  memLimitMb: number;
  /** hard wall-clock ceiling for the sandbox; 0 = none (long-lived services) */
  timeoutSeconds: number;
  /** injected into the container environment (session token, callback URL, proxy…) */
  env: Record<string, string>;
  /**
   * Services only: restart the sandbox if the user's process dies. Bounded
   * rather than unlimited — code that crashes on boot must not restart-loop.
   */
  restartOnFailure?: boolean;
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
  /**
   * Current state (+ endpoint once reachable). Safe to poll.
   *
   * `kind` is passed because readiness is protocol-specific: a Jupyter kernel is
   * ready when /api answers, an MCP service when its own path does. The ref
   * alone cannot tell you which.
   */
  status(ref: string, kind?: KernelKind): Promise<KernelStatus>;
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

/**
 * Is the kernel actually SERVING, not merely scheduled?
 *
 * A running container/pod is not the same as a listening Jupyter Kernel Gateway
 * — JKG needs several seconds to boot. Reporting "ready" on container state
 * alone makes the browser connect too early and the gateway fail with
 * "kernel unavailable … fetch failed". Backends call this before reporting
 * `running`, so readiness means "you can talk to it".
 */
export async function kernelServing(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/api`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Path an MCP service listens on inside its sandbox. */
export const MCP_SERVICE_PATH = "/mcp";

/**
 * Is a long-lived service actually SERVING?
 *
 * Unlike the Jupyter probe this cannot require `res.ok`: a conformant MCP
 * endpoint answers a bare GET with 400/405/406 (it wants a POST with the right
 * Accept header). Those responses still prove something is listening and
 * routing, which is exactly what readiness means here. Only a transport failure
 * or a 5xx counts as not-ready.
 */
export async function serviceServing(endpoint: string, path = MCP_SERVICE_PATH): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Readiness probe for a sandbox of the given kind. */
export async function sandboxServing(endpoint: string, kind: KernelKind): Promise<boolean> {
  return kind === "service" ? serviceServing(endpoint) : kernelServing(endpoint);
}
