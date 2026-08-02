// Outbound HTTP for connectors: corporate proxy support, and retry with
// backoff for transient failures.
//
// Every warehouse HTTP driver and every SaaS connector reaches a third party
// over the internet. Two things were missing and both are table stakes for a
// deployment inside a corporate network:
//
// PROXY. Many enterprises have no direct egress at all — everything leaves
// through an authenticated forward proxy, and HTTPS_PROXY is how that is
// configured by convention. Without it the product simply cannot reach
// Snowflake or Stripe from inside such a network, and the failure looks like
// "connection timed out" rather than "you need to configure a proxy".
//
// Node 24 can do this natively with --use-env-proxy, but the Docker image is
// node:22-slim and `engines` allows >=20.19, so the native flag would silently
// do nothing for most deployments. undici's ProxyAgent works across the whole
// supported range, which is why it is an explicit dependency rather than
// something we hope is present transitively.
//
// RETRY. A 429 or a 503 from a warehouse's API is normal operation, not a
// fault, and previously surfaced to the user as a failed dashboard tile.
//
// ON RETRYING NON-IDEMPOTENT REQUESTS: these are POSTs, and a POST that timed
// out may or may not have taken effect. That is acceptable here for a specific
// reason — every driver enforces read-only SQL and every SaaS call is a read,
// so a duplicated request cannot corrupt anything. The real cost of a
// double-send is MONEY (bytes scanned, credits burned), which is why the
// default is 2 retries rather than an aggressive number, and why 500 is NOT
// retried by default: unlike 429 and 503 it often means the query did run and
// then failed.

import { isBlockedAlways } from "@/utils/ssrfGuard.server";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

/** Attempts AFTER the first. 0 disables retrying entirely. */
function maxRetries(): number {
  return Math.min(envInt("CONNECTOR_MAX_RETRIES", 2), 5);
}

function baseDelayMs(): number {
  return envInt("CONNECTOR_RETRY_BASE_MS", 400);
}

/** Ceiling for one sleep, including a server-supplied Retry-After. */
function maxDelayMs(): number {
  return envInt("CONNECTOR_RETRY_MAX_MS", 8_000);
}

/**
 * Statuses worth trying again.
 *
 * 429 and 503 mean "rejected, come back later" — the request did not run.
 * 408 and 504 are timeouts at the edge. 502 is a bad gateway hop.
 *
 * 500 is deliberately ABSENT: it usually means the request reached the
 * backend and failed there, so retrying pays for the same work twice and
 * rarely succeeds. Set CONNECTOR_RETRY_500=1 for a provider that returns 500
 * for throttling, which some do.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 500)
    return /^(1|true|yes|on)$/i.test((process.env.CONNECTOR_RETRY_500 ?? "").trim());
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * A thrown fetch error is a transport failure — DNS, connection refused, reset
 * mid-flight. Those are worth another go. An AbortError is NOT: the caller's
 * deadline passed, and retrying would ignore it.
 */
export function isRetryableError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return false;
  return true;
}

/**
 * Honour Retry-After, which may be delta-seconds or an HTTP date.
 * Returns null when absent or unparseable, so the caller falls back to backoff.
 */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, maxDelayMs());
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), maxDelayMs());
  return null;
}

/**
 * Exponential backoff with FULL JITTER.
 *
 * Jitter is not a refinement here. Twelve dashboard tiles hitting one rate
 * limit retry in lockstep without it, so they collide again on every attempt —
 * the retry storm re-creates the condition it is backing off from.
 */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const ceiling = Math.min(baseDelayMs() * 2 ** attempt, maxDelayMs());
  return Math.floor(rand() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Proxy ────────────────────────────────────────────────────────────────────

/**
 * NO_PROXY matching, by the convention every other tool follows:
 *   "*"              — bypass everything
 *   "example.com"    — that host AND its subdomains
 *   ".example.com"   — subdomains (and the bare domain, as curl does)
 *   "10.0.0.5:5432"  — host with an explicit port
 */
export function bypassesProxy(hostname: string, port: string, noProxy: string): boolean {
  const entries = noProxy
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.includes("*")) return true;
  const host = hostname.toLowerCase();
  for (const raw of entries) {
    const [ePart, ePort] = raw.startsWith("[")
      ? [raw, ""] // bracketed IPv6, no port split
      : raw.includes(":")
        ? [raw.slice(0, raw.lastIndexOf(":")), raw.slice(raw.lastIndexOf(":") + 1)]
        : [raw, ""];
    if (ePort && ePort !== port) continue;
    const e = ePart.replace(/^\./, "");
    if (host === e || host.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** The proxy URL that applies to `target`, or null for a direct connection. */
export function proxyForUrl(target: URL): string | null {
  const env = process.env;
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  if (noProxy && bypassesProxy(target.hostname, port, noProxy)) return null;
  const proxy =
    target.protocol === "https:"
      ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy)
      : (env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy);
  return proxy?.trim() ? proxy.trim() : null;
}

// One agent per proxy URL. Building a ProxyAgent per request would open a new
// connection pool to the proxy each time — the exact cost pooling exists to
// avoid, moved one hop out.
const agents = new Map<string, unknown>();

async function dispatcherFor(target: URL): Promise<unknown | undefined> {
  const proxy = proxyForUrl(target);
  if (!proxy) return undefined;
  const cached = agents.get(proxy);
  if (cached) return cached;
  try {
    const { ProxyAgent } = await import("undici");
    const agent = new ProxyAgent(proxy);
    agents.set(proxy, agent);
    return agent;
  } catch (e) {
    // Never fail the request because the proxy layer could not load — fall
    // back to a direct connection and say so once, loudly enough to diagnose.
    console.warn(
      `[connector-fetch] proxy configured (${proxy}) but undici is unavailable: ${(e as Error).message}`,
    );
    return undefined;
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

export type ConnectorFetchOptions = {
  /** Label used in error messages, e.g. "Snowflake". */
  label?: string;
  /** Override the retry count for this call. */
  retries?: number;
  /** Injected in tests so backoff is deterministic. */
  rand?: () => number;
  /** Injected in tests so a retry does not really sleep. */
  sleepFn?: (ms: number) => Promise<void>;
};

/**
 * fetch() for third-party connectors: proxy-aware and retrying.
 *
 * A drop-in replacement — same arguments, same Response — so a driver adopts
 * it by changing the function name and nothing else.
 */
export async function connectorFetch(
  input: string | URL,
  init: RequestInit = {},
  opts: ConnectorFetchOptions = {},
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);

  // SSRF check applies to the TARGET, before any proxy is chosen. A proxy must
  // not become a way to reach link-local or cloud-metadata addresses.
  if (isBlockedAlways(url.hostname)) {
    throw new Error(`${opts.label ?? "Connector"}: refusing to connect to a blocked host`);
  }

  const dispatcher = await dispatcherFor(url);
  const attempts = (opts.retries ?? maxRetries()) + 1;
  const doSleep = opts.sleepFn ?? sleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await doSleep(backoffMs(attempt - 1, opts.rand));
    }
    try {
      const res = await fetch(url, {
        ...init,
        ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
      });
      if (attempt < attempts - 1 && isRetryableStatus(res.status)) {
        // Prefer the server's own advice over our backoff when it gives any.
        const after = retryAfterMs(res.headers.get("retry-after"));
        if (after !== null) await doSleep(after);
        // The body must be drained or the connection is not returned to the
        // pool — a leak that only shows up under sustained retrying.
        void res.arrayBuffer().catch(() => {});
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      if (!isRetryableError(e) || attempt === attempts - 1) throw e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.label ?? "Connector"}: request failed`);
}

/** Snapshot for /api/metrics and debugging. Never exposes proxy credentials. */
export function connectorHttpStats(): {
  retries: number;
  proxyConfigured: boolean;
  proxyAgents: number;
} {
  const env = process.env;
  return {
    retries: maxRetries(),
    proxyConfigured: Boolean(
      (
        env.HTTPS_PROXY ??
        env.https_proxy ??
        env.HTTP_PROXY ??
        env.http_proxy ??
        env.ALL_PROXY ??
        env.all_proxy ??
        ""
      ).trim(),
    ),
    proxyAgents: agents.size,
  };
}
