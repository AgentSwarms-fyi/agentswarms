// A run parked at an approval can be cancelled, and a cancelled run does not
// resume (R179). Before: a scheduled swarm with an approval node parked a run
// each time it fired; Recent runs offered each only "Review approval", and the
// only way to end one was to decide its approval: approving runs the rest,
// rejecting ends it as an error, recorded as a rejection nobody made on the
// content. A failed read of the runs also read as "No runs yet" (the R63 shape).
//
// The server functions drag in Supabase, so they are pinned by source, bounded
// by the next export; the status rules are pure.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parkedApproval, parkedRunView, runStatusView } from "@/lib/swarmRunStatus";

const FNS = readFileSync("src/utils/swarmResume.functions.ts", "utf8");
const section = (name: string) => {
  const start = FNS.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  const rest = FNS.slice(start + 10);
  const end = rest.indexOf("\nexport ");
  return FNS.slice(start, start + 10 + (end < 0 ? rest.length : end));
};
const CANCEL = section("cancelParkedSwarmRun");
const RESUME = section("resumeApprovedSwarmRun");
const PANEL = readFileSync("src/components/swarms/RecentRunsPanel.tsx", "utf8");

describe("which runs the panel can end on the server", () => {
  it("every parked view, whatever its request says; nothing else", () => {
    for (const a of ["pending", "decided", "none", "unknown"] as const) {
      expect(parkedRunView(a).parked).toBe(true);
    }
    for (const s of ["running", "waiting", "success", "error", "cancelled", "whatever"]) {
      expect(runStatusView(s).parked).toBe(false);
    }
    expect(parkedRunView(parkedApproval(["approved"], false)).label).toBe("Decided, not resumed");
  });
});

describe("cancelling a parked run", () => {
  it("reads the run as the caller, so only its owner can end it", () => {
    expect(CANCEL).toMatch(
      /const \{ data: run, error: readErr \} = await sb\s*\.from\("swarm_runs"\)/,
    );
    expect(CANCEL).toMatch(/if \(readErr\) return \{ ok: false, error: `The run could not be read/);
    expect(CANCEL).toMatch(/if \(run\.status !== "suspended"\) \{/);
  });
  it("ends the run only while it is still parked, so a resume that got there first wins", () => {
    expect(CANCEL).toMatch(
      /\.update\(\{ status: "cancelled", finished_at: now, cancel_requested: true \}\)\s*\.eq\("id", run\.id\)\s*\.eq\("status", "suspended"\)\s*\.select\("id"\);/,
    );
    expect(CANCEL).toMatch(/if \(!ended\?\.length\) \{\s*return \{\s*ok: false,/);
  });
  it("then removes its checkpoint and closes its pending approvals", () => {
    const end = CANCEL.indexOf('status: "cancelled", finished_at');
    const clear = CANCEL.indexOf("await clearCheckpoint(run.id);");
    const close = CANCEL.indexOf(
      '.update({ status: "cancelled", decided_at: now, decided_by: user.id })',
    );
    expect(end).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(end);
    expect(close).toBeGreaterThan(clear);
    expect(CANCEL.slice(close)).toMatch(
      /\.eq\("swarm_run_id", run\.id\)\s*\.eq\("status", "pending"\)/,
    );
  });
  it("says when the approval could not be closed, and records the cancel", () => {
    expect(CANCEL).toMatch(/closeErr\s*\?\s*\{\s*note:/);
    expect(CANCEL).toMatch(/action: "swarm_run\.cancel"/);
  });
});

describe("a decision after the cancel", () => {
  it("is recorded, and does not resume the run", () => {
    const refuse = RESUME.indexOf('if (run.status === "cancelled") {');
    expect(refuse).toBeGreaterThan(0);
    expect(RESUME.slice(refuse, refuse + 200)).toMatch(/ok: false,/);
    // Before the checkpoint is consulted, and before the resume.
    expect(RESUME.indexOf("loadCheckpoint(run.id")).toBeGreaterThan(refuse);
    expect(RESUME.indexOf("await resumeSwarmRun(")).toBeGreaterThan(refuse);
  });
});

describe("the panel", () => {
  it("offers Cancel on a parked row and sends it to the server", () => {
    expect(PANEL).toMatch(/\{\(view\.cancellable \|\| view\.parked\) && \(/);
    expect(PANEL).toMatch(
      /if \(item\.status === "suspended" && item\.dbRunId\) \{[\s\S]{0,300}cancelParkedFn\(\{ data: \{ access_token: token, run_id: item\.dbRunId \} \}\)/,
    );
  });
  it("says the runs could not be loaded, rather than that there are none", () => {
    expect(PANEL).toMatch(
      /const \{ data, error: readErr \} = await supabase\s*\.from\("swarm_runs"\)/,
    );
    expect(PANEL).toMatch(/if \(readErr\) \{\s*setLoadError\(readErr\.message\);/);
    const errorState = PANEL.indexOf(") : loadError ? (");
    const empty = PANEL.indexOf(") : items.length === 0 ? (");
    expect(errorState).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(errorState);
    expect(PANEL).toContain("The runs could not be loaded, so this list says nothing about them");
  });
});
