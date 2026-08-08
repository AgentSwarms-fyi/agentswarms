// AgentSwarms JS sandbox — server-side execution of user-authored Function and
// custom-component nodes, for HEADLESS swarm runs (deployed API keys and
// schedules). The canvas keeps using the in-browser Worker sandbox.
//
// Why a separate container at all: the app process holds the service-role key,
// provider credentials and the database connection. Running user JavaScript
// there would put all of it one prototype-chain trick away, which is why the
// executor refused custom code outright before this service existed. Here the
// snippet runs in a process that holds no secrets, on a network with no route
// out, in a container that is non-root with a read-only filesystem and every
// capability dropped — and each request gets a fresh realm inside a worker
// thread that is terminated afterwards.
//
// The service is stateless and holds nothing between requests. It authenticates
// callers with the app's internal shared secret and refuses to start without
// one, so an accidentally-exposed port is not an open code-execution endpoint.
import http from "node:http";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8091);
const SECRET = process.env.INTERNAL_RUN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
// Ceilings the CALLER cannot raise. A deployed swarm is unattended, so a bad
// snippet must not be able to pin a core indefinitely.
const MAX_TIMEOUT_MS = Number(process.env.JS_SANDBOX_MAX_TIMEOUT_MS || 5000);
const MAX_BODY_BYTES = Number(process.env.JS_SANDBOX_MAX_BODY_BYTES || 1_000_000);
const MAX_CONCURRENT = Number(process.env.JS_SANDBOX_MAX_CONCURRENT || 4);

if (!SECRET) {
  console.error(
    "[js-sandbox] refusing to start: INTERNAL_RUN_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is required.",
  );
  process.exit(1);
}

let inFlight = 0;

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function runInWorker(code, ctx, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const worker = new Worker(resolve(__dirname, "worker.mjs"), {
      workerData: { code, ctx, timeoutMs },
      // The snippet gets no environment and no argv: the container's env is
      // not the snippet's business even though it holds no secrets.
      env: {},
      argv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: Number(process.env.JS_SANDBOX_MEM_MB || 128),
        maxYoungGenerationSizeMb: 32,
      },
      stdout: true,
      stderr: true,
    });
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      worker.terminate().catch(() => {});
      resolvePromise(payload);
    };
    // A little grace over the snippet's own deadline so the in-worker timer
    // reports the nicer message first; this is the hard backstop.
    const killer = setTimeout(
      () => done({ ok: false, error: `Function timed out after ${timeoutMs}ms`, logs: [] }),
      timeoutMs + 250,
    );
    worker.on("message", done);
    worker.on("error", (e) => done({ ok: false, error: String(e?.message ?? e), logs: [] }));
    worker.on("exit", (codeNum) => {
      if (settled) return;
      done({
        ok: false,
        error:
          codeNum === 1
            ? "The snippet exceeded the sandbox memory limit."
            : `Sandbox worker exited unexpectedly (code ${codeNum}).`,
        logs: [],
      });
    });
  });
}

const server = http.createServer((req, res) => {
  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  // Unauthenticated liveness only — it reveals nothing and runs nothing.
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });

  if (req.method !== "POST" || req.url !== "/run")
    return send(404, { ok: false, error: "not found" });

  const auth = req.headers["x-internal-run-secret"];
  if (!auth || !constantTimeEquals(auth, SECRET)) {
    return send(401, { ok: false, error: "unauthorized" });
  }
  if (inFlight >= MAX_CONCURRENT) {
    return send(503, { ok: false, error: "sandbox busy" });
  }

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      send(413, { ok: false, error: "payload too large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (res.writableEnded) return;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, { ok: false, error: "invalid JSON body" });
    }
    const code = typeof payload?.code === "string" ? payload.code : "";
    if (!code.trim()) return send(400, { ok: false, error: "code is required" });
    const timeoutMs = Math.max(100, Math.min(Number(payload?.timeoutMs) || 2000, MAX_TIMEOUT_MS));
    const ctx = payload?.ctx ?? {};
    inFlight++;
    try {
      const result = await runInWorker(code, ctx, timeoutMs);
      send(200, result);
    } finally {
      inFlight--;
    }
  });
});

server.listen(PORT, () => {
  console.log(
    `[js-sandbox] listening on :${PORT} (max ${MAX_CONCURRENT} concurrent, ${MAX_TIMEOUT_MS}ms ceiling)`,
  );
});
