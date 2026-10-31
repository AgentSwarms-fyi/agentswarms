// The network side of a warehouse or database connection (private
// connectivity, Phase 3, R424).
//
// Two checks before any connection is opened:
//
//   - The always-refused tier, for the wire-protocol databases. Their drivers
//     (pg, mysql2, tedious) open a TCP connection themselves, so none of
//     safeFetch's checks reached them: a Postgres connection could be aimed
//     at the cloud metadata address. Now the host, and every address it
//     resolves to, is held to the same rule as every other outbound call.
//     Private networks stay allowed: a database on the deployment's network
//     is the normal case. The HTTP-based engines already get this from
//     connectorFetch, per request and per redirect hop.
//   - The connection's own "require a private network path" rule, when set:
//     the host must resolve only to private addresses from this server. A
//     wire protocol is always direct; an HTTP-based engine's calls may leave
//     through the proxy, which counts, as it does for the model providers.
//
// Both are checked again when each wire-protocol socket connects (R425): the
// driver used to resolve the name again itself after the check, so a resolver
// could answer the check with a safe address and the driver with the metadata
// address. Every driver now resolves through guardedLookup, which checks the
// addresses it hands over, so a socket connects only to an address that has
// just passed. A pool's later sockets pass it too, and a failover that moves
// the name to a new address keeps working.
import { lookup as resolveName } from "node:dns/promises";
import { connect as netConnect, Socket, type LookupFunction } from "node:net";

import { assertPrivatePath, describeConnectivity } from "@/utils/providers/connectivityPath.server";
import {
  assertPublicUrl,
  HostNotResolvedError,
  isBlockedAlways,
  isPrivateNetwork,
  PrivatePathRequiredError,
  privatePathRefusal,
  SsrfRefusedError,
} from "@/utils/ssrfGuard.server";

import { isWireProtocol, warehouseHosts } from "./destinations";
import type { WarehouseConfig } from "./types";

/** A host or URL as a URL the checks take; a wire protocol's host gets a placeholder scheme. */
function asUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

const ADVICE_DIRECT =
  "Check the database's private DNS zone or the route to it over the VPN or peering link.";
const ADVICE_HTTP = "Check the private endpoint's DNS zone, or send the traffic through the proxy.";

/**
 * Refuse, before a connection is opened, a host in the always-refused tier
 * (wire protocols) and, when the connection requires one, a path that is not
 * private. `onRefuse` hears a private-path refusal, for the audit log.
 */
export async function assertWarehouseNetwork(
  config: WarehouseConfig,
  onRefuse?: (detail: string) => void,
): Promise<void> {
  // The built-in lakehouse has no hosts (warehouseHosts), so it passes.
  const direct = isWireProtocol(config);
  for (const raw of warehouseHosts(config)) {
    if (!raw) continue;
    const url = asUrl(raw);
    if (direct) {
      // Private addresses stay allowed even under BLOCK_PRIVATE_NETWORK_FETCH,
      // as for every connector (connectorFetch). And the name is resolved
      // HERE: the driver never uses the proxy, so a name that does not resolve
      // is not "resolved elsewhere", as assertPublicUrl assumes when a proxy
      // applies, and passing it would let the driver resolve it again.
      const check = await assertPublicUrl(url, { allowPrivate: true, resolvedElsewhere: false });
      if (!check.ok && check.unresolved) {
        throw new HostNotResolvedError(check.unresolved.host, check.unresolved.code);
      }
      // A driver connects; it does not fetch.
      if (!check.ok)
        throw new SsrfRefusedError(
          check.error.replace(/^Refusing to fetch/, "Refusing to connect to"),
        );
    }
    if (config.require_private) {
      await assertPrivatePath(url, `The connection to ${new URL(url).hostname}`, onRefuse, {
        direct,
        advice: direct ? ADVICE_DIRECT : ADVICE_HTTP,
      });
    }
  }
}

/**
 * How the connection was reached, in one line for the person testing it:
 * "direct to 10.0.4.7 (private)", or "via proxy …" for an HTTP-based engine
 * whose calls use it. The certificate is read for an HTTPS engine only.
 */
export async function warehousePath(config: WarehouseConfig): Promise<string | undefined> {
  const raw = warehouseHosts(config).find(Boolean);
  if (!raw) return undefined;
  const direct = isWireProtocol(config);
  try {
    return (await describeConnectivity(asUrl(raw), { tls: !direct, direct })).summary;
  } catch {
    return undefined;
  }
}

// ── Connecting (R425) ────────────────────────────────────────────────────────

/** Why these addresses may not be connected to, or null when they may. */
function connectRefusal(host: string, addresses: string[], requirePrivate: boolean): Error | null {
  const blocked = addresses.find((a) => isBlockedAlways(a));
  if (blocked) {
    return new SsrfRefusedError(
      `Refusing to connect to link-local/metadata address: ${blocked} (resolved from ${host})`,
    );
  }
  if (requirePrivate && addresses.some((a) => !isPrivateNetwork(a))) {
    return new PrivatePathRequiredError(
      privatePathRefusal(
        `The connection to ${host}`,
        host,
        addresses.filter((a) => !isPrivateNetwork(a)),
        ADVICE_DIRECT,
      ),
    );
  }
  return null;
}

/**
 * The name lookup a wire-protocol socket connects through: it resolves the
 * name, refuses the always-refused addresses (and, when the connection
 * requires a private path, any public one), and hands the socket exactly the
 * addresses it checked. net.connect calls it with `all` when it races address
 * families, and wants the list then; otherwise one address.
 */
export function guardedLookup(requirePrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolveName(hostname, { ...options, all: true }).then(
      (resolved) => {
        const refusal = connectRefusal(
          hostname,
          resolved.map((a) => a.address),
          requirePrivate,
        );
        if (refusal) return callback(refusal as NodeJS.ErrnoException, "");
        if (options.all) return callback(null, resolved);
        callback(null, resolved[0].address, resolved[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}

/** The lookup for a connection: its rule decides whether public addresses pass. */
export function connectionLookup(config: { require_private?: boolean }): LookupFunction {
  return guardedLookup(config.require_private === true);
}

/**
 * pg's socket. pg calls `connect(port, host)`, which takes no lookup, so the
 * call is turned into the options form that does. A Unix socket path (no
 * port) is left as it is: there is no name to resolve.
 */
class GuardedSocket extends Socket {
  constructor(private readonly guard: LookupFunction) {
    super();
  }

  override connect(...args: unknown[]): this {
    const [port, host, done] = args;
    if (typeof port === "number" || (typeof port === "string" && /^\d+$/.test(port))) {
      return super.connect(
        {
          port: Number(port),
          host: typeof host === "string" ? host : "localhost",
          lookup: this.guard,
        },
        typeof done === "function" ? (done as () => void) : undefined,
      );
    }
    return (super.connect as (...a: unknown[]) => this)(...args);
  }
}

/** pg's `stream` option (a factory, called once per client). */
export function pgStream(lookup: LookupFunction): () => Socket {
  return () => new GuardedSocket(lookup);
}

/**
 * mysql2's `stream` option. It replaces mysql2's own `Net.connect`, so it
 * keeps what that did: no Nagle delay, and keep-alive when configured. TLS
 * still takes its name from the configured host.
 */
export function mysqlStream(lookup: LookupFunction) {
  return (opts: {
    config: {
      host: string;
      port: number;
      enableKeepAlive?: boolean;
      keepAliveInitialDelay?: number;
    };
  }): Socket => {
    const socket = netConnect({ host: opts.config.host, port: opts.config.port, lookup });
    if (opts.config.enableKeepAlive) {
      socket.on("connect", () => socket.setKeepAlive(true, opts.config.keepAliveInitialDelay));
    }
    socket.setNoDelay(true);
    return socket;
  };
}

/**
 * tedious's `connector` option. tedious calls it with the host and port it
 * would connect to (an Azure gateway's redirect included) and its abort
 * signal, though its typings declare no parameters.
 */
export function tdsConnector(lookup: LookupFunction) {
  return (
    target?: { host: string; port: number; localAddress?: string },
    _lookup?: unknown,
    signal?: AbortSignal,
  ): Promise<Socket> =>
    new Promise((resolve, reject) => {
      if (!target) return reject(new Error("The SQL Server driver did not say where to connect"));
      if (signal?.aborted) return reject(signal.reason);
      const socket = netConnect({
        host: target.host,
        port: target.port,
        localAddress: target.localAddress,
        lookup,
      });
      const onAbort = () => {
        socket.destroy();
        reject(signal?.reason);
      };
      const onError = (err: Error) => {
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        reject(err);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("error", onError);
      socket.once("connect", () => {
        signal?.removeEventListener("abort", onAbort);
        socket.removeListener("error", onError);
        resolve(socket);
      });
    });
}
