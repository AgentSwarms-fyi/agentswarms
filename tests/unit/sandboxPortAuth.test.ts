// R466: a sandbox's port answers only to the platform.
//
// Every sandbox serves on :8888 (Kernel Gateway, an MCP server, or a scorer),
// and every sandbox shares one network. Before R466 none of them asked who was
// calling: measured, code in sandbox A created a kernel on sandbox B, ran code
// in it and printed B's session token. Now each sandbox has its own token,
// derived from its session id under the runtime signing secret; the app puts
// it in that sandbox's environment (KG_AUTH_TOKEN) and every caller sends it.
//
// Pinned here: the app and the gateway derive the same token; the sandbox gets
// it; every request into a sandbox carries it, probes included; a refusal is
// not mistaken for readiness; and the MCP runner's gate refuses without it.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const secret = vi.hoisted(() => ({ value: "a-signing-secret-of-enough-length" as string | null }));
vi.mock("@/utils/notebookRuntime/token.server", () => ({
  getRuntimeSecret: async () => secret.value,
}));

const { SANDBOX_TOKEN_LABEL, deriveSandboxToken, sandboxAuthHeaders, sandboxToken } =
  await import("@/utils/notebookRuntime/sandboxAuth.server");
// The gateway's copy, from the module it really imports (no side effects).
const gateway = (await import("../../services/notebook-gateway/kernels.mjs")) as {
  SANDBOX_TOKEN_LABEL: string;
  deriveSandboxToken: (secret: string, sid: string) => string;
  ensureKernel: (endpoint: string, opts: Record<string, unknown>) => Promise<string>;
};
const { kernelServing, serviceServing } = await import("@/utils/notebookRuntime/orchestrator");

const rd = (p: string) => readFileSync(p, "utf8");
const SID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
  secret.value = "a-signing-secret-of-enough-length";
});

describe("one token per sandbox, the same on both sides", () => {
  it("the app and the gateway derive the same token, and it is an HMAC anyone can check", () => {
    expect(gateway.SANDBOX_TOKEN_LABEL).toBe(SANDBOX_TOKEN_LABEL);
    const app = deriveSandboxToken("s3cret", SID);
    expect(gateway.deriveSandboxToken("s3cret", SID)).toBe(app);
    expect(app).toBe(
      createHmac("sha256", "s3cret").update(`agentswarms/sandbox-port/v1:${SID}`).digest("hex"),
    );
  });

  it("differs per session and per secret, so one sandbox's token opens no other", () => {
    const a = deriveSandboxToken("s3cret", SID);
    expect(deriveSandboxToken("s3cret", SID.replace(/1$/, "2"))).not.toBe(a);
    expect(deriveSandboxToken("other-secret", SID)).not.toBe(a);
  });

  it("is sent in Kernel Gateway's own form, and refuses to exist without a secret", async () => {
    expect(await sandboxAuthHeaders(SID)).toEqual({
      Authorization: `token ${deriveSandboxToken("a-signing-secret-of-enough-length", SID)}`,
    });
    secret.value = null;
    await expect(sandboxToken(SID)).rejects.toThrow(/no signing secret/);
  });
});

describe("the sandbox is given its token", () => {
  it("every sandbox the app starts carries KG_AUTH_TOKEN, derived from its own session", () => {
    const src = rd("src/utils/notebookRuntime/service.server.ts");
    expect(src).toContain("KG_AUTH_TOKEN: opts.portToken,");
    expect(src).toContain("portToken: await sandboxToken(row.id),");
  });

  it("the MCP and score runners take it out of the environment before user code runs", () => {
    for (const f of [
      "docker/notebook-runtime/mcp_runner.py",
      "docker/notebook-runtime/score_server.py",
    ]) {
      expect(rd(f), f).toContain('PORT_TOKEN = os.environ.pop("KG_AUTH_TOKEN", "")');
    }
  });
});

describe("every request into a sandbox carries it", () => {
  it("the readiness probes send it, and a 401 is not ready", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    let status = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response("{}", { status });
      }),
    );
    expect(await kernelServing("http://k:8888", { token: "t1" })).toBe(true);
    expect(seen[0]).toEqual({ Authorization: "token t1" });
    status = 401;
    expect(await kernelServing("http://k:8888", { token: "wrong" })).toBe(false);
    // An MCP endpoint answers a bare GET 4xx and is ready; 401 is not one of those.
    status = 406;
    expect(await serviceServing("http://m:8888", "/mcp", { token: "t2" })).toBe(true);
    status = 401;
    expect(await serviceServing("http://m:8888", "/mcp", { token: "t2" })).toBe(false);
  });

  it("the gateway sends it on the kernel create, and on the websocket, interrupt and delete", async () => {
    const headers: Array<Record<string, string>> = [];
    await gateway.ensureKernel("http://k:8888", {
      headers: { Authorization: "token abc" },
      log: () => {},
      fetchImpl: async (_u: string, init: { headers: Record<string, string> }) => {
        headers.push(init.headers);
        return new Response(JSON.stringify({ id: "kernel-1" }), { status: 201 });
      },
    });
    expect(headers[0]).toMatchObject({ Authorization: "token abc" });

    const index = rd("services/notebook-gateway/index.mjs");
    expect(index).toMatch(
      /const kernelAuth = \{\s*Authorization: `token \$\{deriveSandboxToken\(await getSecret\(\), claims\.sid\)\}`,?\s*\};/,
    );
    expect(index).toContain("kernelId = await ensureKernel(endpoint, { headers: kernelAuth });");
    expect(index).toMatch(/channels\?session_id=\$\{jsession\}`,\s*\{ headers: kernelAuth \},/);
    expect(index).toMatch(/\/interrupt`, \{\s*method: "POST",\s*headers: kernelAuth,/);
    expect(index).toContain('{ method: "DELETE", headers: kernelAuth }');
  });

  it("the app sends it to MCP servers and scorers, wherever it calls them", () => {
    const route = rd("src/routes/api/mcp.s.$slug.ts");
    expect(route).toContain("...(await sandboxAuthHeaders(sandboxSessionId)),");
    expect(route).toContain("...(await sandboxAuthHeaders(running.sessionId)),");
    expect(rd("src/utils/mcpApps/service.server.ts")).toContain(
      "...(await sandboxAuthHeaders(sessionId)),",
    );
    expect(rd("src/utils/mcpApps.functions.ts")).toContain(
      "...(await sandboxAuthHeaders(started.session.id)),",
    );
    const ml = rd("src/utils/ml/serve.server.ts");
    // Two health checks and two score calls.
    expect(ml.match(/await scorerHeaders\(/g)).toHaveLength(4);
    expect(ml).toContain("token: await sandboxToken(session.id),");
  });

  it("no request into a sandbox goes out without it", () => {
    // Every fetch of a sandbox path names a header set; a bare one would be refused.
    for (const [file, pattern] of [
      [
        "src/routes/api/mcp.s.$slug.ts",
        /fetch\(`\$\{[^}]+\}\$\{MCP_SERVICE_PATH\}`, \{[^}]*?headers/,
      ],
      [
        "src/utils/ml/serve.server.ts",
        /fetch\(`\$\{[^}]+\}\$\{(HEALTH|SCORE)_PATH\}`, \{\s*(method: "POST",\s*)?headers/,
      ],
    ] as const) {
      const src = rd(file);
      const calls = src.match(/fetch\(`\$\{[^}]+\}\$\{(MCP_SERVICE|HEALTH|SCORE)_PATH\}`/g) ?? [];
      expect(calls.length, file).toBeGreaterThan(0);
      const withHeaders = src.match(new RegExp(pattern.source, "g")) ?? [];
      expect(withHeaders.length, `${file}: a sandbox call without headers`).toBe(calls.length);
    }
  });
});

// ── The MCP runner's gate, run for real ─────────────────────────────────────

const python = ["python3", "python", "py"].find(
  (c) => spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0,
);

describe("the MCP runner's gate", () => {
  it.skipIf(!python)(
    "refuses a request without the token, and passes the right one through",
    () => {
      const src = rd("docker/notebook-runtime/mcp_runner.py");
      const gate = src.slice(src.indexOf("class TokenGate:"), src.indexOf("def asgi_app("));
      const script = `
import asyncio, hmac, json
${gate}
async def app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"served"})

async def call(headers):
    sent = []
    async def send(m): sent.append(m)
    async def receive(): return {"type": "http.request"}
    await TokenGate(app, "the-token")({"type": "http", "headers": headers}, receive, send)
    return sent[0]["status"]

async def lifespan():
    seen = []
    async def inner(scope, receive, send): seen.append(scope["type"])
    await TokenGate(inner, "the-token")({"type": "lifespan"}, None, None)
    return seen

out = {
  "none": asyncio.run(call([])),
  "wrong": asyncio.run(call([(b"authorization", b"token nope")])),
  "bearer": asyncio.run(call([(b"authorization", b"Bearer the-token")])),
  "right": asyncio.run(call([(b"authorization", b"token the-token")])),
  "lifespan": asyncio.run(lifespan()),
}
print(json.dumps(out))
`;
      const r = spawnSync(python!, ["-c", script], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toEqual({
        none: 401,
        wrong: 401,
        bearer: 401,
        right: 200,
        lifespan: ["lifespan"],
      });
    },
  );

  it("serves through the gate whenever there is a token, and never serves open with one", () => {
    const src = rd("docker/notebook-runtime/mcp_runner.py");
    const serve = src.slice(src.indexOf("def serve(server)"), src.indexOf("def _serve_open("));
    expect(serve).toContain("uvicorn.run(TokenGate(app, PORT_TOKEN), host=HOST, port=PORT");
    expect(serve).toMatch(/if app is None:\s*raise RuntimeError/);
  });
});
