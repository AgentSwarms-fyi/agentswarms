// Automatic insight sweeps. A proactive feature fails in a particular way:
// it is trusted MORE than an answer someone asked for, because nobody
// prompted it. So the failures that matter here are a finding computed from
// data that was cut off, a share of a total that nets losses against profits,
// a widget silently not examined, and — most of all — an empty result read as
// an all-clear.
import { describe, expect, it } from "vitest";

import {
  describeSweep,
  findingsByWidget,
  sweepDashboard,
  sweepWidget,
  SWEEP_THRESHOLDS,
  type SweepWidget,
} from "@/lib/insightSweep";

/** Twelve months rising ~5% per period. */
const risingSeries = (over: Partial<SweepWidget> = {}): SweepWidget => ({
  id: "w-trend",
  title: "Monthly revenue",
  kind: "chart",
  columns: ["Month", "Revenue"],
  rows: Array.from({ length: 12 }, (_, i) => ({
    Month: `2026-${String(i + 1).padStart(2, "0")}`,
    Revenue: 1000 + i * 50,
  })),
  ...over,
});

/** Flat with one enormous spike — median/MAD territory. */
const spikeSeries = (over: Partial<SweepWidget> = {}): SweepWidget => ({
  id: "w-spike",
  title: "Daily signups",
  kind: "chart",
  columns: ["Date", "Signups"],
  rows: [
    ...Array.from({ length: 9 }, (_, i) => ({
      Date: `2026-01-0${i + 1}`,
      Signups: 100 + (i % 2),
    })),
    { Date: "2026-01-10", Signups: 900 },
  ],
  ...over,
});

const concentrated = (over: Partial<SweepWidget> = {}): SweepWidget => ({
  id: "w-conc",
  title: "Revenue by region",
  kind: "chart",
  columns: ["Region", "Revenue"],
  rows: [
    { Region: "EMEA", Revenue: 800 },
    { Region: "AMER", Revenue: 100 },
    { Region: "APAC", Revenue: 60 },
    { Region: "LATAM", Revenue: 40 },
  ],
  ...over,
});

describe("what a sweep finds", () => {
  it("reports a sustained trend with its rate and span", () => {
    const { findings } = sweepWidget(risingSeries());
    const t = findings.find((f) => f.kind === "trend");
    expect(t).toBeDefined();
    expect(t!.headline).toContain("Rising");
    expect(t!.detail.periods).toBe(12);
  });

  it("reports an outlier using the median/MAD score, not a mean", () => {
    // A mean-and-sigma check misses this: the spike inflates the very sigma
    // used to judge it. That is why analystSeries uses MAD, and why the
    // sweep reuses it instead of rolling its own.
    const { findings } = sweepWidget(spikeSeries());
    const a = findings.find((f) => f.kind === "anomaly");
    expect(a).toBeDefined();
    expect(a!.detail.label).toBe("2026-01-10");
    expect(a!.detail.direction).toBe("high");
  });

  it("reports one member dominating a total", () => {
    const { findings } = sweepWidget(concentrated());
    const c = findings.find((f) => f.kind === "concentration");
    expect(c).toBeDefined();
    expect(c!.headline).toContain("EMEA");
    expect(c!.headline).toContain("80%");
  });

  it("stays quiet on a flat series rather than narrating noise", () => {
    const flat = risingSeries({
      rows: Array.from({ length: 12 }, (_, i) => ({
        Month: `2026-${String(i + 1).padStart(2, "0")}`,
        Revenue: 1000 + (i % 2),
      })),
    });
    expect(sweepWidget(flat).findings).toEqual([]);
  });

  it("counts an examined-and-clean widget as SWEPT, not skipped", () => {
    // The distinction the whole summary rests on: "we looked and found
    // nothing" and "we could not look" are different claims.
    const flat = risingSeries({
      rows: Array.from({ length: 12 }, (_, i) => ({
        Month: `2026-0${(i % 9) + 1}`,
        Revenue: 1000,
      })),
    });
    const r = sweepDashboard([flat]);
    expect(r.sweptCount).toBe(1);
    expect(r.skipped).toEqual([]);
  });
});

describe("what a sweep REFUSES to examine, and says so", () => {
  it("refuses a truncated snapshot — every finding here is an aggregate", () => {
    const r = sweepWidget(risingSeries({ truncated: true }));
    expect(r.findings).toEqual([]);
    expect(r.skip).toContain("row cap");
  });

  it("refuses concentration when values are mixed-sign", () => {
    // A share of a total that nets losses against profits can exceed 100% or
    // flip sign, and renders as a confident percentage either way.
    const profit = concentrated({
      title: "Profit by region",
      rows: [
        { Region: "EMEA", Profit: 800 },
        { Region: "AMER", Profit: -500 },
        { Region: "APAC", Profit: 60 },
        { Region: "LATAM", Profit: 40 },
      ],
      columns: ["Region", "Profit"],
    });
    expect(sweepWidget(profit).findings.filter((f) => f.kind === "concentration")).toEqual([]);
  });

  it("refuses a share when the total is zero, rather than rendering NaN%", () => {
    // 0 ÷ 0 is NaN, and `NaN < threshold` is false — so without the guard
    // this sails past the bar and prints "NaN% of Revenue" as a finding.
    const empty = concentrated({
      rows: [
        { Region: "EMEA", Revenue: 0 },
        { Region: "AMER", Revenue: 0 },
        { Region: "APAC", Revenue: 0 },
        { Region: "LATAM", Revenue: 0 },
      ],
    });
    expect(sweepWidget(empty).findings.filter((f) => f.kind === "concentration")).toEqual([]);
  });

  it("does not call two categories 'concentrated' — one is always over half", () => {
    const two = concentrated({
      rows: [
        { Region: "EMEA", Revenue: 800 },
        { Region: "AMER", Revenue: 100 },
      ],
    });
    expect(sweepWidget(two).findings.filter((f) => f.kind === "concentration")).toEqual([]);
  });

  it("skips a widget with no snapshot, naming the reason", () => {
    const r = sweepWidget({ id: "e", title: "Empty", kind: "chart", columns: ["a"], rows: [] });
    expect(r.skip).toContain("no data snapshot");
  });

  it("skips text and image widgets as not-data rather than silently", () => {
    expect(sweepWidget({ id: "t", title: "Note", kind: "text" }).skip).toBe("not a data widget");
  });

  it("needs enough history before calling anything a trend", () => {
    const short = risingSeries({
      rows: Array.from({ length: 3 }, (_, i) => ({ Month: `2026-0${i + 1}`, Revenue: 100 * i })),
    });
    expect(sweepWidget(short).findings.filter((f) => f.kind === "trend")).toEqual([]);
  });
});

describe("ranking", () => {
  it("orders by how far each finding cleared its OWN threshold", () => {
    // An outlier and a trend have no common unit. Expressing both as a
    // multiple of their own bar is what makes the order defensible.
    const r = sweepDashboard([risingSeries(), spikeSeries(), concentrated()]);
    const m = r.findings.map((f) => f.materiality);
    expect(m).toEqual([...m].sort((a, b) => b - a));
    expect(m.every((x) => x >= 1)).toBe(true);
  });

  it("puts a finding exactly on the bar at materiality 1", () => {
    const exact = concentrated({
      rows: [
        { Region: "EMEA", Revenue: 60 },
        { Region: "AMER", Revenue: 20 },
        { Region: "APAC", Revenue: 10 },
        { Region: "LATAM", Revenue: 10 },
      ],
    });
    const c = sweepWidget(exact).findings.find((f) => f.kind === "concentration");
    expect(c!.materiality).toBeCloseTo(1, 5);
  });

  it("caps how many findings are returned, strongest kept", () => {
    const many = Array.from({ length: 12 }, (_, i) => spikeSeries({ id: `s${i}` }));
    const r = sweepDashboard(many, 3);
    expect(r.findings).toHaveLength(3);
    expect(r.sweptCount).toBe(12);
  });

  it("groups findings by widget for rendering beside each card", () => {
    const g = findingsByWidget(sweepDashboard([spikeSeries(), concentrated()]));
    expect(g.get("w-conc")).toHaveLength(1);
  });

  it("ignores malformed widgets entirely — not swept AND not reported as skipped", () => {
    // A widget with no id cannot be linked to a finding or a skip reason, so
    // it belongs in neither tally. Counting one as swept would inflate the
    // coverage number the summary reports.
    const r = sweepDashboard([null as unknown as SweepWidget, { title: "x" } as SweepWidget]);
    expect(r.sweptCount).toBe(0);
    expect(r.skipped).toEqual([]);
    expect(r.findings).toEqual([]);
  });
});

describe("the summary, which is where a proactive feature lies", () => {
  it("NEVER reads as an all-clear when it found nothing", () => {
    // "No insights" is taken as reassurance. What is actually known is
    // narrower, and the difference is the whole point of the feature.
    const msg = describeSweep({
      findings: [],
      sweptCount: 5,
      skipped: [],
      thresholds: SWEEP_THRESHOLDS,
    });
    expect(msg).not.toMatch(/all clear|no issues|nothing wrong|everything looks/i);
    expect(msg).toContain("not the same as nothing being wrong");
  });

  it("states the thresholds it applied, so 'nothing found' means something", () => {
    const msg = describeSweep({
      findings: [],
      sweptCount: 5,
      skipped: [],
      thresholds: SWEEP_THRESHOLDS,
    });
    expect(msg).toContain("2% per period");
    expect(msg).toContain("3 MAD");
    expect(msg).toContain("60%");
  });

  it("discloses how many widgets it could NOT sweep", () => {
    // Coverage silently short of 100% is how "we checked everything" becomes
    // untrue without anyone editing a sentence.
    const msg = describeSweep({
      findings: [],
      sweptCount: 2,
      skipped: [{ widgetId: "a", widgetTitle: "A", reason: "the snapshot hit its row cap" }],
      thresholds: SWEEP_THRESHOLDS,
    });
    expect(msg).toContain("2 widgets");
    expect(msg).toContain("1 could not be swept");
  });

  it("counts findings when there are some", () => {
    const r = sweepDashboard([spikeSeries()]);
    expect(describeSweep(r)).toMatch(/found \d+ thing/);
  });

  it("says 1 widget, not 1 widgets", () => {
    expect(
      describeSweep({ findings: [], sweptCount: 1, skipped: [], thresholds: SWEEP_THRESHOLDS }),
    ).toContain("1 widget.");
  });
});
