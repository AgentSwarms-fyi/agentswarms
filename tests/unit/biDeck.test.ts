// A dashboard deck whose numbers are the dashboard's numbers.
//
// The deck is the artefact that leaves the building. It gets mailed, presented
// and quoted long after the dashboard it came from has moved on, and nobody in
// the room can check it against the source. So the two failures that matter are
// a figure that disagrees with the dashboard, and a chart that is quietly
// missing — and both are silent by construction unless something forbids them.
//
// These tests forbid them.
import { describe, expect, it } from "vitest";

import type { ChartSpec } from "@/lib/biAgent";
import type { BiWidget } from "@/lib/biDashboards";
import {
  AGENTSWARMS_ACCENT,
  MAX_CATEGORIES,
  MAX_TABLE_ROWS,
  buildDeckPlan,
  deckCandidates,
  deckChartType,
  formatCompact,
  kpiFromWidget,
  seriesFromWidget,
  tableFromWidget,
  widgetToSlide,
} from "@/lib/biDeck";

const widget = (over: Partial<BiWidget> = {}): BiWidget =>
  ({
    id: "w1",
    kind: "chart",
    title: "Revenue by region",
    chart: { type: "bar", xField: "region", yField: "revenue" } as ChartSpec,
    columns: ["region", "revenue"],
    rows: [
      { region: "EMEA", revenue: 120 },
      { region: "APAC", revenue: 80 },
      { region: "AMER", revenue: 200 },
    ],
    ...over,
  }) as BiWidget;

describe("chart types map onto what PowerPoint can actually draw", () => {
  it("maps BI's vertical bar to a COLUMN, not a bar", () => {
    // BI calls a vertical bar chart "bar"; pptx calls that a column and
    // reserves "bar" for horizontal. Getting this backwards transposes every
    // category axis in the deck — and still renders, so nothing complains.
    expect(deckChartType("bar")).toBe("column");
    expect(deckChartType("hbar")).toBe("bar");
  });

  it("maps the rest of the drawable family", () => {
    expect(deckChartType("line")).toBe("line");
    expect(deckChartType("area")).toBe("area");
    expect(deckChartType("pie")).toBe("pie");
  });

  it("refuses to pick a lookalike for what it cannot draw", () => {
    // A sankey drawn as a bar chart is a different claim about the data
    // wearing the original's title. null means "degrade to a table and say so".
    for (const t of ["sankey", "map", "barrace", "heatmap", "scatter", "boxplot", "ontology"]) {
      expect(deckChartType(t), t).toBeNull();
    }
  });
});

describe("the numbers come off the widget's own snapshot", () => {
  it("reads categories and values straight from the rows", () => {
    const data = seriesFromWidget(widget());
    expect(data).not.toBeNull();
    expect(data!.categories).toEqual(["EMEA", "APAC", "AMER"]);
    expect(data!.series[0].values).toEqual([120, 80, 200]);
  });

  it("keeps the snapshot's own order rather than re-sorting", () => {
    // The dashboard already sorted this; re-sorting here would produce a slide
    // that disagrees with the card it was exported from.
    const data = seriesFromWidget(widget());
    expect(data!.categories).toEqual(["EMEA", "APAC", "AMER"]);
    expect(data!.categories).not.toEqual([...data!.categories].sort());
  });

  it("splits into series when the spec has a seriesField", () => {
    const w = widget({
      chart: { type: "bar", xField: "q", yField: "amt", seriesField: "line" } as ChartSpec,
      rows: [
        { q: "Q1", line: "Hardware", amt: 10 },
        { q: "Q1", line: "Services", amt: 5 },
        { q: "Q2", line: "Hardware", amt: 12 },
        { q: "Q2", line: "Services", amt: 9 },
      ],
    });
    const data = seriesFromWidget(w)!;
    expect(data.categories).toEqual(["Q1", "Q2"]);
    expect(data.series.map((s) => s.name)).toEqual(["Hardware", "Services"]);
    expect(data.series[0].values).toEqual([10, 12]);
    expect(data.series[1].values).toEqual([5, 9]);
  });

  it("parses numbers that arrived as formatted strings", () => {
    const w = widget({ rows: [{ region: "EMEA", revenue: "1,250" }] });
    expect(seriesFromWidget(w)!.series[0].values).toEqual([1250]);
  });

  it("returns null rather than a chart of zeros when nothing matched", () => {
    // A bar of height zero is a CLAIM that the value is zero. If the snapshot
    // cannot be read the way the spec describes, the honest output is "this
    // widget cannot be charted", not a flat chart that looks like real data.
    const w = widget({ rows: [{ region: "EMEA", revenue: "n/a" }] });
    expect(seriesFromWidget(w)).toBeNull();
  });

  it("returns null when the declared fields are not in the data", () => {
    const w = widget({ chart: { type: "bar", xField: "nope", yField: "revenue" } as ChartSpec });
    expect(seriesFromWidget(w)).toBeNull();
  });

  it("returns null for an empty snapshot", () => {
    expect(seriesFromWidget(widget({ rows: [] }))).toBeNull();
  });
});

describe("caps are disclosed, never silent", () => {
  it("truncates a long category list and says so", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ region: `R${i}`, revenue: i + 1 }));
    const c = widgetToSlide(widget({ rows }));
    expect(c.ok).toBe(true);
    expect(c.ok && c.slide.chart!.categories).toHaveLength(MAX_CATEGORIES);
    // A slide showing 14 of 40 with no note presents a sample as the whole.
    expect(c.ok && c.note).toMatch(/first 14 of 40/i);
  });

  it("caps table rows and says so", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ a: i }));
    const w = widget({ chart: { type: "table" } as ChartSpec, columns: ["a"], rows });
    const c = widgetToSlide(w);
    expect(c.ok && c.slide.table!.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(c.ok && c.note).toMatch(/first 12 of 30/i);
  });

  it("says when a chart type was substituted for a table", () => {
    const w = widget({
      chart: { type: "sankey", xField: "a", yField: "b", valueField: "v" } as ChartSpec,
      columns: ["a", "b", "v"],
      rows: [{ a: "x", b: "y", v: 1 }],
    });
    const c = widgetToSlide(w);
    expect(c.ok).toBe(true);
    expect(c.ok && c.slide.layout).toBe("table");
    expect(c.ok && c.note).toMatch(/no sankey chart/i);
  });
});

describe("a widget that cannot become a slide says why", () => {
  it("refuses a widget with no saved data, and names the fix", () => {
    // The commonest case by far, and the one where a bare "skipped" would send
    // someone hunting through their chart config for a problem that is really
    // just an un-refreshed dashboard.
    const c = widgetToSlide(widget({ rows: [] }));
    expect(c.ok).toBe(false);
    expect(!c.ok && c.reason).toMatch(/refresh the dashboard/i);
  });

  it("refuses text and image tiles for what they are", () => {
    expect(widgetToSlide(widget({ kind: "text" })).ok).toBe(false);
    expect(widgetToSlide(widget({ kind: "image" })).ok).toBe(false);
  });

  it("refuses a widget with no chart definition", () => {
    const c = widgetToSlide(widget({ chart: undefined }));
    expect(!c.ok && c.reason).toMatch(/no chart definition/i);
  });

  it("assesses every widget, so none can go missing unremarked", () => {
    const all = deckCandidates([widget({ id: "a" }), widget({ id: "b", rows: [] })]);
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.ok)).toEqual([true, false]);
  });
});

describe("KPI and table widgets", () => {
  it("turns a KPI widget into a metric card", () => {
    const w = widget({
      chart: { type: "kpi", valueField: "total", label: "Total revenue" } as ChartSpec,
      columns: ["total"],
      rows: [{ total: 1_250_000 }],
    });
    expect(kpiFromWidget(w)).toEqual({ label: "Total revenue", value: "1.3M" });
  });

  it("builds a table from the snapshot's own columns", () => {
    const t = tableFromWidget(widget())!;
    expect(t.columns).toEqual(["region", "revenue"]);
    expect(t.rows[0]).toEqual(["EMEA", "120"]);
  });
});

describe("compact figures read like the dashboard's", () => {
  it("abbreviates the way a KPI card does", () => {
    // A figure that reads 1.2M on screen must not read 1,203,481 in the deck —
    // that invites the question of which one is right.
    expect(formatCompact(1_250_000)).toBe("1.3M");
    expect(formatCompact(2_400_000_000)).toBe("2.4B");
    expect(formatCompact(45_600)).toBe("45.6k");
    expect(formatCompact(842)).toBe("842");
    expect(formatCompact(12.345)).toBe("12.35");
  });

  it("handles negatives without losing the sign", () => {
    expect(formatCompact(-2_500_000)).toBe("-2.5M");
  });
});

describe("assembling the deck", () => {
  const candidates = () => deckCandidates([widget({ id: "a" }), widget({ id: "b" })]);

  it("carries the AgentSwarms accent", () => {
    const plan = buildDeckPlan({ dashboardName: "Q3", candidates: candidates() });
    expect(plan.accent).toBe(AGENTSWARMS_ACCENT);
  });

  it("opens with a cover and includes every chosen visual", () => {
    const plan = buildDeckPlan({ dashboardName: "Q3 Review", candidates: candidates() });
    expect(plan.slides[0].layout).toBe("cover");
    expect(plan.slides.filter((s) => s.layout === "chart")).toHaveLength(2);
  });

  it("matches takeaways to slides by widget id, not position", () => {
    // A model that returns them reversed, or omits one, must not caption a
    // chart with another chart's conclusion.
    const plan = buildDeckPlan({
      dashboardName: "Q3",
      candidates: candidates(),
      narrative: { takeaways: [{ widgetId: "b", text: "About B" }] },
    });
    const charts = plan.slides.filter((s) => s.layout === "chart");
    expect(charts[0].takeaway).toBeUndefined();
    expect(charts[1].takeaway).toBe("About B");
  });

  it("lets a disclosure note outrank the model's prose", () => {
    // Both compete for one line. A caption that omits "first 14 of 240" is a
    // slide presenting a sample as the whole, so the fact wins.
    const rows = Array.from({ length: 40 }, (_, i) => ({ region: `R${i}`, revenue: i + 1 }));
    const plan = buildDeckPlan({
      dashboardName: "Q3",
      candidates: deckCandidates([widget({ id: "a", rows })]),
      narrative: { takeaways: [{ widgetId: "a", text: "AMER leads" }] },
    });
    expect(plan.slides.find((s) => s.layout === "chart")!.takeaway).toMatch(/first 14 of 40/i);
  });

  it("builds a clean deck with no narrative at all", () => {
    // The model is optional. An outage costs captions, never the export.
    const plan = buildDeckPlan({ dashboardName: "Q3", candidates: candidates(), narrative: null });
    expect(plan.slides.length).toBeGreaterThan(1);
    expect(plan.title).toBe("Q3");
  });

  it("excludes candidates that could not become slides", () => {
    const plan = buildDeckPlan({
      dashboardName: "Q3",
      candidates: deckCandidates([widget({ id: "a" }), widget({ id: "b", rows: [] })]),
    });
    expect(plan.slides.filter((s) => s.layout === "chart")).toHaveLength(1);
  });
});
