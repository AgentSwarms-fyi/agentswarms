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
import { createHmac } from "node:crypto";

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
  return `http://127.0.0.1:${listenPort()}`;
}

/**
 * The port `node server.mjs` listens on: PORT, default 8080, read the way
 * server.mjs reads it (empty is unset).
 *
 * Until R486 this was a fixed 8080, on the reasoning that the server never
 * read PORT. server.mjs has read it since it replaced `vite preview`, so a
 * platform that sets PORT (Render, Fly, Heroku style) got a server on that
 * port and self-calls to 8080, where nothing listens. A PORT that is not a
 * usable port number keeps 8080 rather than building a URL that cannot work.
 *
 * `npm run dev` is the exception: Vite listens on 8080 from vite.config.ts
 * whatever PORT says, so a PORT exported in a dev shell sends these calls to
 * the wrong port. Leave PORT unset for dev.
 */
function listenPort(): number {
  const port = Number(process.env.PORT || 8080);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8080;
}

/**
 * The label the fallback secret is derived under. services/js-sandbox derives
 * the same value from the same key, and a test holds the two to one label.
 */
export const INTERNAL_SECRET_LABEL = "agentswarms/internal-run/v1";

let derivedFor: string | null = null;
let derived: string | null = null;

/**
 * Shared secret proving a request came from this server itself: its own
 * /api/chat self-calls, and the JS sandbox.
 *
 * INTERNAL_RUN_SECRET when set; the setup scripts generate one. Without it,
 * a value DERIVED from the service-role key (an HMAC under a fixed label)
 * rather than the key itself (R463). The fallback used to be the key, so an
 * install that never set INTERNAL_RUN_SECRET sent the database master key in
 * a request header on every internal call, including to the sandbox that runs
 * users' JavaScript. Deriving it keeps those installs working with no change
 * to their .env, and the key never leaves the process.
 */
export function internalRunSecret(): string | null {
  const own = process.env.INTERNAL_RUN_SECRET;
  if (own) return own;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  if (derivedFor !== key) {
    derived = createHmac("sha256", key).update(INTERNAL_SECRET_LABEL).digest("hex");
    derivedFor = key;
  }
  return derived;
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
