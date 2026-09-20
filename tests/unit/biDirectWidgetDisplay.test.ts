// A direct-query widget draws a result its stored rows know nothing about.
//
// `query_mode: "direct"` re-runs the SQL at view time and renders the answer
// instead of the snapshot. What it kept from the snapshot were the two
// sentences — the title's reconciliation note and the narrative — both
// computed against rows that are not the rows on screen. The refresh-time
// restatements cannot reach it, because they rewrite the widget's STORED rows
// and those are not what a direct widget is drawing.
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import type { BiWidget } from "@/lib/biDashboards";
import { widgetForLiveResult } from "@/lib/biDashboards";

const base = (over: Partial<BiWidget> = {}): BiWidget => ({
  id: "w1",
  kind: "chart",
  title: "Top 5 Regions by Revenue — The data has 3 rows, not 5.",
  reconcile_note: "The data has 3 rows, not 5.",
  query_mode: "direct",
  source: { kind: "warehouse", connection_id: "c1" },
  sql: "SELECT r, SUM(v) AS t FROM x GROUP BY r ORDER BY t DESC LIMIT 5",
  chart: { type: "bar", xField: "r", yField: "t" },
  columns: ["r", "t"],
  rows: [{ r: "AMER", t: 3 }],
  ...over,
});

const live = (n: number) => ({
  columns: ["r", "t"],
  rows: Array.from({ length: n }, (_, i) => ({ r: `r${i}`, t: n - i })),
});

describe("the sentences on a direct widget come from the live result", () => {
  it("withdraws a note the live rows have outgrown", () => {
    // Five live bars under "The data has 3 rows, not 5." is the card
    // contradicting itself in the space of one line.
    const out = widgetForLiveResult(base(), live(5));
    expect(out.title).toBe("Top 5 Regions by Revenue");
    expect(out.reconcile_note).toBeUndefined();
  });

  it("restates the note against the live count when it is still short", () => {
    const out = widgetForLiveResult(base(), live(4));
    expect(out.title).toBe("Top 5 Regions by Revenue — The data has 4 rows, not 5.");
    expect(out.reconcile_note).toBe("The data has 4 rows, not 5.");
  });

  it("leaves the note alone when the live result agrees with it", () => {
    const out = widgetForLiveResult(base(), live(3));
    expect(out.title).toBe("Top 5 Regions by Revenue — The data has 3 rows, not 5.");
  });

  it("withdraws prose whose figures the live rows cannot support", () => {
    const w = base({
      title: "Revenue by Region",
      reconcile_note: undefined,
      narrative: "The top region generated $25.9k in revenue.",
    });
    const out = widgetForLiveResult(w, {
      columns: ["r", "t"],
      rows: [
        { r: "AMER", t: 12 },
        { r: "EMEA", t: 9 },
      ],
    });
    expect(out.narrative).toBeUndefined();
  });

  it("keeps prose the live rows still support", () => {
    const w = base({
      title: "Revenue by Region",
      reconcile_note: undefined,
      narrative: "The top region generated 12 in revenue.",
    });
    const out = widgetForLiveResult(w, {
      columns: ["r", "t"],
      rows: [
        { r: "AMER", t: 12 },
        { r: "EMEA", t: 9 },
      ],
    });
    expect(out.narrative).toBe("The top region generated 12 in revenue.");
  });

  it("carries the live result's own shape and truncation, not the snapshot's", () => {
    // Deliberately DIFFERENT column names from the stored snapshot: identical
    // ones cannot tell "took the live columns" from "kept its own", which is
    // how the first version of this test let that mutant live.
    const out = widgetForLiveResult(base({ truncated: false, columns: ["r", "t"] }), {
      columns: ["region", "total"],
      rows: Array.from({ length: 5 }, (_, i) => ({ region: `r${i}`, total: 5 - i })),
      truncated: true,
    });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(5);
    expect(out.columns).toEqual(["region", "total"]);
    // A capped live result cannot be counted against a title, so the note
    // stands and the Partial badge explains the card.
    expect(out.title).toContain("The data has 3 rows, not 5.");
  });

  it("does not mutate the stored widget", () => {
    // The display object is per-view. Writing back would persist one viewer's
    // filtered result as everybody's snapshot.
    const w = base();
    const before = JSON.stringify(w);
    widgetForLiveResult(w, live(5));
    expect(JSON.stringify(w)).toBe(before);
  });

  it("is what the dashboard actually renders for a direct widget", () => {
    const route = fs.readFileSync("src/routes/_authenticated/bi_.$dashboardId.tsx", "utf8");
    expect(route).toContain("return [w.id, widgetForLiveResult(w, live)] as const;");
    // And nothing persists it: the substitution happens in the render map.
    expect(route).not.toMatch(/persist\([^)]*widgetForLiveResult/);
  });
});
