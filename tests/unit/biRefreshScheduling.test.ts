// The scheduled BI refresh: when it runs, and what it alerts on.
//
// This is the unattended path. Nobody is watching when it fires, so a wrong
// number here reaches a person as an email that says the opposite of the truth
// — or as silence when something is actually broken.
//
// THE BUG THIS WAS WRITTEN FOR: alertValue coerced every cell with Number()
// and kept whatever was finite. `Number(null)` is 0 and 0 IS finite, so a
// blank cell became a real zero. On a response-time column with one NULL row
// that made avg 97.5 instead of 130 and min 0 instead of 120 — so an alert
// "fire when min(ms) < 5" fired on a perfectly healthy service. On an
// all-negative column it made max 0 instead of the true maximum. SQL
// aggregates ignore NULL; these now do too.
import { describe, expect, it } from "vitest";

import { alertFires, alertValue, computeNextRun } from "@/utils/bi/refresh.server";

describe("alertValue ignores NULL, like SQL does", () => {
  const rows = [{ ms: 120 }, { ms: 140 }, { ms: null }, { ms: 130 }];

  it("averages only the real values", () => {
    expect(alertValue(rows, "ms", "avg")).toBe(130);
  });

  it("does not let a blank cell become the minimum", () => {
    // The sharp one: min went to 0 and every "below threshold" alert fired.
    expect(alertValue(rows, "ms", "min")).toBe(120);
  });

  it("does not let a blank cell become the maximum of a negative column", () => {
    expect(alertValue([{ pnl: -50 }, { pnl: -20 }, { pnl: null }], "pnl", "max")).toBe(-20);
  });

  it("sums the same as before, since NULL adds nothing either way", () => {
    expect(alertValue(rows, "ms", "sum")).toBe(390);
  });

  it("treats every value JS coerces to a silent zero as blank", () => {
    // Number("") , Number("  ") , Number([]) are all 0 and all finite.
    for (const blank of [null, undefined, "", "   ", [], {}]) {
      const r = [{ v: 10 }, { v: blank }, { v: 20 }];
      expect(alertValue(r, "v", "min"), `blank=${JSON.stringify(blank)}`).toBe(10);
      expect(alertValue(r, "v", "avg"), `blank=${JSON.stringify(blank)}`).toBe(15);
    }
  });

  it("keeps false and 0, which are real values", () => {
    // `false` coerces to 0 too, but a boolean column read numerically means it.
    expect(alertValue([{ v: 5 }, { v: 0 }], "v", "min")).toBe(0);
    expect(alertValue([{ v: 5 }, { v: false }], "v", "min")).toBe(0);
  });

  it("ignores text that is not a number", () => {
    expect(alertValue([{ v: 10 }, { v: "n/a" }, { v: 20 }], "v", "avg")).toBe(15);
  });

  it("returns null rather than 0 when there is nothing to aggregate", () => {
    // 0 would be a number an alert could fire on.
    expect(alertValue([], "v", "sum")).toBeNull();
    expect(alertValue([{ v: null }, { v: "x" }], "v", "avg")).toBeNull();
    expect(alertValue([{ v: null }], "v", "first")).toBeNull();
  });

  it("counts rows, not values, for count", () => {
    expect(alertValue(rows, "ms", "count")).toBe(4);
    expect(alertValue(rows, "", "sum")).toBe(4);
  });

  it("refuses an aggregation it does not know", () => {
    expect(alertValue(rows, "ms", "median")).toBeNull();
  });
});

describe("alertFires", () => {
  it("applies each operator", () => {
    expect(alertFires(5, "gt", 3)).toBe(true);
    expect(alertFires(3, "gt", 3)).toBe(false);
    expect(alertFires(3, "gte", 3)).toBe(true);
    expect(alertFires(2, "lt", 3)).toBe(true);
    expect(alertFires(3, "lte", 3)).toBe(true);
    expect(alertFires(3, "eq", 3)).toBe(true);
    expect(alertFires(4, "neq", 3)).toBe(true);
  });

  it("does not fire on an operator it does not know", () => {
    // Silent, and deliberately so: the fail-safe direction for an alert engine
    // is no alarm rather than a false one. Worth knowing that a bad operator
    // means an alert that never fires and never says why.
    for (const op of ["greater_than", ">", "", "GT"]) {
      expect(alertFires(5, op, 3), op).toBe(false);
    }
  });
});

describe("computeNextRun always moves forward", () => {
  const sunday1430 = new Date("2026-08-02T14:30:00Z");

  it("advances hourly to the top of the next hour", () => {
    expect(computeNextRun("hourly", 0, 0, sunday1430).toISOString()).toBe(
      "2026-08-02T15:00:00.000Z",
    );
  });

  it("rolls the day, month and year over", () => {
    expect(computeNextRun("hourly", 0, 0, new Date("2026-08-02T23:30:00Z")).toISOString()).toBe(
      "2026-08-03T00:00:00.000Z",
    );
    expect(computeNextRun("daily", 9, 0, new Date("2026-12-31T14:00:00Z")).toISOString()).toBe(
      "2027-01-01T09:00:00.000Z",
    );
  });

  it("moves daily to tomorrow when today's hour has passed", () => {
    expect(computeNextRun("daily", 9, 0, sunday1430).toISOString()).toBe(
      "2026-08-03T09:00:00.000Z",
    );
    expect(computeNextRun("daily", 20, 0, sunday1430).toISOString()).toBe(
      "2026-08-02T20:00:00.000Z",
    );
  });

  it("moves weekly a full week when today is the day but the hour has passed", () => {
    // 2 Aug 2026 is a Sunday (weekday 0).
    expect(computeNextRun("weekly", 9, 0, sunday1430).toISOString()).toBe(
      "2026-08-09T09:00:00.000Z",
    );
    expect(computeNextRun("weekly", 20, 0, sunday1430).toISOString()).toBe(
      "2026-08-02T20:00:00.000Z",
    );
    expect(computeNextRun("weekly", 9, 3, sunday1430).toISOString()).toBe(
      "2026-08-05T09:00:00.000Z",
    );
  });

  it("never returns a time in the past, whatever the stored row says", () => {
    // A next_run_at in the past re-fires on every tick — a mail loop. Bad
    // at_hour/weekday/cadence values must not be able to produce one.
    for (const [cadence, hour, weekday] of [
      ["daily", 24, 0],
      ["daily", -1, 0],
      ["daily", 99, 0],
      ["weekly", 9, 9],
      ["weekly", 9, -1],
      ["hourly", 0, 0],
      ["montly", 9, 0],
      ["", 9, 0],
    ] as const) {
      const next = computeNextRun(cadence, hour, weekday, sunday1430);
      expect(
        next.getTime(),
        `${cadence}/${hour}/${weekday} -> ${next.toISOString()} is not in the future`,
      ).toBeGreaterThan(sunday1430.getTime());
    }
  });

  it("is UTC throughout, so a DST change cannot shift or skip a run", () => {
    // Both sides of the European clock change land on the configured hour.
    for (const day of ["2026-03-28T12:00:00Z", "2026-03-29T12:00:00Z", "2026-10-25T12:00:00Z"]) {
      expect(computeNextRun("daily", 6, 0, new Date(day)).getUTCHours()).toBe(6);
    }
  });
});
