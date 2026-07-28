// Applying the notebook egress allow-list to the running proxy.
//
// The allow-list has always been stored in notebook_runtime_settings and
// editable in Admin → Developer runtime, but nothing ever read it: the squid
// container mounts a file baked into the repo, so adding github.com in the UI
// silently did nothing and `pip install git+https://…` kept failing. A settings
// field that looks like it works and doesn't is worse than no field at all.
//
// This writes the operator's list to the file squid actually reads and restarts
// the proxy so it takes effect. Every failure path returns a REASON rather than
// swallowing it, so the UI can say "saved, but not applied because …" instead of
// implying success.
import { promises as fs } from "node:fs";
import path from "node:path";
import { renderEgressAllowlist } from "./egress";

export type EgressApplyResult = {
  applied: boolean;
  /** Human-readable explanation when applied is false. */
  reason?: string;
  /** True when the file was written but the proxy could not be reloaded — the
   *  new list takes effect on the proxy's next restart. */
  pendingRestart?: boolean;
  hosts?: number;
};

/** Path squid reads its dstdomain list from, as mounted into THIS container. */
function allowlistPath(): string {
  return process.env.NOTEBOOK_EGRESS_ALLOWLIST_PATH || "/etc/agentswarms/egress/allowed_domains";
}

/** Container name (or id) of the squid proxy, for the reload. */
function proxyContainer(): string {
  return process.env.NOTEBOOK_EGRESS_CONTAINER || "agentswarms-notebook-egress";
}

function dockerBase(): string {
  return (process.env.NOTEBOOK_DOCKER_HOST || "http://notebook-docker-proxy:2375").replace(
    /\/+$/,
    "",
  );
}

/**
 * Restart the proxy so it re-reads the ACL file.
 *
 * Squid caches ACL files at (re)configure time, and the docker socket proxy
 * deliberately denies `exec` — so `squid -k reconfigure` isn't available to us.
 * A restart is the blunt option that IS permitted, and an admin settings save
 * is a fine moment to drop idle proxy connections.
 */
async function restartProxy(): Promise<{ ok: boolean; reason?: string }> {
  const name = proxyContainer();
  try {
    // Resolve by name first: compose prefixes the project, so "notebook-egress"
    // alone rarely matches the real container name.
    const listRes = await fetch(
      `${dockerBase()}/containers/json?all=true&filters=${encodeURIComponent(
        JSON.stringify({ name: [name] }),
      )}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!listRes.ok) {
      return { ok: false, reason: `Docker API returned ${listRes.status} listing containers.` };
    }
    const rows = (await listRes.json()) as { Id?: string; Names?: string[] }[];
    const id = rows?.[0]?.Id;
    if (!id) return { ok: false, reason: `No running container matching "${name}".` };

    const res = await fetch(`${dockerBase()}/containers/${id}/restart?t=5`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok && res.status !== 204) {
      return { ok: false, reason: `Restarting the proxy returned ${res.status}.` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Write the allow-list and reload the proxy.
 *
 * Never throws — the caller has already persisted the settings, and a failure
 * here must not roll that back or look like a save failure.
 */
export async function applyEgressAllowlist(hosts: string[]): Promise<EgressApplyResult> {
  const file = allowlistPath();
  const body = renderEgressAllowlist(hosts ?? []);
  const count = body.split("\n").filter((l) => l && !l.startsWith("#")).length;

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const hint =
      err.code === "EACCES" || err.code === "EROFS"
        ? ` Mount the egress config directory writable into the app container (see docs/DEVELOPER_WORKSPACE_RUNTIME.md).`
        : "";
    return { applied: false, reason: `Could not write ${file}: ${err.message}.${hint}` };
  }

  const reload = await restartProxy();
  if (!reload.ok) {
    return {
      applied: false,
      pendingRestart: true,
      hosts: count,
      reason: `Allow-list written, but the proxy could not be reloaded (${reload.reason}). It takes effect next time the proxy restarts.`,
    };
  }
  return { applied: true, hosts: count };
}
