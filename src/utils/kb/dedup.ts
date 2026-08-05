// The dedup decision table for KB source syncs — pure, on purpose.
//
// sync.server.ts owns the IO around these; the decisions themselves live here
// so tests exercise the real rules (and mutate them to prove the tests can
// tell). See sync.server.ts for the two-level contract these implement:
// version skip (no download) and content-hash skip (no re-embed).

import { createHash } from "node:crypto";
import type { RemoteItem } from "./connectors.server";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Which existing documents need what, given the remote listing. */
export function diffRemoteItems(
  remote: RemoteItem[],
  existing: Array<{ external_id: string | null; version: string | null }>,
): { toFetch: RemoteItem[]; unchanged: RemoteItem[]; toRemoveExternalIds: string[] } {
  const remoteById = new Map(remote.map((r) => [r.externalId, r]));
  const existingById = new Map(
    existing.filter((e) => e.external_id).map((e) => [e.external_id as string, e]),
  );

  const toFetch: RemoteItem[] = [];
  const unchanged: RemoteItem[] = [];
  for (const item of remote) {
    const prior = existingById.get(item.externalId);
    // An empty version means the provider gave no change marker — always
    // re-fetch, and let the content hash decide whether anything is re-embedded.
    if (prior && item.version && prior.version === item.version) unchanged.push(item);
    else toFetch.push(item);
  }
  const toRemoveExternalIds = Array.from(existingById.keys()).filter((id) => !remoteById.has(id));
  return { toFetch, unchanged, toRemoveExternalIds };
}
