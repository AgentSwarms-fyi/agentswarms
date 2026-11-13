// A sandbox's environment, traded once for a nonce (R477): the app's side,
// the database's, and the sandbox's own script, run for real.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const update = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({
      update: (patch: unknown) => ({ eq: (_c: string, id: string) => update(patch, id) }),
    }),
  },
}));
const owners: (string | null)[] = [];
vi.mock("@/utils/providers/crypto.server", () => ({
  encryptJson: async (payload: unknown, opts: { owner: string | null }) => {
    owners.push(opts.owner);
    return { ciphertext: JSON.stringify(payload), iv: "iv", kid: "k1" };
  },
  decryptBlob: async (blob: { ciphertext: string }) => JSON.parse(blob.ciphertext),
  isEncryptedBlob: (v: unknown) => !!v && typeof v === "object" && "ciphertext" in (v as object),
}));

import {
  NONCE_RE,
  nonceHash,
  redeemBootstrap,
  stageBootstrap,
} from "@/utils/notebookRuntime/bootstrap.server";

const SID = "6f0d3c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f";
const NONCE = "A".repeat(43);

beforeEach(() => {
  rpc.mockReset();
  update.mockReset();
});

describe("the app keeps the environment until the nonce comes back", () => {
  it("stores it sealed under its owner's key, with the nonce's hash and never the nonce", async () => {
    update.mockResolvedValue({ error: null });
    owners.length = 0;
    await stageBootstrap(SID, "user-1", { AGENTSWARMS_TOKEN: "t" }, NONCE);
    expect(owners).toEqual(["user-1"]);
    const [patch, id] = update.mock.calls[0];
    expect(id).toBe(SID);
    expect(patch).toEqual({
      bootstrap_env: { ciphertext: '{"AGENTSWARMS_TOKEN":"t"}', iv: "iv", kid: "k1" },
      bootstrap_hash: createHash("sha256").update(NONCE).digest("hex"),
      bootstrap_used_at: null,
    });
    expect(JSON.stringify(patch)).not.toContain(NONCE);
  });

  it("fails the start when it cannot keep it", async () => {
    update.mockResolvedValue({ error: { message: "permission denied" } });
    await expect(stageBootstrap(SID, "user-1", {}, NONCE)).rejects.toThrow(
      /Could not keep the sandbox's environment: permission denied/,
    );
  });

  it("hands it over for the right nonce, asking the database by hash", async () => {
    rpc.mockResolvedValue({
      data: { ciphertext: '{"KG_AUTH_TOKEN":"p"}', iv: "iv", kid: "k1" },
      error: null,
    });
    expect(await redeemBootstrap(SID, NONCE)).toEqual({ KG_AUTH_TOKEN: "p" });
    expect(rpc).toHaveBeenCalledWith("redeem_notebook_bootstrap", {
      p_session: SID,
      p_hash: nonceHash(NONCE),
      p_window_minutes: 15,
    });
  });

  it("has nothing for a used, wrong or expired nonce", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await redeemBootstrap(SID, NONCE)).toBeNull();
  });

  it("does not ask the database about something that is not a nonce", async () => {
    expect(await redeemBootstrap(SID, "short")).toBeNull();
    expect(await redeemBootstrap(SID, `${"A".repeat(42)}=`)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(NONCE_RE.test(NONCE)).toBe(true);
  });

  it("says so when the database could not be asked", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    await expect(redeemBootstrap(SID, NONCE)).rejects.toThrow(/timeout/);
  });
});

describe("the database hands it over once", () => {
  const dir = "supabase/migrations";
  const file = readdirSync(dir).find((f) =>
    readFileSync(`${dir}/${f}`, "utf8").includes("redeem_notebook_bootstrap"),
  );
  const sql = file ? readFileSync(`${dir}/${file}`, "utf8") : "";

  it("deletes what it hands over, under a row lock", () => {
    expect(file, "a migration defines redeem_notebook_bootstrap").toBeTruthy();
    expect(sql).toMatch(/FOR UPDATE;/);
    expect(sql).toMatch(/SET bootstrap_env = NULL, bootstrap_used_at = now\(\)/);
    expect(sql).toMatch(/s\.created_at > now\(\) - make_interval\(mins => p_window_minutes\)/);
  });

  it("lets only the service role call it", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.redeem_notebook_bootstrap(uuid, text, integer) FROM anon, authenticated;",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.redeem_notebook_bootstrap(uuid, text, integer) TO service_role;",
    );
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
  });

  it("lets the settings name the ECS backend", () => {
    expect(sql).toContain("CHECK (backend IN ('docker', 'k8s', 'e2b', 'ecs'))");
  });
});

// ── The sandbox's script, run ───────────────────────────────────────────────

const PYTHON: string | null = (() => {
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["-c", "import json, shlex, urllib.request"], { stdio: "ignore" });
      return c;
    } catch {
      /* next */
    }
  }
  return null;
})();
if (!PYTHON) {
  console.warn(
    "\n[sandboxBootstrap] no Python on this machine: bootstrap.py is NOT run, those tests are SKIPPED.\n",
  );
}

const BASH: string | null = (() => {
  try {
    execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
    return "bash";
  } catch {
    return null;
  }
})();

describe("bootstrap.py", () => {
  let server: Server;
  let answers: { status: number; body: unknown }[];
  let received: unknown[];
  let url = "";

  beforeEach(async () => {
    answers = [];
    received = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push(JSON.parse(data));
        const a = answers.shift() ?? { status: 500, body: {} };
        res.writeHead(a.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notebook/runtime/bootstrap`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  function run(
    extra: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        PYTHON!,
        ["-I", "docker/notebook-runtime/bootstrap.py"],
        {
          // A proxy that does not exist: the script must not use it.
          env: {
            ...process.env,
            HTTP_PROXY: "http://127.0.0.1:9",
            http_proxy: "http://127.0.0.1:9",
            NB_BOOTSTRAP_URL: url,
            NB_BOOTSTRAP_NONCE: NONCE,
            NB_SESSION_ID: SID,
            ...extra,
          },
        },
        (err, stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  const tricky = {
    AGENTSWARMS_TOKEN: "eyJ.a.b",
    NB_INPUTS: `{"q": "it's \\"quoted\\"", "cmd": "$(touch /tmp/pwned) \`id\`"}`,
    MULTI: "line one\nline two",
  };

  it.skipIf(!PYTHON)("prints the environment as export lines, asking with its nonce", async () => {
    answers.push({ status: 200, body: { env: tricky } });
    const r = await run();
    expect(r.code, r.stderr).toBe(0);
    expect(received).toEqual([{ session_id: SID, nonce: NONCE }]);
    expect(r.stdout.split("\n")[0]).toBe("export AGENTSWARMS_TOKEN=eyJ.a.b");
  });

  it.skipIf(!PYTHON || !BASH)(
    "survives the shell: every value comes back exactly, nothing runs",
    async () => {
      answers.push({ status: 200, body: { env: tricky } });
      const r = await run();
      const out = execFileSync(
        BASH!,
        ["-c", 'eval "$BOOT"; printf "%s\\0%s\\0%s" "$AGENTSWARMS_TOKEN" "$NB_INPUTS" "$MULTI"'],
        { env: { ...process.env, BOOT: r.stdout } },
      ).toString();
      expect(out.split("\0")).toEqual([tricky.AGENTSWARMS_TOKEN, tricky.NB_INPUTS, tricky.MULTI]);
    },
  );

  it.skipIf(!PYTHON)(
    "waits out an app that is not ready, then takes the answer",
    async () => {
      answers.push({ status: 503, body: {} }, { status: 200, body: { env: { A: "1" } } });
      const r = await run();
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("export A=1");
      expect(received).toHaveLength(2);
    },
    20_000,
  );

  it.skipIf(!PYTHON)("stops at once, printing nothing, when the nonce is refused", async () => {
    answers.push({ status: 404, body: { error: "No environment for this nonce" } });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/refused the nonce \(HTTP 404\)/);
    expect(received).toHaveLength(1);
  });

  it.skipIf(!PYTHON)("refuses a name the shell would read as something else", async () => {
    answers.push({ status: 200, body: { env: { "A;touch x": "1" } } });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/not NAME=string/);
  });

  it.skipIf(!PYTHON)("needs all three of its settings", async () => {
    const r = await run({ NB_BOOTSTRAP_NONCE: "" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/are all required/);
    expect(received).toHaveLength(0);
  });
});
