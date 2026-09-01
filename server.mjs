// Production HTTP entry.
//
// WHY THIS EXISTS. The built server bundle (`dist/server/server.js`) exports a
// Web Fetch handler and nothing else — no `listen`, no port. The only thing
// that bound a port was `vite preview`, which Vite documents as a way to look
// at a production build locally, not as a production server: it carries the
// dev toolchain into the runtime image and gives you no control over
// concurrency, timeouts or shutdown.
//
// The consequence that actually mattered was concurrency. Node runs JavaScript
// on one thread, so one `vite preview` process served roughly one core no
// matter how large the host was. A 64-core machine ran 1/64th of itself unless
// the operator hand-rolled many containers. This forks one worker per core by
// default, so a big machine is used by default rather than by accident.
//
// Everything here is deliberately boring: srvx (already a dependency, and what
// the framework itself uses) bridges Node HTTP to Fetch, `node:cluster` forks
// the workers, and the parent restarts a worker that dies.
import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOSTNAME = process.env.HOST || "0.0.0.0";

/**
 * The container's CPU quota in cores, or null when there is no quota to find
 * (bare metal, an unlimited cgroup, or a non-Linux host).
 *
 * WHY THIS IS NEEDED, MEASURED on Docker 28 / Node 22:
 *
 *   --cpus=4    availableParallelism() = 4    correct
 *   --cpus=2    availableParallelism() = 2    correct
 *   --cpus=1.5  availableParallelism() = 1    correct
 *   --cpus=0.5  availableParallelism() = 8    WRONG — the host's core count
 *
 * libuv reads the cgroup quota, but below one whole CPU it gives up and reports
 * the machine. That is the dangerous direction: `resources.limits.cpu: 500m` is
 * an ordinary Kubernetes request, and on a 64-core node it would fork 64
 * workers at ~0.5-1 GB RSS each — an OOMKill presented as a crash loop. Reading
 * the quota ourselves turns the one case libuv gets wrong into one worker.
 */
function cgroupCpuLimit() {
  // cgroup v2: "<quota> <period>", or "max <period>" when unlimited.
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota === "max") return null;
    const cores = Number(quota) / Number(period || 100000);
    return Number.isFinite(cores) && cores > 0 ? cores : null;
  } catch {
    // Not cgroup v2, or not readable — try v1 below.
  }
  // cgroup v1 splits the same numbers across two files; quota -1 is unlimited.
  try {
    const quota = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8"));
    const period = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8"));
    if (quota > 0 && period > 0) return quota / period;
  } catch {
    // No cgroup CPU controller — nothing is limiting us.
  }
  return null;
}

/**
 * Workers to fork. `WEB_CONCURRENCY` is the convention Heroku/Render/Fly and
 * most Node images already use; 0 or 1 means "run in this process", which is
 * what a container-per-core deployment wants.
 *
 * Otherwise: every core the process may actually use. On a bare host that is
 * the whole machine — the point of the exercise. In a container it is the CPU
 * quota, never more, so the default is safe to leave alone anywhere.
 */
function workerCount() {
  const raw = process.env.WEB_CONCURRENCY?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  // An analytics node exists to run ONE big query engine, and the engine is
  // per process — forking would divide the memory limit it was sized for into
  // N independent copies, each able to claim the whole figure. One worker is
  // the only default that makes `LAKEHOUSE_MEMORY_LIMIT=64GB` mean what the
  // operator who typed it meant. WEB_CONCURRENCY above still overrides.
  // Kept in step with src/utils/appRole.ts by a test.
  if ((process.env.APP_ROLE ?? "").trim().toLowerCase() === "analytics") return 1;
  const reported = Math.max(1, os.availableParallelism?.() ?? os.cpus()?.length ?? 1);
  const quota = cgroupCpuLimit();
  // Floor, not round: half a core's worth of quota buys one worker, not two.
  return quota === null ? reported : Math.max(1, Math.min(reported, Math.floor(quota)));
}

/**
 * Content types the static handler gets wrong, by extension.
 *
 * FOUND FROM THE UI: the Data Catalog reported "Local tables: 0" on a workspace
 * with 33 datasets. The cause was two layers down — srvx's static handler
 * served `.wasm` as `application/octet-stream`, so
 * `WebAssembly.compileStreaming` refused the module ("Incorrect response MIME
 * type"), the browser DuckDB engine never started, and the catalog's loader —
 * which registers every dataset into that engine before returning their
 * metadata — threw and yielded an empty list. `vite preview` set this header,
 * so replacing it with this server is what introduced the bug.
 *
 * Only .wasm is wrong; js, css, woff2, svg and png were all checked and are
 * correct. It is a map rather than a special case so the next one is a line.
 */
const CONTENT_TYPE_FIXES = { ".wasm": "application/wasm" };

/** Wrap a static handler so those extensions get the type they need. */
function correctContentTypes(handler) {
  return async (request, next) => {
    const res = await handler(request, next);
    if (!res) return res;
    const ext = new URL(request.url).pathname.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
    const want = ext && CONTENT_TYPE_FIXES[ext];
    if (!want || res.headers.get("content-type") === want) return res;
    const headers = new Headers(res.headers);
    headers.set("content-type", want);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * Compress static responses the client is willing to decompress.
 *
 * WHY IT MATTERS MORE THAN IT SOUNDS: the browser DuckDB engine is a 32.7 MB
 * WebAssembly module, and every first visit downloaded all of it uncompressed.
 * It gzips to 7.4 MB — a 4.4x saving on the single largest thing this app
 * serves, paid by every new visitor and on every cache-busting deploy.
 * `vite preview` did not compress either, so this is not a regression; it was
 * simply never done, and nothing surfaced it until a slow link made the
 * download fail outright and the Data Catalog quietly showed zero tables.
 *
 * Compressing on the fly rather than at build time keeps this self-contained;
 * assets are content-hashed and immutable, so a browser pays it once.
 */
const COMPRESSIBLE = /^(?:text\/|image\/svg|application\/(?:javascript|json|wasm|xml))/i;

/**
 * The same request object, reporting `identity` for Accept-Encoding.
 *
 * A PROXY, not `new Request(request, { headers })`. srvx's static handler reads
 * `req._url` — its own cached parsed URL, not part of the Request interface —
 * and a rebuilt Request does not carry it. Doing that reset the connection
 * mid-response, which looked exactly like the transfer problem this code is
 * here to fix. The proxy changes one header lookup and leaves the object
 * otherwise itself.
 */
function asIdentityRequest(request) {
  const headers = new Proxy(request.headers, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      if (prop !== "get") return bound;
      return (name) =>
        String(name).toLowerCase() === "accept-encoding" ? "identity" : bound(name);
    },
  });
  return new Proxy(request, {
    get(target, prop) {
      if (prop === "headers") return headers;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function compressStatic(handler) {
  return async (request, next) => {
    // ASK THE INNER HANDLER FOR AN UNCOMPRESSED BODY.
    //
    // MEASURED, and the reason this wrapper exists at all: srvx's static
    // handler compresses with `createBrotliCompress()` — brotli at its default
    // quality 11 — whenever the client's Accept-Encoding mentions `br`, which
    // every browser's does. On the 32.7 MB WebAssembly engine that took
    // **157 seconds per request**, so the download never finished, the browser
    // SQL engine never started, and the Data Catalog reported "Local tables: 0"
    // on a workspace holding 33 of them. The same file with Accept-Encoding
    // identity: 644 ms.
    //
    // Brotli at that quality is for build-time compression, not per-request.
    // Stripping the header here keeps srvx out of the compression business and
    // lets the gzip below — fast, and 4.4x on this file — do the job.
    const res = await handler(asIdentityRequest(request), next);

    // 200 only: compressing a 206 would misreport the byte range, and a body
    // that is already encoded must be left alone.
    if (!res?.body || res.status !== 200 || res.headers.get("content-encoding")) return res;
    if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) return res;
    if (!COMPRESSIBLE.test(res.headers.get("content-type") ?? "")) return res;

    const headers = new Headers(res.headers);
    headers.set("content-encoding", "gzip");
    // The compressed length is not known until it is written, and a stale
    // Content-Length is worse than none: the client truncates the body.
    headers.delete("content-length");
    headers.set("vary", "accept-encoding");
    return new Response(res.body.pipeThrough(new CompressionStream("gzip")), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

async function startWorker() {
  const [{ serve }, { serveStatic }, mod] = await Promise.all([
    import("srvx"),
    import("srvx/static"),
    import("./dist/server/server.js"),
  ]);
  const app = mod.default ?? mod.server;
  if (typeof app?.fetch !== "function") {
    throw new Error(
      "dist/server/server.js did not export a fetch handler — run `npm run build` first.",
    );
  }

  const server = serve({
    port: PORT,
    hostname: HOSTNAME,
    // Every worker binds the same port; the OS balances accepts between them.
    // Without this the second worker dies with EADDRINUSE.
    reusePort: true,
    // Client assets are hashed and immutable; the SSR handler should never see
    // a request for one.
    // Order matters: the type fix runs first (innermost) so the compressor
    // sees the corrected Content-Type when deciding what is compressible.
    middleware: [
      compressStatic(correctContentTypes(serveStatic({ dir: path.join(HERE, "dist", "client") }))),
    ],
    fetch: app.fetch,
  });

  await server.ready?.();
  const who = cluster.isWorker ? `worker ${process.pid}` : `single process ${process.pid}`;
  console.log(`[agentswarms] ${who} listening on http://${HOSTNAME}:${PORT}`);

  // SIGTERM is how a container runtime asks for a clean stop. Without a handler
  // Node exits immediately and in-flight requests are cut mid-response.
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      console.log(`[agentswarms] ${who} draining on ${signal}`);
      Promise.resolve(server.close?.()).finally(() => process.exit(0));
    });
  }
}

const workers = workerCount();

// Publish the count to the app, which needs it to size PER-PROCESS resources —
// the lakehouse engine lives in every worker, so its memory limit is charged N
// times over. Passing it through the environment (forked workers inherit it)
// keeps ONE source of truth: the app never re-derives the number and so can
// never disagree with how many processes actually exist. Unset under `vite dev`,
// where the answer is correctly 1.
process.env.AGENTSWARMS_WORKERS = String(workers < 1 ? 1 : workers);

if (workers > 1 && cluster.isPrimary) {
  console.log(
    `[agentswarms] primary ${process.pid} forking ${workers} workers ` +
      `(WEB_CONCURRENCY to override; 1 = no cluster)`,
  );
  for (let i = 0; i < workers; i++) cluster.fork();

  // A worker that dies takes its share of traffic with it, so replace it —
  // except during shutdown, where refilling the pool would stop the container
  // from ever exiting.
  let shuttingDown = false;
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    console.warn(
      `[agentswarms] worker ${worker.process.pid} exited (${signal || code}) — restarting`,
    );
    cluster.fork();
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      shuttingDown = true;
      for (const w of Object.values(cluster.workers ?? {})) w?.kill(signal);
    });
  }
} else {
  await startWorker();
}
