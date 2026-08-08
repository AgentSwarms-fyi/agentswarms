// Service catalogue and health/utilisation shapes for the monitoring page.
//
// PURE module — no fetch, no node APIs — so the catalogue is one definition
// shared by the prober, the UI and the tests, and so the rules below (what
// counts as "not deployed" versus "down", how a cgroup limit beats a host
// total) can be unit-tested without a container.

export type ServiceId =
  | "app"
  | "database"
  | "docgen"
  | "js-sandbox"
  | "notebook-gateway"
  | "notebook-egress"
  | "notebook-docker-proxy";

export type ServiceStatus =
  /** Answered, and answered correctly. */
  | "up"
  /** Reachable but unhealthy (bad status code, wrong body). */
  | "degraded"
  /**
   * Nothing is listening. For an OPTIONAL service that is the expected state
   * when its Compose profile was never started — the UI must not paint a red
   * "down" for a feature the operator deliberately did not enable.
   */
  | "down"
  /** Not probed because the deployment says it does not apply. */
  | "not-deployed"
  /**
   * Cannot be determined FROM HERE. Some services are reachable only inside
   * the Compose network (the egress proxy publishes no host port), so an app
   * running on the host with `npm run dev` cannot probe them at all. Reporting
   * that as "not running" is a lie the operator would have to disprove by
   * hand — and a status page that lies about one row is not trusted about any.
   */
  | "unreachable";

export type ServiceProbe = {
  id: ServiceId;
  label: string;
  /** What breaks if this is down, in the operator's terms. */
  purpose: string;
  /** Compose profile that starts it, or null for always-on pieces. */
  profile: string | null;
  optional: boolean;
  status: ServiceStatus;
  latencyMs: number | null;
  /** Endpoint that answered (or the last one tried). */
  endpoint: string | null;
  /** Extra facts the service itself reported (docgen's soffice flag, etc). */
  detail?: Record<string, string | number | boolean>;
  message?: string;
};

/**
 * The catalogue. Endpoints list the in-network Compose name FIRST and the
 * published loopback second, so the same probe works whether the app runs in
 * Compose or on the host with `npm run dev` — the same discovery order the
 * document renderer and the JS sandbox already use.
 */
export const SERVICE_CATALOGUE: {
  id: ServiceId;
  label: string;
  purpose: string;
  profile: string | null;
  optional: boolean;
  candidates: string[];
  /**
   * Whether compose publishes a host port. When false, only an app running
   * INSIDE the Compose network can probe it — see the "unreachable" status.
   */
  hostPublished: boolean;
  /** Path appended to each candidate. */
  path: string;
  /** A 2xx that is not JSON is still fine for some of these. */
  expect: "json-ok" | "any-2xx" | "docker-ping";
}[] = [
  {
    id: "docgen",
    hostPublished: true,
    label: "Document renderer",
    purpose:
      "Deep-mode PowerPoint / Word / Excel exports. Without it, Agent Chat falls back to the in-browser builder.",
    profile: "docgen",
    optional: true,
    candidates: ["http://docgen:8099", "http://127.0.0.1:8099"],
    path: "/health",
    expect: "json-ok",
  },
  {
    id: "js-sandbox",
    hostPublished: true,
    label: "JS sandbox",
    purpose:
      "Function and custom-component nodes in deployed and scheduled swarm runs. Without it, those nodes are canvas-only.",
    profile: "sandbox",
    optional: true,
    candidates: ["http://js-sandbox:8091", "http://127.0.0.1:8091"],
    path: "/health",
    expect: "json-ok",
  },
  {
    id: "notebook-gateway",
    hostPublished: true,
    label: "Notebook gateway",
    purpose: "Websocket bridge between the notebook editor and per-session Python kernels.",
    profile: "notebooks",
    optional: true,
    candidates: ["http://notebook-gateway:8090", "http://127.0.0.1:8090"],
    path: "/",
    expect: "any-2xx",
  },
  {
    id: "notebook-egress",
    hostPublished: false,
    label: "Notebook egress proxy",
    purpose: "The kernels' only route to the internet, default-deny with an allow-list.",
    profile: "notebooks",
    optional: true,
    // Squid answers HTTP on 3128; a request it refuses to proxy still proves
    // the process is alive, which is all this probe claims.
    // Both names: compose sets container_name for this one, and the service
    // name stays a network alias — try each before concluding it is down.
    candidates: [
      "http://notebook-egress:3128",
      "http://agentswarms-notebook-egress:3128",
      "http://127.0.0.1:3128",
    ],
    path: "/",
    expect: "any-2xx",
  },
  {
    id: "notebook-docker-proxy",
    hostPublished: true,
    label: "Docker API proxy",
    purpose: "Least-privilege container control used to start notebook kernels.",
    profile: "notebooks",
    optional: true,
    candidates: ["http://notebook-docker-proxy:2375", "http://127.0.0.1:2375"],
    path: "/_ping",
    expect: "docker-ping",
  },
];

// ── Hardware utilisation ────────────────────────────────────────────────────

export type MemoryUsage = {
  usedBytes: number;
  totalBytes: number;
  /**
   * Where the total came from. A container with a memory limit reports the
   * LIMIT, not the host's RAM — showing 3 GB of 64 GB when the container dies
   * at 4 GB is worse than useless.
   */
  source: "cgroup" | "host";
};

export type SystemMetrics = {
  hostname: string;
  platform: string;
  nodeVersion: string;
  uptimeSeconds: number;
  cpu: {
    cores: number;
    /** 0–1, averaged across cores over the sample window. */
    usage: number | null;
    /** 1/5/15-minute load averages; zeros on platforms without them. */
    load: [number, number, number];
    /** Container CPU quota in cores, when one is set. */
    limitCores: number | null;
  };
  memory: MemoryUsage;
  process: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  disk: { usedBytes: number; totalBytes: number; path: string } | null;
  sampledAt: string;
};

export const pct = (used: number, total: number): number =>
  total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // One decimal until the number is big enough not to need it: "1.5 KB",
  // "5.0 MB", but "814 GB" rather than "814.3 GB".
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Traffic-light thresholds, shared by every gauge so they cannot disagree. */
export function utilisationTone(percent: number): "ok" | "warn" | "critical" {
  if (percent >= 90) return "critical";
  if (percent >= 75) return "warn";
  return "ok";
}

/**
 * How a service's state should read to an operator.
 *
 * An optional service that is simply not running is NOT an incident: it means
 * the profile was never started. Saying "down" there trains people to ignore
 * the page, so it gets its own wording and its own colour.
 */
export function statusTone(p: Pick<ServiceProbe, "status" | "optional">): {
  tone: "ok" | "warn" | "critical" | "muted";
  label: string;
} {
  if (p.status === "up") return { tone: "ok", label: "Healthy" };
  if (p.status === "degraded") return { tone: "warn", label: "Degraded" };
  if (p.status === "not-deployed") return { tone: "muted", label: "Not deployed" };
  if (p.status === "unreachable") return { tone: "muted", label: "Can't check from here" };
  return p.optional ? { tone: "muted", label: "Not running" } : { tone: "critical", label: "Down" };
}
