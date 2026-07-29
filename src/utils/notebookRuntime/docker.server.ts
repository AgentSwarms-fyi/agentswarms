// Docker backend for the notebook runtime (dev / single host).
//
// Talks to the Docker Engine API through a least-privilege socket-proxy
// (DOCKER_PROXY_URL, e.g. http://docker-socket-proxy:2375) — the app is NEVER
// given the raw /var/run/docker.sock. Kernels are created with the Tier-A
// hardening from docs/DEVELOPER_WORKSPACE_RUNTIME.md §5.1: non-root, read-only
// rootfs, all caps dropped, no-new-privileges, pids/memory/cpu limits, attached
// to an egress-restricted network, with HTTP(S)_PROXY pointed at the filtering
// egress proxy.
import { existsSync } from "node:fs";
import type { KernelKind, KernelSpec, KernelStatus, NotebookOrchestrator } from "./orchestrator";
import { sandboxName, sandboxServing } from "./orchestrator";

// The socket-proxy is reachable by different names depending on how the app is
// deployed, so probe rather than assume:
//   - app inside compose  → the service name resolves on the compose network
//   - app on the host (npm run dev) → the published loopback port
// The first candidate that answers /_ping wins and is cached.
let resolvedBase: string | null = null;

function candidates(): string[] {
  return [
    process.env.DOCKER_PROXY_URL,
    "http://notebook-docker-proxy:2375",
    "http://127.0.0.1:2375",
  ].filter((c): c is string => !!c);
}

export async function dockerBase(): Promise<string> {
  if (resolvedBase) return resolvedBase;
  const tried: string[] = [];
  for (const candidate of candidates()) {
    const base = candidate.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/_ping`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        resolvedBase = base;
        return base;
      }
      tried.push(`${base} → HTTP ${res.status}`);
    } catch (e) {
      tried.push(`${base} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    "Cannot reach the Docker socket-proxy, so no kernel can be started. Start the runtime " +
      "services with:  docker compose --profile notebooks up -d --build  (tried " +
      tried.join("; ") +
      ")",
  );
}

async function dockerFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await dockerBase();
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** True when this app process is itself running inside a container. */
export function appInContainer(): boolean {
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

/**
 * Network the kernels attach to.
 *  - App in compose (production): the `internal` network — kernels get NO direct
 *    internet, only the egress proxy, and reach the app by service name.
 *  - App on the host (local dev): that internal network has no route to the host,
 *    so kernels could never call back. Use the default bridge plus a
 *    host-gateway mapping. Egress control then rests on the proxy env vars alone
 *    — weaker, which is why it's the dev-only path.
 */
function network(): string {
  if (process.env.NOTEBOOK_NETWORK) return process.env.NOTEBOOK_NETWORK;
  // Both are user-defined networks the gateway also joins. Never the default
  // `bridge`: it has no name-based DNS, and on Linux hosts separate bridges are
  // iptables-isolated, so the gateway could not reach the kernel at all.
  return appInContainer() ? "agentswarms_nb-internal" : "agentswarms_nb-dev";
}

/** The runner uid:gid baked into the image (non-root). */
const RUN_USER = process.env.NOTEBOOK_RUN_USER || "1000:1000";

type InspectResult = {
  State: { Running: boolean; ExitCode: number; Status: string; Error?: string };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string } | null>;
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  };
};

export class DockerOrchestrator implements NotebookOrchestrator {
  async create(spec: KernelSpec): Promise<{ ref: string }> {
    const name = sandboxName(spec.sessionId);
    const envList = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
    const memBytes = spec.memLimitMb * 1024 * 1024;
    // Docker wants CPU as NanoCPUs (1 CPU = 1e9).
    const nanoCpus = Math.round(parseFloat(spec.cpuLimit || "1") * 1e9);

    const body = {
      Image: spec.image,
      User: RUN_USER,
      Env: envList,
      Labels: {
        "agentswarms.notebook.session": spec.sessionId,
        "agentswarms.notebook.user": spec.userId,
        "agentswarms.notebook.kind": spec.kind,
        "agentswarms.managed": "true",
      },
      ExposedPorts: { "8888/tcp": {} },
      StopTimeout: 5,
      HostConfig: {
        Memory: memBytes,
        MemorySwap: memBytes, // no swap
        NanoCpus: nanoCpus,
        PidsLimit: 256,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        NetworkMode: network(),
        // Lets a kernel reach an app running on the host (local dev). Harmless
        // in compose, where the app is reached by service name instead.
        ExtraHosts: ["host.docker.internal:host-gateway"],
        // Writable paths (root fs is read-only); lost on teardown — notebooks
        // persist in the DB. ~/.local holds runtime `pip install --user` output.
        //
        // mode=1777 is REQUIRED: tmpfs mounts default to root-owned 0755, but the
        // kernel runs as uid 1000, so without it every write fails with
        // "Permission denied" (and runtime pip install breaks). Sticky world-write
        // is safe here — each container is a single-tenant, ephemeral sandbox.
        Tmpfs: {
          "/home/runner/work": "rw,exec,size=512m,mode=1777",
          "/home/runner/.local": "rw,exec,size=512m,mode=1777",
          "/tmp": "rw,size=256m,mode=1777",
        },
        // When the app runs on the HOST (dev), Docker Desktop cannot route to
        // container IPs — so publish the kernel port on loopback purely so the
        // app can probe readiness. In compose the app is a container on the same
        // network and needs no published port.
        ...(appInContainer()
          ? {}
          : { PortBindings: { "8888/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } }),
        // Long-lived services opt into a BOUNDED restart so a transient crash
        // doesn't silently take a published MCP server offline. Deliberately
        // not "unless-stopped": code that fails on boot would restart-loop
        // forever, burning a CPU slice and hiding the error.
        RestartPolicy: spec.restartOnFailure
          ? { Name: "on-failure", MaximumRetryCount: 3 }
          : { Name: "no" },
        AutoRemove: false, // we remove explicitly so batch logs survive until read
      },
    };

    const res = await dockerFetch(`/containers/create?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      // Name already exists (retry/duplicate) — reuse it.
      const existing = await this.inspect(name);
      if (existing) return { ref: name };
    }
    if (!res.ok) {
      throw new Error(`docker create failed (${res.status}): ${await res.text()}`);
    }
    const created = (await res.json()) as { Id: string };
    const start = await dockerFetch(`/containers/${created.Id}/start`, { method: "POST" });
    if (!start.ok && start.status !== 304) {
      await this.stop(created.Id).catch(() => {});
      throw new Error(`docker start failed (${start.status}): ${await start.text()}`);
    }
    // Use the stable name as the ref so the gateway can reach it by DNS on the
    // shared network (http://nb-<id>:8888) without tracking the container id.
    return { ref: name };
  }

  private async inspect(ref: string): Promise<InspectResult | null> {
    const res = await dockerFetch(`/containers/${encodeURIComponent(ref)}/json`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`docker inspect failed (${res.status})`);
    return (await res.json()) as InspectResult;
  }

  async status(ref: string, kind: KernelKind = "interactive"): Promise<KernelStatus> {
    const info = await this.inspect(ref);
    if (!info) return { state: "gone" };
    const s = info.State;
    if (s.Running) {
      // Address the kernel by IP rather than container name: name-based DNS only
      // exists on user-defined networks, and the IP works regardless of how the
      // gateway and kernel are attached.
      const nets = info.NetworkSettings?.Networks ?? {};
      const ip = Object.values(nets)
        .map((n) => n?.IPAddress)
        .find((a): a is string => !!a);
      // The gateway (a container) always reaches the kernel by container IP.
      const endpoint = `http://${ip || ref}:8888`;
      // ...but WE may be on the host, which cannot route to that IP. Probe the
      // published loopback port in that case, so readiness reflects reality in
      // both deployment shapes.
      const hostPort = info.NetworkSettings?.Ports?.["8888/tcp"]?.[0]?.HostPort;
      const probeUrl = appInContainer() || !hostPort ? endpoint : `http://127.0.0.1:${hostPort}`;
      // Container up != kernel serving. Stay "starting" until the process
      // answers, so nothing connects to a socket that isn't listening yet.
      if (!(await sandboxServing(probeUrl, kind))) return { state: "starting" };
      // Kernels are consumed by the GATEWAY (a container), which reaches them by
      // container IP. A service is consumed by THIS process, which in local dev
      // is on the host and cannot route to that IP — so hand back the URL the
      // caller can actually open. probeUrl is precisely "reachable from here".
      return { state: "running", endpoint: kind === "service" ? probeUrl : endpoint };
    }
    if (s.Status === "exited" && s.ExitCode === 0) return { state: "succeeded", exitCode: 0 };
    return {
      state: s.Status === "created" ? "starting" : "error",
      exitCode: s.ExitCode,
      message: s.Error,
    };
  }

  async stop(ref: string): Promise<void> {
    // Stop then remove; ignore 404 (already gone).
    await dockerFetch(`/containers/${encodeURIComponent(ref)}/stop?t=5`, { method: "POST" }).catch(
      () => {},
    );
    await dockerFetch(`/containers/${encodeURIComponent(ref)}?force=true`, {
      method: "DELETE",
    }).catch(() => {});
  }

  async logs(ref: string): Promise<string> {
    const res = await dockerFetch(
      `/containers/${encodeURIComponent(ref)}/logs?stdout=true&stderr=true&tail=2000`,
    );
    if (!res.ok) return "";
    // Docker multiplexes logs with an 8-byte header per frame; strip it best-effort.
    const buf = new Uint8Array(await res.arrayBuffer());
    let out = "";
    let i = 0;
    while (i + 8 <= buf.length) {
      const len = (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
      const start = i + 8;
      const end = Math.min(start + len, buf.length);
      out += new TextDecoder().decode(buf.subarray(start, end));
      i = end;
    }
    return out || new TextDecoder().decode(buf);
  }
}
