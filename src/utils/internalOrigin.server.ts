// Trusted origin + shared secret for server→own-API calls.
//
// Several headless paths (the deployed-swarm API, scheduled swarm runs) execute
// LLM nodes by calling this app's OWN /api/chat over HTTP, authenticated with an
// internal shared secret.
//
// SECURITY — why the origin is never derived from the incoming request:
// `new URL(request.url).origin` reflects the client-supplied Host header on most
// Node/Nitro adapters. Because these self-calls carry the internal secret in a
// header, a spoofed `Host:` would make the server POST that secret straight to
// an attacker's server. So the origin is resolved ONLY from configuration, with
// a loopback fallback — never from user input.

/** Strip trailing slashes so callers can safely append "/api/...". */
function normalize(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Absolute origin this server uses to call its own HTTP API.
 *
 * Order: PUBLIC_APP_URL → SITE_URL → loopback on the app's own port. The
 * loopback fallback keeps single-container / VM deployments working with no
 * extra configuration (the process simply calls itself), while remaining immune
 * to Host-header spoofing. Set PUBLIC_APP_URL when the app is not reachable on
 * localhost from inside its own container.
 */
export function resolveInternalOrigin(): string {
  const configured = process.env.PUBLIC_APP_URL || process.env.SITE_URL;
  if (configured && /^https?:\/\/\S+$/i.test(configured.trim())) {
    return normalize(configured.trim());
  }
  // 8080 is where this app actually binds (Dockerfile CMD --port 8080
  // --strictPort, and vite.config's preview port). Deliberately NOT
  // process.env.PORT: the server never reads PORT, so a platform that sets it
  // (Render/Fly/Heroku style) would otherwise send these self-calls to a port
  // nothing is listening on. If you bind a different port, set PUBLIC_APP_URL.
  return "http://127.0.0.1:8080";
}

/**
 * Shared secret proving a request to /api/chat came from this server itself.
 *
 * Prefers a dedicated INTERNAL_RUN_SECRET; falls back to the service-role key so
 * existing deployments keep working. Setting INTERNAL_RUN_SECRET is strongly
 * recommended — it keeps the database master key out of outbound HTTP headers.
 */
export function internalRunSecret(): string | null {
  return process.env.INTERNAL_RUN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

/**
 * Constant-time comparison of a presented secret against the expected one.
 * Returns false when either side is missing. Length is not secret-dependent
 * here (both are fixed per deployment), so an early length check is fine.
 */
export function internalSecretMatches(presented: string | null | undefined): boolean {
  const expected = internalRunSecret();
  if (!expected || !presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
