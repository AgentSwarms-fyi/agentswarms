// The production HTTP entry.
//
// WHY THIS EXISTS. The built server bundle exports a Web Fetch handler and
// nothing that binds a port, so the only thing serving production was
// `vite preview` — a tool Vite documents for looking at a build locally. It
// ran one Node process, which means one core of request handling however large
// the host, and it carried the dev toolchain into the runtime image.
//
// Measured on an 8-core box while Docker and a dev server were also running:
// SSR throughput went 19 -> 55 req/s and p50 460ms -> 127ms purely from
// forking workers. Static assets were ~1,940 req/s either way, which is how we
// know SSR is the bottleneck and the HTTP layer is not.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("production server entry", () => {
  const server = read("server.mjs");

  it("serves the built fetch handler rather than re-implementing routing", () => {
    // The bundle's default export is `{ fetch }`. Anything else here would be
    // a second copy of the framework's request handling.
    expect(server).toContain('import("./dist/server/server.js")');
    expect(server).toContain("mod.default ?? mod.server");
    expect(server).toContain("app.fetch");
  });

  it("fails loudly when the build is missing", () => {
    // Otherwise the container starts, binds a port and 500s every request,
    // which looks like an app bug rather than a missing build step.
    expect(server).toContain("run `npm run build` first");
  });

  it("serves client assets so SSR never sees an asset request", () => {
    expect(server).toContain("srvx/static");
    expect(server).toContain('path.join(HERE, "dist", "client")');
  });

  it("forks one worker per CPU by default, and honours WEB_CONCURRENCY", () => {
    // The default has to be "use the machine": an operator should not have to
    // discover clustering to get more than one core's worth of throughput.
    expect(server).toContain("WEB_CONCURRENCY");
    expect(server).toContain("os.availableParallelism");
    expect(server).toContain("cluster.fork()");
    // reusePort is what lets every worker bind the same port; without it the
    // second worker dies with EADDRINUSE.
    expect(server).toContain("reusePort: true");
  });

  it("lets a container-per-core deployment turn clustering off", () => {
    // WEB_CONCURRENCY=1 must mean "no primary, no fork" — forking inside a
    // container pinned to one CPU makes workers fight over a fractional quota.
    expect(server).toContain("workers > 1 && cluster.isPrimary");
  });

  it("restarts a dead worker, but not while shutting down", () => {
    // Refilling the pool during shutdown stops the container ever exiting.
    expect(server).toContain('cluster.on("exit"');
    expect(server).toContain("if (shuttingDown) return;");
  });

  it("drains on SIGTERM instead of cutting live requests", () => {
    expect(server).toContain('"SIGTERM"');
    expect(server).toContain("server.close?.()");
  });
});

// Behavioural coverage for the sizing rule, driven through the REAL functions
// lifted out of server.mjs — a second copy here would be free to disagree with
// what actually ships.
//
// server.mjs binds a port on import, so it cannot simply be imported. The slice
// between these two markers is the pure part.
function sizing(opts: { cpuMax?: string; v1?: { quota: string; period: string }; cpus: number }) {
  const src = read("server.mjs");
  const start = src.indexOf("function cgroupCpuLimit()");
  const end = src.indexOf("async function startWorker()");
  expect(start, "cgroupCpuLimit() moved — this harness needs updating").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const readFileSync = (p: string) => {
    if (p === "/sys/fs/cgroup/cpu.max") {
      if (opts.cpuMax === undefined) throw new Error("ENOENT");
      return opts.cpuMax;
    }
    if (p === "/sys/fs/cgroup/cpu/cpu.cfs_quota_us") {
      if (!opts.v1) throw new Error("ENOENT");
      return opts.v1.quota;
    }
    if (p === "/sys/fs/cgroup/cpu/cpu.cfs_period_us") {
      if (!opts.v1) throw new Error("ENOENT");
      return opts.v1.period;
    }
    throw new Error("ENOENT");
  };
  const factory = new Function(
    "readFileSync",
    "os",
    "process",
    `${src.slice(start, end)}\nreturn workerCount;`,
  ) as (
    r: typeof readFileSync,
    o: { availableParallelism: () => number; cpus: () => unknown[] },
    p: { env: Record<string, string | undefined> },
  ) => () => number;

  return factory(
    readFileSync,
    { availableParallelism: () => opts.cpus, cpus: () => new Array(opts.cpus) },
    { env: {} },
  )();
}

describe("static assets are served with the type the browser requires", () => {
  // FOUND FROM THE UI, two layers from the symptom. The Data Catalog showed
  // "Local tables: 0" on a workspace holding 33 datasets. The catalog's loader
  // registers every dataset into the browser DuckDB engine before returning
  // their metadata, that engine is WebAssembly, and this server was serving
  // .wasm as application/octet-stream — which WebAssembly.compileStreaming
  // refuses outright. So the engine never started, the loader threw, and the
  // page rendered an empty list with no error anywhere near the cause.
  //
  // `vite preview` set this header. Replacing it with server.mjs is what broke
  // it, which is precisely why it is pinned here.
  const server = read("server.mjs");

  it("serves .wasm as application/wasm", () => {
    expect(server).toContain('".wasm": "application/wasm"');
  });

  it("applies the correction to the static handler", () => {
    // Declaring the map without wrapping the handler would fix nothing.
    expect(server).toContain("correctContentTypes(serveStatic(");
  });

  it("only overrides types it means to", () => {
    // js, css, woff2, svg and png were measured as already correct; blanket
    // rewriting would be a new way to get this wrong.
    expect(server).toContain("CONTENT_TYPE_FIXES[ext]");
    expect(server).toContain('res.headers.get("content-type") === want');
  });

  it("preserves the response body and status while replacing the header", () => {
    expect(server).toContain("new Response(res.body, { status: res.status");
  });
});

describe("static compression", () => {
  // THE BUG, end to end: the Data Catalog showed "Local tables: 0" on a
  // workspace holding 33 datasets. The catalog registers every dataset into the
  // browser DuckDB engine before listing them; that engine is a 32.7 MB
  // WebAssembly module; and srvx's static handler compresses with
  // `createBrotliCompress()` — brotli at its default quality 11 — whenever the
  // client's Accept-Encoding mentions `br`, which every browser's does.
  //
  // MEASURED on that file, through the shipped middleware:
  //     identity                  754 ms
  //     br  (srvx's own default)  157,213 ms   <- the download never finished
  //     gzip (this code)            1,774 ms
  //
  // So the fix is not "add compression", it is "stop srvx compressing" and do
  // it at a quality meant for per-request work.
  const server = read("server.mjs");

  it("keeps srvx out of the compression business", () => {
    expect(server).toContain("asIdentityRequest(request)");
    expect(server).toContain('"accept-encoding" ? "identity"');
  });

  it("uses a proxy rather than rebuilding the request", () => {
    // srvx's static handler reads `req._url`, its own cached parsed URL. A
    // rebuilt Request loses it and the connection resets mid-response — which
    // looks exactly like the problem being fixed.
    expect(server).toContain("_url");
    expect(server).toContain("new Proxy(request");
    // Comments stripped: the block above explains at length why the rebuilt
    // Request is wrong, and matching that prose fails on the explanation.
    const code = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("new Request(request, { headers");
  });

  it("gzips compressible bodies when the client accepts it", () => {
    expect(server).toContain('new CompressionStream("gzip")');
    expect(server).toContain("COMPRESSIBLE");
  });

  it("drops Content-Length and sets Vary when it re-encodes", () => {
    // A stale Content-Length truncates the body; a missing Vary poisons any
    // shared cache for clients that did not ask for gzip.
    expect(server).toContain('headers.delete("content-length")');
    expect(server).toContain('headers.set("vary", "accept-encoding")');
  });

  it("never compresses a partial or already-encoded response", () => {
    expect(server).toContain("res.status !== 200");
    expect(server).toContain('res.headers.get("content-encoding")');
  });
});

describe("worker count respects a container CPU quota", () => {
  // MEASURED on Docker 28 / Node 22: availableParallelism() reports the CPU
  // quota correctly at 1 core and above, but at --cpus=0.5 it reports the
  // HOST's core count. `limits.cpu: 500m` is an ordinary Kubernetes setting, so
  // on a large node that spawned one worker per host core, each ~0.5-1 GB RSS.
  it("gives a sub-core quota one worker, not one per host core", () => {
    expect(sizing({ cpuMax: "50000 100000", cpus: 8 })).toBe(1);
    expect(sizing({ cpuMax: "25000 100000", cpus: 64 })).toBe(1);
  });

  it("matches the quota when it is a whole number of cores", () => {
    expect(sizing({ cpuMax: "200000 100000", cpus: 8 })).toBe(2);
    expect(sizing({ cpuMax: "400000 100000", cpus: 8 })).toBe(4);
  });

  it("floors a fractional quota — half a core does not buy a second worker", () => {
    expect(sizing({ cpuMax: "250000 100000", cpus: 8 })).toBe(2);
  });

  it("uses the whole machine when nothing is limiting it", () => {
    // The entire point: a big host is used by default, not by configuration.
    expect(sizing({ cpus: 16 })).toBe(16);
    expect(sizing({ cpuMax: "max 100000", cpus: 16 })).toBe(16);
  });

  it("reads the cgroup v1 layout too", () => {
    expect(sizing({ v1: { quota: "200000", period: "100000" }, cpus: 8 })).toBe(2);
    // -1 is v1's "unlimited".
    expect(sizing({ v1: { quota: "-1", period: "100000" }, cpus: 8 })).toBe(8);
  });

  it("never exceeds what the runtime says it can run in parallel", () => {
    // A generous quota on a small machine must not over-fork.
    expect(sizing({ cpuMax: "1600000 100000", cpus: 2 })).toBe(2);
  });
});

describe("the worker count reaches the app that has to size against it", () => {
  // The lakehouse engine is per PROCESS, so its memory limit is charged once
  // per worker. The admin page showed that setting as if it were a per-machine
  // budget. Publishing the count through the environment keeps one source of
  // truth: re-deriving it in the app would drift the moment WEB_CONCURRENCY or
  // a CPU quota moved the real number.
  it("the server publishes the count before forking", () => {
    const server = read("server.mjs");
    expect(server).toContain("process.env.AGENTSWARMS_WORKERS =");
    // Must be set BEFORE fork(), or workers inherit an unset value.
    expect(server.indexOf("process.env.AGENTSWARMS_WORKERS =")).toBeLessThan(
      server.indexOf("cluster.fork()"),
    );
  });

  it("the app reads it rather than counting CPUs itself", () => {
    const cfg = read("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain("AGENTSWARMS_WORKERS");
    // os.cpus() reports the MACHINE even under a CPU quota (measured: 8 inside
    // a --cpus=2 container), so it is the wrong basis for either number.
    expect(cfg).toContain("os.availableParallelism");
    expect(cfg).not.toMatch(/cpus:\s*Math\.max\(1,\s*os\.cpus\(\)/);
  });

  it("defaults to one worker when nothing published a count", () => {
    // `vite dev` runs a single process and never sets the variable; reporting
    // 0 or NaN there would render "NaN GB" on the admin page.
    const cfg = read("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain("Number.isFinite(declared) && declared >= 1");
  });

  it("the admin page multiplies the lakehouse limit by it", () => {
    const tab = read("src/components/admin/RuntimeTab.tsx");
    expect(tab).toContain("state?.host?.workers ?? 1");
    expect(tab).toContain("lakehousePerWorkerGb * Math.max(1, workers)");
    expect(tab).toContain("Lakehouse capacity");
  });
});

describe("the image and scripts use it", () => {
  it("the Dockerfile runs the entry, not vite preview", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain('CMD ["node", "server.mjs"]');
    expect(dockerfile).not.toMatch(/CMD \[.*preview/);
  });

  it("npm start runs it too", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe("node server.mjs");
    // `preview` stays: it is still the right tool for looking at a build
    // locally, which is what it is for.
    expect(pkg.scripts.preview).toBe("vite preview");
  });
});
