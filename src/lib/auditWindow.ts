// The audit log's merged window, and what it may claim about completeness.
//
// The log is assembled from three capped sources — audit_events,
// execution_traces (as model.call), swarm_runs (as swarm.run) — each fetched
// newest-first with its own row cap. MEASURED before this existed: the page
// showed 400 merged rows to a 14-day window holding 1,922 events, with no
// disclosure, and the caps were NON-UNIFORM in time — model.call's 300 of
// 1,537 reached back ~3 days while audit_events' 300 of 361 reached ~13, so
// the table silently mixed a 3-day view of one action type with a 13-day view
// of another. An auditor reading "no model calls on the 10th" off that screen
// would have been reading an artifact of the cap, not the history.
//
// The rule this module enforces: a merged feed built from capped sources is
// only complete down to the NEWEST "oldest fetched row" among the sources
// that hit their cap. Everything older has gaps and must not be shown as if
// it were history. Trimming to that boundary makes the visible window
// uniform — gap-free for every action type — which is the property an audit
// log exists to have.

export type AuditSourceWindow = {
  /** Oldest fetched row's timestamp (ISO), or null when the source returned nothing. */
  oldest: string | null;
  /** The source returned exactly its cap — rows older than `oldest` exist unseen. */
  capped: boolean;
};

/**
 * The timestamp down to which the merged window is complete, or null when no
 * source hit its cap (the whole retention window is complete).
 *
 * ISO-8601 strings from one database compare lexicographically; the newest
 * boundary among capped sources wins because every source is complete back to
 * it, and none is guaranteed complete past it.
 */
export function uniformBoundary(sources: AuditSourceWindow[]): string | null {
  let boundary: string | null = null;
  for (const s of sources) {
    if (!s.capped || s.oldest === null) continue;
    if (boundary === null || s.oldest > boundary) boundary = s.oldest;
  }
  return boundary;
}

/** Keep only rows the uniform window vouches for. */
export function trimToUniformWindow<T extends { created_at: string }>(
  rows: T[],
  boundary: string | null,
): T[] {
  if (boundary === null) return rows;
  return rows.filter((r) => r.created_at >= boundary);
}

/**
 * The sentence above the table. Complete windows state the population;
 * trimmed windows state exactly what is shown and that older activity exists
 * beyond it — never "the most recent N", which a merged-then-sliced feed
 * cannot honestly claim.
 */
export function auditWindowHeadline(args: {
  shown: number;
  total: number;
  boundary: string | null;
  windowDays: number;
}): string {
  if (args.boundary === null) {
    return `${args.total.toLocaleString()} events over the last ${args.windowDays} day${args.windowDays === 1 ? "" : "s"}`;
  }
  const since = new Date(args.boundary).toLocaleString();
  return `showing all ${args.shown.toLocaleString()} events since ${since} — the ${args.windowDays}-day window holds ${args.total.toLocaleString()}; older activity is beyond the per-source fetch cap`;
}
