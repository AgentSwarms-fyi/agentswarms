// The monitoring page's one-line services summary.
//
// Module 26 of the adversarial pass. The header read
// `unhealthy.length === 0 ? "No problems detected" : …`, blind to whether the
// probe set was EMPTY — so a first-load failure (catch keeps services at []),
// a misconfiguration returning no probes, or an all-filtered set all rendered
// "No problems detected" on a page whose whole job is to say if anything is
// wrong. This is source-certain and injection-independent: the claim is wrong
// on an empty set regardless of why it is empty.
import { describe, expect, it } from "vitest";
import { servicesSummary } from "@/lib/serviceHealth";

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

  it("keeps reporting the last-good status when a refresh fails but data remains", () => {
    // A later refresh failing keeps the previous probes; the header should
    // still summarise them (the error banner carries the failure separately).
    expect(servicesSummary({ services: svc(22), unhealthy: 1, errored: true })).toBe(
      "1 needing attention",
    );
    expect(servicesSummary({ services: svc(22), unhealthy: 0, errored: true })).toBe(
      "No problems detected",
    );
  });
});
