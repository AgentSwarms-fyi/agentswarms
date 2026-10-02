// The arithmetic behind giving a candidate version real traffic to answer.
//
// The split is checked against an EXACT oracle rather than by sampling. A
// random split tested with random numbers tells you about the generator; a
// deterministic sweep of rolls tells you about the rule, and the rule is the
// only part this module owns.
import { describe, expect, it } from "vitest";

import {
  canaryVerdict,
  clampPercent,
  ERROR_FLOOR,
  errorRate,
  MIN_CANDIDATE_REQUESTS,
  observedShare,
  requestsUntilVerdict,
  rollbackDecision,
  routeToCandidate,
  WORSE_THAN_PRIMARY_BY,
  type MlCanaryTotals,
} from "@/lib/mlCanary";

const totals = (t: Partial<MlCanaryTotals> = {}): MlCanaryTotals => ({
  primaryRequests: 0,
  primaryErrors: 0,
  candidateRequests: 0,
  candidateErrors: 0,
  ...t,
});

describe("which side answers this request", () => {
  it("nothing goes to the candidate at 0%, everything at 100%", () => {
    // The two settings that must be absolute. A canary at 0 that occasionally
    // answered somebody would be an unapproved model serving traffic nobody
    // asked it to serve.
    for (const roll of [0, 0.001, 0.5, 0.9999]) {
      expect(routeToCandidate(0, roll)).toBe(false);
      expect(routeToCandidate(100, roll)).toBe(true);
    }
  });

  it("splits at exactly the configured share, checked against a count", () => {
    // Walk 1000 evenly spaced rolls. The number that should cross is not a
    // statistical expectation — it is countable: the k/1000 strictly below
    // p/100, which is exactly 10p of them.
    const N = 1000;
    for (const percent of [1, 5, 10, 25, 50, 99]) {
      let crossed = 0;
      for (let k = 0; k < N; k++) if (routeToCandidate(percent, k / N)) crossed++;
      expect(crossed, `${percent}%`).toBe(percent * 10);
    }
  });

  it("the boundary roll stays with production", () => {
    // roll === p/100 is NOT below it. Off by one here is off by one per cent
    // of live traffic, which at ten per cent is a tenth of the whole canary.
    expect(routeToCandidate(10, 0.1)).toBe(false);
    expect(routeToCandidate(10, 0.0999999)).toBe(true);
  });

  it("a roll outside [0, 1) is not a roll, and goes to production", () => {
    // A mutation check found this: without the guard a NEGATIVE roll is below
    // every threshold, so it crossed at any share — including 0%, where the
    // whole promise is that nobody crosses.
    for (const percent of [0, 10, 100]) {
      expect(routeToCandidate(percent, -0.5), `${percent}% at -0.5`).toBe(false);
      expect(routeToCandidate(percent, 1), `${percent}% at 1`).toBe(false);
      expect(routeToCandidate(percent, 1.5), `${percent}% at 1.5`).toBe(false);
    }
  });

  it("a share that is not a number sends nobody across", () => {
    // The safe direction. A NaN percentage must not become "all of it".
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(routeToCandidate(bad, 0.5)).toBe(false);
    }
    expect(routeToCandidate(50, Number.NaN)).toBe(false);
  });

  it("and a share is a whole number of per cent, bounded both ends", () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(12.4)).toBe(12);
    expect(clampPercent(12.5)).toBe(13);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("what actually happened", () => {
  it("reports the share observed, not the one configured", () => {
    // 13 of 100 when 10% was asked for is what a random split does. Showing
    // the configured number alone would be telling the reader something that
    // is not true of their traffic.
    expect(observedShare(totals({ primaryRequests: 87, candidateRequests: 13 }))).toBeCloseTo(
      0.13,
      10,
    );
    expect(observedShare(totals())).toBeNull();
  });

  it("an error rate needs requests to be a rate at all", () => {
    expect(errorRate(0, 0)).toBeNull();
    expect(errorRate(20, 2)).toBeCloseTo(0.1, 10);
    // Bounded, so a miscount cannot report 300%.
    expect(errorRate(10, 50)).toBe(1);
    expect(errorRate(10, -5)).toBe(0);
  });
});

describe("the verdict, and when it is allowed to exist", () => {
  it("says nothing until enough real callers have been served", () => {
    const t = totals({ candidateRequests: MIN_CANDIDATE_REQUESTS - 1, candidateErrors: 5 });
    expect(canaryVerdict(t)).toBe("watching");
    expect(requestsUntilVerdict(t)).toBe(1);
    // Even at a catastrophic rate. Nineteen requests at 26% is four people,
    // and four is not yet a rate.
    expect(rollbackDecision(t).rollback).toBe(false);
  });

  it("healthy below the floor", () => {
    const t = totals({ candidateRequests: 100, candidateErrors: 9, primaryRequests: 900 });
    expect(errorRate(100, 9)!).toBeLessThan(ERROR_FLOOR);
    expect(canaryVerdict(t)).toBe("healthy");
  });

  it("exactly at the floor is already failing, not healthy", () => {
    // Two in twenty is the rate the floor was chosen to describe, so it has to
    // be ON the failing side of the line. A mutation check found the
    // comparison could be flipped to inclusive-healthy without a test noticing,
    // which would have let the documented rate serve for ever.
    const t = totals({
      candidateRequests: 20,
      candidateErrors: 2,
      primaryRequests: 180,
      primaryErrors: 0,
    });
    expect(errorRate(20, 2)).toBe(ERROR_FLOOR);
    expect(canaryVerdict(t)).toBe("failing");
    expect(rollbackDecision(t).rollback).toBe(true);
  });

  it("failing when it is over the floor AND worse than production", () => {
    const t = totals({
      candidateRequests: 100,
      candidateErrors: 20,
      primaryRequests: 900,
      primaryErrors: 9,
    });
    expect(canaryVerdict(t)).toBe("failing");
    const d = rollbackDecision(t);
    expect(d.rollback).toBe(true);
    // The reason names both figures, so the audit row says what was compared.
    expect(d.reason).toContain("20 of 100");
    expect(d.reason).toContain("20.0%");
    expect(d.reason).toContain("1.0%");
  });

  it("but NOT when production is failing just as hard", () => {
    // The lakehouse being down is not evidence that the candidate is bad, and
    // rolling back to a version failing at the same rate fixes nothing.
    const t = totals({
      candidateRequests: 100,
      candidateErrors: 30,
      primaryRequests: 900,
      primaryErrors: 270,
    });
    expect(errorRate(100, 30)).toBeGreaterThan(ERROR_FLOOR);
    expect(canaryVerdict(t)).toBe("endpoint-failing");
    expect(rollbackDecision(t).rollback).toBe(false);
    expect(rollbackDecision(t).reason).toContain("Both versions are failing");
  });

  it("and the margin is what separates those two, exactly", () => {
    // Production at 10%, candidate at 10% + the margin: rolls back. A hair
    // under: does not. Asserted on both sides of the line so a change to the
    // margin cannot pass by making the rule vacuous.
    const at = totals({
      candidateRequests: 1000,
      candidateErrors: Math.round(1000 * (0.1 + WORSE_THAN_PRIMARY_BY)),
      primaryRequests: 1000,
      primaryErrors: 100,
    });
    expect(canaryVerdict(at)).toBe("failing");
    const under = totals({
      candidateRequests: 1000,
      candidateErrors: Math.round(1000 * (0.1 + WORSE_THAN_PRIMARY_BY)) - 1,
      primaryRequests: 1000,
      primaryErrors: 100,
    });
    expect(canaryVerdict(under)).toBe("endpoint-failing");
  });

  it("a candidate failing everything with a healthy production rolls back", () => {
    const t = totals({
      candidateRequests: 25,
      candidateErrors: 25,
      primaryRequests: 225,
      primaryErrors: 0,
    });
    expect(rollbackDecision(t).rollback).toBe(true);
    expect(rollbackDecision(t).reason).toContain("100.0%");
  });

  it("and a quiet, healthy canary is left alone", () => {
    const t = totals({ candidateRequests: 50, candidateErrors: 0, primaryRequests: 450 });
    expect(canaryVerdict(t)).toBe("healthy");
    expect(rollbackDecision(t).rollback).toBe(false);
    expect(rollbackDecision(t).reason).toContain("0 failures in 50");
  });
});
