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
// DNS REBINDING (VA-2026-10-25-21): a direct connection is PINNED to the
// addresses that were just checked — fetch() is given a dispatcher whose lookup
// answers with them — so a resolver cannot pass the check with one address and
// hand the connection another. A name that does not resolve here is refused,
// unless the hop leaves through the proxy, which resolves it. A proxied hop, and
// a fetch some other program makes (DuckDB, a scraping service), cannot be
// pinned from here; egress firewall rules remain the strongest control.
import { AsyncLocalStorage } from "node:async_hooks";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";

import { Agent } from "undici";

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
 * by luck — assertPublicUrl allowed a URL whose lookup FAILED (until R395), so a
 * resolver that errors (or a platform that does not normalise) turned a missed
 * static check into a reachable metadata endpoint.
 */
function extractV4(h: string): [number, number, number, number] | null {
  // An IPv4 address carried in the last two hextets: IPv4-mapped (::ffff:),
  // IPv4-compatible (::), and the NAT64 well-known prefix (64:ff9b::) — the URL
  // parser writes all three in hex, and through a NAT64 gateway
  // 64:ff9b::a9fe:a9fe IS 169.254.169.254 (VA-2026-10-25-21).
  const hexTail = h.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexTail) {
    const hi = parseInt(hexTail[1], 16);
    const lo = parseInt(hexTail[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  }
  // 6to4 (2002::/16) carries one in the second and third hextets.
  const sixToFour = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1], 16);
    const lo = parseInt(sixToFour[2], 16);
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
  // IPv6 link-local is fe80::/10 — fe80: through febf: — not just fe80:
  // (VA-2026-10-25-21); multicast is ff00::/8.
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // IPv6 link-local
  if (/^ff[0-9a-f]{2}:/.test(h)) return true; // IPv6 multicast
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
  if (/^fe[c-f][0-9a-f]:/.test(h)) return true; // IPv6 site-local fec0::/10 (deprecated)
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
  opts: {
    blockPrivate?: boolean;
    allowPrivate?: boolean;
    /**
     * The name is resolved somewhere else — the hop goes through the proxy.
     * Undefined: assume so when a proxy applies to this URL (a caller that
     * hands the URL to another service, or to the proxy, rather than fetching
     * it directly). safeFetch says exactly.
     */
    resolvedElsewhere?: boolean;
  } = {},
): Promise<
  | { ok: true; url: URL; addresses: LookupAddress[] }
  | { ok: false; error: string; unresolved?: { host: string; code: string } }
> {
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
  // Say WHY it was refused, accurately. The message used to blame
  // BLOCK_PRIVATE_NETWORK_FETCH unconditionally, so /api/a2a — which passes
  // blockPrivate itself and does not consult the env var — told users an
  // environment variable was enabled when it was not set anywhere. The advice
  // that message implies (go unset it) does nothing, and the real reason is
  // invisible.
  // `allowPrivate` is for the one kind of call site the deployment's block was
  // never meant to cover: a model provider's base URL (see providerFetch). It
  // drops the private-network tier only; the always-blocked tier still applies.
  const strictFromEnv = opts.allowPrivate === true ? false : blockPrivateNetworks();
  const strict = opts.blockPrivate === true || strictFromEnv;
  const whyStrict = strictFromEnv
    ? "BLOCK_PRIVATE_NETWORK_FETCH is enabled"
    : "this endpoint does not allow private-network targets";
  const classify = (host: string): string | null => {
    if (isBlockedAlways(host)) return `Refusing to fetch link-local/metadata address: ${host}`;
    if (strict && isPrivateNetwork(host)) {
      return `Refusing to fetch private/internal host ${host} — ${whyStrict}`;
    }
    return null;
  };

  const hostErr = classify(u.hostname);
  if (hostErr) return { ok: false, error: hostErr };

  // A public-looking name can still resolve into a blocked range.
  let addrs: LookupAddress[];
  try {
    addrs = await lookup(normalize(u.hostname), { all: true });
  } catch (e) {
    // A name that does not resolve HERE is refused (VA-2026-10-25-21): it used
    // to pass, and fetch() then resolved it again — a resolver that fails the
    // first query and answers the second with 169.254.169.254 walked straight
    // through. Unless the name is resolved elsewhere: a proxied hop.
    const elsewhere =
      opts.resolvedElsewhere ??
      (await import("@/utils/http/connectorFetch.server")).proxyForUrl(u) !== null;
    if (elsewhere) return { ok: true, url: u, addresses: [] };
    const code = String((e as { code?: unknown })?.code ?? "ENOTFOUND");
    return {
      ok: false,
      unresolved: { host: u.hostname, code },
      error: unresolvedMessage(u.hostname, code),
    };
  }
  for (const a of addrs) {
    const err = classify(a.address);
    if (err) return { ok: false, error: `${err} (resolved from ${u.hostname})` };
  }
  return { ok: true, url: u, addresses: addrs };
}

function unresolvedMessage(host: string, code: string): string {
  return `${host} does not resolve from this server (${code}), so nothing was sent to it`;
}

/**
 * The target's name did not resolve, so nothing was sent. A network failure
 * caught before the connection, not a refusal: a transient EAI_AGAIN is worth
 * retrying (each attempt resolves and checks again), and `code` is the one
 * fetch() itself would have reported, so describeFetchFailure still says "its
 * host name does not resolve".
 */
export class HostNotResolvedError extends Error {
  readonly code: string;
  constructor(host: string, code: string) {
    super(unresolvedMessage(host, code));
    this.name = "HostNotResolvedError";
    this.code = code;
  }
}

// One pinned agent per host and checked address set: pooled like any agent,
// and able to connect nowhere but those addresses. Dropped (not closed — a
// response may still be streaming) once there are many.
const pinnedAgents = new Map<string, Agent>();

/** A dispatcher whose every connection goes to the addresses already checked. */
function pinnedDispatcher(host: string, addresses: LookupAddress[]): Agent {
  const key = `${host}|${addresses
    .map((a) => a.address)
    .sort()
    .join(",")}`;
  let agent = pinnedAgents.get(key);
  if (!agent) {
    if (pinnedAgents.size >= 256) pinnedAgents.clear();
    agent = new Agent({
      connect: {
        // net.connect's lookup: with `all` (address-family racing) it wants the
        // list, without it one address.
        lookup: (
          _name: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      } as never,
    });
    pinnedAgents.set(key, agent);
  }
  return agent;
}

/**
 * The guard refused the target. Distinct from a network failure: retrying it
 * cannot succeed, and its message is safe to show the caller.
 */
export class SsrfRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfRefusedError";
  }
}

/**
 * fetch() that validates the target and every redirect hop, so a public URL
 * cannot bounce the request into a blocked range.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit & {
    maxRedirects?: number;
    blockPrivate?: boolean;
    allowPrivate?: boolean;
    /** Route through HTTPS_PROXY / HTTP_PROXY unless NO_PROXY bypasses the hop. */
    useProxy?: boolean;
  } = {},
): Promise<Response> {
  const { maxRedirects = 5, blockPrivate, allowPrivate, useProxy, ...rest } = init;
  let current = rawUrl;
  const callerDispatcher = "dispatcher" in rest;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // The proxy is chosen per hop (NO_PROXY may send one hop direct and the
    // next through the proxy) — before the check, which must know whether this
    // hop's name is resolved here or by the proxy.
    let dispatcher: unknown;
    if (useProxy && !callerDispatcher) {
      let hopUrl: URL | null = null;
      try {
        hopUrl = new URL(current);
      } catch {
        /* the check below says it is not a URL */
      }
      if (hopUrl) {
        const { proxyDispatcherFor } = await import("@/utils/http/connectorFetch.server");
        dispatcher = await proxyDispatcherFor(hopUrl);
      }
    }
    // EVERY hop is re-validated, including the first. A public URL that 302s
    // to 169.254.169.254 is the whole reason this loop exists.
    const check = await assertPublicUrl(current, {
      blockPrivate,
      allowPrivate,
      resolvedElsewhere: Boolean(dispatcher) || callerDispatcher,
    });
    // A provider set to require a private path: a hop that leaves through the
    // proxy is the egress the operator chose; a direct hop must resolve to
    // private addresses only — checked against the addresses just resolved,
    // the ones the connection is pinned to. A name that does not resolve is
    // that refusal too (audited), not the generic one.
    const policy = useProxy ? privatePathScope.getStore() : undefined;
    if (policy?.required && !dispatcher) {
      if (!check.ok && check.unresolved) assertPrivateTarget(check.unresolved.host, policy, []);
      if (check.ok) assertPrivateTarget(check.url.hostname, policy, check.addresses);
    }
    if (!check.ok && check.unresolved) {
      throw new HostNotResolvedError(check.unresolved.host, check.unresolved.code);
    }
    if (!check.ok) throw new SsrfRefusedError(check.error);
    // A direct hop connects only to the addresses just checked (DNS rebinding).
    if (!dispatcher && !callerDispatcher && check.addresses.length > 0) {
      dispatcher = pinnedDispatcher(check.url.hostname, check.addresses);
    }
    const res = await fetch(check.url, {
      ...rest,
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
      redirect: "manual",
    });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;
    current = new URL(res.headers.get("location")!, check.url).toString();
  }
  throw new Error("Too many redirects");
}

/**
 * safeFetch for a model provider's endpoint — a base URL, gateway or token URI
 * that a signed-in user configured (R386). Those are per-user settings, not
 * operator configuration, so any user could aim one at the cloud metadata
 * address: the always-blocked tier applies here, to the name, every address it
 * resolves to and every redirect hop. BLOCK_PRIVATE_NETWORK_FETCH does not: a
 * model server on a private address (Ollama, vLLM, LiteLLM) is what these
 * settings exist for, and the models docs say the block does not cover them.
 *
 * Model calls honour the corporate proxy (HTTPS_PROXY / HTTP_PROXY, bypassed
 * per host by NO_PROXY) like every connector: a network whose only egress is
 * a proxy could otherwise reach no hosted model at all.
 */
export function providerFetch(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  return safeFetch(rawUrl, { ...init, allowPrivate: true, useProxy: true });
}

// ── Require a private path (per provider, off by default) ───────────────────

/**
 * The provider requires a private network path, and this call would not take
 * one. A refusal like SsrfRefusedError: never retried, safe to show.
 */
export class PrivatePathRequiredError extends SsrfRefusedError {
  constructor(message: string) {
    super(message);
    this.name = "PrivatePathRequiredError";
  }
}

/**
 * The private-path requirement for the provider call in progress. Mutable on
 * purpose: a call enters the scope before its provider's configuration is
 * read, and marks it required once it has been.
 */
export type PrivatePathPolicy = {
  required: boolean;
  /** Names the provider in the refusal, e.g. "AWS Bedrock". */
  label: string;
  /** Records a refusal (the audit trail); never throws. */
  onRefuse?: (detail: string) => void;
};

const privatePathScope = new AsyncLocalStorage<PrivatePathPolicy>();

/** Run a provider call in a scope its configuration can mark private-only. */
export function withPrivatePathScope<T>(fn: (policy: PrivatePathPolicy) => Promise<T>): Promise<T> {
  const policy: PrivatePathPolicy = { required: false, label: "This provider" };
  return privatePathScope.run(policy, () => fn(policy));
}

/** The refusal message, shared by the per-connection check and the preflight. */
export function privatePathRefusal(label: string, host: string, addresses: string[]): string {
  const where = addresses.length
    ? `resolves to a public address (${addresses.slice(0, 2).join(", ")})`
    : "does not resolve";
  return (
    `${label} is set to require a private network path, but ${host} ${where} from this ` +
    "server, so the call was not sent. Check the private endpoint's DNS zone, set the " +
    "provider's endpoint URL, or send model traffic through the proxy."
  );
}

/**
 * Refuse a direct hop for a provider that requires a private path unless every
 * address it resolved to — the ones its connection is pinned to — is private.
 * An empty list is a name that did not resolve.
 */
function assertPrivateTarget(
  hostname: string,
  policy: PrivatePathPolicy,
  resolved: LookupAddress[],
): void {
  const host = normalize(hostname);
  const addresses = resolved.map((a) => a.address);
  if (addresses.length > 0 && addresses.every((a) => isPrivateNetwork(a))) return;
  const detail = privatePathRefusal(
    policy.label,
    host,
    addresses.filter((a) => !isPrivateNetwork(a)),
  );
  try {
    policy.onRefuse?.(detail);
  } catch {
    /* auditing must not change the outcome */
  }
  throw new PrivatePathRequiredError(detail);
}
