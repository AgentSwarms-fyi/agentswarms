// Driver analysis — the arithmetic behind "why did it move".
//
// This is the half of the feature a language model must NOT do. Every
// number here is checked against hand-computed values, because a
// contribution that is approximately right ranks the wrong driver first
// and reads exactly as confident as a correct one.
import { describe, expect, it } from "vitest";

import {
  analyseDrivers,
  describeDrivers,
  driverInputsFrom,
  type DriverInput,
} from "@/lib/analystDrivers";

describe("decomposing a change", () => {
  // Total: 1000 -> 920, a fall of 80.
  //   EMEA   500 -> 380  (-120) = 150% of the fall
  //   AMER   300 -> 330  (+30)  = -37.5% (an OFFSET)
  //   APJ    200 -> 210  (+10)  = -12.5% (an OFFSET)
  const rows: DriverInput[] = [
    { label: "EMEA", previous: 500, current: 380 },
    { label: "AMER", previous: 300, current: 330 },
    { label: "APJ", previous: 200, current: 210 },
  ];

  it("computes totals, deltas and percentages that add up", () => {
    const a = analyseDrivers(rows);
    expect(a.previousTotal).toBe(1000);
    expect(a.currentTotal).toBe(920);
    expect(a.totalChange).toBe(-80);
    expect(a.totalPctChange).toBeCloseTo(-0.08, 10);
    // The parts must sum to the whole — the property that makes this a
    // decomposition rather than three unrelated numbers.
    const sum = a.contributions.reduce((s, c) => s + c.change, 0);
    expect(sum).toBeCloseTo(a.totalChange, 10);
  });

  it("lets a contribution EXCEED 100% when winners offset losers", () => {
    // The tempting bug is clamping this to look tidy. EMEA really did
    // account for 150% of a net fall that AMER and APJ partly cancelled,
    // and hiding that hides the actual story.
    const a = analyseDrivers(rows);
    const emea = a.contributions.find((c) => c.label === "EMEA")!;
    expect(emea.change).toBe(-120);
    expect(emea.pctChange).toBeCloseTo(-0.24, 10);
    expect(emea.shareOfChange).toBeCloseTo(1.5, 10);
    const amer = a.contributions.find((c) => c.label === "AMER")!;
    expect(amer.shareOfChange).toBeCloseTo(-0.375, 10);
  });

  it("ranks by absolute movement, and splits drivers from offsets", () => {
    const a = analyseDrivers(rows);
    expect(a.contributions.map((c) => c.label)).toEqual(["EMEA", "AMER", "APJ"]);
    expect(a.drivers.map((c) => c.label)).toEqual(["EMEA"]); // fell, like the total
    expect(a.offsets.map((c) => c.label)).toEqual(["AMER", "APJ"]); // rose against it
  });

  it("refuses a percentage where none exists instead of inventing one", () => {
    const a = analyseDrivers([
      { label: "New", previous: 0, current: 50 }, // no baseline: ∞%, not 100%
      { label: "Gone", previous: 40, current: 0 },
      { label: "Steady", previous: 10, current: 10 },
    ]);
    expect(a.contributions.find((c) => c.label === "New")!.pctChange).toBeNull();
    expect(a.appeared).toEqual(["New"]);
    expect(a.disappeared).toEqual(["Gone"]);
    expect(a.contributions.find((c) => c.label === "Steady")!.direction).toBe("flat");
  });

  it("reports no share-of-change when the total did not move", () => {
    // +50 and −50 cancel. Shares would each be a division by zero, and
    // "infinite contribution" is not a finding — but the movement itself
    // still is, so the members keep their own changes.
    const a = analyseDrivers([
      { label: "Up", previous: 100, current: 150 },
      { label: "Down", previous: 100, current: 50 },
    ]);
    expect(a.totalChange).toBe(0);
    expect(a.contributions.every((c) => c.shareOfChange === null)).toBe(true);
    expect(a.contributions.find((c) => c.label === "Up")!.change).toBe(50);
    expect(a.drivers).toEqual([]);
    expect(a.offsets).toEqual([]);
  });
});

describe("reading a two-period result", () => {
  it("finds the label and the before/after measures by intent", () => {
    const got = driverInputsFrom(
      ["region", "prev_sales", "curr_sales"],
      [{ region: "EMEA", prev_sales: 5, curr_sales: 7 }],
    );
    expect(got).toEqual([{ label: "EMEA", previous: 5, current: 7 }]);
  });

  it("handles the other wordings models produce", () => {
    expect(
      driverInputsFrom(
        ["segment", "sales_last_year", "sales_this_year"],
        [{ segment: "SMB", sales_last_year: 2, sales_this_year: 3 }],
      ),
    ).toEqual([{ label: "SMB", previous: 2, current: 3 }]);
  });

  it("falls back to column ORDER when nothing is named prev/curr", () => {
    expect(driverInputsFrom(["country", "q1", "q2"], [{ country: "UK", q1: 9, q2: 4 }])).toEqual([
      { label: "UK", previous: 9, current: 4 },
    ]);
  });

  it("returns null rather than guessing at a shape it cannot read", () => {
    // No label to attribute the change to…
    expect(driverInputsFrom(["prev", "curr"], [{ prev: 1, curr: 2 }])).toBeNull();
    // …only one measure, so there is no "change" at all…
    expect(driverInputsFrom(["region", "sales"], [{ region: "EMEA", sales: 1 }])).toBeNull();
    // …and nothing to analyse.
    expect(driverInputsFrom(["region", "a", "b"], [])).toBeNull();
  });
});

describe("what the write-up is told", () => {
  it("states the movement, the drivers and the offsets it hides", () => {
    const text = describeDrivers(
      analyseDrivers([
        { label: "EMEA", previous: 500, current: 380 },
        { label: "AMER", previous: 300, current: 330 },
      ]),
      "total_sales",
    );
    // 500+300 = 800 falling to 380+330 = 710. (The first draft of this
    // expectation said 1,000 → 1,010 — the totals from the three-region
    // fixture above, not this two-region one. The check caught it.)
    expect(text).toContain("total_sales moved from 800 to 710");
    expect(text).toContain("DRIVERS");
    expect(text).toContain("OFFSETS");
    expect(text).toContain("EMEA");
  });

  it("says plainly when a flat total hides movement underneath", () => {
    const text = describeDrivers(
      analyseDrivers([
        { label: "Up", previous: 100, current: 150 },
        { label: "Down", previous: 100, current: 50 },
      ]),
    );
    expect(text).toContain("did not move");
    expect(text).toContain("offset each other");
  });
});
