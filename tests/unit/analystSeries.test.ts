// Time-series reading: trend, outliers, and a projection that knows what it
// is. The maths is checked against hand-computed values, and the REFUSALS
// are checked just as hard — a forecast from seven noisy points is the kind
// of output that gets believed precisely because it looks like data.
import { describe, expect, it } from "vitest";

import {
  describeSeries,
  forecastSeries,
  MIN_FORECAST_POINTS,
  readSeries,
  seriesFrom,
  type SeriesPoint,
} from "@/lib/analystSeries";

const pts = (values: number[], prefix = "2026-"): SeriesPoint[] =>
  values.map((v, i) => ({ label: `${prefix}${String(i + 1).padStart(2, "0")}`, value: v }));

describe("reading a series", () => {
  it("measures the trend per period, not just first vs last", () => {
    // Perfectly linear: 100, 110, 120, 130, 140 → slope 10.
    const r = readSeries(pts([100, 110, 120, 130, 140]))!;
    expect(r.slopePerPeriod).toBeCloseTo(10, 10);
    expect(r.direction).toBe("rising");
    expect(r.slopePctPerPeriod).toBeCloseTo(10 / 120, 10);
    expect(r.first.value).toBe(100);
    expect(r.last.value).toBe(140);
  });

  it("calls a series flat when the movement is noise around a level", () => {
    expect(readSeries(pts([100, 101, 99, 100, 100]))!.direction).toBe("flat");
  });

  it("finds a spike the mean-and-sigma version would miss", () => {
    // The classic failure: one huge value inflates the standard deviation
    // used to judge it, so it scores under 3 sigma and hides. Median/MAD
    // does not move, so the spike stands out as it should.
    const r = readSeries(pts([100, 102, 98, 101, 99, 100, 900, 101]))!;
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0].value).toBe(900);
    expect(r.anomalies[0].direction).toBe("high");
    expect(Math.abs(r.anomalies[0].score)).toBeGreaterThan(3);
  });

  it("reports no outliers for a clean series, and refuses a tiny one", () => {
    expect(readSeries(pts([10, 11, 12, 13, 14]))!.anomalies).toEqual([]);
    expect(readSeries(pts([10, 11, 12]))).toBeNull(); // 3 points is not a series
  });
});

describe("recognising a series in a result", () => {
  it("accepts the date-ish shapes models return, and SORTS by time", () => {
    // Deliberately given out of order: a result sorted by value would make
    // every trend meaningless if the order were trusted.
    const got = seriesFrom(
      ["month", "total"],
      [
        { month: "2026-03", total: 30 },
        { month: "2026-01", total: 10 },
        { month: "2026-05", total: 50 },
        { month: "2026-02", total: 20 },
        { month: "2026-04", total: 40 },
      ],
    );
    expect(got?.map((p) => p.label)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ]);
    expect(readSeries(got!)!.direction).toBe("rising");
  });

  it("understands quarters and month-name labels", () => {
    expect(
      seriesFrom(
        ["period", "v"],
        ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4", "2027-Q1"].map((period, i) => ({
          period,
          v: i,
        })),
      ),
    ).toHaveLength(5);
    const named = seriesFrom(
      ["m", "v"],
      ["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026"].map((m, i) => ({ m, v: i })),
    );
    expect(named?.[0].label).toBe("Jan 2026");
  });

  it("returns null when there is no time column or too little history", () => {
    expect(
      seriesFrom(
        ["region", "total"],
        ["EMEA", "AMER", "APJ", "LATAM", "MEA"].map((region, i) => ({ region, total: i })),
      ),
    ).toBeNull();
    expect(seriesFrom(["month", "v"], [{ month: "2026-01", v: 1 }])).toBeNull();
  });
});

describe("projecting — and refusing to", () => {
  it("extends the fitted trend and reports its own fit error", () => {
    const f = forecastSeries(pts([10, 20, 30, 40, 50, 60, 70, 80]), 3)!;
    expect(f.points).toHaveLength(3);
    expect(f.points[0].value).toBeCloseTo(90, 6); // next in a perfect +10 line
    expect(f.points[2].value).toBeCloseTo(110, 6);
    expect(f.fitError).toBeCloseTo(0, 6); // a perfect line has no error
    expect(f.method).toBe("linear trend");
  });

  it("REFUSES with too little history rather than drawing a confident line", () => {
    // Seven points can be fitted perfectly and predict nothing. Refusing is
    // the honest answer; a caveat under a number nobody reads is not.
    expect(forecastSeries(pts([1, 2, 3, 4, 5, 6, 7]), 3)).toBeNull();
    expect(MIN_FORECAST_POINTS).toBeGreaterThan(7);
  });

  it("caps how far ahead it will go", () => {
    const f = forecastSeries(pts(Array.from({ length: 24 }, (_, i) => i)), 99)!;
    expect(f.points.length).toBeLessThanOrEqual(6);
  });

  it("states its assumptions where the write-up will read them", () => {
    const f = forecastSeries(pts([10, 20, 30, 40, 50, 60, 70, 80]))!;
    expect(f.caveat).toMatch(/assumes the recent trend simply continues/);
    expect(f.caveat).toMatch(/seasonality/);
  });
});

describe("what the write-up is told", () => {
  it("labels projections as estimates, in terms the prose must repeat", () => {
    const points = pts([10, 20, 30, 40, 50, 60, 70, 80]);
    const text = describeSeries(readSeries(points)!, forecastSeries(points)!);
    expect(text).toContain("PROJECTION (ESTIMATE, NOT MEASURED DATA)");
    expect(text).toContain("projections, not measurements");
    expect(text).toContain("SERIES: 8 periods");
  });

  it("says why there is no projection when there is not enough history", () => {
    const points = pts([10, 12, 11, 13, 12]);
    const text = describeSeries(readSeries(points)!, null);
    expect(text).toMatch(/Too few periods to project responsibly/);
    expect(text).toContain("do not extrapolate");
  });

  it("names the outliers it found", () => {
    const points = pts([100, 102, 98, 101, 99, 100, 900, 101]);
    const text = describeSeries(readSeries(points)!, null);
    expect(text).toContain("OUTLIERS");
    expect(text).toContain("900");
  });
});

describe("shapes the live run actually produced", () => {
  // Both of these came from one real analysis over saas_sales, where the
  // model's SQL used DATE_TRUNC and the driver arrived as epoch millis.
  const months = Array.from({ length: 8 }, (_, i) => ({
    month_start: Date.UTC(2026, i, 1), // 1767225600000, not "2026-01-01"
    total_sales: 1000 + i * 50,
    month_index: i + 1,
  }));

  it("reads epoch-millisecond dates as the TIME column, not the measure", () => {
    // Picking the measure first made month_start the measure — a "series"
    // of timestamps rising by one month, trending beautifully, meaning
    // nothing.
    const s = seriesFrom(["month_start", "total_sales", "month_index"], months)!;
    expect(s).toHaveLength(8);
    expect(s[0].label).toBe("2026-01-01"); // rendered, not raw millis
    expect(s.map((p) => p.value)).toEqual([1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350]);
    expect(readSeries(s)!.slopePerPeriod).toBeCloseTo(50, 6);
  });

  it("does not mistake a STRING number for a year", () => {
    // Some drivers (Snowflake among them) return numerics as strings, so
    // "13946.22" reaches the date patterns as text. Unanchored, /^\d{4}/
    // matched it as the year 1394 and a sales column became the timeline —
    // with a measure column dutifully found elsewhere and a trend drawn
    // through nonsense. The anchor is what stops it.
    expect(
      seriesFrom(
        ["total_sales", "orders"],
        [
          { total_sales: "13946.22", orders: 5 },
          { total_sales: "4810.55", orders: 6 },
          { total_sales: "55691.00", orders: 7 },
          { total_sales: "28295.34", orders: 8 },
          { total_sales: "23048.28", orders: 9 },
        ],
      ),
    ).toBeNull();
  });

  it("does not mistake a plain number for a year", () => {
    // "13946.22" starts with four digits. Unanchored, the year pattern
    // matched it and a sales column became the timeline.
    expect(
      seriesFrom(
        ["segment", "total_sales"],
        [
          { segment: "SMB", total_sales: 13946.22 },
          { segment: "Enterprise", total_sales: 4810.55 },
          { segment: "Strategic", total_sales: 55691.0 },
          { segment: "Gov", total_sales: 28295.34 },
          { segment: "Edu", total_sales: 23048.28 },
        ],
      ),
    ).toBeNull();
  });

  it("ignores big numbers that are not dates, however large", () => {
    // An id column of epoch-sized integers must not become an axis just
    // because the numbers are big — the NAME has to agree.
    expect(
      seriesFrom(
        ["order_id", "amount"],
        Array.from({ length: 6 }, (_, i) => ({ order_id: 1_700_000_000_000 + i, amount: i })),
      ),
    ).toBeNull();
  });
});
