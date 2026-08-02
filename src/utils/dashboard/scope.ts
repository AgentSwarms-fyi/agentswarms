// Who may see whose numbers, and over what window.
//
// Pure and browser-safe on purpose: the SERVER enforces these rules, and the
// UI needs the same definitions to render the pickers without a round trip.
// One definition, imported by both — a second copy is how a UI ends up
// offering a scope the server refuses.

export const DASHBOARD_SCOPES = ["mine", "team", "org"] as const;
export type DashboardScope = (typeof DASHBOARD_SCOPES)[number];

export const DASHBOARD_RANGES = ["24h", "7d", "30d", "mtd", "90d", "ytd"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export const RANGE_LABELS: Record<DashboardRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  mtd: "Month to date",
  "90d": "Last 90 days",
  ytd: "Year to date",
};

export const SCOPE_LABELS: Record<DashboardScope, string> = {
  mine: "Just me",
  team: "My teams",
  org: "Whole organisation",
};

export function isDashboardScope(v: unknown): v is DashboardScope {
  return typeof v === "string" && (DASHBOARD_SCOPES as readonly string[]).includes(v);
}

export function isDashboardRange(v: unknown): v is DashboardRange {
  return typeof v === "string" && (DASHBOARD_RANGES as readonly string[]).includes(v);
}

/**
 * Resolve a range to a half-open [from, to) window in UTC.
 *
 * Half-open, and UTC, for the same reason the semantic layer's relative dates
 * are: an inclusive upper bound double-counts a row landing exactly on the
 * boundary, and a local-time boundary makes the same dashboard disagree with
 * itself across a timezone change.
 *
 * `now` is injectable so the tests are not a function of when they run.
 */
export function resolveRange(
  range: DashboardRange,
  now = new Date(),
): { from: string; to: string } {
  const to = now.toISOString();
  const start = new Date(now);
  switch (range) {
    case "24h":
      start.setUTCHours(start.getUTCHours() - 24);
      break;
    case "7d":
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    case "30d":
      start.setUTCDate(start.getUTCDate() - 30);
      break;
    case "90d":
      start.setUTCDate(start.getUTCDate() - 90);
      break;
    case "mtd":
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      break;
    case "ytd":
      start.setUTCMonth(0, 1);
      start.setUTCHours(0, 0, 0, 0);
      break;
  }
  return { from: start.toISOString(), to };
}

/**
 * Which scopes a caller may ask for.
 *
 * "team" needs at least one group — offering it to someone in none would show
 * a picker that returns their own numbers under a different label, which is
 * worse than not offering it. "org" is superadmin only.
 */
export function allowedScopes(args: {
  isSuperadmin: boolean;
  groupCount: number;
}): DashboardScope[] {
  const scopes: DashboardScope[] = ["mine"];
  if (args.groupCount > 0) scopes.push("team");
  if (args.isSuperadmin) scopes.push("org");
  return scopes;
}

/**
 * Display name for one person in the spend breakdown.
 *
 * Execution traces OUTLIVE the accounts that made them: delete a user, or
 * restore a database beside a fresh auth project, and spend stays attributed
 * to an id with no owner. On the first instance this was checked against,
 * seven of eight people in the breakdown were in that state — one with 96 runs.
 *
 * A bare UUID in a chargeback table reads as a rendering fault, and cannot be
 * charged to anybody. Saying "Removed account" is the same information with
 * the reason attached. The id fragment stays so two removed accounts remain
 * distinguishable from each other.
 */
export function personLabel(userId: string, email?: string | null): string {
  const trimmed = (email ?? "").trim();
  if (trimmed) return trimmed;
  return `Removed account · ${userId.slice(0, 8)}`;
}
