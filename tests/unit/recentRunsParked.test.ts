// A swarm run parked at an approval, shown as running.
//
// FOUND IN R108. Recent runs knew four statuses and showed any other as
// "Running". A run parked at a human approval is stored as "suspended", so
// five parked "Approval durability check (schedule)" runs read "Running",
// with durations of "1175m 26s" to "1321m 35s" that grew by the minute, and
// only Open and Trace beside them, under a header saying a paused run can be
// cancelled there. Observability listed the same five runs as "suspended".
// Four older ones read the same, but their approvals had been decided before
// R92's fix and their work finished under another run: "suspended" alone
// cannot say whether anyone is still being asked, so the request decides.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  formatRunDuration,
  parkedApproval,
  parkedRunView,
  runStatusView,
  showsDuration,
} from "@/lib/swarmRunStatus";

const panel = readFileSync("src/components/swarms/RecentRunsPanel.tsx", "utf8");
const inbox = readFileSync("src/components/ApprovalInbox.tsx", "utf8");

describe("a run parked at an approval", () => {
  it("reads as awaiting approval, not running", () => {
    const v = runStatusView("suspended");
    expect(v.label).toBe("Awaiting approval");
    expect(v.tone).toBe("waiting");
  });

  it("is not polled as if it were moving, and not offered a Cancel that cannot reach it", () => {
    const v = runStatusView("suspended");
    expect(v.live).toBe(false);
    expect(v.cancellable).toBe(false);
    expect(v.awaitingDecision).toBe(true);
  });

  it("keeps the in-tab wait cancellable, because Cancel reaches a run in this tab", () => {
    const v = runStatusView("waiting");
    expect(v.label).toBe("Awaiting approval");
    expect(v.cancellable).toBe(true);
    expect(v.live).toBe(true);
  });
});

describe("what the approval request says about a parked run", () => {
  it("reduces a run's requests to pending, decided or none", () => {
    expect(parkedApproval(["pending"], false)).toBe("pending");
    // A second approval step: the first was decided, the second waits.
    expect(parkedApproval(["approved", "pending"], false)).toBe("pending");
    expect(parkedApproval(["approved"], false)).toBe("decided");
    expect(parkedApproval(["rejected"], false)).toBe("decided");
    expect(parkedApproval([], false)).toBe("none");
    expect(parkedApproval(undefined, false)).toBe("none");
    expect(parkedApproval(["pending"], true)).toBe("unknown");
  });

  it("offers the inbox only where a request is waiting there", () => {
    expect(parkedRunView("pending").label).toBe("Awaiting approval");
    expect(parkedRunView("pending").awaitingDecision).toBe(true);
    // The inbox lists pending requests only, so a decided one is not there.
    expect(parkedRunView("decided").label).toBe("Decided, not resumed");
    expect(parkedRunView("decided").awaitingDecision).toBe(false);
    expect(parkedRunView("none").label).toBe("Parked, nobody asked");
    expect(parkedRunView("none").awaitingDecision).toBe(false);
  });

  it("claims no more than the run row when the requests cannot be read", () => {
    const v = parkedRunView("unknown");
    expect(v.label).toBe("Parked");
    expect(v.awaitingDecision).toBe(true);
  });

  it("never makes a parked run cancellable or live, whatever its request says", () => {
    for (const a of ["pending", "decided", "none", "unknown"] as const) {
      expect(parkedRunView(a).cancellable).toBe(false);
      expect(parkedRunView(a).live).toBe(false);
    }
  });
});

describe("statuses", () => {
  it("gives every status the executor writes a view of its own", () => {
    // swarm_runs.status is free text; these are the values written to it.
    for (const s of ["running", "success", "error", "suspended", "cancelled"]) {
      expect(runStatusView(s).label).not.toBe(s);
    }
    expect(runStatusView("running").label).toBe("Running");
    expect(runStatusView("running").cancellable).toBe(true);
  });

  it("shows a status it does not know as itself, never as running", () => {
    const v = runStatusView("quarantined");
    expect(v.label).toBe("quarantined");
    expect(v.live).toBe(false);
    expect(v.cancellable).toBe(false);
  });
});

describe("durations", () => {
  it("are shown for time spent running, and not for a run that is parked", () => {
    expect(showsDuration(runStatusView("running"), null)).toBe(true);
    expect(showsDuration(runStatusView("error"), Date.now())).toBe(true);
    for (const a of ["pending", "decided", "none", "unknown"] as const) {
      expect(showsDuration(parkedRunView(a), null)).toBe(false);
    }
  });

  it("reads hours as hours", () => {
    expect(formatRunDuration((1175 * 60 + 26) * 1000)).toBe("19h 35m");
    expect(formatRunDuration((7 * 60 + 5) * 1000)).toBe("7m 5s");
    expect(formatRunDuration(42_000)).toBe("42s");
  });
});

describe("the panel", () => {
  it("takes its status rules from runStatusView, with no fallback to running", () => {
    expect(panel).toContain("runStatusView(");
    expect(panel).not.toMatch(/\?\?\s*map\.running/);
  });

  it("offers the approval, not a duration or a Cancel, on a parked run", () => {
    expect(panel).toMatch(/\{view\.awaitingDecision && \([\s\S]{0,300}openApprovalsInbox\(\)/);
    expect(panel).toMatch(/Review approval/);
    expect(panel).toMatch(/\{view\.cancellable && \(/);
    expect(panel).toMatch(
      /\{showsDuration\(view, item\.finishedAt\) && \([\s\S]{0,120}duration\(item\.startedAt, item\.finishedAt\)/,
    );
  });

  it("labels the badge from the view, whatever the stored word", () => {
    expect(panel).toMatch(/const view = viewOf\(item\);/);
    expect(panel).toMatch(/<StatusBadge view=\{view\}/);
    expect(panel).toContain("{view.label}");
  });

  it("reads a parked run's requests and lets them decide its view", () => {
    expect(panel).toMatch(
      /\.from\("approvals"\)\s*\.select\("swarm_run_id, status"\)\s*\.in\("swarm_run_id", parked\)/,
    );
    expect(panel).toMatch(/if \(error\) next\.failed = true;/);
    expect(panel).toMatch(
      /item\.status === "suspended" && item\.dbRunId\s*\?\s*parkedRunView\(parkedApproval\(requests\.byRun\.get\(item\.dbRunId\), requests\.failed\)\)/,
    );
  });

  it("is opened by the approvals inbox when a row asks", () => {
    expect(inbox).toMatch(/addEventListener\(\s*OPEN_APPROVALS_EVENT/);
  });
});
