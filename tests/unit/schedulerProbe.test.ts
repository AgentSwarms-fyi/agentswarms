// The scheduler's last pass, as a service on the Monitoring page.
//
// R57 made the scheduler's pass record every folded failure in `errors`, and
// the only place that answer went was the JSON of /api/bi/cron, which the
// page polls and discards. The Monitoring page listed every service the
// deployment runs and never the scheduler. This probe is where a pass's
// failures — and a scheduler that has stopped — are seen.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SCHEDULER_STALE_MS, schedulerProbe } from "@/lib/serviceHealth";

const NOW = new Date("2026-09-21T12:00:00Z");
const pass = (
  overrides: Partial<{
    errors: string[];
    processed: number;
    prep_flows: number;
    secondsAgo: number;
  }> = {},
) => ({
  at: new Date(NOW.getTime() - (overrides.secondsAgo ?? 20) * 1000).toISOString(),
  result: {
    ran: true,
    errors: overrides.errors ?? [],
    processed: overrides.processed ?? 2,
    prep_flows: overrides.prep_flows ?? 1,
  },
});

describe("schedulerProbe", () => {
  it("is up with the counts after a clean recent pass", () => {
    const p = schedulerProbe({
      last: pass(),
      now: NOW,
      bootedAt: NOW.getTime() - 600_000,
      inProcessDisabled: false,
    });
    expect(p.id).toBe("scheduler");
    expect(p.status).toBe("up");
    expect(p.message).toBeUndefined();
    expect(p.detail).toEqual({ last_pass: "20 s ago", processed: 2, prep_flows: 1, failures: 0 });
  });

  it("is degraded and names the failures when the last pass had any", () => {
    const p = schedulerProbe({
      last: pass({
        errors: [
          "bi-schedules: could not read due schedules: connection reset",
          "etl-scheduler: boom",
        ],
      }),
      now: NOW,
      bootedAt: NOW.getTime() - 600_000,
      inProcessDisabled: false,
    });
    expect(p.status).toBe("degraded");
    expect(p.message).toMatch(
      /Last pass had 2 failure\(s\): bi-schedules: could not read due schedules: connection reset; etl-scheduler: boom/,
    );
    expect(p.detail?.failures).toBe(2);
  });

  it("caps the failures it lists and says how many more", () => {
    const p = schedulerProbe({
      last: pass({ errors: ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5"] }),
      now: NOW,
      bootedAt: 0,
      inProcessDisabled: false,
    });
    expect(p.message).toMatch(/5 failure\(s\): a: 1; b: 2; c: 3; and 2 more$/);
  });

  it("is degraded when the last pass is too old, even if it was clean", () => {
    const p = schedulerProbe({
      last: pass({ secondsAgo: SCHEDULER_STALE_MS / 1000 + 60 }),
      now: NOW,
      bootedAt: 0,
      inProcessDisabled: false,
    });
    expect(p.status).toBe("degraded");
    expect(p.message).toMatch(/Last pass 6 minutes ago — the scheduler has stopped\./);
  });

  it("gives a fresh process time for its first pass, then calls the silence a failure", () => {
    const young = schedulerProbe({
      last: null,
      now: NOW,
      bootedAt: NOW.getTime() - 60_000,
      inProcessDisabled: false,
    });
    expect(young.status).toBe("up");
    expect(young.message).toMatch(/No pass recorded yet/);
    const old = schedulerProbe({
      last: null,
      now: NOW,
      bootedAt: NOW.getTime() - 20 * 60_000,
      inProcessDisabled: false,
    });
    expect(old.status).toBe("degraded");
    expect(old.message).toMatch(/No pass in the 20 minutes since this process started\./);
  });

  it("does not blame an instance whose in-process scheduler is disabled by configuration", () => {
    const p = schedulerProbe({ last: null, now: NOW, bootedAt: 0, inProcessDisabled: true });
    expect(p.status).toBe("up");
    expect(p.message).toMatch(/DISABLE_INPROCESS_SCHEDULER/);
  });
});

describe("judged by the fleet's last pass, not one worker's memory (R409)", () => {
  // Measured: with the default eight workers, the page said "Last pass 42
  // minutes ago — the scheduler has stopped" and "No pass in the 18 minutes
  // since this process started", alternately, while passes ran in another
  // worker (its lakehouse maintenance logged twice in that hour).
  const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

  it("is up when another worker passed recently, though this one has run nothing for 40 minutes", () => {
    const p = schedulerProbe({
      last: pass({ secondsAgo: 40 * 60 }),
      now: NOW,
      bootedAt: NOW.getTime() - 60 * 60_000,
      inProcessDisabled: false,
      fleetLastPassAt: at(30),
    });
    expect(p.status).toBe("up");
    expect(p.message).toBeUndefined();
    // Only the fleet's age: this worker's old counts are not today's.
    expect(p.detail).toEqual({ last_pass: "30 s ago" });
  });

  it("is up for a worker that never won the lease", () => {
    const p = schedulerProbe({
      last: null,
      now: NOW,
      bootedAt: NOW.getTime() - 60 * 60_000,
      inProcessDisabled: false,
      fleetLastPassAt: at(45),
    });
    expect(p.status).toBe("up");
  });

  it("says the scheduler stopped only when no pass ran anywhere", () => {
    const p = schedulerProbe({
      last: pass(),
      now: NOW,
      bootedAt: NOW.getTime() - 60 * 60_000,
      inProcessDisabled: false,
      fleetLastPassAt: at(SCHEDULER_STALE_MS / 1000 + 120),
    });
    expect(p.status).toBe("degraded");
    expect(p.message).toBe(
      "No pass in any worker or instance for 7 minutes — the scheduler has stopped.",
    );
  });

  it("still shows this process's recent failures when the fleet is passing", () => {
    const p = schedulerProbe({
      last: pass({ secondsAgo: 50, errors: ["etl-scheduler: boom"] }),
      now: NOW,
      bootedAt: 0,
      inProcessDisabled: false,
      fleetLastPassAt: at(50),
    });
    expect(p.status).toBe("degraded");
    expect(p.message).toBe("Last pass had 1 failure(s): etl-scheduler: boom");
    expect(p.detail).toEqual({ last_pass: "50 s ago", processed: 2, prep_flows: 1, failures: 1 });
  });

  it("gives a process that just started time for the first pass", () => {
    const p = schedulerProbe({
      last: null,
      now: NOW,
      bootedAt: NOW.getTime() - 60_000,
      inProcessDisabled: false,
      fleetLastPassAt: at(3 * 3600),
    });
    expect(p.status).toBe("up");
    expect(p.message).toMatch(/No pass recorded yet/);
  });

  it("blames the external cron when the in-process scheduler is off and nothing passed", () => {
    const p = schedulerProbe({
      last: null,
      now: NOW,
      bootedAt: 0,
      inProcessDisabled: true,
      fleetLastPassAt: at(20 * 60),
    });
    expect(p.status).toBe("degraded");
    expect(p.message).toMatch(
      /DISABLE_INPROCESS_SCHEDULER\), and the external cron has not called/,
    );
  });

  it("falls back to this process's memory when the lease cannot be read", () => {
    const p = schedulerProbe({
      last: pass({ secondsAgo: SCHEDULER_STALE_MS / 1000 + 60 }),
      now: NOW,
      bootedAt: 0,
      inProcessDisabled: false,
      fleetLastPassAt: null,
    });
    expect(p.message).toMatch(/Last pass 6 minutes ago — the scheduler has stopped\./);
  });
});

describe("the wiring", () => {
  const REFRESH = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
  const FN = readFileSync("src/utils/monitoring.functions.ts", "utf8");

  it("the pass keeps its last result in process memory", () => {
    expect(REFRESH).toMatch(/export function getLastCronPass\(\)/);
    expect(REFRESH).toMatch(
      /lastCronPass = \{ at: new Date\(\)\.toISOString\(\), result \};\s*return result;/,
    );
  });

  it("the health handler reads the fleet's last pass from the scheduler lease", () => {
    const LOCK = readFileSync("src/utils/cronLock.server.ts", "utf8");
    expect(LOCK).toMatch(
      /export async function lastCronLeaseClaimAt[\s\S]*?\.from\("cron_locks"\)\s*\.select\("updated_at"\)\s*\.eq\("name", name\)/,
    );
    expect(FN).toContain('const fleetLastPassAt = await lastCronLeaseClaimAt("scheduler");');
    expect(FN).toMatch(/schedulerProbe\(\{[^}]*fleetLastPassAt,\s*\}\)/);
    // When this PROCESS started, not when the module first loaded.
    expect(FN).toContain("const BOOTED_AT = Date.now() - Math.round(process.uptime() * 1000);");
  });

  it("the health handler reports it beside the other services", () => {
    expect(FN).toMatch(/schedulerProbe\(\{\s*last: getLastCronPass\(\),/);
    expect(FN).toMatch(
      /appProbe\(\),\s*dbProbe\(\),\s*scheduler\(\),\s*\.\.\.SERVICE_CATALOGUE\.map\(probeOne\),/,
    );
  });
});
