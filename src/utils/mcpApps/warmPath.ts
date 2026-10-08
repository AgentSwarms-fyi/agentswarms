// What a request to a Builder MCP server may skip once its sandbox is known to
// be serving (R367).
//
// MEASURED (R367). Every request through /api/mcp/s/<slug> took 1.2 to 1.5 s
// before the sandbox, which answers in milliseconds, saw it. Counted, that is
// about eleven round trips to the database one after another, and one takes
// 120 ms or more from the container. Seven were in `ensureRunning`, and most
// of those re-proved, on every request, what
// the request before had proved: the sandbox was serving. Its log showed a
// readiness GET before every POST. A session is three requests, so an agent's
// tool call through a Builder server paid about 3.8 s.
//
// So a sandbox this process saw serving moments ago is taken as serving, and
// its activity is written for the idle reaper only as often as the reaper
// could need it. A forward that fails forgets it, so the next request proves
// it again and starts a fresh one if it died.

/** How long a sandbox this process saw serving is taken as still serving. */
export const SERVING_FOR_MS = 30_000;

/** How often a busy sandbox's activity is written. The idle TTL is minutes. */
export const TOUCH_EVERY_MS = 30_000;

/** When each sandbox was last seen serving, by session id, in this process. */
const seenServing = new Map<string, number>();

export function sawServing(sessionId: string, now = Date.now()): void {
  seenServing.set(sessionId, now);
  // Sessions end; their entries would not. Dropped once stale.
  if (seenServing.size > 500) {
    for (const [id, at] of seenServing) if (now - at >= SERVING_FOR_MS) seenServing.delete(id);
  }
}

export function recentlyServing(sessionId: string, now = Date.now()): boolean {
  const at = seenServing.get(sessionId);
  return at !== undefined && now - at < SERVING_FOR_MS;
}

/** A request to it failed: prove it again before the next one. */
export function forgetServing(sessionId: string): void {
  seenServing.delete(sessionId);
}

/** Is this session's recorded activity old enough to write again? */
export function touchDue(lastActiveAt: string | null | undefined, now = Date.now()): boolean {
  const at = lastActiveAt ? Date.parse(lastActiveAt) : NaN;
  return !Number.isFinite(at) || now - at >= TOUCH_EVERY_MS;
}
