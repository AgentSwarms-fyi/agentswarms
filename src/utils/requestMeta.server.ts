// Request metadata helpers for public endpoints (client IP, user agent).
//
// Used for credential last-used stamps and for auditing authorization
// decisions on internet-facing routes. Every value here is derived from
// hop-by-hop headers a client can spoof unless a trusted proxy overwrites
// them, so treat these as forensic hints — never as an access-control input.

/** Header order matters: the platform-specific ones are set by the edge. */
const IP_HEADERS = [
  "cf-connecting-ip", // Cloudflare
  "x-real-ip", // nginx / common reverse proxies
  "x-vercel-forwarded-for",
  "true-client-ip",
];

/**
 * Best-effort client IP. Prefers headers written by the edge/proxy, then the
 * left-most entry of X-Forwarded-For (the original client per RFC 7239).
 * Returns null when nothing usable is present (e.g. direct local calls).
 */
export function clientIp(request: Request): string | null {
  for (const h of IP_HEADERS) {
    const v = request.headers.get(h)?.trim();
    if (v) return v.slice(0, 64);
  }
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return null;
}

/** Truncated User-Agent, for the same forensic purpose. */
export function clientUserAgent(request: Request): string | null {
  const ua = request.headers.get("user-agent")?.trim();
  return ua ? ua.slice(0, 200) : null;
}
