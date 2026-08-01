// The swarm scheduler's decisions.
//
// A scheduled swarm run is NOT idempotent from the outside: it calls models,
// spends budget, and can send notifications or hit webhooks. Firing one twice
// or running the wrong user's swarm is a real, billable, sometimes user-visible
// event — so these are correctness tests, not tidiness ones.
//
// The decisions were previously inline between database calls and therefore
// untestable. They are extracted, not re-implemented: these call the same
// functions processDueSwarmSchedules calls.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { coerceInitialState, isScheduleDue, scheduleMayRun } from "@/utils/swarmSchedules.server";

const src = readFileSync("src/utils/swarmSchedules.server.ts", "utf8");
const MIN = 60_000;
const T0 = new Date("2026-08-01T12:00:00.000Z").getTime();

describe("isScheduleDue", () => {
  it("runs a never-run schedule immediately", () => {
    // Otherwise creating a weekly schedule means a week of nothing happening,
    // which reads as broken.
    expect(isScheduleDue({ last_run_at: null, interval_minutes: 60 }, T0)).toBe(true);
  });

  it("waits the full interval after a run", () => {
    const last = new Date(T0).toISOString();
    expect(isScheduleDue({ last_run_at: last, interval_minutes: 60 }, T0 + 59 * MIN)).toBe(false);
    expect(isScheduleDue({ last_run_at: last, interval_minutes: 60 }, T0 + 60 * MIN)).toBe(true);
  });

  it("is due exactly ON the boundary, not just after", () => {
    // A strict `>` would push every run one whole tick late, compounding.
    const last = new Date(T0).toISOString();
    expect(isScheduleDue({ last_run_at: last, interval_minutes: 5 }, T0 + 5 * MIN)).toBe(true);
  });

  it("force overrides everything, including a just-completed run", () => {
    const last = new Date(T0).toISOString();
    expect(isScheduleDue({ last_run_at: last, interval_minutes: 60 }, T0, true)).toBe(true);
  });

  it("refuses a zero or negative interval instead of running every tick", () => {
    // The expensive failure: interval 0 would fire this swarm once a minute,
    // for ever, spending real money.
    const last = new Date(T0).toISOString();
    expect(isScheduleDue({ last_run_at: last, interval_minutes: 0 }, T0 + 999 * MIN)).toBe(false);
    expect(isScheduleDue({ last_run_at: last, interval_minutes: -5 }, T0 + 999 * MIN)).toBe(false);
  });

  it("refuses a non-numeric interval", () => {
    const last = new Date(T0).toISOString();
    expect(isScheduleDue({ last_run_at: last, interval_minutes: Number.NaN }, T0 + 999 * MIN)).toBe(
      false,
    );
  });

  it("treats an unparseable last_run_at as never-run rather than stranding it", () => {
    // NaN comparisons are always false, so without this the schedule would be
    // permanently not-due and silently stop for ever.
    expect(isScheduleDue({ last_run_at: "not a date", interval_minutes: 60 }, T0)).toBe(true);
  });
});

describe("scheduleMayRun — the tenant boundary", () => {
  it("allows a schedule to run its owner's swarm", () => {
    expect(scheduleMayRun({ user_id: "u1" }, { user_id: "u1" })).toBe(true);
  });

  it("REFUSES another user's swarm", () => {
    // These run under the service role with RLS off. A schedule row carrying
    // someone else's swarm_id would otherwise execute their swarm — reading
    // their data and spending their connections — under the scheduler's
    // authority.
    expect(scheduleMayRun({ user_id: "u1" }, { user_id: "u2" })).toBe(false);
  });

  it("fails closed on a missing swarm", () => {
    expect(scheduleMayRun({ user_id: "u1" }, null)).toBe(false);
    expect(scheduleMayRun({ user_id: "u1" }, undefined)).toBe(false);
  });

  it("fails closed when the swarm has no owner recorded", () => {
    // An ownerless row must not be treated as "belongs to whoever asked".
    expect(scheduleMayRun({ user_id: "u1" }, {})).toBe(false);
    expect(scheduleMayRun({ user_id: "u1" }, { user_id: null })).toBe(false);
  });
});

describe("coerceInitialState", () => {
  it("keeps string values", () => {
    expect(coerceInitialState({ region: "EMEA" })).toEqual({ region: "EMEA" });
  });

  it("rejects an ARRAY, which typeof calls an object", () => {
    // A naive `typeof v === "object"` check passes an array, which then
    // spreads into {0: …, 1: …} state keys.
    expect(coerceInitialState(["a", "b"])).toEqual({});
  });

  it("rejects null and primitives", () => {
    expect(coerceInitialState(null)).toEqual({});
    expect(coerceInitialState("x")).toEqual({});
    expect(coerceInitialState(42)).toEqual({});
  });

  it("stringifies scalars rather than passing a number where a string is expected", () => {
    expect(coerceInitialState({ n: 5, ok: true })).toEqual({ n: "5", ok: "true" });
  });

  it("drops nested objects instead of stringifying them to [object Object]", () => {
    expect(coerceInitialState({ good: "a", bad: { deep: 1 } })).toEqual({ good: "a" });
  });
});

describe("the claim is conditional", () => {
  it("stamps last_run_at only while it still holds the value we read", () => {
    // Optimistic concurrency. The previous version updated unconditionally,
    // which claimed nothing: two callers had already read the same due row,
    // both stamped it, and both ran the swarm.
    const claim = src.slice(
      src.indexOf("async function claimSchedule"),
      src.indexOf("export async function processDueSwarmSchedules"),
    );
    expect(claim).toContain('q.eq("last_run_at", s.last_run_at)');
    expect(claim).toContain('q.is("last_run_at", null)');
    expect(claim).toContain(".select(");
  });

  it("uses .is for null, which PostgREST needs instead of .eq", () => {
    // `.eq(col, null)` does not become IS NULL, so a never-run schedule would
    // never match and could never be claimed — the scheduler would silently
    // never fire a brand-new schedule.
    expect(src).not.toMatch(/\.eq\("last_run_at",\s*null\)/);
  });

  it("skips the schedule when the claim matched nothing", () => {
    expect(src).toMatch(/if \(!\(await claimSchedule\(s\)\)\) continue;/);
  });

  it("claims before executing", () => {
    expect(src.indexOf("await claimSchedule(s)")).toBeLessThan(src.indexOf("executeSwarmServer({"));
  });

  it("guards against re-entry within one process", () => {
    expect(src).toMatch(/if \(processing\) return 0;/);
  });

  it("checks ownership before executing", () => {
    expect(src.indexOf("scheduleMayRun(s, swarm)")).toBeLessThan(
      src.indexOf("executeSwarmServer({"),
    );
  });
});
