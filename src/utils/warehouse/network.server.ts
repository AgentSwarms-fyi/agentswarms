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
import { assertPrivatePath, describeConnectivity } from "@/utils/providers/connectivityPath.server";
import { assertPublicUrl, HostNotResolvedError, SsrfRefusedError } from "@/utils/ssrfGuard.server";

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
      if (!check.ok) throw new SsrfRefusedError(check.error);
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
