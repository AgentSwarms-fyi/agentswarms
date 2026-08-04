// A bar chart must label every bar.
//
// Reported from a generated dashboard: "Returns by Reason" drew EIGHT bars and
// printed SIX labels. Recharts defaults a category XAxis to
// interval="preserveEnd", which silently drops ticks that would overlap — so
// two bars had no label, nothing on screen said a label was missing, and the
// reader had no way to tell which bar was which.
//
// That is the failure mode worth naming: crowding is visible and self-
// correcting, a dropped label is invisible. The axis now never drops one; it
// angles, and truncates only as a last resort with the full value still in the
// tooltip.
import { describe, expect, it } from "vitest";

import { categoryAxis } from "@/components/bi/BiChartRender";

const TICK = 11;

describe("no category is ever left unlabelled", () => {
  it("always disables tick thinning", () => {
    // interval 0 is the whole fix. Every other property is presentation.
    for (const n of [2, 8, 20, 60]) {
      const labels = Array.from({ length: n }, (_, i) => `Category ${i}`);
      expect(categoryAxis(labels, TICK).interval, `${n} categories`).toBe(0);
    }
  });

  it("angles the labels when they cannot fit flat", () => {
    // The reported case: eight return reasons, longest "Not as described".
    const reasons = [
      "Changed mind",
      "Arrived too late",
      "Damaged in transit",
      "Defective",
      "Late delivery",
      "Wrong size",
      "Not as described",
      "Wrong item sent",
    ];
    const ax = categoryAxis(reasons, TICK);
    expect(ax.angle, "labels are still flat and will collide").toBe(-35);
    expect(ax.textAnchor).toBe("end");
    expect(ax.height, "angled labels with no extra height are clipped instead").toBeGreaterThan(24);
  });

  it("leaves short labels flat", () => {
    // Angling four short labels would be ugly for no reason.
    const ax = categoryAxis(["Q1", "Q2", "Q3", "Q4"], TICK);
    expect(ax.angle).toBeUndefined();
    expect(ax.height).toBeUndefined();
    expect(ax.interval).toBe(0);
  });

  it("angles when there are many categories even if each is short", () => {
    // Width per slice shrinks as the count grows; "Mon".."Sun" fits, forty
    // three-letter codes do not.
    const many = Array.from({ length: 40 }, (_, i) => `C${i}`);
    expect(categoryAxis(many, TICK).angle).toBe(-35);
  });
});

describe("truncation is a last resort, and bounded", () => {
  it("does not truncate a label that fits the budget", () => {
    expect(categoryAxis(["Damaged in transit"], TICK).tickFormatter).toBeUndefined();
  });

  it("truncates a very long label with an ellipsis", () => {
    const long = "Customer changed their mind after delivery was attempted twice";
    const f = categoryAxis([long, "Short"], TICK).tickFormatter;
    expect(f, "a 62-character label is printed in full").toBeDefined();
    const out = f!(long);
    expect(out.length).toBeLessThanOrEqual(18);
    expect(out.endsWith("…")).toBe(true);
    // The beginning is what distinguishes one label from another.
    expect(out.startsWith("Customer changed")).toBe(true);
  });

  it("leaves a short label alone even when the formatter exists", () => {
    const f = categoryAxis(["A very long category label indeed", "OK"], TICK).tickFormatter!;
    expect(f("OK")).toBe("OK");
  });

  it("survives null and undefined categories", () => {
    // A grouping key with blanks reaches the axis as null, and String(null)
    // would print "null" — but it must not throw.
    const ax = categoryAxis([null, undefined, "EMEA"], TICK);
    expect(ax.interval).toBe(0);
    expect(() => ax.tickFormatter?.(null)).not.toThrow();
  });

  it("caps the axis height so one long label cannot eat the chart", () => {
    const huge = Array.from({ length: 12 }, () => "x".repeat(200));
    const ax = categoryAxis(huge, TICK);
    expect(ax.height).toBeLessThanOrEqual(110);
  });
});

describe("an angled label is given room to overhang", () => {
  // The first angled label is anchored at its end and runs up-and-LEFT, so it
  // reaches past the plot area. With margin.left of 0 it was clipped: measured
  // 12px of "Wrong item shipped" cut off in the browser, rendering as
  // "rong item shipped" — present, wrong, and looking deliberate. Worse than
  // the missing label it replaced, because nothing suggests it is truncated.
  it("asks for left margin when it angles", () => {
    const reasons = [
      "Wrong item shipped",
      "Changed mind",
      "Better price elsewhere",
      "Damaged in transit",
      "Defective",
      "Late delivery",
      "Wrong size",
      "Not as described",
    ];
    const ax = categoryAxis(reasons, TICK);
    expect(ax.angle).toBe(-35);
    expect(ax.leftMargin, "angled labels will be clipped at the left edge").toBeGreaterThan(0);
  });

  it("asks for none when the labels stay flat", () => {
    expect(categoryAxis(["Q1", "Q2", "Q3", "Q4"], TICK).leftMargin).toBe(0);
  });

  it("does not reserve a silly amount", () => {
    const huge = Array.from({ length: 30 }, () => "x".repeat(120));
    expect(categoryAxis(huge, TICK).leftMargin).toBeLessThanOrEqual(48);
  });
});

describe("the bar charts use it and the continuous ones do not", () => {
  it("is applied to the bar and combo axes only", () => {
    // Line and area x-axes are usually a time series, where thinning ticks is
    // correct — forcing interval={0} on 365 points would be a new bug, not a
    // fix. Recorded so the next person does not "finish the job".
    const src = readSrc();
    const applied = (src.match(/\{\.\.\.(barCat|comboCat)\.axis\}/g) ?? []).length;
    expect(applied, "expected exactly the two bar-style charts").toBe(2);
    expect(src).toMatch(/\{\.\.\.barCat\.axis\}/);
    expect(src).toMatch(/\{\.\.\.comboCat\.axis\}/);
  });
});

function readSrc(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync("src/components/bi/BiChartRender.tsx", "utf8");
}
