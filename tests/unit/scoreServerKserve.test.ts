// The scorer as a KServe pod (R532): it asks the app for its own model,
// proving which endpoint it is with that endpoint's port token, keeps asking
// while the app cannot be reached, still refuses an artifact whose digest is
// not the one the registry recorded, and answers a token-less health check (a
// Kubernetes probe) with ready-or-not and nothing more.
//
// The real score_server.py, run as a process, against a stub of the app's
// serving API. The model program is a stub too, so this runs without the ML
// stack.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const python = ["python3", "python", "py"].find(
  (c) => spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0,
);
const hasStdlib =
  python !== undefined &&
  spawnSync(python, ["-c", "import urllib.request"], { encoding: "utf8" }).status === 0;

const PROGRAM = `
import hashlib

def _ensure_packages():
    pass

def _fetch_artifact(uri):
    raise RuntimeError("the program's own fetch was used")

def _download_artifact(cfg):
    blob = _fetch_artifact(cfg["artifact_uri"])
    if hashlib.sha256(blob).hexdigest() != cfg["artifact_sha256"]:
        raise RuntimeError("Artifact digest mismatch")
    return {"algorithm": "stub", "blob": blob.decode()}

def _predict(cfg, warnings):
    rows = cfg["input"]["rows"]
    return {"columns": ["n_fields"], "rows": [[len(r)] for r in rows]}
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let proc: ChildProcess | null = null;
let app: Server | null = null;
afterEach(async () => {
  proc?.kill();
  proc = null;
  await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
  app = null;
});

const TOKEN = "the-token";
const ENDPOINT = "serving/ml-0123456789abcdef0123";

/** The app's serving API: answers only the right endpoint with the right token. */
async function startApp(opts: { artifact: string; recorded: string; downFor?: number }) {
  const seen: { path: string; token?: string; endpoint?: string }[] = [];
  let refusedUntil = Date.now() + (opts.downFor ?? 0);
  app = createHttpServer((req, res) => {
    seen.push({
      path: req.url ?? "",
      token: req.headers["x-port-token"] as string | undefined,
      endpoint: req.headers["x-endpoint"] as string | undefined,
    });
    if (Date.now() < refusedUntil) {
      res.writeHead(503).end();
      return;
    }
    refusedUntil = 0;
    if (req.headers["x-port-token"] !== TOKEN || req.headers["x-endpoint"] !== ENDPOINT) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not this endpoint" }));
      return;
    }
    if (req.url === "/api/ml/serving/bundle") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: PROGRAM,
          config: {
            model_id: "m1",
            version: 3,
            artifact_uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
            artifact_sha256: createHash("sha256").update(opts.recorded).digest("hex"),
          },
          env: {},
        }),
      );
      return;
    }
    if (req.url === "/api/ml/serving/artifact") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(opts.artifact);
      return;
    }
    res.writeHead(404).end();
  });
  const appPort = await freePort();
  await new Promise<void>((r) => app!.listen(appPort, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${appPort}/api/ml/serving`, seen };
}

async function startScorer(servingUrl: string) {
  const port = await freePort();
  proc = spawn(python!, [path.resolve("docker/notebook-runtime/score_server.py")], {
    env: {
      ...process.env,
      AGENTSWARMS_SERVING_URL: servingUrl,
      AGENTSWARMS_ENDPOINT: ENDPOINT,
      KG_IP: "127.0.0.1",
      KG_PORT: String(port),
      KG_AUTH_TOKEN: TOKEN,
      AGENTSWARMS_ORIGIN: "",
      AGENTSWARMS_TOKEN: "",
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  // Until it listens, and then until it has finished loading or failed.
  for (let i = 0; i < 450; i++) {
    try {
      const r = await fetch(`${base}/healthz`, { headers: { "X-Port-Token": TOKEN } });
      const body = (await r.json()) as { ready: boolean; error: string | null };
      if (body.ready || body.error) return base;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the scorer never answered");
}

describe.skipIf(!python || !hasStdlib)("the scorer as a KServe pod", () => {
  it("loads its own model from the app, proving which endpoint it is", async () => {
    const stub = await startApp({ artifact: "fitted", recorded: "fitted" });
    const base = await startScorer(stub.url);

    expect(stub.seen.map((s) => s.path)).toEqual([
      "/api/ml/serving/bundle",
      "/api/ml/serving/artifact",
    ]);
    for (const s of stub.seen) expect(s).toMatchObject({ token: TOKEN, endpoint: ENDPOINT });

    // A probe has no token: ready or not, and nothing about the model.
    const probe = await fetch(`${base}/healthz`);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ ready: true });

    const full = (await (
      await fetch(`${base}/healthz`, { headers: { Authorization: `token ${TOKEN}` } })
    ).json()) as { ready: boolean; version: number; algorithm: string };
    expect(full).toMatchObject({ ready: true, version: 3, algorithm: "stub" });

    const body = JSON.stringify({ rows: [{ a: 1, b: 2 }, { a: 1 }] });
    expect((await fetch(`${base}/score`, { method: "POST", body })).status).toBe(401);
    const scored = await fetch(`${base}/score`, {
      method: "POST",
      body,
      headers: { "X-Port-Token": TOKEN },
    });
    expect(scored.status).toBe(200);
    expect(await scored.json()).toMatchObject({ columns: ["n_fields"], rows: [[2], [1]] });

    // A wrong token is refused; and on the SAME kept-alive connection after a
    // refusal, the next request is still read as a request (it was a 501).
    const wrong = await fetch(`${base}/score`, {
      method: "POST",
      body,
      headers: { "X-Port-Token": "the-tokeN" },
    });
    expect(wrong.status).toBe(401);
    const after = await fetch(`${base}/score`, {
      method: "POST",
      body,
      headers: { Authorization: `token ${TOKEN}` },
    });
    expect(after.status).toBe(200);
  }, 60_000);

  it("keeps asking while the app cannot answer, then loads", async () => {
    const stub = await startApp({ artifact: "fitted", recorded: "fitted", downFor: 3_000 });
    const base = await startScorer(stub.url);
    const full = (await (
      await fetch(`${base}/healthz`, { headers: { "X-Port-Token": TOKEN } })
    ).json()) as { ready: boolean };
    expect(full.ready).toBe(true);
    expect(stub.seen.filter((s) => s.path.endsWith("/bundle")).length).toBeGreaterThan(1);
  }, 60_000);

  it("refuses an artifact whose digest is not the one recorded", async () => {
    const stub = await startApp({ artifact: "tampered", recorded: "fitted" });
    const base = await startScorer(stub.url);
    const probe = await fetch(`${base}/healthz`);
    expect(probe.status).toBe(503);
    expect(await probe.json()).toEqual({ ready: false });
    const full = (await (
      await fetch(`${base}/healthz`, { headers: { "X-Port-Token": TOKEN } })
    ).json()) as { error: string };
    expect(full.error).toMatch(/digest mismatch/);
  }, 60_000);
});
