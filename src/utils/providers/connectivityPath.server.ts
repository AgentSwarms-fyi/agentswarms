// Which network path a model call takes (private connectivity, Phase 2).
//
// A private endpoint is only private if the name actually resolves to a
// private address, or the call actually leaves through the proxy. A mis-set DNS
// zone fails silently otherwise: the call still works, over the internet. This
// reports the path so a connection test — and the require-private policy — can
// say which one it was.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { proxyForUrl } from "@/utils/http/connectorFetch.server";
import {
  isBlockedAlways,
  isPrivateNetwork,
  PrivatePathRequiredError,
  privatePathRefusal,
} from "@/utils/ssrfGuard.server";

export type PathReport = {
  /** The host the call is made to. */
  host: string;
  /** True when HTTPS_PROXY / HTTP_PROXY applies and NO_PROXY does not bypass it. */
  proxied: boolean;
  /** The proxy's host:port, without any credentials in its URL. */
  proxy?: string;
  /** Addresses the host resolves to here (empty when proxied or unresolvable). */
  addresses: string[];
  /** All addresses private? null when proxied (the proxy resolves) or unresolved. */
  privateAddress: boolean | null;
  /** The certificate the endpoint presents, when asked for and reachable. */
  tls?: TlsReport;
  /** One line for a person: "direct to 10.0.12.34 (private)". */
  summary: string;
};

export type TlsReport = {
  /** The certificate's subject CN, or its first DNS name. */
  subject: string;
  /** The issuer's organisation, or its CN. */
  issuer: string;
  /** Chains to a CA this server trusts and covers the host, as Node checks it. */
  valid: boolean;
  /** Why not, when it is not: e.g. ERR_TLS_CERT_ALTNAME_INVALID. */
  error?: string;
};

const TLS_TIMEOUT_MS = 5_000;

/** A certificate name field: one value, or several. */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The certificate presented at `address` for `host` — a handshake only, no
 * request and no credentials. null when the handshake fails or stalls.
 */
function readCertificate(host: string, address: string, port: number): Promise<TlsReport | null> {
  return new Promise((resolve) => {
    // Verified by hand below, so a wrong certificate is reported, not thrown.
    const socket = tlsConnect({
      host: address,
      port,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: TLS_TIMEOUT_MS,
    });
    const done = (report: TlsReport | null) => {
      socket.destroy();
      resolve(report);
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const subject =
        first(cert.subject?.CN) ||
        cert.subjectaltname?.split(",")[0]?.trim().replace(/^DNS:/, "") ||
        "";
      if (!subject) return done(null);
      done({
        subject,
        issuer: first(cert.issuer?.O) || first(cert.issuer?.CN) || "an unnamed issuer",
        valid: socket.authorized,
        ...(socket.authorized ? {} : { error: String(socket.authorizationError ?? "not trusted") }),
      });
    });
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
  });
}

/**
 * Describe the path a call to `rawUrl` would take from this server. With
 * `tls`, a direct https call also reports the certificate the endpoint
 * presents: read from the address resolved here (no second lookup), and
 * never from a name that resolves to a metadata or link-local address.
 */
export async function describeConnectivity(
  rawUrl: string,
  opts: { tls?: boolean } = {},
): Promise<PathReport> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const proxyUrl = proxyForUrl(url);
  if (proxyUrl) {
    let proxy = "the configured proxy";
    try {
      proxy = new URL(proxyUrl).host;
    } catch {
      /* keep the generic label */
    }
    return {
      host,
      proxied: true,
      proxy,
      addresses: [],
      privateAddress: null,
      summary: `via proxy ${proxy}`,
    };
  }
  let addresses: string[] = [];
  try {
    addresses = (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return {
      host,
      proxied: false,
      addresses: [],
      privateAddress: null,
      summary: `direct; ${host} does not resolve from this server`,
    };
  }
  const privateAddress = addresses.length > 0 && addresses.every((a) => isPrivateNetwork(a));
  const shown = addresses.slice(0, 2).join(", ");
  let summary = `direct to ${shown} (${privateAddress ? "private" : "public"})`;
  let tls: TlsReport | null = null;
  if (
    opts.tls &&
    url.protocol === "https:" &&
    addresses.length > 0 &&
    !addresses.some((a) => isBlockedAlways(a))
  ) {
    tls = await readCertificate(host, addresses[0], Number(url.port) || 443);
  }
  if (tls) {
    summary += `; certificate for ${tls.subject} from ${tls.issuer}`;
    if (!tls.valid) summary += ` — not valid for this name (${tls.error})`;
  }
  return {
    host,
    proxied: false,
    addresses,
    privateAddress,
    ...(tls ? { tls } : {}),
    summary,
  };
}

/**
 * Refuse, before any call, a provider set to require a private path whose
 * endpoint would be reached directly at a public (or unresolvable) address.
 * Used where the calls happen outside a private-path scope (a resolved
 * OpenAI-compatible transport is fetched later, by its caller).
 */
export async function assertPrivatePath(
  url: string,
  label: string,
  onRefuse?: (detail: string) => void,
): Promise<void> {
  const path = await describeConnectivity(url);
  if (path.proxied || path.privateAddress === true) return;
  const detail = privatePathRefusal(
    label,
    path.host,
    path.addresses.filter((a) => !isPrivateNetwork(a)),
  );
  try {
    onRefuse?.(detail);
  } catch {
    /* auditing must not change the outcome */
  }
  throw new PrivatePathRequiredError(detail);
}
