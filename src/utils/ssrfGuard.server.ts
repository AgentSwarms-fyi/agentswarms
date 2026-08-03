// SSRF guard for server-side fetches of user- or model-supplied URLs.
//
// The swarm `http` node and provider/MCP/n8n endpoints take a URL the user
// authored; the `web_browse` tool takes one the MODEL chose (reachable by
// prompt injection, incl. through a public embed). All run server-side, inside
// the deployment's network.
//
// POLICY (two tiers):
//   1. Link-local / cloud-metadata / unspecified / multicast addresses are
//      ALWAYS refused. 169.254.169.254 (AWS/GCP/Azure/OCI instance metadata)
//      can hand out the host's IAM credentials and has no legitimate use as a
//      fetch target, so nothing can enable it.
//   2. Ordinary private networks (localhost, RFC1918, CGNAT, IPv6 ULA) are
//      ALLOWED BY DEFAULT — self-hosted model servers (Ollama/vLLM), in-cluster
//      MCP servers and self-hosted n8n live there, and this is a self-hostable
//      tool. Operators running untrusted multi-tenant or public embeds can set
//      BLOCK_PRIVATE_NETWORK_FETCH=true to refuse those too.
//
// The hostname is RESOLVED and every resulting IP is checked, and redirects are
// followed manually, so a public URL can't 302 into a blocked range.
//
// RESIDUAL RISK: DNS rebinding — we validate the resolved address, then fetch()
// resolves again; a hostile resolver could answer differently the second time.
// Fully closing that needs connection-level IP pinning, which fetch() does not
// expose. Egress firewall rules remain the strongest control.
import { lookup } from "node:dns/promises";

function normalize(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .trim();
}

/**
 * Parse an IPv4 (incl. IPv4-mapped IPv6) into octets, or null if not IPv4.
 *
 * Both spellings of the mapped form must be understood. `::ffff:169.254.169.254`
 * keeps the dotted tail, but the COMPRESSED HEX form `::ffff:a9fe:a9fe` is the
 * same address and used to fall through every static check: it was refused only
 * because Node's resolver happened to hand the dotted form back. That is defence
 * by luck — assertPublicUrl allows a URL whose lookup FAILS, so a resolver that
 * errors (or a platform that does not normalise) turned a missed static check
 * into a reachable metadata endpoint.
 */
function extractV4(h: string): [number, number, number, number] | null {
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  }
  const mapped = h.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  const v4 = mapped ? mapped[1] : /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : null;
  if (!v4) return null;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

/**
 * Addresses that are NEVER a legitimate fetch target — refused regardless of
 * the private-network policy: cloud instance metadata (169.254.169.254), the
 * rest of link-local, the unspecified address, and multicast/reserved.
 */
export function isBlockedAlways(host: string): boolean {
  const h = normalize(host);
  if (!h) return true;
  if (h === "::") return true; // unspecified
  if (h.startsWith("fe80:")) return true; // IPv6 link-local
  if (h === "fd00:ec2::254") return true; // AWS instance metadata over IPv6
  const v4 = extractV4(h);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true; // 0.0.0.0/8 (can resolve to localhost)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local incl. cloud metadata
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

/**
 * Ordinary private / internal networks that ARE legitimate for self-hosted
 * tools. Allowed by default; refused only under BLOCK_PRIVATE_NETWORK_FETCH.
 */
export function isPrivateNetwork(host: string): boolean {
  const h = normalize(host);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true; // IPv6 loopback
  if (/^f[cd]/.test(h)) return true; // IPv6 ULA fc00::/7 (fd00:ec2::254 already blocked above)
  const v4 = extractV4(h);
  if (v4) {
    const [a, b] = v4;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }
  return false;
}

/** Back-compat: any address that is either always-blocked or a private network. */
export function isPrivateAddress(host: string): boolean {
  return isBlockedAlways(host) || isPrivateNetwork(host);
}

/**
 * Whether ordinary private networks should be refused. Off by default (they're
 * allowed). ALLOW_PRIVATE_NETWORK_FETCH is honoured for backward compatibility
 * and forces the permissive behaviour even if BLOCK is also set.
 */
function blockPrivateNetworks(): boolean {
  if (/^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_NETWORK_FETCH ?? "")) return false;
  return /^(1|true|yes)$/i.test(process.env.BLOCK_PRIVATE_NETWORK_FETCH ?? "");
}

/**
 * Validate a URL for server-side fetching: http(s) only; never a link-local /
 * metadata address; and — when BLOCK_PRIVATE_NETWORK_FETCH is set — never an
 * ordinary private/internal address either. Checks the hostname and every IP it
 * resolves to.
 */
export async function assertPublicUrl(
  rawUrl: string,
  opts: { blockPrivate?: boolean } = {},
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

  // `blockPrivate` lets a CALLER be stricter than the deployment default, and
  // only stricter — it is OR'd, never consulted to permit something the
  // deployment refuses. /api/a2a uses it: it proxies a remote agent's response
  // back to the browser, so a private-network fetch there is a read primitive
  // rather than a self-hosted convenience.
  const strict = opts.blockPrivate === true || blockPrivateNetworks();
  const classify = (host: string): string | null => {
    if (isBlockedAlways(host)) return `Refusing to fetch link-local/metadata address: ${host}`;
    if (strict && isPrivateNetwork(host)) {
      return `Refusing to fetch private/internal host ${host} — BLOCK_PRIVATE_NETWORK_FETCH is enabled`;
    }
    return null;
  };

  const hostErr = classify(u.hostname);
  if (hostErr) return { ok: false, error: hostErr };

  // A public-looking name can still resolve into a blocked range.
  try {
    const addrs = await lookup(u.hostname, { all: true });
    for (const a of addrs) {
      const err = classify(a.address);
      if (err) return { ok: false, error: `${err} (resolved from ${u.hostname})` };
    }
  } catch {
    // Resolution failure isn't itself an SSRF signal — let fetch report it.
  }
  return { ok: true, url: u };
}

/**
 * fetch() that validates the target and every redirect hop, so a public URL
 * cannot bounce the request into a blocked range.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number; blockPrivate?: boolean } = {},
): Promise<Response> {
  const { maxRedirects = 5, blockPrivate, ...rest } = init;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // EVERY hop is re-validated, including the first. A public URL that 302s
    // to 169.254.169.254 is the whole reason this loop exists.
    const check = await assertPublicUrl(current, { blockPrivate });
    if (!check.ok) throw new Error(check.error);
    const res = await fetch(check.url, { ...rest, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;
    current = new URL(res.headers.get("location")!, check.url).toString();
  }
  throw new Error("Too many redirects");
}
