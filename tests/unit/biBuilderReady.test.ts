// The chart builder says why "Add to dashboard" is disabled (R203).
//
// FOUND IN R203, seen first in R196: in the BI project "R196 dates", a
// query run (2 rows · 2 cols) and its columns chosen, the bar chart drawn in
// the pane, "Add to dashboard" stayed disabled with no title attribute and
// no text. The one thing missing was the widget title, whose empty box
// showed its placeholder, "Revenue by month", in grey.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { chartBlocker, metricBlocker } from "@/lib/biBuilderReady";

const ready = { ontology: false, sql: "SELECT 1", ran: true, chart: true, title: "Orders" };

describe("chartBlocker", () => {
  it("names the title when it is the one thing missing", () => {
    expect(chartBlocker({ ...ready, title: "" })).toBe("Give the widget a title.");
    expect(chartBlocker({ ...ready, title: "   " })).toBe("Give the widget a title.");
    expect(chartBlocker(ready)).toBeNull();
  });

  it("names the first thing missing, in the order the pane is filled", () => {
    const empty = { ontology: false, sql: "", ran: false, chart: false, title: "" };
    expect(chartBlocker(empty)).toBe("Write a query or pick tables, then Run it.");
    expect(chartBlocker({ ...empty, sql: "SELECT 1" })).toBe("Run the query to see its rows.");
    expect(chartBlocker({ ...empty, sql: "SELECT 1", ran: true })).toBe(
      "Choose the columns to chart.",
    );
  });

  it("asks an ontology map for no query", () => {
    const map = { ontology: true, sql: "", ran: false, chart: false, title: "Map" };
    expect(chartBlocker(map)).toBe("Build the map to add it.");
    expect(chartBlocker({ ...map, chart: true })).toBeNull();
  });
});

describe("metricBlocker", () => {
  it("walks a governed metric the same way", () => {
    const m = { model: "", metrics: 0, ran: false, title: "" };
    expect(metricBlocker(m)).toBe("Pick a metric model.");
    expect(metricBlocker({ ...m, model: "orders" })).toBe("Pick at least one metric.");
    expect(metricBlocker({ ...m, model: "orders", metrics: 1 })).toBe(
      "Press Preview to see the metric's rows.",
    );
    expect(metricBlocker({ ...m, model: "orders", metrics: 1, ran: true })).toBe(
      "Give the widget a title.",
    );
    expect(metricBlocker({ model: "orders", metrics: 1, ran: true, title: "T" })).toBeNull();
  });
});

describe("the builder pane", () => {
  const pane = readFileSync("src/components/bi/BiBuilderPane.tsx", "utf8");

  it("disables the button on the same reason it shows beneath it", () => {
    expect(pane).toMatch(/const canSubmit = blocker === null;/);
    expect(pane).toMatch(/const canSubmitMetric = metricBlocked === null;/);
    expect(pane).toMatch(/return why \? \(\s*<p[^>]*role="status"[^>]*>\s*\{why\}/);
  });

  it("writes the title's example as an example", () => {
    expect(pane).toContain('placeholder="e.g. Revenue by month"');
    expect(pane).not.toContain('placeholder="Revenue by month"');
  });
});
