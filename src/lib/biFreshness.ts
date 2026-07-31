// How old is the data on a dashboard?
//
// Every widget already records `refreshed_at` when its query last ran, but
// nothing rendered it — so a viewer (especially on a published or embedded
// dashboard, which ALWAYS renders a stored snapshot) could not tell numbers
// computed minutes ago from numbers computed last quarter. "As of <time>" is
// standard on every BI product for exactly that reason.
//
// Pure functions, no date library, so the share/embed bundles stay small.

export type Freshness = {
  /** Compact relative age, e.g. "4h ago". */
  relative: string;
  /** Full local timestamp for the tooltip. */
  absolute: string;
  /** Old enough that the number deserves a second look. */
  stale: boolean;
  /** Milliseconds since the data was computed. */
  ageMs: number;
};

/** Data older than this is called out rather than shown quietly. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relativeAge(ageMs: number): string {
  if (ageMs < 45 * 1000) return "just now";
  if (ageMs < HOUR) return `${Math.max(1, Math.round(ageMs / MINUTE))}m ago`;
  if (ageMs < DAY) return `${Math.round(ageMs / HOUR)}h ago`;
  const days = Math.round(ageMs / DAY);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

/**
 * Describe one timestamp. Returns null for missing or unparseable input —
 * a widget that has never run should show nothing rather than "just now",
 * which would be a lie in the most misleading direction.
 */
export function describeFreshness(
  iso: string | null | undefined,
  now: number = Date.now(),
): Freshness | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  // Clock skew between the server that stamped this and the viewer's browser
  // can put it slightly in the future; clamp rather than print "in 3 minutes".
  const ageMs = Math.max(0, now - t);
  return {
    relative: relativeAge(ageMs),
    absolute: new Date(t).toLocaleString(),
    stale: ageMs >= STALE_AFTER_MS,
    ageMs,
  };
}

/**
 * Dashboard-level freshness: the OLDEST widget wins.
 *
 * A dashboard is only as current as its stalest tile — reporting the newest
 * would let one auto-refreshing widget vouch for a dozen stale ones.
 */
export function dashboardFreshness(
  widgets: { refreshed_at?: string | null }[],
  now: number = Date.now(),
): Freshness | null {
  let oldest: Freshness | null = null;
  for (const w of widgets) {
    const f = describeFreshness(w.refreshed_at, now);
    if (!f) continue;
    if (!oldest || f.ageMs > oldest.ageMs) oldest = f;
  }
  return oldest;
}
