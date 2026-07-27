// Pure origin-matching helpers for embed authorization.
//
// Kept out of embed.server.ts (which pulls in the service-role client) so the
// matching rules can be unit-tested directly and reused anywhere.

export function hostnameOf(originOrUrl: string | null | undefined): string | null {
  if (!originOrUrl) return null;
  try {
    return new URL(originOrUrl).hostname.toLowerCase();
  } catch {
    // Bare hostname without scheme
    const bare = String(originOrUrl).trim().toLowerCase();
    return /^[a-z0-9.-]+$/.test(bare) ? bare : null;
  }
}

/** '*' allows everything; 'example.com' exact; '*.example.com' any subdomain (and the apex). */
export function domainAllowed(allowed: string[], parentOrigin: string | null | undefined): boolean {
  const list = (allowed ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (list.includes("*")) return true;
  const host = hostnameOf(parentOrigin);
  if (!host) return false;
  for (const entry of list) {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (host === base || host.endsWith("." + base)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Browser-enforced origin check, complementing the client-reported
 * `parentOrigin`.
 *
 * WHAT THIS CLOSES. The embed page is served from OUR origin, so the fetch it
 * makes to /api/embed* is same-origin and the browser sets
 * `Origin: <this app>`. A malicious site that lifted someone's key out of an
 * iframe snippet could previously call the API straight from its own page —
 * the browser truthfully sent `Origin: https://evil.example`, but we never
 * looked, and CORS is `*`, so it worked. Now that request is refused.
 *
 * WHAT THIS DOES NOT CLOSE, and cannot. `Origin` is only trustworthy because
 * *browsers* refuse to lie about it. A non-browser client (curl, a script)
 * sets any header it likes, and the embed key is public by construction — it
 * ships in the host page's HTML. So the domain allow-list is a browser-level
 * control, not an authentication boundary. What actually bounds abuse from a
 * scripted client is the per-key budget, the rate limit, and key expiry; all
 * three exist, and denials are audited.
 */
export function requestOriginAllowed(
  request: Request,
  allowedDomains: string[],
): { ok: true } | { ok: false; origin: string } {
  const origin = request.headers.get("origin");
  // Absent Origin means this isn't a browser cross-origin request — either a
  // same-origin call or a non-browser client. Nothing to check; see the
  // "does not close" note above.
  if (!origin) return { ok: true };

  const originHost = hostnameOf(origin);
  if (!originHost) return { ok: false, origin };

  // Our own embed page calling home.
  let selfHost: string | null = null;
  try {
    selfHost = new URL(request.url).hostname.toLowerCase();
  } catch {
    /* malformed request URL — fall through to the allow-list */
  }
  if (selfHost && originHost === selfHost) return { ok: true };

  // A site on the key's allow-list calling the API directly is legitimate.
  if (domainAllowed(allowedDomains ?? [], origin)) return { ok: true };

  return { ok: false, origin };
}
