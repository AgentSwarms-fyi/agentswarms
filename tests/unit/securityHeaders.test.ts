// R396 (VA-2026-10-25-22): the production server set no security headers —
// no Content-Security-Policy, X-Content-Type-Options, framing control,
// Referrer-Policy or HSTS. Any site could frame a signed-in page.
//
// These run the middleware on real responses, and once through srvx itself,
// as server.mjs serves.
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { headersFor, securityHeaderPolicy, securityHeaders } from "../../serverSecurityHeaders.mjs";

type Env = Record<string, string | undefined>;

const page = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:8080${path}`, { headers });

/** The middleware answering `path` with `answer`, as srvx would call it. */
async function through(path: string, env: Env = {}, answer?: () => Response) {
  const mw = securityHeaders(env);
  return (await mw(
    page(path),
    async () => answer?.() ?? new Response("<html></html>", { status: 200 }),
  )) as Response;
}

const directives = (csp: string | null) =>
  (csp ?? "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);

describe("an app page", () => {
  it("may be framed only by the app itself, and carries the rest", async () => {
    const res = await through("/dashboard");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(directives(res.headers.get("content-security-policy"))).toEqual([
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ]);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("so does an API response, a static file and a redirect", async () => {
    for (const path of ["/api/health/ready", "/assets/index-abc.js", "/login"]) {
      const res = await through(path);
      expect(res.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    // Response.redirect's headers are immutable: the response is copied.
    const res = await through("/old", {}, () =>
      Response.redirect("http://localhost:8080/new", 302),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:8080/new");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("the signed-in page that manages embed keys is not frameable", async () => {
    // /embeds is not /embed/<...>; nor are the embedding docs.
    for (const path of ["/embeds", "/embedded", "/docs/embedding", "/share", "/share/other/x"]) {
      expect((await through(path)).headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
    }
  });
});

describe("pages other sites are meant to frame", () => {
  const frameable = [
    "/embed/agent/emk_abc",
    "/embed/swarm/emk_abc",
    "/embed/bi/emk_abc?vt=x.y",
    "/embed/analyst/emk_abc",
    "/share/bi/q3-revenue?embed=1",
  ];

  it("send no framing restriction by default (the key's domain allow-list gates them)", async () => {
    for (const path of frameable) {
      const res = await through(path);
      expect(res.headers.get("x-frame-options"), path).toBeNull();
      const csp = directives(res.headers.get("content-security-policy"));
      expect(
        csp.some((d) => d.startsWith("frame-ancestors")),
        path,
      ).toBe(false);
      // The rest of the policy still applies.
      expect(csp, path).toContain("object-src 'none'");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });

  it("are limited to the operator's sites when EMBED_FRAME_ANCESTORS names them", async () => {
    const env = { EMBED_FRAME_ANCESTORS: "https://www.example.com https://help.example.com" };
    for (const path of frameable) {
      const csp = (await through(path, env)).headers.get("content-security-policy");
      expect(directives(csp), path).toContain(
        "frame-ancestors https://www.example.com https://help.example.com",
      );
    }
    // And an app page stays 'self' regardless.
    const app = (await through("/bi", env)).headers.get("content-security-policy");
    expect(directives(app)).toContain("frame-ancestors 'self'");
  });
});

describe("HSTS", () => {
  const hsts = (req: Request, env: Env = {}) =>
    headersFor(req, securityHeaderPolicy(env)!)["strict-transport-security"];

  it("is sent when the browser came over HTTPS, directly or through the proxy", () => {
    expect(hsts(new Request("https://agents.example.com/"))).toBe("max-age=15552000");
    expect(hsts(page("/", { "x-forwarded-proto": "https" }))).toBe("max-age=15552000");
    expect(hsts(page("/", { "x-forwarded-proto": "https, http" }))).toBe("max-age=15552000");
  });

  it("is not sent over plain HTTP, where it would mean nothing", () => {
    expect(hsts(page("/"))).toBeUndefined();
    expect(hsts(page("/", { "x-forwarded-proto": "http" }))).toBeUndefined();
  });

  it("follows HSTS_MAX_AGE and HSTS_INCLUDE_SUBDOMAINS; 0 turns it off", () => {
    const tls = () => new Request("https://agents.example.com/");
    expect(hsts(tls(), { HSTS_MAX_AGE: "31536000", HSTS_INCLUDE_SUBDOMAINS: "true" })).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(hsts(tls(), { HSTS_MAX_AGE: "0" })).toBeUndefined();
    expect(hsts(tls(), { HSTS_MAX_AGE: "soon" })).toBeUndefined();
  });
});

describe("the operator's own policy", () => {
  it("replaces the default, and frame-ancestors stays per page", async () => {
    const env = {
      CONTENT_SECURITY_POLICY:
        "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    };
    const app = directives((await through("/", env)).headers.get("content-security-policy"));
    expect(app).toEqual([
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "frame-ancestors 'self'",
    ]);
    // 'none' would have broken every embed; frame-ancestors is this module's.
    const embed = directives(
      (await through("/embed/agent/emk_a", env)).headers.get("content-security-policy"),
    );
    expect(embed).toEqual(["default-src 'self'", "script-src 'self' 'unsafe-inline'"]);
  });

  it("a report-only policy is passed through to trial a stricter one", async () => {
    const env = { CONTENT_SECURITY_POLICY_REPORT_ONLY: "script-src 'self'; report-to csp" };
    const res = await through("/", env);
    expect(res.headers.get("content-security-policy-report-only")).toBe(
      "script-src 'self'; report-to csp",
    );
    expect(res.headers.get("content-security-policy")).toContain("object-src 'none'");
  });

  it("a header the app set itself is left alone", async () => {
    const res = await through(
      "/",
      {},
      () => new Response("x", { headers: { "referrer-policy": "no-referrer" } }),
    );
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("SECURITY_HEADERS=off sends none (a proxy in front sets them)", async () => {
    const res = await through("/", { SECURITY_HEADERS: "off" });
    for (const h of ["content-security-policy", "x-frame-options", "x-content-type-options"]) {
      expect(res.headers.get(h), h).toBeNull();
    }
  });
});

describe("through srvx, as server.mjs serves", () => {
  // srvx's own middleware chain: the order, the `next` contract and the
  // response type are srvx's, not this test's.
  let server: { url?: string; close: () => Promise<void> | void; ready: () => Promise<unknown> };
  let base = "";
  beforeAll(async () => {
    const { serve } = await import("srvx");
    server = serve({
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
      middleware: [securityHeaders({})],
      fetch: (req: Request) =>
        new URL(req.url).pathname === "/gone"
          ? Response.redirect("http://127.0.0.1/elsewhere", 302)
          : new Response("<html>ok</html>", { headers: { "content-type": "text/html" } }),
    }) as unknown as typeof server;
    await server.ready();
    base = String(server.url).replace(/\/$/, "");
  });
  afterAll(async () => {
    await server?.close();
  });

  it("an app page and an embed page leave with their headers", async () => {
    const app = await fetch(`${base}/dashboard`);
    expect(app.status).toBe(200);
    expect(app.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(app.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(app.headers.get("x-content-type-options")).toBe("nosniff");

    const embed = await fetch(`${base}/embed/bi/emk_abc`);
    expect(embed.headers.get("x-frame-options")).toBeNull();
    expect(embed.headers.get("content-security-policy")).not.toContain("frame-ancestors");

    const moved = await fetch(`${base}/gone`, { redirect: "manual" });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("server.mjs", () => {
  it("serves through it, outermost, so static files get the headers too", () => {
    const entry = readFileSync("server.mjs", "utf8");
    expect(entry).toContain('import { securityHeaders } from "./serverSecurityHeaders.mjs";');
    expect(entry).toMatch(/middleware: \[\s*securityHeaders\(\),\s*compressStatic\(/);
  });
});
