// Which swarms are actually reachable from outside the app.
//
// MEASURED, which is why this is a module rather than an inline filter. The
// gallery's "deployed" badge read `swarms.is_deployed`, a column that appears in
// the migrations only as `DEFAULT false`, is written by nothing anywhere in the
// application, and is read in exactly that one place. It could never become
// true. So the badge was unreachable UI, and the one screen that lists every
// swarm could not tell you which of them were live.
//
// The runtime does not consult that column either: /api/swarm.run authorises on
// an API key row and serves the published graph. A key that has not been revoked
// IS the deployment. Deriving the badge from the same fact the runtime uses is
// what makes it true in both directions — present when traffic can arrive, gone
// when the last key is revoked.

/** The fields of a swarm API key row this derivation needs. */
export type SwarmKeyRow = {
  swarm_id: string | null;
  /** Set when the key was revoked; null/undefined means it still works. */
  revoked_at?: string | null;
};

/**
 * The set of swarm ids with at least one key that still works.
 *
 * A revoked key is not a deployment, and a key row with no swarm cannot vouch
 * for one — both are dropped rather than counted, because a badge that appears
 * for a revoked key tells the operator the opposite of the truth.
 */
export function liveSwarmIds(keys: readonly SwarmKeyRow[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const k of keys ?? []) {
    if (!k) continue;
    if (k.revoked_at) continue;
    if (typeof k.swarm_id !== "string" || k.swarm_id === "") continue;
    out.add(k.swarm_id);
  }
  return out;
}
