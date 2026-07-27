// Locating the optional doc-gen renderer.
//
// The correct hostname depends on where the APP runs, which is a footgun:
//
//   app in the compose stack  →  http://docgen:8099    (service name)
//   app via `npm run dev`     →  http://localhost:8099 (published loopback port)
//
// Setting the dev value while running the Docker stack (or vice versa) makes
// every Deep-mode generation silently fall back to the in-browser builder,
// producing a file identical to Fast mode — indistinguishable from Deep mode
// being broken. So instead of trusting the configuration, we probe: an explicit
// DOCGEN_SERVICE_URL is tried first, and only if nothing answers there do we
// try the two well-known hostnames. A correct setting is always honoured; a
// stale one self-heals instead of silently degrading.
//
// The resolved value is cached for a short while: operators start and stop the
// container mid-session, and a stale "not available" would be worse than the
// occasional extra probe.

const CANDIDATES = ["http://docgen:8099", "http://localhost:8099"];
const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2500;

let cached: { at: number; url: string | null } | null = null;

function authHeaders(): Record<string, string> {
  return process.env.DOCGEN_TOKEN ? { Authorization: `Bearer ${process.env.DOCGEN_TOKEN}` } : {};
}

async function reachable(base: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/health`, { headers: authHeaders(), signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Base URL of the doc-gen service, or null when it isn't running anywhere we
 * can see. A configured DOCGEN_SERVICE_URL is tried first and wins whenever it
 * answers; the well-known hostnames are only a fallback for when it doesn't.
 */
export async function resolveDocgenBaseUrl(): Promise<string | null> {
  const explicit = (process.env.DOCGEN_SERVICE_URL || "").replace(/\/+$/, "");
  const candidates = explicit
    ? [explicit, ...CANDIDATES.filter((c) => c !== explicit)]
    : [...CANDIDATES];

  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.url;
  for (const base of candidates) {
    if (await reachable(base)) {
      cached = { at: Date.now(), url: base };
      return base;
    }
  }
  cached = { at: Date.now(), url: null };
  return null;
}

/** Headers for a call to the service (shared bearer token when configured). */
export { authHeaders as docgenAuthHeaders };
