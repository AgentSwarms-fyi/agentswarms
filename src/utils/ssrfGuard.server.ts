// SSRF guard for server-side fetches of user- or model-supplied URLs.
//
// The swarm `http` node takes a URL the user authored, and the `web_browse`
// tool takes one the MODEL chose (so it is reachable by prompt injection, incl.
// through a public embed). Both run server-side, inside the deployment's
// network. Without a guard they can reach:
//   - cloud instance metadata (169.254.169.254) — on the documented VM targets
//     (OCI/AWS/GCP) that can return the instance's IAM credentials,
//   - the app's own loopback endpoints,
//   - anything else on the private network.
//
// Generalised from the check already applied to A2A endpoints (routes/api/a2a),
// with two additions that a hostname-only check misses: the hostname is
// RESOLVED and every resulting IP is checked, and redirects are followed
// manually so a public URL can't 302 into the private range.
//
// RESIDUAL RISK: DNS rebinding. We validate the resolved address, then fetch()
// resolves again; a hostile resolver could answer differently the second time.
// Fully closing that needs connection-level IP pinning, which fetch() does not
// expose. Egress firewall rules remain the strongest control.
import { lookup } from "node:dns/promises";

/** Escape hatch for self-hosters who deliberately call internal services. */
function privateNetworkAllowed(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_NETWORK_FETCH ?? "");
}

/** True for loopback, private, link-local, multicast and reserved addresses. */
export function isPrivateAddress(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .trim();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;

  // IPv6 loopback / unique-local / link-local / unspecified.
  if (h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::") return true;
  if (/^f[cd]/.test(h)) return true; // ULA fc00::/7
  if (h.startsWith("fe80:")) return true; // link-local

  // IPv4, including IPv4-mapped IPv6 (::ffff:192.168.1.1).
  const mapped = h.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  const v4 = mapped ? mapped[1] : /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : null;
  if (v4) {
    const parts = v4.split(".").map(Number);
    if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

/**
 * Validate a URL for server-side fetching: http(s) only, and neither the
 * hostname nor any address it resolves to may be private/internal.
 */
export async function assertPublicUrl(
  rawUrl: string,
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "Only http(s) URLs are allowed" };
  }
  if (privateNetworkAllowed()) return { ok: true, url: u };

  if (isPrivateAddress(u.hostname)) {
    return { ok: false, error: `Refusing to fetch private/internal host: ${u.hostname}` };
  }
  // A public-looking name can still resolve into the private range.
  try {
    const addrs = await lookup(u.hostname, { all: true });
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        return {
          ok: false,
          error: `Refusing to fetch ${u.hostname}: it resolves to a private address (${a.address})`,
        };
      }
    }
  } catch {
    // Resolution failure isn't itself an SSRF signal — let fetch report it.
  }
  return { ok: true, url: u };
}

/**
 * fetch() that validates the target and every redirect hop, so a public URL
 * cannot bounce the request into the private network.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  const { maxRedirects = 5, ...rest } = init;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await assertPublicUrl(current);
    if (!check.ok) throw new Error(check.error);
    const res = await fetch(check.url, { ...rest, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;
    current = new URL(res.headers.get("location")!, check.url).toString();
  }
  throw new Error("Too many redirects");
}
