// HTTP security headers for server.mjs (R396, VA-2026-10-25-22).
//
// The production server set none: no Content-Security-Policy, no
// X-Content-Type-Options, nothing against framing, no Referrer-Policy, no HSTS.
// So any site could frame a signed-in page under a decoy and steer a click
// (clickjacking), and `vite preview` never set them either, so nothing showed
// the gap until the assessment looked.
//
// In its own module, as serverCompression.mjs is, so a test runs it against
// real responses (securityHeaders.test.ts), including through srvx itself.
//
// SCRIPTS (R397). R396 shipped no script-src, because the page's own scripts
// would have needed 'unsafe-inline' and 'unsafe-eval'. Each of those has been
// dealt with instead. The router's inline scripts carry a per-request nonce,
// made here. Two workers compile code by design, and they get their own
// policy (below). Everything else on the page runs from this origin. So the
// default now refuses any script that is not this app's own.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Pages other sites are MEANT to frame: embed keys' widgets (/embed/agent,
 * /swarm, /bi, /analyst) and published dashboards (/share/bi/<slug>, whose
 * Publish dialog hands out an <iframe> snippet). The trailing slash matters:
 * /embeds is the signed-in page that manages the keys, and is not one of them.
 */
const FRAMEABLE = /^\/(?:embed|share\/bi)\//;

/** Where a policy names the request's nonce: `script-src 'nonce-{nonce}'`. */
const NONCE_SLOT = "{nonce}";

/**
 * The policy enforced when the operator sets none. No plugins, no <base>
 * that re-points relative script URLs, no form that posts to another origin,
 * and no script but the app's own: its files ('self') and the inline scripts
 * the router renders with this response's nonce. No 'unsafe-inline', no
 * 'unsafe-eval', and no 'wasm-unsafe-eval'. MEASURED in the R397 report-only
 * trial across thirteen pages: no document compiled WebAssembly (the DuckDB
 * worker does, under its own policy), and the only eval was Zod's probe,
 * which src/lib/zodNoEval.ts now skips.
 */
const DEFAULT_CSP = `object-src 'none'; base-uri 'self'; form-action 'self'; script-src 'self' 'nonce-${NONCE_SLOT}'`;

/**
 * Workers that compile code, found by path. A worker loaded from a URL takes
 * its policy from its own response, not from the page, so these get exactly
 * the script-src they need and no more.
 *
 * DuckDB-WASM's engine workers: src/lib/browserDuckdb.ts imports them with
 * `?url`, so Vite emits them as <name>-<hash>.js. They compile the engine's
 * WebAssembly, so they need 'wasm-unsafe-eval'. They do not need
 * 'unsafe-eval'. Their emscripten loader evals only the JS that dynamically
 * linked extensions carry, and the app loads none. MEASURED in the R397
 * trial: the worker compiled the engine, registered 28 local tables and
 * answered queries under exactly this script-src, with no report. Every other
 * directive the operator wrote still applies to them.
 */
const DUCKDB_WORKER = /^\/assets\/duckdb-browser-(?:eh|mvp|coi)(?:\.pthread)?\.worker-[\w-]+\.js$/;
const DUCKDB_WORKER_SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval'";

/**
 * The swarm function node's sandbox (public/sandbox/function-node.js).
 * Compiling the user's snippet is its job, so it may eval. It may do nothing
 * else: no network, no importScripts, nothing loaded. The bootstrap already
 * deletes those globals; this policy holds even if a deletion fails. Fixed,
 * whatever the operator set, because nothing an operator could add belongs
 * in it. It used to be a blob: worker, which takes the PAGE's policy, so a
 * page policy without 'unsafe-eval' would have stopped the node outright.
 */
const SANDBOX_WORKER = "/sandbox/function-node.js";
const SANDBOX_WORKER_CSP = "default-src 'none'; script-src 'unsafe-eval'";

/** HSTS lifetime when HSTS_MAX_AGE is not set: 180 days. */
const DEFAULT_HSTS_MAX_AGE = 15552000;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

const directivesOf = (policy) =>
  policy
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);

const named = (name) => (d) => new RegExp(`^${name}(?:\\s|$)`, "i").test(d);

/** A policy with any frame-ancestors directive removed; this module owns it. */
function withoutFrameAncestors(policy) {
  return directivesOf(policy)
    .filter((d) => !named("frame-ancestors")(d))
    .join("; ");
}

/**
 * `policy` with its script-src replaced by `scriptSrc` — when it restricts
 * scripts at all (a script-src, or a default-src it falls back to). One that
 * does not already lets the worker do what it needs; adding a script-src
 * would only take something away.
 */
function withScriptSrc(policy, scriptSrc) {
  const all = directivesOf(policy);
  if (!all.some((d) => named("script-src")(d) || named("default-src")(d))) return policy;
  return [...all.filter((d) => !named("script-src")(d)), scriptSrc].join("; ");
}

/**
 * The nonce for the request being served, for anything rendering inside it.
 * Parked on globalThis under a registered symbol so the app's server bundle
 * finds the same store without importing this file (src/lib/cspNonce.ts);
 * TanStack Start keeps its own request store the same way.
 */
const NONCE_STORE_KEY = Symbol.for("agentswarms.cspNonce");
const nonceStore = (globalThis[NONCE_STORE_KEY] ??= new AsyncLocalStorage());

/** 128 random bits, base64: one per response, never reused. */
export const newNonce = () => randomBytes(16).toString("base64");

/**
 * What to send, read once from the environment.
 *
 * SECURITY_HEADERS=off            send none (a proxy in front sets them)
 * CONTENT_SECURITY_POLICY         the enforced policy, replacing the default
 * CONTENT_SECURITY_POLICY_REPORT_ONLY  a policy to trial, reported not enforced
 *                                 (in either one, {nonce} is this response's
 *                                 nonce: script-src 'self' 'nonce-{nonce}')
 * EMBED_FRAME_ANCESTORS           who may frame the embed and share pages
 *                                 (default: anyone; the embed key's domain
 *                                 allow-list still gates what they show)
 * HSTS_MAX_AGE                    seconds; 0 sends no HSTS
 * HSTS_INCLUDE_SUBDOMAINS         add includeSubDomains
 */
export function securityHeaderPolicy(env = process.env) {
  if (/^(0|false|no|off)$/i.test(String(env.SECURITY_HEADERS ?? "").trim())) return null;
  const base = withoutFrameAncestors(env.CONTENT_SECURITY_POLICY?.trim() || DEFAULT_CSP);
  const embedAncestors = env.EMBED_FRAME_ANCESTORS?.trim() || "";
  const rawAge = String(env.HSTS_MAX_AGE ?? "").trim();
  const age = rawAge === "" ? DEFAULT_HSTS_MAX_AGE : Number(rawAge);
  const hstsAge = Number.isFinite(age) && age > 0 ? Math.trunc(age) : 0;
  return {
    appCsp: [base, "frame-ancestors 'self'"].filter(Boolean).join("; "),
    embedCsp: [base, embedAncestors && `frame-ancestors ${embedAncestors}`]
      .filter(Boolean)
      .join("; "),
    reportOnly: env.CONTENT_SECURITY_POLICY_REPORT_ONLY?.trim() || "",
    hsts: hstsAge
      ? `max-age=${hstsAge}${truthy(env.HSTS_INCLUDE_SUBDOMAINS) ? "; includeSubDomains" : ""}`
      : "",
  };
}

/**
 * Whether the browser reached us over HTTPS: directly, or through a proxy
 * that terminated TLS and said so. A forged X-Forwarded-Proto can only add
 * HSTS to a plain-HTTP response, which browsers ignore by specification.
 */
function viaHttps(request, url) {
  if (url.protocol === "https:") return true;
  const proto = request.headers.get("x-forwarded-proto") ?? "";
  return proto.split(",")[0].trim().toLowerCase() === "https";
}

/** A policy as the response at `pathname` carries it, nonce filled in. */
function shaped(policy, pathname, nonce) {
  const filled = policy.replaceAll(NONCE_SLOT, nonce);
  return DUCKDB_WORKER.test(pathname) ? withScriptSrc(filled, DUCKDB_WORKER_SCRIPT_SRC) : filled;
}

/** The headers this response should carry, for the path it answers. */
export function headersFor(request, policy, nonce = newNonce()) {
  const url = new URL(request.url);
  const frameable = FRAMEABLE.test(url.pathname);
  const sandbox = url.pathname === SANDBOX_WORKER;
  const out = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": sandbox
      ? SANDBOX_WORKER_CSP
      : shaped(frameable ? policy.embedCsp : policy.appCsp, url.pathname, nonce),
  };
  // The legacy header has no way to say "these sites", so a frameable page
  // simply does not send it.
  if (!frameable) out["x-frame-options"] = "SAMEORIGIN";
  // The sandbox's enforced policy is already the strictest there is.
  if (policy.reportOnly && !sandbox) {
    out["content-security-policy-report-only"] = shaped(policy.reportOnly, url.pathname, nonce);
  }
  if (policy.hsts && viaHttps(request, url)) out["strict-transport-security"] = policy.hsts;
  return out;
}

/** The response with any of `add` it does not already carry. */
function decorate(res, add) {
  const missing = Object.entries(add).filter(([k]) => !res.headers.has(k));
  if (missing.length === 0) return res;
  try {
    for (const [k, v] of missing) res.headers.set(k, v);
    return res;
  } catch {
    // Immutable headers (Response.redirect, a proxied fetch response): copy.
    const headers = new Headers(res.headers);
    for (const [k, v] of missing) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/**
 * srvx middleware: every response — static files, pages, API routes — leaves
 * with the headers above. A header the app set itself is left as it is.
 *
 * The rest of the chain runs inside the nonce store, so the page the router
 * renders stamps the same nonce on its scripts that the header allows.
 */
export function securityHeaders(env = process.env) {
  const policy = securityHeaderPolicy(env);
  return async (request, next) => {
    if (!policy) return next();
    const nonce = newNonce();
    const res = await nonceStore.run(nonce, next);
    if (!res) return res;
    return decorate(res, headersFor(request, policy, nonce));
  };
}
