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
  | "notebook-docker-proxy"
  | "lakehouse-catalog"
  | "spark-connect"
  | "qdrant"
  | "valkey"
  | "minio";

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
  candidates: string[];
  /**
   * Whether compose publishes a host port. When false, only an app running
   * INSIDE the Compose network can probe it — see the "unreachable" status.
   */
  hostPublished: boolean;
  /** Path appended to each candidate. */
  path: string;
  /** A 2xx that is not JSON is still fine for some of these. */
  expect: "json-ok" | "any-2xx" | "docker-ping" | "tcp-open";
}[] = [
  {
    id: "docgen",
    hostPublished: true,
    label: "Document renderer",
    purpose:
      "Deep-mode PowerPoint / Word / Excel exports. Without it, Agent Chat falls back to the in-browser builder.",
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
    candidates: ["http://js-sandbox:8091", "http://127.0.0.1:8091"],
    path: "/health",
    expect: "json-ok",
  },
  {
    id: "notebook-gateway",
    hostPublished: true,
    label: "Notebook gateway",
    purpose: "Websocket bridge between the notebook editor and per-session Python kernels.",
    candidates: ["http://notebook-gateway:8090", "http://127.0.0.1:8090"],
    path: "/",
    expect: "any-2xx",
  },
  {
    id: "notebook-egress",
    hostPublished: false,
    label: "Notebook egress proxy",
    purpose: "The kernels' only route to the internet, default-deny with an allow-list.",
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
    id: "lakehouse-catalog",
    hostPublished: true,
    label: "Lakehouse catalog",
    purpose:
      "DuckLake's transactional catalog (schemas, snapshots, file manifests). Without it, the Lakehouse page says it is not configured.",
    // Postgres speaks no HTTP — an open TCP socket is the whole claim.
    // 55432 on the host: a developer's own Postgres usually holds 5432, and
    // probing that would report somebody else's database as this one.
    candidates: ["tcp://lakehouse-catalog:5432", "tcp://127.0.0.1:55432"],
    path: "",
    expect: "tcp-open",
  },
  {
    id: "spark-connect",
    hostPublished: true,
    label: "Spark Connect",
    purpose:
      "The shared Spark cluster for ETL pipelines on the Spark engine. Without it those runs fail to connect; pipelines on the default engine are unaffected.",
    // gRPC over HTTP/2 with no unauthenticated health path — an open socket is
    // the whole claim, as for the catalog's Postgres.
    candidates: ["tcp://spark-connect:15002", "tcp://127.0.0.1:15002"],
    path: "",
    expect: "tcp-open",
  },
  {
    id: "notebook-docker-proxy",
    hostPublished: true,
    label: "Docker API proxy",
    purpose: "Least-privilege container control used to start notebook kernels.",
    candidates: ["http://notebook-docker-proxy:2375", "http://127.0.0.1:2375"],
    path: "/_ping",
    expect: "docker-ping",
  },
  {
    id: "valkey",
    // Not published to the host, for the reason the vector store is not: a
    // feature store reachable on a laptop's loopback is one anybody on that
    // laptop can read, and it holds whatever the feature table holds.
    hostPublished: true,
    label: "Online feature store",
    purpose:
      "Where a feature view's latest row per key is served from. Without it, every lookup reads the lakehouse instead — correct, and about sixty times slower.",
    // RESP is not HTTP, so an open socket is the whole claim — as for the
    // catalog's Postgres and Spark's gRPC.
    candidates: ["tcp://valkey:6379", "tcp://127.0.0.1:6379"],
    path: "",
    expect: "tcp-open",
  },
  {
    id: "qdrant",
    // Not published to the host: on the Compose network the app reaches it by
    // service name, and a vector store on a laptop's loopback is a vector
    // store anyone on that laptop can read.
    hostPublished: true,
    label: "Vector store (Qdrant)",
    purpose:
      "Where knowledge-base embeddings are searched when VECTOR_STORE=qdrant. Without it, retrieval falls back to keyword search over the same chunks — the text never leaves Postgres.",
    candidates: ["http://qdrant:6333", "http://127.0.0.1:6333"],
    // /readyz, not /livez: "the process is up" is not the same claim as "it
    // can answer a search", and this page exists to tell them apart.
    path: "/readyz",
    expect: "any-2xx",
  },
  {
    id: "minio",
    // Published on loopback so a host-run app probes the same store the
    // containerised one writes to.
    hostPublished: true,
    label: "Object store (MinIO)",
    purpose:
      "Where the lakehouse's Parquet files live. Without it the catalog has nowhere to write and every table operation fails.",
    candidates: ["http://minio:9000", "http://127.0.0.1:9000"],
    // /ready, not /live: this page exists to tell "the process is up" from
    // "it can serve an object".
    path: "/minio/health/ready",
    expect: "any-2xx",
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
  /**
   * Whichever instance answered this request. On Kubernetes this is the POD
   * NAME, which is the point: behind a Service with N replicas, each refresh
   * of this page can be answered by a different one, and the numbers below
   * belong to that one only. Without saying so, the CPU figure looks like it
   * is jumping around when it is really three different machines taking turns.
   */
  hostname: string;
  /** "web" or "analytics" — see APP_ROLE. */
  role: string;
  /** Worker processes in this instance. Per-process limits multiply by it. */
  workers: number;
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
 * Every service in the catalogue is installed by every install — there are no
 * profiles and nothing to opt into — so "down" means down. It used to read
 * "Not running" in grey for anything behind a profile, which was right when a
 * service could legitimately have never been started and is now a way to make
 * a real outage look deliberate.
 */
export function statusTone(p: Pick<ServiceProbe, "status">): {
  tone: "ok" | "warn" | "critical" | "muted";
  label: string;
} {
  if (p.status === "up") return { tone: "ok", label: "Healthy" };
  if (p.status === "degraded") return { tone: "warn", label: "Degraded" };
  if (p.status === "not-deployed") return { tone: "muted", label: "Not deployed" };
  if (p.status === "unreachable") return { tone: "muted", label: "Can't check from here" };
  return { tone: "critical", label: "Down" };
}

// The one-line summary above the services table.
//
// MEASURED as a source certainty on /monitoring: the header read
// `unhealthy.length === 0 ? "No problems detected" : …`, which asserts health
// whenever the probe set is EMPTY — a first-load failure (the catch keeps
// services at []), a misconfiguration that returns no probes, or an
// all-filtered set. On a page whose entire job is to tell you whether anything
// is wrong, "No problems detected" over zero probes is the reassurance it
// exists to prevent. The fix distinguishes "nothing was checked" from
// "everything checked out", and lets a load error speak instead of a health
// claim it cannot support.
export function servicesSummary(args: {
  services: { status: ServiceStatus }[];
  unhealthy: number;
  /** A load error is present — the probes on hand are stale or absent. */
  errored: boolean;
}): string {
  // A failed refresh leaves the PREVIOUS probes on screen — the page's catch
  // sets the error and nothing else — and the page re-polls every 15s, so a
  // network that stays down freezes this line on its last value for as long as
  // the tab is open. The first pass let the verdict stand and left the banner to
  // carry the failure; that is two surfaces for one claim, and a reader who
  // takes the header at its word takes a reassurance the page can no longer
  // support. The asymmetry is the familiar one: over a stale snapshot a
  // needs-attention count is a floor still worth acting on, while "no problems"
  // is sound in no direction at all — anything could have broken since. So the
  // verdict moves into the past tense and names the check it came from, which is
  // what the timestamp beside it has meant all along.
  if (args.errored) {
    if (args.services.length === 0) return "Health unknown — could not probe";
    return args.unhealthy === 0
      ? "No problems at the last successful check"
      : `${args.unhealthy} needing attention at the last successful check`;
  }
  if (args.services.length === 0) return "No services to probe";
  if (args.unhealthy === 0) return "No problems detected";
  return `${args.unhealthy} needing attention`;
}

// The banner says the refresh failed. It does not say that the gauges, the
// service rows and the capacity figures beneath it all stopped moving at that
// moment — while the page's own subtitle promises what the machine is doing
// "right now". One line, once, above everything that is no longer live. A
// monitoring board that quietly freezes on its last good reading is the exact
// failure this page exists to catch.
export function stalenessNotice(args: {
  errored: boolean;
  hasServices: boolean;
  hasMetrics: boolean;
}): string | null {
  if (!args.errored) return null;
  // Nothing was ever loaded: the banner and the unknown-health header already
  // say so, and there is no stale figure to warn about.
  if (!args.hasServices && !args.hasMetrics) return null;
  return "Live updates have stopped — every figure below is from the last successful check, not from now.";
}
