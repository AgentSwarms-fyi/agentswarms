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

/**
 * Pages other sites are MEANT to frame: embed keys' widgets (/embed/agent,
 * /swarm, /bi, /analyst) and published dashboards (/share/bi/<slug>, whose
 * Publish dialog hands out an <iframe> snippet). The trailing slash matters:
 * /embeds is the signed-in page that manages the keys, and is not one of them.
 */
const FRAMEABLE = /^\/(?:embed|share\/bi)\//;

/**
 * The policy enforced when the operator sets none. Only directives the app
 * cannot trip over: no plugins, no <base> that re-points relative script
 * URLs, no form that posts to another origin. A script-src is deliberately
 * NOT in the default — measured on the built client, the SSR hydration
 * scripts are inline and the DuckDB workers, exceljs, pptxgen and the swarm
 * runtime compile code at run time, so a default script-src would have to
 * allow 'unsafe-inline' and 'unsafe-eval' and stop next to nothing. Operators
 * who want one set CONTENT_SECURITY_POLICY (trial it with the Report-Only
 * variable first).
 */
const DEFAULT_CSP = "object-src 'none'; base-uri 'self'; form-action 'self'";

/** HSTS lifetime when HSTS_MAX_AGE is not set: 180 days. */
const DEFAULT_HSTS_MAX_AGE = 15552000;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/** A policy with any frame-ancestors directive removed; this module owns it. */
function withoutFrameAncestors(policy) {
  return policy
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(?:\s|$)/i.test(d))
    .join("; ");
}

/**
 * What to send, read once from the environment.
 *
 * SECURITY_HEADERS=off            send none (a proxy in front sets them)
 * CONTENT_SECURITY_POLICY         the enforced policy, replacing the default
 * CONTENT_SECURITY_POLICY_REPORT_ONLY  a policy to trial, reported not enforced
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

/** The headers this response should carry, for the path it answers. */
export function headersFor(request, policy) {
  const url = new URL(request.url);
  const frameable = FRAMEABLE.test(url.pathname);
  const out = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": frameable ? policy.embedCsp : policy.appCsp,
  };
  // The legacy header has no way to say "these sites", so a frameable page
  // simply does not send it.
  if (!frameable) out["x-frame-options"] = "SAMEORIGIN";
  if (policy.reportOnly) out["content-security-policy-report-only"] = policy.reportOnly;
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
 */
export function securityHeaders(env = process.env) {
  const policy = securityHeaderPolicy(env);
  return async (request, next) => {
    const res = await next();
    if (!policy || !res) return res;
    return decorate(res, headersFor(request, policy));
  };
}
