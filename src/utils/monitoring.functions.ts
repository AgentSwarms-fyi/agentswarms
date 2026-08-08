// Monitoring — service health probes and hardware utilisation.
//
// Superadmin-only: this reports infrastructure detail (hostnames, container
// limits, which optional services exist) that ordinary users have no reason
// to see.
//
// Both functions are read-only and best-effort. A probe that fails is a
// RESULT, not an exception: the page's whole job is to show what is broken, so
// throwing on the first unreachable service would hide the rest.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperadmin } from "@/utils/iam.server";
import { SERVICE_CATALOGUE, type ServiceProbe, type SystemMetrics } from "@/lib/serviceHealth";
import { resolveInternalOrigin } from "@/utils/internalOrigin.server";

const PROBE_TIMEOUT_MS = 2500;

async function probeOne(entry: (typeof SERVICE_CATALOGUE)[number]): Promise<ServiceProbe> {
  const base: Omit<ServiceProbe, "status" | "latencyMs" | "endpoint"> = {
    id: entry.id,
    label: entry.label,
    purpose: entry.purpose,
    profile: entry.profile,
    optional: entry.optional,
  };
  let lastEndpoint: string | null = null;
  // Distinguish "the name did not resolve" (we are outside the Compose
  // network) from "the name resolved and nothing answered" (it really is
  // down). Without that distinction a host-run app reports every
  // in-network-only service as down.
  // An in-network Compose name that we cannot reach at all (DNS failure on some
  // platforms, a hung lookup that times out on others — measured: Windows SSR
  // reports TimeoutError, plain Node reports ENOTFOUND) means only that THIS
  // process is outside that network. It says nothing about the service.
  let networkNameUnreachable = false;
  for (const candidate of entry.candidates) {
    const url = `${candidate}${entry.path}`;
    lastEndpoint = candidate;
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const latencyMs = Date.now() - started;
      if (entry.expect === "json-ok") {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.ok && body?.ok === true) {
          // Surface whatever extra facts the service volunteers (docgen's
          // soffice availability, for instance) rather than only up/down.
          const detail: Record<string, string | number | boolean> = {};
          for (const [k, v] of Object.entries(body)) {
            if (k === "ok") continue;
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
              detail[k] = v;
            else if (Array.isArray(v)) detail[k] = v.join(", ");
          }
          return { ...base, status: "up", latencyMs, endpoint: candidate, detail };
        }
        return {
          ...base,
          status: "degraded",
          latencyMs,
          endpoint: candidate,
          message: res.ok ? "answered without ok:true" : `HTTP ${res.status}`,
        };
      }
      if (entry.expect === "docker-ping") {
        // The socket proxy answers /_ping with "OK" and no JSON.
        if (res.ok) return { ...base, status: "up", latencyMs, endpoint: candidate };
        return {
          ...base,
          status: "degraded",
          latencyMs,
          endpoint: candidate,
          message: `HTTP ${res.status}`,
        };
      }
      // any-2xx: anything that answers HTTP proves the process is alive. Squid
      // replies 400 to a non-proxy request, which still means "running" — so a
      // 4xx is reported as up, and only a connection failure counts as down.
      return {
        ...base,
        status: res.status < 500 ? "up" : "degraded",
        latencyMs,
        endpoint: candidate,
        message: res.status < 500 ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      // Read the WHOLE error chain: under the SSR runtime the failure arrives
      // as a bare TimeoutError, while plain Node reports cause.code
      // ENOTFOUND — a code-only check saw neither and mislabelled every
      // unreachable Compose name as "connection refused".
      const err = e as {
        name?: string;
        message?: string;
        cause?: { code?: string; message?: string };
      };
      const why = [err?.name, err?.message, err?.cause?.code, err?.cause?.message]
        .filter(Boolean)
        .join(" ");
      const isLoopback = /127\.0\.0\.1|localhost/.test(candidate);
      if (!isLoopback && /ENOTFOUND|EAI_AGAIN|getaddrinfo|Timeout|aborted/i.test(why)) {
        networkNameUnreachable = true;
      }
      // Try the next candidate address before concluding anything.
    }
  }

  // No host port AND its Compose name is out of reach: there is genuinely
  // nothing this process can learn. A loopback refusal proves nothing here
  // either — no port is published on loopback for this service by design.
  if (!entry.hostPublished && networkNameUnreachable) {
    return {
      ...base,
      status: "unreachable",
      latencyMs: null,
      endpoint: lastEndpoint,
      message:
        "Publishes no host port, and this app is running outside the Compose network — so its state cannot be determined from here. Run the app in Compose to include it in this check.",
    };
  }
  return {
    ...base,
    status: "down",
    latencyMs: null,
    endpoint: lastEndpoint,
    message: entry.optional
      ? `Not answering. Start it with \`docker compose --profile ${entry.profile} up -d\` if you want it.`
      : "Not answering.",
  };
}

export const serviceHealth = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => z.object({ access_token: z.string().min(1) }).parse(i))
  .handler(async ({ data }): Promise<{ services: ServiceProbe[]; checkedAt: string }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) throw new Error(guard.error);

    // The app itself and the database are not optional, so they get bespoke
    // probes rather than catalogue entries.
    const appProbe = async (): Promise<ServiceProbe> => {
      const started = Date.now();
      try {
        const res = await fetch(`${resolveInternalOrigin()}/api/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        return {
          id: "app",
          label: "Application server",
          purpose: "Serves the UI, the API and every background schedule.",
          profile: null,
          optional: false,
          status: res.ok && body?.status === "ok" ? "up" : "degraded",
          latencyMs: Date.now() - started,
          endpoint: resolveInternalOrigin(),
        };
      } catch (e) {
        return {
          id: "app",
          label: "Application server",
          purpose: "Serves the UI, the API and every background schedule.",
          profile: null,
          optional: false,
          status: "degraded",
          latencyMs: null,
          endpoint: resolveInternalOrigin(),
          // If this reports at all, the server is obviously running — so a
          // failure here means the self-call is misconfigured, not that the
          // app is down. Say that instead of a scary red.
          message: `Self-call failed (${(e as Error).message}). PUBLIC_APP_URL may be wrong.`,
        };
      }
    };

    const dbProbe = async (): Promise<ServiceProbe> => {
      const started = Date.now();
      const url = process.env.SUPABASE_URL;
      try {
        if (!url) throw new Error("SUPABASE_URL is not set");
        const res = await fetch(`${url}/auth/v1/health`, {
          headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "" },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return {
          id: "database",
          label: "Supabase",
          purpose: "Postgres, authentication, storage and vector search.",
          profile: null,
          optional: false,
          status: res.ok ? "up" : "degraded",
          latencyMs: Date.now() - started,
          endpoint: url,
          message: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (e) {
        return {
          id: "database",
          label: "Supabase",
          purpose: "Postgres, authentication, storage and vector search.",
          profile: null,
          optional: false,
          status: "down",
          latencyMs: null,
          endpoint: url ?? null,
          message: (e as Error).message,
        };
      }
    };

    const [app, db, ...rest] = await Promise.all([
      appProbe(),
      dbProbe(),
      ...SERVICE_CATALOGUE.map(probeOne),
    ]);
    return { services: [app, db, ...rest], checkedAt: new Date().toISOString() };
  });

// ── Hardware utilisation ────────────────────────────────────────────────────

/**
 * Read a cgroup v2 (then v1) file. Inside a container these describe the
 * CONTAINER's limits; on a host they are absent and we fall back to os.*.
 */
async function readCgroup(paths: string[]): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  for (const p of paths) {
    try {
      const txt = (await readFile(p, "utf-8")).trim();
      if (txt) return txt;
    } catch {
      /* not this layout */
    }
  }
  return null;
}

export const systemMetrics = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => z.object({ access_token: z.string().min(1) }).parse(i))
  .handler(async ({ data }): Promise<SystemMetrics> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) throw new Error(guard.error);
    const os = await import("node:os");

    // CPU usage: sample the aggregate CPU times twice and diff. os.loadavg()
    // is 0 on Windows and reflects the HOST inside a container, so it is
    // reported alongside rather than used as the number.
    const snapshot = () => {
      let idle = 0;
      let total = 0;
      for (const c of os.cpus()) {
        for (const [k, v] of Object.entries(c.times)) {
          total += v as number;
          if (k === "idle") idle += v as number;
        }
      }
      return { idle, total };
    };
    const a = snapshot();
    await new Promise((r) => setTimeout(r, 200));
    const b = snapshot();
    const dTotal = b.total - a.total;
    const dIdle = b.idle - a.idle;
    const usage = dTotal > 0 ? Math.min(1, Math.max(0, 1 - dIdle / dTotal)) : null;

    // Memory: prefer the container's limit over the host's RAM.
    const memCurrent = await readCgroup([
      "/sys/fs/cgroup/memory.current",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ]);
    const memMax = await readCgroup([
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]);
    const limitBytes = memMax && memMax !== "max" ? Number(memMax) : NaN;
    const hostTotal = os.totalmem();
    // A cgroup with no limit reports a sentinel far larger than real RAM.
    const useCgroup =
      Number.isFinite(limitBytes) && limitBytes > 0 && limitBytes < hostTotal * 4 && !!memCurrent;
    const memory = useCgroup
      ? { usedBytes: Number(memCurrent), totalBytes: limitBytes, source: "cgroup" as const }
      : { usedBytes: hostTotal - os.freemem(), totalBytes: hostTotal, source: "host" as const };

    // CPU quota, when the container has one (cgroup v2: "<quota> <period>").
    const cpuMax = await readCgroup(["/sys/fs/cgroup/cpu.max"]);
    let limitCores: number | null = null;
    if (cpuMax && !cpuMax.startsWith("max")) {
      const [q, p] = cpuMax.split(/\s+/).map(Number);
      if (Number.isFinite(q) && Number.isFinite(p) && p > 0) limitCores = q / p;
    }

    // Disk: the filesystem the app is installed on. statfs is unavailable on
    // some platforms/older runtimes, in which case the card is simply omitted
    // rather than filled with a guess.
    let disk: SystemMetrics["disk"] = null;
    try {
      const { statfs } = await import("node:fs/promises");
      const path = process.cwd();
      const st = await (
        statfs as (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }>
      )(path);
      const totalBytes = st.blocks * st.bsize;
      const freeBytes = st.bavail * st.bsize;
      if (totalBytes > 0) disk = { usedBytes: totalBytes - freeBytes, totalBytes, path };
    } catch {
      /* no statfs on this platform */
    }

    const mem = process.memoryUsage();
    const load = os.loadavg() as [number, number, number];
    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
      cpu: { cores: os.cpus().length, usage, load, limitCores },
      memory,
      process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
      disk,
      sampledAt: new Date().toISOString(),
    };
  });
