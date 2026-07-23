// Docker backend for the notebook runtime (dev / single host).
//
// Talks to the Docker Engine API through a least-privilege socket-proxy
// (DOCKER_PROXY_URL, e.g. http://docker-socket-proxy:2375) — the app is NEVER
// given the raw /var/run/docker.sock. Kernels are created with the Tier-A
// hardening from docs/DEVELOPER_WORKSPACE_RUNTIME.md §5.1: non-root, read-only
// rootfs, all caps dropped, no-new-privileges, pids/memory/cpu limits, attached
// to an egress-restricted network, with HTTP(S)_PROXY pointed at the filtering
// egress proxy.
import type {
  KernelSpec,
  KernelStatus,
  NotebookOrchestrator,
} from "./orchestrator";
import { sandboxName } from "./orchestrator";

function dockerBase(): string {
  const url = process.env.DOCKER_PROXY_URL;
  if (!url) throw new Error("DOCKER_PROXY_URL is not set (the notebook runtime needs a Docker socket-proxy)");
  return url.replace(/\/$/, "");
}

async function dockerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${dockerBase()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Docker network the kernels attach to; its only egress route is the proxy. */
function network(): string {
  return process.env.NOTEBOOK_NETWORK || "nb-egress";
}

/** The runner uid:gid baked into the image (non-root). */
const RUN_USER = process.env.NOTEBOOK_RUN_USER || "1000:1000";

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
        // Writable paths (root fs is read-only); lost on teardown — notebooks
        // persist in the DB. ~/.local holds runtime `pip install --user` output.
        Tmpfs: {
          "/home/runner/work": "rw,exec,size=512m",
          "/home/runner/.local": "rw,exec,size=512m",
          "/tmp": "rw,size=256m",
        },
        RestartPolicy: { Name: "no" },
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

  private async inspect(ref: string): Promise<
    | { State: { Running: boolean; ExitCode: number; Status: string; Error?: string } }
    | null
  > {
    const res = await dockerFetch(`/containers/${encodeURIComponent(ref)}/json`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`docker inspect failed (${res.status})`);
    return (await res.json()) as {
      State: { Running: boolean; ExitCode: number; Status: string; Error?: string };
    };
  }

  async status(ref: string): Promise<KernelStatus> {
    const info = await this.inspect(ref);
    if (!info) return { state: "gone" };
    const s = info.State;
    if (s.Running) {
      return { state: "running", endpoint: `http://${ref}:8888` };
    }
    if (s.Status === "exited" && s.ExitCode === 0) return { state: "succeeded", exitCode: 0 };
    return { state: s.Status === "created" ? "starting" : "error", exitCode: s.ExitCode, message: s.Error };
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
    const res = await dockerFetch(`/containers/${encodeURIComponent(ref)}/logs?stdout=true&stderr=true&tail=2000`);
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
