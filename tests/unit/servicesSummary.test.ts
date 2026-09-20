// The monitoring page's one-line services summary.
//
// Module 26 of the adversarial pass. The header read
// `unhealthy.length === 0 ? "No problems detected" : …`, blind to whether the
// probe set was EMPTY — so a first-load failure (catch keeps services at []),
// a misconfiguration returning no probes, or an all-filtered set all rendered
// "No problems detected" on a page whose whole job is to say if anything is
// wrong. This is source-certain and injection-independent: the claim is wrong
// on an empty set regardless of why it is empty.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { servicesSummary, stalenessNotice } from "@/lib/serviceHealth";

const svc = (n: number) => Array.from({ length: n }, () => ({ status: "healthy" as const }));

describe("servicesSummary", () => {
  it("reassures only when services were actually probed and all are healthy", () => {
    expect(servicesSummary({ services: svc(22), unhealthy: 0, errored: false })).toBe(
      "No problems detected",
    );
  });

  it("counts the unhealthy when some need attention", () => {
    expect(servicesSummary({ services: svc(22), unhealthy: 3, errored: false })).toBe(
      "3 needing attention",
    );
  });

  it("never claims health over an EMPTY probe set", () => {
    // THE finding: zero services must not read as "No problems detected".
    expect(servicesSummary({ services: [], unhealthy: 0, errored: false })).toBe(
      "No services to probe",
    );
  });

  it("says health is UNKNOWN when the probe failed and left nothing", () => {
    // The first-load-failure shape: catch set the error, services stayed [].
    // The header must defer to that, not assert the opposite of the banner.
    expect(servicesSummary({ services: [], unhealthy: 0, errored: true })).toBe(
      "Health unknown — could not probe",
    );
  });

  it("never asserts health in the present tense over probes that failed to refresh", () => {
    // OVERTURNS the first pass, which let the verdict stand over stale probes
    // and left the error banner to carry the failure. Two surfaces, one claim:
    // the banner says the refresh failed, it does not say the sentence beside
    // it is now old. And the page re-polls every 15s, so a network that stays
    // down freezes this line on its last value for as long as the tab is open
    // — the monitoring board that goes quiet and green while the estate burns.
    expect(servicesSummary({ services: svc(22), unhealthy: 0, errored: true })).toBe(
      "No problems at the last successful check",
    );
    expect(servicesSummary({ services: svc(22), unhealthy: 0, errored: true })).not.toBe(
      "No problems detected",
    );
  });

  it("keeps the count when the refresh fails, but dates it", () => {
    // The asymmetry: over a stale snapshot a needs-attention count is a floor
    // still worth acting on, so it survives — in the past tense. "No problems"
    // is sound in no direction at all, which is why it cannot survive as-is.
    expect(servicesSummary({ services: svc(22), unhealthy: 1, errored: true })).toBe(
      "1 needing attention at the last successful check",
    );
    expect(servicesSummary({ services: svc(22), unhealthy: 3, errored: true })).toBe(
      "3 needing attention at the last successful check",
    );
  });
});

describe("stalenessNotice", () => {
  // The header is one sentence on a page of figures. When the refresh fails,
  // the gauges, the service rows and the capacity panel below it all stop
  // moving too — under a subtitle that promises what the machine is doing
  // "right now".
  it("says nothing while refreshes are succeeding", () => {
    expect(stalenessNotice({ errored: false, hasServices: true, hasMetrics: true })).toBeNull();
  });

  it("warns once when a failed refresh left figures on screen", () => {
    const note = stalenessNotice({ errored: true, hasServices: true, hasMetrics: true });
    expect(note).toContain("Live updates have stopped");
    expect(note).toContain("not from now");
  });

  it("warns when either half of the page is stale", () => {
    expect(stalenessNotice({ errored: true, hasServices: true, hasMetrics: false })).not.toBeNull();
    expect(stalenessNotice({ errored: true, hasServices: false, hasMetrics: true })).not.toBeNull();
  });

  it("stays quiet on a first load that failed with nothing to show", () => {
    // Nothing stale to warn about; the banner and the unknown-health header
    // already carry it, and a third line would be noise.
    expect(stalenessNotice({ errored: true, hasServices: false, hasMetrics: false })).toBeNull();
  });
});

describe("what /monitoring actually renders", () => {
  const src = readFileSync("src/routes/_authenticated/monitoring.tsx", "utf8");

  it("tells the summary whether the read failed", () => {
    expect(src).toContain(
      "servicesSummary({ services, unhealthy: unhealthy.length, errored: error !== null })",
    );
  });

  it("computes AND renders the staleness notice", () => {
    // Presence is not use: importing the helper and calling it prove nothing if
    // the result never reaches the page. Pin the rendered branch.
    expect(src).toContain("const staleNote = stalenessNotice({");
    expect(src).toContain("{staleNote && <p");
  });

  it("does not call a failed probe read an empty one", () => {
    expect(src).toContain('{error ? "The probes could not be read." : "No probe results yet."}');
  });
});
