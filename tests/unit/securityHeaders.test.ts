// R396 (VA-2026-10-25-22): the production server set no security headers —
// no Content-Security-Policy, X-Content-Type-Options, framing control,
// Referrer-Policy or HSTS. Any site could frame a signed-in page.
//
// These run the middleware on real responses, and once through srvx itself,
// as server.mjs serves.
//
// R397 added a default script-src: the app's own files and the inline
// scripts the router renders with a per-request nonce, nothing else. The
// nonce is made by the middleware and reaches the router through a store on
// globalThis (src/lib/cspNonce.ts); the two workers that compile code get a
// policy of their own.
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { headersFor, securityHeaderPolicy, securityHeaders } from "../../serverSecurityHeaders.mjs";
import { cspNonce } from "../../src/lib/cspNonce";
import { SANDBOX_WORKER_URL } from "../../src/lib/sandbox/jsSandbox";

type Env = Record<string, string | undefined>;

/** 16 random bytes, base64: what the middleware puts in 'nonce-…'. */
const NONCE = /^[A-Za-z0-9+/]{22}==$/;
const nonceIn = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1];

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
    const csp = res.headers.get("content-security-policy");
    const nonce = nonceIn(csp);
    expect(nonce).toMatch(NONCE);
    expect(directives(csp)).toEqual([
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
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

describe("scripts (R397)", () => {
  it("only the app's own and nonced ones: no unsafe-inline, no eval, no wasm", async () => {
    for (const path of ["/", "/lakehouse", "/embed/agent/emk_abc", "/share/bi/q3?embed=1"]) {
      const csp = (await through(path)).headers.get("content-security-policy")!;
      const scriptSrc = directives(csp).find((d) => d.startsWith("script-src"));
      expect(scriptSrc, path).toBe(`script-src 'self' 'nonce-${nonceIn(csp)}'`);
      for (const loose of [
        "'unsafe-inline'",
        "'unsafe-eval'",
        "'wasm-unsafe-eval'",
        "*",
        "data:",
      ]) {
        expect(scriptSrc, `${path}: ${loose}`).not.toContain(loose);
      }
    }
  });

  it("the nonce the header allows is the one the router reads, inside the request", async () => {
    let seen: string | undefined;
    const res = (await securityHeaders({})(page("/agents"), async () => {
      // An await first: the store must survive the async hops a render takes.
      await new Promise((r) => setTimeout(r, 5));
      seen = cspNonce();
      return new Response("<html></html>");
    })) as Response;
    expect(seen).toMatch(NONCE);
    expect(nonceIn(res.headers.get("content-security-policy"))).toBe(seen);
    // …and not outside one.
    expect(cspNonce()).toBeUndefined();
  });

  it("every response gets its own nonce, even two in flight at once", async () => {
    const mw = securityHeaders({});
    const seen: Record<string, string | undefined> = {};
    const serve = (path: string, ms: number) =>
      mw(page(path), async () => {
        await new Promise((r) => setTimeout(r, ms));
        seen[path] = cspNonce();
        return new Response("<html></html>");
      }) as Promise<Response>;
    // The first request finishes LAST, so a shared slot would hand it the
    // second one's nonce.
    const [a, b] = await Promise.all([serve("/a", 30), serve("/b", 5)]);
    const na = nonceIn(a.headers.get("content-security-policy"));
    const nb = nonceIn(b.headers.get("content-security-policy"));
    expect(na).not.toBe(nb);
    expect(seen["/a"]).toBe(na);
    expect(seen["/b"]).toBe(nb);
  });

  it("{nonce} in the operator's policies is that response's nonce, in both", async () => {
    const env = {
      CONTENT_SECURITY_POLICY: "default-src 'self'; script-src 'self' 'nonce-{nonce}'",
      CONTENT_SECURITY_POLICY_REPORT_ONLY: "script-src 'nonce-{nonce}' 'strict-dynamic'",
    };
    const res = await through("/", env);
    const enforced = res.headers.get("content-security-policy");
    const nonce = nonceIn(enforced);
    expect(nonce).toMatch(NONCE);
    expect(enforced).not.toContain("{nonce}");
    expect(res.headers.get("content-security-policy-report-only")).toBe(
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    );
  });

  it("SECURITY_HEADERS=off makes no nonce, so the router renders none", async () => {
    let seen: string | undefined = "unset";
    await securityHeaders({ SECURITY_HEADERS: "off" })(page("/"), async () => {
      seen = cspNonce();
      return new Response("x");
    });
    expect(seen).toBeUndefined();
  });
});

describe("workers that compile code (R397)", () => {
  // The names Vite gives the `?url` imports in src/lib/browserDuckdb.ts:
  // <file name>-<8-character hash>.js under /assets.
  const duckdbImports = [
    ...readFileSync("src/lib/browserDuckdb.ts", "utf8").matchAll(
      /@duckdb\/duckdb-wasm\/dist\/(duckdb-browser-[\w.-]+?)\.js\?url/g,
    ),
  ].map((m) => m[1]);

  it("finds the DuckDB workers the app actually imports", () => {
    expect(duckdbImports.sort()).toEqual(["duckdb-browser-eh.worker", "duckdb-browser-mvp.worker"]);
  });

  it("DuckDB's engine workers may compile WebAssembly, and nothing else changes", async () => {
    for (const name of duckdbImports) {
      for (const hash of ["CwdVMcbT", "BEKIas_-"]) {
        const path = `/assets/${name}-${hash}.js`;
        const csp = directives((await through(path)).headers.get("content-security-policy"));
        expect(csp, path).toEqual([
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
        ]);
      }
    }
  });

  it("…under the operator's policy too, and in a report-only trial", async () => {
    const env = {
      CONTENT_SECURITY_POLICY: "default-src 'self'; connect-src 'self' https://x.supabase.co",
      CONTENT_SECURITY_POLICY_REPORT_ONLY: "script-src 'self' 'nonce-{nonce}'; report-uri /r",
    };
    const res = await through("/assets/duckdb-browser-eh.worker-CwdVMcbT.js", env);
    expect(directives(res.headers.get("content-security-policy"))).toEqual([
      "default-src 'self'",
      "connect-src 'self' https://x.supabase.co",
      "frame-ancestors 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
    ]);
    expect(directives(res.headers.get("content-security-policy-report-only"))).toEqual([
      "report-uri /r",
      "script-src 'self' 'wasm-unsafe-eval'",
    ]);
  });

  it("a policy that restricts no scripts is not given a script-src it did not have", async () => {
    const env = { CONTENT_SECURITY_POLICY: "object-src 'none'; base-uri 'self'" };
    const csp = (await through("/assets/duckdb-browser-mvp.worker-BEKIasyR.js", env)).headers.get(
      "content-security-policy",
    );
    expect(directives(csp)).toEqual([
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ]);
  });

  it("any other script keeps the page policy", async () => {
    for (const path of [
      "/assets/index-D0oJKb5Y.js",
      "/assets/duckdb-browser-Di27TqZr.js", // the engine's main-thread half
      "/assets/x/duckdb-browser-eh.worker-CwdVMcbT.js",
      "/sw.js",
      "/vendor/pdfjs/pdf.worker.min.mjs",
    ]) {
      const csp = (await through(path)).headers.get("content-security-policy");
      expect(csp, path).toContain(`script-src 'self' 'nonce-${nonceIn(csp)}'`);
      expect(csp, path).not.toContain("eval");
    }
  });

  it("the function-node sandbox may compile its snippet and reach nothing", async () => {
    expect(SANDBOX_WORKER_URL).toBe("/sandbox/function-node.js");
    expect(existsSync(`public${SANDBOX_WORKER_URL}`)).toBe(true);
    const env = {
      CONTENT_SECURITY_POLICY: "script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *",
      CONTENT_SECURITY_POLICY_REPORT_ONLY: "script-src 'self'; report-uri /r",
    };
    for (const e of [{}, env]) {
      const res = await through(SANDBOX_WORKER_URL, e);
      // Fixed, whatever the operator wrote: nothing they could add belongs.
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; script-src 'unsafe-eval'",
      );
      expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    }
  });

  it("no worker in the app is a blob: worker, which would take the page's policy", () => {
    // Every `new Worker(` in src, and what it is given. A blob: or data:
    // worker inherits the PAGE's policy, so the page's script-src would stop
    // anything it compiles; a same-origin file takes its own.
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/new (?:Shared)?Worker\(([^)]*)\)/g)) {
            found.push(`${p}: ${m[1]}`);
          }
        }
      }
    };
    walk("src");
    expect(found.sort()).toEqual([
      "src/lib/browserDuckdb.ts: bundle.mainWorker!",
      "src/lib/sandbox/jsSandbox.ts: SANDBOX_WORKER_URL",
    ]);
    const sandbox = readFileSync("src/lib/sandbox/jsSandbox.ts", "utf8");
    expect(sandbox).not.toContain("createObjectURL");
  });
});

describe("the page's own inline scripts (R397)", () => {
  // Code only: the comments explain what was removed, in its own words.
  const root = readFileSync("src/routes/__root.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("the router is given the request's nonce", () => {
    const router = readFileSync("src/router.tsx", "utf8");
    expect(router).toContain('import { cspNonce } from "./lib/cspNonce";');
    expect(router).toMatch(/ssr:\s*\{\s*nonce:\s*cspNonce\(\)\s*\}/);
  });

  it("the theme boot script goes through ScriptOnce, which stamps the nonce", () => {
    expect(root).toContain("<ScriptOnce>{themeBootScript}</ScriptOnce>");
    // A bare <script> would render without one and be refused.
    expect(root).not.toMatch(/<script[\s>]/);
  });

  it("the head scripts are data only: the service worker registers from an effect", () => {
    expect(root).not.toContain("navigator.serviceWorker.register('/sw.js')");
    expect(root).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(root).toContain("<ServiceWorkerRegistration />");
    const scripts = root.slice(root.indexOf("scripts: ["), root.indexOf("shellComponent:"));
    expect(scripts.match(/children:/g)).toHaveLength(1);
    expect(scripts).toContain('type: "application/ld+json"');
  });

  it("every script the consent banner adds carries the nonce", () => {
    const consent = readFileSync("src/components/CookieConsent.tsx", "utf8");
    const created = consent.match(/document\.createElement\("script"\)/g) ?? [];
    const nonced = consent.match(/withCspNonce\(document\.createElement\("script"\)\)/g) ?? [];
    expect(created.length).toBe(3);
    expect(nonced.length).toBe(created.length);
  });

  it("the static pages have no inline script or handler for the policy to refuse", () => {
    for (const file of readdirSync("public").filter((f) => f.endsWith(".html"))) {
      // Comments may describe what was removed; the markup may not contain it.
      const html = readFileSync(`public/${file}`, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      expect(html, file).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, file).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
      expect(html, file).not.toMatch(/javascript:/i);
    }
  });
});

describe("nothing on the page evals (R397)", () => {
  // The report-only trial's only report: Zod 4 probing `new Function("")`
  // on every page load. Zod reads `jitless` when a schema is BUILT, and the
  // app builds schemas at module scope, so the setting must come first.
  const firstImport = (file: string) =>
    readFileSync(file, "utf8").match(/^import\s[^;]*;/m)?.[0] ?? "";

  it("Zod is told before any schema exists: the first import of both entry roots", () => {
    expect(firstImport("src/router.tsx")).toBe('import "./lib/zodNoEval";');
    expect(firstImport("src/start.ts")).toBe('import "@/lib/zodNoEval";');
  });

  it("…and the bundler keeps it: package.json says it has side effects", () => {
    // `"sideEffects": false` made Rollup drop the bare import from the build.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { sideEffects?: unknown };
    expect(pkg.sideEffects).toEqual(["./src/lib/zodNoEval.ts"]);
    expect(existsSync("src/lib/zodNoEval.ts")).toBe(true);
  });

  it("…which makes Zod skip the probe in the browser, and only there", async () => {
    const { z } = await import("zod");
    const before = z.config().jitless;
    try {
      vi.resetModules();
      await import("../../src/lib/zodNoEval");
      expect(z.config().jitless).toBeFalsy(); // no document: the server keeps its fast path
      vi.stubGlobal("document", {});
      vi.resetModules();
      const fresh = await import("zod");
      await import("../../src/lib/zodNoEval");
      expect(fresh.z.config().jitless).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      z.config({ jitless: before });
    }
  });

  it("pdf.js is told not to try eval either", () => {
    const parsers = readFileSync("src/lib/fileParsers.ts", "utf8");
    expect(parsers).toContain("getDocument({ data: buf, isEvalSupported: false })");
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
