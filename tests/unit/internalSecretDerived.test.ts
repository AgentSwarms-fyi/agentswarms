// R463: an install without INTERNAL_RUN_SECRET no longer sends the database
// master key in a request header. The app and the JS sandbox both derive the
// same secret from it, and the sandbox drops the key from its environment.
//
// The sandbox half runs the REAL service in a child process, with the exact
// environment docker-compose.yml gives it in each case.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { INTERNAL_SECRET_LABEL, internalRunSecret } from "@/utils/internalOrigin.server";

const KEY = "service-role-key-for-the-test";
const derive = (k: string) => createHmac("sha256", k).update(INTERNAL_SECRET_LABEL).digest("hex");

const saved = {
  own: process.env.INTERNAL_RUN_SECRET,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
afterEach(() => {
  if (saved.own === undefined) delete process.env.INTERNAL_RUN_SECRET;
  else process.env.INTERNAL_RUN_SECRET = saved.own;
  if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
});

describe("the app's side", () => {
  it("uses INTERNAL_RUN_SECRET when it is set", () => {
    process.env.INTERNAL_RUN_SECRET = "own-secret";
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
    expect(internalRunSecret()).toBe("own-secret");
  });

  it("without it, derives a secret from the key instead of sending the key", () => {
    delete process.env.INTERNAL_RUN_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
    const s = internalRunSecret();
    expect(s).toBe(derive(KEY));
    expect(s).not.toContain(KEY);
  });

  it("has nothing to offer with neither", () => {
    delete process.env.INTERNAL_RUN_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(internalRunSecret()).toBeNull();
  });

  it("both sides derive under one label", () => {
    const sandbox = readFileSync("services/js-sandbox/server.mjs", "utf8");
    expect(sandbox).toContain(`const INTERNAL_SECRET_LABEL = "${INTERNAL_SECRET_LABEL}";`);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | null = null;
afterEach(() => {
  child?.kill();
  child = null;
});

/** Start the real sandbox with `env`; resolve its port once /health answers. */
async function startSandbox(env: Record<string, string>): Promise<number> {
  const port = await freePort();
  child = spawn(process.execPath, ["services/js-sandbox/server.mjs"], {
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      PORT: String(port),
      ...env,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return port;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("js-sandbox did not start");
}

async function run(port: number, secret: string, code = "return 6 * 7;") {
  const r = await fetch(`http://127.0.0.1:${port}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-run-secret": secret },
    body: JSON.stringify({ code }),
  });
  return r.status;
}

describe("the sandbox's side, with the environment docker-compose.yml gives it", () => {
  it("INTERNAL_RUN_SECRET set (KIND=own): accepts that secret, refuses anything else", async () => {
    const port = await startSandbox({
      INTERNAL_RUN_SECRET: "own-secret",
      INTERNAL_RUN_SECRET_KIND: "own",
    });
    expect(await run(port, "own-secret")).toBe(200);
    expect(await run(port, derive("own-secret"))).toBe(401);
  });

  it("unset (Compose passes the key, KIND empty): accepts the derived secret and NOT the key", async () => {
    const port = await startSandbox({ INTERNAL_RUN_SECRET: KEY, INTERNAL_RUN_SECRET_KIND: "" });
    expect(await run(port, derive(KEY))).toBe(200);
    expect(await run(port, KEY)).toBe(401);
  });

  it("an older layout that passes only SUPABASE_SERVICE_ROLE_KEY derives the same", async () => {
    const port = await startSandbox({ SUPABASE_SERVICE_ROLE_KEY: KEY });
    expect(await run(port, derive(KEY))).toBe(200);
  });

  it("an explicit secret from a Kubernetes Secret (no KIND) is used as is", async () => {
    const port = await startSandbox({ INTERNAL_RUN_SECRET: "k8s-secret" });
    expect(await run(port, "k8s-secret")).toBe(200);
  });

  it("the app's derived secret and the sandbox's agree end to end", async () => {
    delete process.env.INTERNAL_RUN_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
    const port = await startSandbox({ INTERNAL_RUN_SECRET: KEY, INTERNAL_RUN_SECRET_KIND: "" });
    expect(await run(port, internalRunSecret()!)).toBe(200);
  });

  it("docker-compose.yml says which it passed", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const block = compose.slice(
      compose.indexOf("  js-sandbox:"),
      compose.indexOf("  js-sandbox:") + 2500,
    );
    expect(block).toContain(
      "INTERNAL_RUN_SECRET: ${INTERNAL_RUN_SECRET:-${SUPABASE_SERVICE_ROLE_KEY}}",
    );
    expect(block).toContain("INTERNAL_RUN_SECRET_KIND: ${INTERNAL_RUN_SECRET:+own}");
  });
});
