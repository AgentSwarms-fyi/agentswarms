// Chart analytics: date bucketing, running totals, overlays, trend, forecast.
//
// 258 lines with no tests, and it is the layer that decides what a chart SHOWS
// rather than what the query returned — so a fault here is silent by
// construction. The engine split had already produced one bug of exactly this
// shape (a running total that returned 0 for every row and rendered as a flat
// line), which is why this file is worth pinning.
//
// THE BUG THIS WAS WRITTEN FOR: parseDateValue's number branch treated any
// number as an epoch stamp, so a `year` column of 2024/2025/2026 parsed as
// ~34 minutes past midnight on 1 January 1970. isMostlyDates then reported
// "yes, these are dates", the UI offered the date-grain toggle, and choosing a
// grain collapsed EVERY row into a single "1970" bucket. No error, no empty
// chart — one bar where there should have been three. The string branch had
// rejected these values since it was written; the number branch never did.
import { describe, expect, it } from "vitest";

import {
  bucketDate,
  bucketRowsX,
  condRuleMatches,
  cumulative,
  drillRows,
  isMostlyDates,
  linearFit,
  forecastRows,
  nextBucketLabel,
  parseDateValue,
  priorPeriodOverlay,
  priorYearOverlay,
} from "@/lib/biChartMath";

describe("parseDateValue — numbers and strings must agree", () => {
  it("reads a numeric year as that year, not as 1970", () => {
    expect(parseDateValue(2026)?.getUTCFullYear()).toBe(2026);
    expect(bucketDate(2026, "year")).toBe("2026");
  });

  it("agrees with the string form of the same value", () => {
    // The same column arrives as text or number depending on the loader. A
    // chart that buckets differently for identical data is the failure.
    for (const y of [1999, 2026, 2100]) {
      expect(parseDateValue(y)?.toISOString()).toBe(parseDateValue(String(y))?.toISOString());
    }
  });

  it("rejects small integers — a month or quarter is not a date", () => {
    // These are the values that produced the 1970 collapse.
    for (const n of [0, 1, 4, 7, 12, 31, 999]) expect(parseDateValue(n)).toBeNull();
    expect(parseDateValue(-5)).toBeNull();
  });

  it("still reads real epoch stamps, in seconds or milliseconds", () => {
    expect(parseDateValue(1_767_225_600).getUTCFullYear()).toBe(2026); // seconds
    expect(parseDateValue(1_767_225_600_000).getUTCFullYear()).toBe(2026); // ms
  });

  it("rejects junk rather than inventing a date", () => {
    for (const v of [NaN, Infinity, "", "   ", "not a date", null, undefined, {}])
      expect(parseDateValue(v)).toBeNull();
  });
});

describe("isMostlyDates gates the grain toggle", () => {
  it("says no to a month-number column", () => {
    // Saying yes here is what put the broken toggle on screen.
    const rows = [{ m: 1 }, { m: 2 }, { m: 3 }, { m: 4 }];
    expect(isMostlyDates(rows, "m")).toBe(false);
  });

  it("says yes to a year column and buckets it into distinct years", () => {
    const rows = [{ y: 2024 }, { y: 2025 }, { y: 2026 }];
    expect(isMostlyDates(rows, "y")).toBe(true);
    expect(bucketRowsX(rows, "y", "year").map((r) => r.y)).toEqual(["2024", "2025", "2026"]);
  });

  it("ignores blanks when judging, and needs 80%", () => {
    expect(isMostlyDates([{ d: "2026-01-01" }, { d: null }, { d: "" }], "d")).toBe(true);
    // 3 of 5 parse — under the threshold.
    const mixed = [
      { d: "2026-01-01" },
      { d: "2026-01-02" },
      { d: "2026-01-03" },
      { d: "banana" },
      { d: "kiwi" },
    ];
    expect(isMostlyDates(mixed, "d")).toBe(false);
  });
});

describe("bucketDate / bucketRowsX", () => {
  it("labels each grain in a form that sorts chronologically", () => {
    const d = "2026-07-05T13:00:00Z";
    expect(bucketDate(d, "day")).toBe("2026-07-05");
    expect(bucketDate(d, "month")).toBe("2026-07");
    expect(bucketDate(d, "quarter")).toBe("2026-Q3");
    expect(bucketDate(d, "year")).toBe("2026");
    // 2026-07-05 is a SUNDAY, so its ISO week is the one starting Mon
    // 2026-06-29 — week 27, not 28. Written as 28 first; the code was right.
    expect(bucketDate(d, "week")).toBe("2026-W27");
  });

  it("sorts buckets chronologically, not by input order", () => {
    const rows = [{ d: "2026-10-01" }, { d: "2026-09-01" }, { d: "2026-01-01" }];
    expect(bucketRowsX(rows, "d", "month").map((r) => r.d)).toEqual([
      "2026-01",
      "2026-09",
      "2026-10",
    ]);
  });

  it("drops rows it cannot parse rather than bucketing them together", () => {
    // Lumping unparsable rows into one bucket would invent a category.
    const rows = [{ d: "2026-01-01" }, { d: "nonsense" }, { d: "2026-02-01" }];
    expect(bucketRowsX(rows, "d", "month")).toHaveLength(2);
  });
});

describe("nextBucketLabel rolls over at year end", () => {
  it("advances each grain across the boundary", () => {
    expect(nextBucketLabel("2026-12", 1)).toBe("2027-01");
    expect(nextBucketLabel("2026-Q4", 1)).toBe("2027-Q1");
    expect(nextBucketLabel("2026-12-31", 1)).toBe("2027-01-01");
    expect(nextBucketLabel("2026", 1)).toBe("2027");
  });

  it("handles a 53-week ISO year", () => {
    // 2026 starts on a Thursday, so it genuinely has 53 ISO weeks; 2020 too.
    expect(nextBucketLabel("2026-W52", 1)).toBe("2026-W53");
    expect(nextBucketLabel("2020-W53", 1)).toBe("2021-W01");
  });

  it("returns null for a label it does not recognise", () => {
    expect(nextBucketLabel("Q3 FY26", 1)).toBeNull();
    expect(nextBucketLabel("", 1)).toBeNull();
  });
});

describe("cumulative", () => {
  it("accumulates in array order", () => {
    expect(cumulative([{ v: 1 }, { v: 2 }, { v: 3 }], "v").map((r) => r.v)).toEqual([1, 3, 6]);
  });

  it("carries the running total across holes instead of resetting", () => {
    // The engine-split bug rendered a flat line; a hole that reset the
    // accumulator would render a sawtooth. Both are silent.
    expect(
      cumulative([{ v: 10 }, { v: null }, { v: "abc" }, { v: 5 }], "v").map((r) => r.v),
    ).toEqual([10, 10, 10, 15]);
  });

  it("does not mutate the input rows", () => {
    const input = [{ v: 1 }, { v: 2 }];
    cumulative(input, "v");
    expect(input.map((r) => r.v)).toEqual([1, 2]);
  });
});

describe("period overlays", () => {
  it("lags by one row for prior period", () => {
    const out = priorPeriodOverlay([{ v: 1 }, { v: 2 }, { v: 3 }], "v", "prev");
    expect(out.map((r) => r.prev)).toEqual([null, 2 - 1, 3 - 1]);
  });

  it("matches the year-1 twin by label, not by position", () => {
    const rows = [
      { x: "2025-03", v: 10 },
      { x: "2026-01", v: 99 },
      { x: "2026-03", v: 20 },
    ];
    const out = priorYearOverlay(rows, "x", "v", "prev");
    expect(out.map((r) => r.prev)).toEqual([null, null, 10]);
  });

  it("shifts the YEAR of a day label, not the day", () => {
    const rows = [
      { x: "2025-07-05", v: 1 },
      { x: "2026-07-05", v: 2 },
    ];
    expect(priorYearOverlay(rows, "x", "v", "prev")[1].prev).toBe(1);
  });
});

describe("linearFit and forecastRows", () => {
  it("fits a straight line exactly", () => {
    const fit = linearFit([1, 2, 3, 4]);
    expect(fit?.slope).toBeCloseTo(1);
    expect(fit?.intercept).toBeCloseTo(1);
    expect(fit?.sigma).toBeCloseTo(0);
  });

  it("keeps positional index when skipping non-finite points", () => {
    // Filtering must not renumber the remaining points — that would tilt the
    // line toward the gap.
    const fit = linearFit([1, NaN, 3, 4]);
    expect(fit?.slope).toBeCloseTo(1);
    expect(fit?.intercept).toBeCloseTo(1);
  });

  it("refuses a fit it cannot make", () => {
    expect(linearFit([])).toBeNull();
    expect(linearFit([5])).toBeNull();
  });

  it("projects forward with labels that continue the series", () => {
    const out = forecastRows(
      [
        { x: "2026-01", y: 10 },
        { x: "2026-02", y: 20 },
        { x: "2026-03", y: 30 },
      ],
      "x",
      "y",
      2,
    );
    expect(out?.rows.map((r) => r.x)).toEqual(["2026-04", "2026-05"]);
    expect(out?.rows.map((r) => r.__forecast)).toEqual([40, 50]);
  });

  it("returns null rather than a zero-period forecast", () => {
    const data = [
      { x: "2026-01", y: 1 },
      { x: "2026-02", y: 2 },
    ];
    expect(forecastRows(data, "x", "y", 0)).toBeNull();
  });
});

describe("drillRows and condRuleMatches", () => {
  it("filters by every step of the drill path", () => {
    const rows = [
      { region: "EU", city: "Paris" },
      { region: "EU", city: "Berlin" },
      { region: "US", city: "Austin" },
    ];
    expect(drillRows(rows, [{ field: "region", value: "EU" }])).toHaveLength(2);
    expect(
      drillRows(rows, [
        { field: "region", value: "EU" },
        { field: "city", value: "Paris" },
      ]),
    ).toHaveLength(1);
    expect(drillRows(rows, [])).toHaveLength(3);
  });

  it("compares as strings so a numeric category still matches", () => {
    expect(drillRows([{ yr: 2026 }], [{ field: "yr", value: "2026" }])).toHaveLength(1);
  });

  it("applies each comparison operator", () => {
    const r = (op: string, value: number, value2?: number) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ op, value, value2, color: "blue" }) as any;
    expect(condRuleMatches(5, r("gt", 4))).toBe(true);
    expect(condRuleMatches(4, r("gt", 4))).toBe(false);
    expect(condRuleMatches(4, r("gte", 4))).toBe(true);
    expect(condRuleMatches(3, r("lt", 4))).toBe(true);
    expect(condRuleMatches(4, r("lte", 4))).toBe(true);
    expect(condRuleMatches(4, r("eq", 4))).toBe(true);
    expect(condRuleMatches(5, r("neq", 4))).toBe(true);
    expect(condRuleMatches(5, r("between", 1, 10))).toBe(true);
    expect(condRuleMatches(11, r("between", 1, 10))).toBe(false);
  });

  it("treats between with no upper bound as an exact match", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rule = { op: "between", value: 7, color: "blue" } as any;
    expect(condRuleMatches(7, rule)).toBe(true);
    expect(condRuleMatches(8, rule)).toBe(false);
  });
});
