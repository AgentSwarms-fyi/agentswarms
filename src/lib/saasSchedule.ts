// How to describe a SaaS source's sync cadence, and when it next runs.
//
// The scheduler claims a source by `next_sync_at <= now` (migration
// 20260777000000), so that column is the whole truth about whether a run is
// coming. Deriving "next run in 4 hours" from the cadence and the last run
// instead would print a comforting sentence for a source the scheduler cannot
// see at all — which is the failure this module exists to make visible.

import type { SyncSchedule } from "@/utils/saas/types";

export const SCHEDULE_LABELS: Record<SyncSchedule, string> = {
  manual: "Only when I sync",
  hourly: "Every hour",
  daily: "Every day",
  weekly: "Every week",
};

/** What the row says about the next run. */
export type ScheduleSummary = {
  /** Short label for the cadence itself. */
  cadence: string;
  /** One line about the next run, or null when there is nothing to say. */
  next: string | null;
  /**
   * The row is in a state the scheduler cannot act on, and the UI should say
   * so rather than render a blank.
   */
  broken: boolean;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "in 3 hours", "in 12 minutes" — coarse on purpose; this is not a countdown. */
function inWords(ms: number): string {
  if (ms < MINUTE) return "in under a minute";
  if (ms < HOUR) return `in ${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(ms / DAY);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/**
 * Describe a connection's schedule.
 *
 * `now` is a parameter rather than read from the clock so this is testable and
 * so a list renders every row against one instant.
 */
export function scheduleSummary(
  conn: { sync_schedule: SyncSchedule; next_sync_at: string | null },
  now: Date,
): ScheduleSummary {
  const cadence = SCHEDULE_LABELS[conn.sync_schedule] ?? conn.sync_schedule;

  if (conn.sync_schedule === "manual") {
    // A manual source SHOULD have no next_sync_at — that is what keeps it out
    // of the scheduler's partial index. A leftover value means it is still
    // claimable, so it is worth saying rather than hiding.
    return {
      cadence,
      next: conn.next_sync_at ? "A scheduled run is still queued" : null,
      broken: Boolean(conn.next_sync_at),
    };
  }

  if (!conn.next_sync_at) {
    // Scheduled, but invisible to the scheduler: no due time means the claim
    // query can never match it, so it will never run again on its own.
    return { cadence, next: "No run scheduled — re-pick a cadence", broken: true };
  }

  const due = new Date(conn.next_sync_at);
  if (Number.isNaN(due.getTime())) {
    return { cadence, next: "Next run time is unreadable", broken: true };
  }

  const ms = due.getTime() - now.getTime();
  // OVERDUE IS NOT "SOON". A due time in the past means the scheduler has not
  // picked it up — worth showing plainly, because the alternative is a source
  // that silently stopped syncing while its row still promises a cadence.
  if (ms <= 0) return { cadence, next: "Due now", broken: false };
  return { cadence, next: `Next ${inWords(ms)}`, broken: false };
}
