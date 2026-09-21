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

describe("the wiring", () => {
  const REFRESH = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
  const FN = readFileSync("src/utils/monitoring.functions.ts", "utf8");

  it("the pass keeps its last result in process memory", () => {
    expect(REFRESH).toMatch(/export function getLastCronPass\(\)/);
    expect(REFRESH).toMatch(
      /lastCronPass = \{ at: new Date\(\)\.toISOString\(\), result \};\s*return result;/,
    );
  });

  it("the health handler reports it beside the other services", () => {
    expect(FN).toMatch(/schedulerProbe\(\{\s*last: getLastCronPass\(\),/);
    expect(FN).toMatch(
      /appProbe\(\),\s*dbProbe\(\),\s*scheduler\(\),\s*\.\.\.SERVICE_CATALOGUE\.map\(probeOne\),/,
    );
  });
});
