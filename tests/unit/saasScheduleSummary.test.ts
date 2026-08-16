// What a SaaS source's schedule row SAYS about the next run.
//
// Companion to saasSchedule.test.ts, which covers the scheduler itself. This
// file is about the sentence the user reads.
//
// The scheduler claims a source with `next_sync_at <= now` (migration
// 20260777000000), so that column decides whether a run is coming at all. The
// cases that matter here are the ones where a cadence is set and the run is
// NOT coming — a source that promises "every hour" and has quietly stopped is
// the failure worth surfacing, not papering over.
import { describe, expect, it } from "vitest";

import { SCHEDULE_LABELS, scheduleSummary } from "@/lib/saasSchedule";
import { SYNC_SCHEDULES } from "@/utils/saas/types";

const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("cadence labels", () => {
  it("names every schedule the database allows", () => {
    // The CHECK constraint lists exactly these four. A cadence with no label
    // would render as a raw enum value in the picker.
    expect(Object.keys(SCHEDULE_LABELS).sort()).toEqual([...SYNC_SCHEDULES].sort());
  });

  it("says what manual means rather than just 'manual'", () => {
    expect(SCHEDULE_LABELS.manual).toMatch(/only when i sync/i);
  });
});

describe("a scheduled source with a run coming", () => {
  it("reports the wait in hours", () => {
    const s = scheduleSummary(
      { sync_schedule: "daily", next_sync_at: "2026-08-16T15:00:00Z" },
      NOW,
    );
    expect(s.next).toBe("Next in 3 hours");
    expect(s.broken).toBe(false);
  });

  it("reports minutes when the run is close", () => {
    const s = scheduleSummary(
      { sync_schedule: "hourly", next_sync_at: "2026-08-16T12:12:00Z" },
      NOW,
    );
    expect(s.next).toBe("Next in 12 min");
  });

  it("reports days for a weekly cadence", () => {
    const s = scheduleSummary(
      { sync_schedule: "weekly", next_sync_at: "2026-08-21T12:00:00Z" },
      NOW,
    );
    expect(s.next).toBe("Next in 5 days");
  });

  it("carries the cadence label alongside the timing", () => {
    const s = scheduleSummary(
      { sync_schedule: "daily", next_sync_at: "2026-08-17T12:00:00Z" },
      NOW,
    );
    expect(s.cadence).toBe(SCHEDULE_LABELS.daily);
  });
});

describe("a due time in the past is not 'soon'", () => {
  it("says the run is due now", () => {
    // Overdue means the scheduler has NOT picked it up. Rendering "in -2
    // hours", or rounding it to "in a moment", would read as healthy.
    const s = scheduleSummary(
      { sync_schedule: "hourly", next_sync_at: "2026-08-16T10:00:00Z" },
      NOW,
    );
    expect(s.next).toBe("Due now");
  });

  it("treats the exact due instant as due, not as a countdown", () => {
    const s = scheduleSummary(
      { sync_schedule: "hourly", next_sync_at: "2026-08-16T12:00:00Z" },
      NOW,
    );
    expect(s.next).toBe("Due now");
  });
});

describe("rows the scheduler cannot act on are called out", () => {
  it("flags a cadence with no due time", () => {
    // The claim query matches on next_sync_at; null can never match, so this
    // source will never run again on its own however healthy it looks.
    const s = scheduleSummary({ sync_schedule: "daily", next_sync_at: null }, NOW);
    expect(s.broken).toBe(true);
    expect(s.next).toMatch(/no run scheduled/i);
  });

  it("flags an unparseable due time instead of printing NaN", () => {
    const s = scheduleSummary({ sync_schedule: "daily", next_sync_at: "not-a-date" }, NOW);
    expect(s.broken).toBe(true);
    expect(s.next).not.toMatch(/NaN/);
  });

  it("flags a manual source that still has a run queued", () => {
    // Manual is supposed to clear next_sync_at — that is what keeps the row
    // out of the scheduler's partial index. A leftover value means it is
    // still claimable, so "only when I sync" would be a false promise.
    const s = scheduleSummary({ sync_schedule: "manual", next_sync_at: NOW.toISOString() }, NOW);
    expect(s.broken).toBe(true);
    expect(s.next).toMatch(/still queued/i);
  });
});

describe("a healthy manual source says nothing about a next run", () => {
  it("has no next line to render", () => {
    const s = scheduleSummary({ sync_schedule: "manual", next_sync_at: null }, NOW);
    expect(s.next).toBeNull();
    expect(s.broken).toBe(false);
    expect(s.cadence).toBe(SCHEDULE_LABELS.manual);
  });
});
