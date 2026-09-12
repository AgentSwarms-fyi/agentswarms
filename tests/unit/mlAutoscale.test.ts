// Deciding how many copies of a model should be answering.
//
// This is arithmetic, so it is tested as arithmetic — but the cases that
// matter are not "does ceil work". They are the two ways an autoscaler is
// normally wrong: adding copies too slowly to help, and removing them so
// eagerly that the endpoint flaps between sizes and pays a cold start every
// time it changes its mind.
//
// The flapping tests below are written as SEQUENCES rather than single calls,
// because flapping is a property of consecutive decisions and a test that only
// ever asks once cannot see it.
import { describe, expect, it } from "vitest";

import {
  SCALE_DOWN_MARGIN,
  idleSeconds,
  ratePerMinute,
  replicaToScore,
  replicaToStop,
  replicasForLoad,
  scaleDecision,
  type MlScaleInput,
} from "@/lib/mlAutoscale";

/** A steady endpoint: two copies, well inside cooldown, nothing in flight. */
const BASE: MlScaleInput = {
  requestsPerMinute: 100,
  replicasReady: 2,
  replicasStarting: 0,
  min: 1,
  max: 5,
  targetPerReplica: 60,
  secondsSinceChange: 600,
  cooldownSeconds: 120,
  idlestReplicaIdleSeconds: 600,
};
const at = (o: Partial<MlScaleInput>) => scaleDecision({ ...BASE, ...o });

describe("adding a copy", () => {
  it("happens the moment the load asks for it, with no cooldown", () => {
    // A queue is the thing this exists to prevent, so waiting out a cooldown
    // before relieving one would defeat the point.
    const d = at({ requestsPerMinute: 200, replicasReady: 2, secondsSinceChange: 1 });
    expect(d.action).toBe("up");
    expect(d.desired).toBe(4);
  });

  it("counts copies that are still loading, so a burst does not stampede", () => {
    // Without this, every pass during a cold start sees "not enough copies"
    // and starts another; an endpoint that needed two ends up with six.
    const d = at({ requestsPerMinute: 200, replicasReady: 1, replicasStarting: 3 });
    expect(d.action).toBe("hold");
    expect(d.desired).toBe(4);
  });

  it("never exceeds the maximum the owner set", () => {
    const d = at({ requestsPerMinute: 100_000, max: 3 });
    expect(d.desired).toBe(3);
  });

  it("brings a cold endpoint up to the minimum even with no traffic", () => {
    const d = at({ requestsPerMinute: 0, replicasReady: 0, min: 2 });
    expect(d.action).toBe("up");
    expect(d.desired).toBe(2);
    expect(d.reason).toContain("minimum");
  });

  it("and leaves a zero-minimum endpoint alone when nothing is calling", () => {
    const d = at({ requestsPerMinute: 0, replicasReady: 0, min: 0 });
    expect(d.action).toBe("hold");
    expect(d.desired).toBe(0);
  });
});

describe("removing a copy is reluctant, on purpose", () => {
  it("waits out the cooldown since the last change", () => {
    const d = at({ requestsPerMinute: 10, secondsSinceChange: 30, cooldownSeconds: 120 });
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("cooldown");
  });

  it("refuses while the quietest copy was used recently", () => {
    // Stopping a sandbox takes any request still inside it. "Idle" has to mean
    // idle for longer than a request can plausibly last.
    const d = at({ requestsPerMinute: 10, idlestReplicaIdleSeconds: 5 });
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("5s ago");
  });

  it("null means there is no copy to stop, not that one was never used", () => {
    // The distinction matters and cost a live bug. A copy that has answered
    // NOTHING is the safest one to stop, so the caller passes how long it has
    // been up rather than null — see the autoscale pass, which falls back to
    // last_started_at. Null here is reserved for "there is nothing to stop".
    const neverUsedButUpForAges = at({ requestsPerMinute: 10, idlestReplicaIdleSeconds: 9999 });
    expect(neverUsedButUpForAges.action).toBe("down");
  });

  it("refuses when there is no copy to stop at all, and says which rule stopped it", () => {
    // The reason matters, not just the action. Delete the explicit null check
    // and JS coerces `null < cooldown` to true, so the NEXT rule holds instead
    // and the outcome looks identical — while the endpoint would be relying on
    // a coercion rather than on a decision anybody wrote. The reason is
    // recorded on the deployment and read by a person, so it is behaviour.
    const d = at({ requestsPerMinute: 10, idlestReplicaIdleSeconds: null });
    expect(d.action).toBe("hold");
    expect(d.reason).toBe("no copy is idle enough to stop");
  });

  it("needs the load clear of the line, not merely at it", () => {
    // Two copies at target 60 could carry 60 on one. At exactly 60 a naive
    // rule drops to one, which is then at 100% and gets a copy added back.
    const exactly = at({ requestsPerMinute: 60, replicasReady: 2 });
    expect(exactly.action).toBe("hold");
    // Clear of it by the margin, and it goes.
    const clear = at({ requestsPerMinute: 60 * SCALE_DOWN_MARGIN - 1, replicasReady: 2 });
    expect(clear.action).toBe("down");
    expect(clear.desired).toBe(1);
  });

  it("never goes below the minimum", () => {
    const d = at({ requestsPerMinute: 0, replicasReady: 3, min: 2 });
    expect(d.action).toBe("down");
    expect(d.desired).toBe(2);
  });
});

describe("the endpoint does not flap", () => {
  /** Run the decision repeatedly at a steady rate and record every size. */
  function settle(rate: number, start: number, passes = 12): number[] {
    let live = start;
    const sizes: number[] = [];
    let sinceChange = 9999;
    for (let i = 0; i < passes; i++) {
      const d = scaleDecision({
        ...BASE,
        requestsPerMinute: rate,
        replicasReady: live,
        replicasStarting: 0,
        secondsSinceChange: sinceChange,
        idlestReplicaIdleSeconds: 9999,
      });
      if (d.desired !== live) {
        live = d.desired;
        sinceChange = 0;
      } else {
        sinceChange = 9999;
      }
      sizes.push(live);
    }
    return sizes;
  }

  it("settles at one size and stays there, from above and from below", () => {
    for (const rate of [0, 30, 59, 60, 61, 119, 120, 121, 200, 300]) {
      const fromBelow = settle(rate, 1);
      const fromAbove = settle(rate, 5);
      const endBelow = fromBelow[fromBelow.length - 1];
      const endAbove = fromAbove[fromAbove.length - 1];
      // The last four passes must all agree: no oscillation at rest.
      expect(new Set(fromBelow.slice(-4)).size).toBe(1);
      expect(new Set(fromAbove.slice(-4)).size).toBe(1);
      // And both directions must land on a size that can carry the load.
      for (const size of [endBelow, endAbove]) {
        if (rate > 0) expect(size * BASE.targetPerReplica).toBeGreaterThanOrEqual(rate);
      }
    }
  });

  it("a rate exactly at the boundary does not oscillate", () => {
    // 120 a minute is exactly two copies at 60. The margin is what stops this
    // alternating 2, 1, 2, 1 for ever.
    const sizes = settle(120, 2, 10);
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe(2);
  });

  it("and a size reached by scaling up is not immediately undone", () => {
    const up = at({ requestsPerMinute: 200, replicasReady: 2 });
    expect(up.action).toBe("up");
    // The very next pass, with the copies now present and the cooldown fresh.
    const next = scaleDecision({
      ...BASE,
      requestsPerMinute: 200,
      replicasReady: up.desired,
      secondsSinceChange: 1,
    });
    expect(next.action).toBe("hold");
  });
});

describe("the rate is measured, not guessed", () => {
  const t0 = "2026-09-12T10:00:00.000Z";
  const now = new Date("2026-09-12T10:02:00.000Z");

  it("is the change in the counter over the time between readings", () => {
    expect(ratePerMinute(100, t0, 400, now)).toBeCloseTo(150, 6);
  });

  it("has no answer before there is a previous reading", () => {
    expect(ratePerMinute(null, t0, 400, now)).toBeNull();
    expect(ratePerMinute(100, null, 400, now)).toBeNull();
  });

  it("refuses a counter that went BACKWARDS rather than inventing a rate", () => {
    // The endpoint restarted and its count reset. Treating 0 - 500 as traffic
    // would ask for copies nobody needs; treating it as a large negative would
    // scale to the floor. Neither is a measurement.
    expect(ratePerMinute(500, t0, 0, now)).toBeNull();
  });

  it("and a reading from the future is not a duration", () => {
    expect(ratePerMinute(100, "2026-09-12T10:05:00.000Z", 400, now)).toBeNull();
    expect(ratePerMinute(100, "not a date", 400, now)).toBeNull();
  });
});

describe("which copy", () => {
  const rs = [
    { id: "a", last_used_at: "2026-09-12T10:00:00.000Z" },
    { id: "b", last_used_at: "2026-09-12T09:00:00.000Z" },
    { id: "c", last_used_at: "2026-09-12T11:00:00.000Z" },
  ];

  it("the quietest one is both the one to stop and the one to use next", () => {
    // Deliberately the same rule. Two notions of "quietest" would have the
    // scorer and the scaler disagreeing about the same endpoint, and the idle
    // clock the safety check reads would never mean what it says.
    expect(replicaToStop(rs)!.id).toBe("b");
    expect(replicaToScore(rs)!.id).toBe("b");
  });

  it("a copy that has never been used is the quietest of all", () => {
    expect(replicaToStop([...rs, { id: "new", last_used_at: null }])!.id).toBe("new");
  });

  it("and nothing at all is nothing, not a crash", () => {
    expect(replicaToStop([])).toBeNull();
    expect(replicaToScore([])).toBeNull();
  });

  it("does not reorder the caller's array", () => {
    const copy = [...rs];
    replicaToStop(copy);
    expect(copy.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("idle time", () => {
  const now = new Date("2026-09-12T10:00:00.000Z");
  it("is seconds since the copy last answered", () => {
    expect(idleSeconds("2026-09-12T09:59:00.000Z", now)).toBeCloseTo(60, 6);
  });
  it("is null when it never has", () => {
    expect(idleSeconds(null, now)).toBeNull();
    expect(idleSeconds("nonsense", now)).toBeNull();
  });
  it("and never negative, however the clocks disagree", () => {
    expect(idleSeconds("2026-09-12T10:05:00.000Z", now)).toBe(0);
  });
});

describe("load alone", () => {
  it("rounds up, because a partial copy cannot answer", () => {
    expect(replicasForLoad(61, 60)).toBe(2);
    expect(replicasForLoad(120, 60)).toBe(2);
    expect(replicasForLoad(121, 60)).toBe(3);
  });
  it("asks for nothing when nothing is calling", () => {
    expect(replicasForLoad(0, 60)).toBe(0);
  });
  it("and survives a target nobody set", () => {
    expect(replicasForLoad(50, 0)).toBe(1);
    expect(replicasForLoad(50, Number.NaN)).toBe(1);
  });
});
