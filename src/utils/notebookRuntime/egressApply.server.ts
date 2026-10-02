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
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { renderEgressAllowlist, renderEgressIpAllowlist } from "./egress";

/**
 * Destinations the PLATFORM configured, unioned in so an operator never has to
 * allow-list infrastructure this deployment set up itself.
 *
 * The lakehouse object store is the case that proves the need: an ETL
 * lakehouse node reads and writes Parquet over S3 from inside a kernel, and
 * when that endpoint is a raw IP — the norm for a self-hosted MinIO — squid
 * denies it with a 403 that DuckDB reports as "Authentication Failure ...
 * credentials did not work". That message sends you hunting a credential bug
 * which does not exist, exactly the misdirection this module exists to stop.
 */
export function platformEgressHosts(): string[] {
  const out: string[] = [];
  const endpoint = process.env.LAKEHOUSE_S3_ENDPOINT?.trim();
  if (endpoint) out.push(endpoint);
  return out;
}

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

    // Seen live: the restart took longer than 20s while the daemon was busy
    // and the caller reported "could not be reloaded" for a proxy that came
    // back seconds later. A minute is generous and the call is rare.
    const res = await fetch(`${dockerBase()}/containers/${id}/restart?t=5`, {
      method: "POST",
      signal: AbortSignal.timeout(60000),
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
  // The operator's list plus whatever this deployment configured for itself.
  const all = [...(hosts ?? []), ...platformEgressHosts()];
  const body = renderEgressAllowlist(all);
  const count = body.split("\n").filter((l) => l && !l.startsWith("#")).length;

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
    // Raw-IP entries go into the sibling dst file — dstdomain cannot match
    // them, so leaving them in allowed_domains would silently deny a LAN
    // MinIO while the admin field claimed otherwise.
    await fs.writeFile(
      path.join(path.dirname(file), "allowed_ips"),
      renderEgressIpAllowlist(all),
      "utf8",
    );
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

/**
 * Make sure the proxy admits the hosts this deployment configured for
 * itself (the lake's S3 endpoint above all) BEFORE a sandbox needs them.
 *
 * The allow-list used to reach the proxy only when an administrator saved
 * the runtime settings. Configure the lakehouse afterwards and every sandbox
 * that read Parquet got a 403 from squid, which DuckDB reports as
 * "Authentication Failure ... credentials did not work" — a credential hunt
 * for a bug that is not there. Called at job start; a no-op (no write, no
 * proxy restart) when the rendered files already match, so a running job is
 * never disturbed by another one starting.
 */
export async function ensurePlatformEgress(): Promise<EgressApplyResult> {
  if (!platformEgressHosts().length) return { applied: true, hosts: 0 };
  // On Kubernetes the allow-list is the notebook-egress ConfigMap, not a file
  // this process can write: name the hosts so the warning is the instruction.
  if ((process.env.NOTEBOOK_RUNTIME_BACKEND || "").toLowerCase() === "k8s") {
    return {
      applied: false,
      reason:
        `On Kubernetes, add ${platformEgressHosts().join(", ")} to the notebook-egress ConfigMap ` +
        `(allowed_domains, or allowed_ips for a raw address) and restart the proxy; ` +
        `see deploy/k8s/notebooks/notebook-runtime.yaml.`,
    };
  }
  let stored: string[] = [];
  try {
    const { data } = await supabaseAdmin
      .from("notebook_runtime_settings")
      .select("egress_allowlist")
      .eq("id", true)
      .maybeSingle();
    stored = (data?.egress_allowlist ?? []) as string[];
  } catch {
    /* no settings row yet: the platform hosts alone */
  }
  const all = [...stored, ...platformEgressHosts()];
  const file = allowlistPath();
  try {
    const [domains, ips] = await Promise.all([
      fs.readFile(file, "utf8").catch(() => ""),
      fs.readFile(path.join(path.dirname(file), "allowed_ips"), "utf8").catch(() => ""),
    ]);
    if (domains === renderEgressAllowlist(all) && ips === renderEgressIpAllowlist(all)) {
      return { applied: true, hosts: all.length };
    }
  } catch {
    /* unreadable: fall through and (re)write */
  }
  return applyEgressAllowlist(stored);
}
