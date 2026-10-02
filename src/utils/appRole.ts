// What this process is FOR.
//
// THE PROBLEM. A heavy lakehouse query and a user's page render compete inside
// the same Node process — the engine is in-process, not a separate service, so
// a thirty-second GROUP BY and a login share one event loop and one memory
// budget. The documented mitigation used to be "run some replicas with a big
// memory limit and keep them out of the request path", which is sound advice
// and entirely manual: nothing told the replica it was special, and nothing
// told the load balancer either.
//
// THE MECHANISM. `APP_ROLE=analytics` makes a node report **not ready** while
// staying **alive**. Every load balancer and orchestrator already understands
// that pair: readiness decides whether traffic is routed, liveness decides
// whether the process is restarted. So an analytics node drains out of the
// interactive pool by itself, with no LB-specific configuration, and keeps
// running its scheduled work.
//
// What it does NOT do is refuse requests that reach it directly. The role is a
// routing declaration, not an access control — pointing a browser straight at
// an analytics node still works, which is what you want when investigating one.
//
// Pure module (no `.server` suffix, no imports) so the rule is unit-testable;
// `.server.ts` files are import-protected.

export type AppRole = "web" | "analytics";

/** The literal an operator sets. Kept here so server.mjs and the routes agree. */
export const ANALYTICS_ROLE = "analytics";

/**
 * Read a role from raw environment text. Anything unrecognised is "web": a
 * typo'd APP_ROLE must not silently pull a node out of rotation, because the
 * failure would look like capacity vanishing for no reason.
 */
export function parseAppRole(raw: string | undefined | null): AppRole {
  return (raw ?? "").trim().toLowerCase() === ANALYTICS_ROLE ? ANALYTICS_ROLE : "web";
}

/** This process's role. */
export function appRole(): AppRole {
  return parseAppRole(process.env.APP_ROLE);
}
