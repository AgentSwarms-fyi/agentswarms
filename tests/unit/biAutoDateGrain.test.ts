// Every tick on the revenue trend read `1667260800000`.
//
// Found by generating a paginated report with AI over `saas_sales`: the
// planner asked for a monthly revenue trend, the SQL writer produced
// `date_trunc('month', order_date)`, and the chart drew a correct line under
// an axis labelled in epoch milliseconds — on the page a finance team reads.
//
// The data was never wrong: clicking the chart's **M** grain button relabelled
// the same line `2022-05 … 2025-12`. But the toggle defaults to "auto", auto
// did no bucketing at all, and auto is what every reader gets. The toggle is
// also offered on line and area charts ONLY, so a column chart over the same
// column had no escape hatch whatsoever.
//
// Two rules, and the split between them is the fix:
//   - an EXPLICIT grain regroups the data (bucketRowsX: sorts, aggregates,
//     drops what will not parse) — the reader asked for that;
//   - AUTO only relabels (labelRowsX) — the reader asked for nothing, so
//     nothing may move, disappear, or change value.
import { describe, expect, it } from "vitest";

import { autoDateGrain, bucketRowsX, hasRawDateValues, labelRowsX } from "@/lib/biChartMath";

const DAY = 86_400_000;

/** `n` rows `stepDays` apart, as epoch ms — what `date_trunc` arrives as. */
function series(n: number, stepDays: number, start = Date.UTC(2022, 4, 1)) {
  return Array.from({ length: n }, (_, i) => ({
    d: start + i * stepDays * DAY,
    revenue: 100 + i,
  }));
}

describe("whether a field needs relabelling at all", () => {
  it("calls a timestamp raw and a formatted string not raw", () => {
    expect(hasRawDateValues(series(5, 30), "d")).toBe(true);
    expect(hasRawDateValues([{ d: new Date("2023-01-01") }], "d")).toBe(true);
    // Already a label: `strftime(d,'%Y-%m')`. Relabelling could only break it.
    expect(hasRawDateValues([{ d: "2023-01" }, { d: "2023-02" }], "d")).toBe(false);
    expect(hasRawDateValues([{ d: "2023-01-05" }], "d")).toBe(false);
  });

  it("treats a four-digit year as the label it already is", () => {
    // parseDateValue reads 2026 as the year 2026, so the axis prints "2026"
    // and there is nothing to fix. Relabelling would be a no-op at best.
    const rows = [{ d: 2022 }, { d: 2023 }, { d: 2024 }];
    expect(hasRawDateValues(rows, "d")).toBe(false);
    expect(autoDateGrain(rows, "d")).toBeNull();
  });

  it("leaves non-dates alone", () => {
    expect(autoDateGrain([{ d: "AMER" }, { d: "EMEA" }], "d")).toBeNull();
    expect(autoDateGrain([], "d")).toBeNull();
    // Small integers are counts, not epochs — the axis is a number line.
    expect(autoDateGrain([{ d: 1 }, { d: 2 }, { d: 3 }], "d")).toBeNull();
  });
});

describe("what must never be mistaken for a timestamp", () => {
  // Caught while writing the table half of this fix: `parseDateValue` maps
  // any number below 10^10 to seconds-since-epoch, so a column of revenue
  // (13946.229, 4810.558, 55691.009) parsed as three moments in 1970 and the
  // table relabelled the finance team's money as dates. Harmless where it
  // only decides whether to offer a grain toggle; not harmless where it
  // rewrites what is printed.
  const money = [{ v: 13946.229 }, { v: 4810.558 }, { v: 55691.009 }];

  it("leaves a money column as money", () => {
    expect(hasRawDateValues(money, "v")).toBe(false);
    expect(autoDateGrain(money, "v")).toBeNull();
  });

  it("leaves whole-number quantities alone", () => {
    expect(hasRawDateValues([{ v: 1500 }, { v: 42 }, { v: 55691 }], "v")).toBe(false);
    expect(hasRawDateValues([{ v: 12345678 }], "v")).toBe(false); // 8 digits: not an epoch
  });

  it("still recognises an epoch in either unit", () => {
    expect(hasRawDateValues([{ v: 1667260800000 }], "v")).toBe(true); // ms
    expect(hasRawDateValues([{ v: 1667260800 }], "v")).toBe(true); // seconds
    expect(hasRawDateValues([{ v: new Date() }], "v")).toBe(true);
  });

  it("refuses a fractional value even inside the epoch range", () => {
    // A stamp is an integer; 1667260800000.5 is a number that happens to sit
    // in the range, which is not the same thing.
    expect(hasRawDateValues([{ v: 1667260800000.5 }], "v")).toBe(false);
  });
});

describe("the grain auto picks", () => {
  it("picks the finest grain whose labels still fit", () => {
    expect(autoDateGrain(series(45, 1), "d")).toBe("day"); // 45 days
    expect(autoDateGrain(series(200, 1), "d")).toBe("week"); // 200 days
    expect(autoDateGrain(series(1000, 1), "d")).toBe("month"); // ~2.7 years
    expect(autoDateGrain(series(40, 91), "d")).toBe("quarter"); // ~10 years
    expect(autoDateGrain(series(80, 365), "d")).toBe("year"); // 80 years
  });

  it("keeps the report's own case at month, not rolled up to quarters", () => {
    // 44 monthly points, 2022-05 → 2025-12. Month is 44 labels and fits; a
    // tighter cap would have silently aggregated the finance team's months
    // into quarters, which is a different report from the one it asked for.
    // Real calendar months, the way date_trunc emits them.
    const rows = Array.from({ length: 44 }, (_, i) => ({ d: Date.UTC(2022, 4 + i, 1) }));
    expect(autoDateGrain(rows, "d")).toBe("month");
    const labelled = labelRowsX(rows, "d", "month");
    expect(labelled[0].d).toBe("2022-05");
    expect(labelled[labelled.length - 1].d).toBe("2025-12");
  });

  it("handles a single point without dividing by nothing", () => {
    expect(autoDateGrain(series(1, 1), "d")).toBe("day");
  });
});

describe("auto relabels; it does not regroup", () => {
  const ranked = [
    { d: Date.UTC(2024, 2, 1), revenue: 900 },
    { d: Date.UTC(2024, 0, 1), revenue: 500 },
    { d: Date.UTC(2024, 1, 1), revenue: 100 },
  ];

  it("keeps row order, so a ranked chart stays ranked", () => {
    const out = labelRowsX(ranked, "d", "month");
    expect(out.map((r) => r.d)).toEqual(["2024-03", "2024-01", "2024-02"]);
    // …where an explicit grain deliberately sorts.
    expect(bucketRowsX(ranked, "d", "month").map((r) => r.d)).toEqual([
      "2024-01",
      "2024-02",
      "2024-03",
    ]);
  });

  it("keeps every row and every value", () => {
    const rows = [
      { d: Date.UTC(2024, 0, 3), revenue: 10 },
      { d: Date.UTC(2024, 0, 17), revenue: 20 },
      { d: "not a date", revenue: 7 },
    ];
    const out = labelRowsX(rows, "d", "month");
    expect(out).toHaveLength(3);
    expect(out.reduce((a, r) => a + Number(r.revenue), 0)).toBe(37);
    // Two January rows keep their own identity rather than being summed.
    expect(out.map((r) => r.d)).toEqual(["2024-01", "2024-01", "not a date"]);
    // An explicit grain drops what it cannot parse — and so changes the total.
    const bucketed = bucketRowsX(rows, "d", "month");
    expect(bucketed).toHaveLength(2);
    expect(bucketed.reduce((a, r) => a + Number(r.revenue), 0)).toBe(30);
  });

  it("does not mutate the rows it was given", () => {
    const rows = series(3, 30);
    const before = rows[0].d;
    labelRowsX(rows, "d", "month");
    expect(rows[0].d).toBe(before);
  });

  it("turns the exact ticks that were reported into month labels", () => {
    // The four tick values read off the broken axis, verbatim.
    const rows = [
      { d: 1667260800000 },
      { d: 1696118400000 },
      { d: 1725148800000 },
      { d: 1764547200000 },
    ];
    expect(labelRowsX(rows, "d", "month").map((r) => r.d)).toEqual([
      "2022-11",
      "2023-10",
      "2024-09",
      "2025-12",
    ]);
  });
});
