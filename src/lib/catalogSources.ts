// Which source a Data Catalog asset belongs to.
//
// Connector-synced datasets land in user_data_tables exactly like an upload —
// deliberately, so a synced dataset cannot behave differently to an uploaded
// one. The side effect was that the catalog filed seven Salesforce tables under
// "Local tables": true about where the bytes sit, useless about where the data
// came from, and the only answer anyone is looking for when they ask.
//
// The provenance was already written as text (source_filename holds
// "Salesforce · opportunities"), but a label is for a human to read, not
// something a filter can group by. Migration 20260832000000 records the
// connection id, which is the fact. This module turns those rows into the two
// things the catalog needs: the rail's list of sources, and the source id for
// each asset.

/** The catch-all for datasets with no upstream connection: uploads and samples. */
export const LOCAL_SOURCE_ID = "local";

/**
 * Namespace for a connector-derived source id.
 *
 * Prefixed rather than using the connection id bare, so a SaaS source can never
 * collide with a crawled `catalog_sources` row id — both live in the same
 * `source_id` field and the same rail.
 */
export const SAAS_SOURCE_PREFIX = "saas:";

export type SaasConnectionRow = { id: string; name: string; provider: string };

/** A row of user_data_tables, as far as attribution is concerned. */
export type SaasAttributionRow = { id: string; saas_connection_id: string | null };

/** A connection presented as a catalog source. */
export type SaasSource = {
  id: string;
  name: string;
  provider: string;
  /**
   * The connection this came from, unprefixed.
   *
   * Carried so the rail's actions — re-sync, reschedule — can address the
   * connection without re-deriving it by stripping the prefix off `id`, which
   * is the kind of parsing this module exists to replace.
   */
  connectionId: string;
};

export function saasSourceId(connectionId: string): string {
  return `${SAAS_SOURCE_PREFIX}${connectionId}`;
}

/** True for a source id this module minted, as opposed to a crawled source. */
export function isSaasSourceId(sourceId: string): boolean {
  return sourceId.startsWith(SAAS_SOURCE_PREFIX);
}

export function saasSourcesFrom(connections: SaasConnectionRow[]): SaasSource[] {
  return connections.map((c) => ({
    id: saasSourceId(c.id),
    name: c.name,
    provider: c.provider,
    connectionId: c.id,
  }));
}

/**
 * Map dataset id → the source it should be filed under.
 *
 * Datasets with no attribution are absent from the map; the caller files those
 * under LOCAL_SOURCE_ID.
 *
 * A dataset whose connection is NOT in `connections` is also absent, and that
 * is the load-bearing part. The connection row could be missing because it was
 * deleted, or because this read was filtered — and an asset filed under a
 * source that has no rail entry is unreachable: it disappears from every filter
 * except "All". Falling back to "Local tables" is both reachable and true, since
 * the bytes really are local. Naming a source we cannot show is neither.
 */
export function datasetSourceIds(
  attribution: SaasAttributionRow[],
  connections: SaasConnectionRow[],
): Map<string, string> {
  const known = new Set(connections.map((c) => c.id));
  const out = new Map<string, string>();
  for (const row of attribution) {
    const connId = row.saas_connection_id;
    if (!connId || !known.has(connId)) continue;
    out.set(row.id, saasSourceId(connId));
  }
  return out;
}
