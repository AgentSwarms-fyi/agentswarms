// Period KPIs, computed narratives and styled table cells (R498).
//
// Every dashboard in the demo gallery we compared against leads with a KPI
// that says how this period did against the last, and with sentences like
// "Revenue for Nov 2026 increased by 44%". These pin the arithmetic behind
// both — which period is "latest", which one it is compared with, and that a
// missing comparison is said rather than replaced — plus the narrative kinds,
// the author's {{token}} sentence, the table cell rules (text matches, whole
// rows, safe pictures and links) and the generator's choice of shape.
import { describe, expect, it } from "vitest";

import type { ChartSpec } from "@/lib/biAgent";
import { reconcileChartFields } from "@/lib/biChartFields";
import { condRuleMatchesValue, firstMatchingRule } from "@/lib/biChartMath";
import { insightBullets, kpiFromWidget } from "@/lib/biDeck";
import type { BiWidget } from "@/lib/biDashboards";
import { parseCompare, parseInsightKind, shapeGeneratedChart } from "@/lib/biGeneratedShape";
import { computeInsight, humanizeField, pluralize, renderTemplate } from "@/lib/biInsights";
import {
  comparePeriods,
  comparisonLabel,
  dateLikeColumns,
  inferGrain,
  kpiHeadlineValue,
  parsePeriodValue,
  periodSeries,
  prettyPeriod,
} from "@/lib/biPeriods";
import { safeImageSrc, safeLinkHref } from "@/lib/safeUrl";

const monthly = (values: number[], start = 2026 * 12) =>
  values.map((v, i) => {
    const t = start + i;
    return { month: `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`, revenue: v };
  });

const f = { value: (n: number) => String(Math.round(n * 100) / 100), locale: "en-US" };
const text = (parts: { text: string }[]) => parts.map((p) => p.text).join("");

describe("periods", () => {
  it("reads the grain the rows are already at", () => {
    const d = (s: string) => new Date(s);
    expect(inferGrain([d("2026-01-01"), d("2026-01-02"), d("2026-01-03")])).toBe("day");
    expect(inferGrain([d("2026-01-01"), d("2026-02-01"), d("2026-03-01")])).toBe("month");
    expect(inferGrain([d("2026-01-01"), d("2026-04-01"), d("2026-07-01")])).toBe("quarter");
    expect(inferGrain([d("2024-01-01"), d("2025-01-01")])).toBe("year");
  });

  it("keeps one row per period as it is — a rate is not summed", () => {
    const rows = [
      { m: "2026-01", rate: 12.5 },
      { m: "2026-02", rate: 13.5 },
    ];
    expect(periodSeries(rows, "m", "rate").points).toEqual([
      { label: "2026-01", value: 12.5 },
      { label: "2026-02", value: 13.5 },
    ]);
  });

  it("adds daily rows up into an explicit grain, oldest first", () => {
    const rows = [
      { d: "2026-02-03", v: 5 },
      { d: "2026-01-10", v: 1 },
      { d: "2026-01-20", v: 2 },
      { d: "bad", v: 9 },
      { d: "2026-02-04", v: null },
    ];
    const s = periodSeries(rows, "d", "v", "month");
    expect(s.points).toEqual([
      { label: "2026-01", value: 3 },
      { label: "2026-02", value: 5 },
    ]);
    expect(s.dropped).toBe(2);
  });

  it("reads quarter and ISO-week labels SQL returns", () => {
    expect(parsePeriodValue("2026-Q3")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parsePeriodValue("2026-W01")?.toISOString()).toBe("2025-12-29T00:00:00.000Z");
    const s = periodSeries(
      [
        { q: "2026-Q1", v: 1 },
        { q: "2026-Q2", v: 2 },
      ],
      "q",
      "v",
    );
    expect(s.grain).toBe("quarter");
    expect(s.points.map((p) => p.label)).toEqual(["2026-Q1", "2026-Q2"]);
  });

  it("compares the latest period with the one before, and with a year before", () => {
    const rows = monthly([100, 80, 90, 120, 110, 100, 95, 105, 115, 125, 130, 150, 160]);
    const s = periodSeries(rows, "month", "revenue");
    const prev = comparePeriods(s, "previous")!;
    expect(prev.current).toEqual({ label: "2027-01", value: 160 });
    expect(prev.previous).toEqual({ label: "2026-12", value: 150 });
    expect(prev.change).toBe(10);
    expect(prev.changePct).toBeCloseTo(10 / 150);
    const yoy = comparePeriods(s, "year")!;
    expect(yoy.previous).toEqual({ label: "2026-01", value: 100 });
    expect(yoy.changePct).toBeCloseTo(0.6);
  });

  it("says a missing comparison period is missing instead of using an older one", () => {
    const s = periodSeries(
      [
        { month: "2026-08", revenue: 50 },
        { month: "2026-11", revenue: 70 },
      ],
      "month",
      "revenue",
      "month",
    );
    const c = comparePeriods(s, "previous")!;
    expect(c.previous).toBeUndefined();
    expect(c.previousLabel).toBe("2026-10");
  });

  it("finds the same period a year back for every label shape", () => {
    expect(comparisonLabel("2026-07", "month", "year")).toBe("2025-07");
    expect(comparisonLabel("2026-Q3", "quarter", "year")).toBe("2025-Q3");
    expect(comparisonLabel("2028-02-29", "day", "year")).toBe("2027-02-28");
    expect(comparisonLabel("2026-01", "month", "previous")).toBe("2025-12");
  });

  it("prints periods for people", () => {
    expect(prettyPeriod("2026-11", "en-US")).toBe("Nov 2026");
    expect(prettyPeriod("2026-Q3", "en-US")).toBe("Q3 2026");
    expect(prettyPeriod("2026-W05", "en-US")).toBe("Week 5, 2026");
    expect(prettyPeriod("2026-11-05", "en-US")).toBe("Nov 5, 2026");
  });

  it("gives the digest the number the card shows", () => {
    const rows = monthly([5, 7, 9]);
    expect(kpiHeadlineValue({ valueField: "revenue", dateField: "month" }, rows)).toBe(9);
    expect(kpiHeadlineValue({ valueField: "revenue" }, rows)).toBe(5);
  });

  it("does not take a column of money for dates", () => {
    const rows = [
      {
        at: "2026-01-01 00:00:00",
        m: "2026-02",
        q: "2026-Q1",
        revenue: 13946,
        stamp: 1767225600000,
      },
      {
        at: "2026-01-02 00:00:00",
        m: "2026-03",
        q: "2026-Q2",
        revenue: 2026,
        stamp: 1767312000000,
      },
    ];
    expect(dateLikeColumns(Object.keys(rows[0]), rows)).toEqual(["at", "m", "q", "stamp"]);
  });
});

describe("narratives", () => {
  const regions = [
    { region: "EMEA", revenue: 50 },
    { region: "AMER", revenue: 30 },
    { region: "APAC", revenue: 15 },
    { region: "LATAM", revenue: 5 },
    { region: "EMEA", revenue: 10 },
  ];

  it("ranks the top members, with their shares, and says how many there were", () => {
    const r = computeInsight(
      { kind: "top", valueField: "revenue", categoryField: "region", topN: 2 },
      regions,
      f,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(text(r.lead)).toBe("The top 2 regions by revenue (of 4) are:");
    expect(r.items!.map(text)).toEqual(["EMEA 60 (54.5%)", "AMER 30 (27.3%)"]);
    expect(r.tokens.first).toBe("EMEA");
  });

  it("ranks from the bottom and drops shares when values net against each other", () => {
    const r = computeInsight(
      { kind: "bottom", valueField: "profit", categoryField: "region", topN: 1 },
      [
        { region: "A", profit: -5 },
        { region: "B", profit: 20 },
      ],
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(text(r.lead)).toBe("The bottom 1 region by profit (of 2) is:");
    expect(r.items!.map(text)).toEqual(["A -5"]);
  });

  it("states the change from the period before, coloured by whether it is good news", () => {
    const r = computeInsight(
      { kind: "change", valueField: "revenue", dateField: "month" },
      monthly([80, 100]),
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(text(r.lead)).toBe("Revenue for Feb 2026 increased by 25.0% (+20) from 80 to 100.");
    expect(r.lead.find((p) => p.text === "25.0%")?.tone).toBe("good");
    const cost = computeInsight(
      {
        kind: "change",
        valueField: "revenue",
        dateField: "month",
        lowerIsBetter: true,
        label: "Cost",
      },
      monthly([80, 100]),
      f,
    );
    if (!cost.ok) throw new Error(cost.reason);
    expect(cost.lead.find((p) => p.text === "25.0%")?.tone).toBe("bad");
  });

  it("does not compare with a period that is not there", () => {
    const r = computeInsight(
      { kind: "change", valueField: "revenue", dateField: "month", dateGrain: "month" },
      [
        { month: "2026-01", revenue: 1 },
        { month: "2026-05", revenue: 2 },
      ],
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(text(r.lead)).toBe(
      "Revenue for May 2026 was 2. There is no Apr 2026 to compare it with.",
    );
  });

  it("refuses a forecast on too little history, and labels one it makes", () => {
    const short = computeInsight(
      { kind: "forecast", valueField: "revenue", dateField: "month" },
      monthly([1, 2, 3]),
      f,
    );
    expect(short).toEqual({
      ok: false,
      reason: "A forecast needs at least 8 periods; this has 3.",
    });
    const r = computeInsight(
      { kind: "forecast", valueField: "revenue", dateField: "month" },
      monthly([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.tokens.next_period).toBe("Nov 2026");
    expect(Number(r.tokens.forecast)).toBeCloseTo(110, 0);
    expect(text(r.lead)).toMatch(
      /^Revenue is forecast to be 110 for Nov 2026 \(likely .+ to .+, by linear trend\)\.$/,
    );
  });

  it("names the most recent anomaly, and says plainly when there is none", () => {
    const flat = computeInsight(
      { kind: "anomaly", valueField: "revenue", dateField: "month" },
      monthly([10, 11, 10, 12, 11, 10, 11]),
      f,
    );
    if (!flat.ok) throw new Error(flat.reason);
    expect(text(flat.lead)).toMatch(/^No month stands out: none of the 7 is 3 or more deviations/);
    const spike = computeInsight(
      { kind: "anomaly", valueField: "revenue", dateField: "month" },
      monthly([10, 11, 10, 12, 11, 90, 11, 10]),
      f,
    );
    if (!spike.ok) throw new Error(spike.reason);
    expect(spike.tokens.period).toBe("Jun 2026");
    expect(spike.tokens.direction).toBe("higher");
  });

  it("compounds a growth rate over the periods asked for", () => {
    const r = computeInsight(
      { kind: "growth", valueField: "revenue", dateField: "month", periods: 2 },
      monthly([100, 110, 121]),
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.tokens.rate).toBe("10.0%");
    expect(text(r.lead)).toBe(
      "The 2-month compounded growth rate for revenue is 10.0% per month, from 100 in Jan 2026 to 121 in Mar 2026.",
    );
    const neg = computeInsight(
      { kind: "growth", valueField: "revenue", dateField: "month" },
      monthly([-1, 5]),
      f,
    );
    expect(neg.ok).toBe(false);
  });

  it("lists the biggest movers between the latest two periods", () => {
    const rows = [
      { month: "2026-01", sku: "A", units: 10 },
      { month: "2026-02", sku: "A", units: 30 },
      { month: "2026-01", sku: "B", units: 50 },
      { month: "2026-02", sku: "B", units: 45 },
      { month: "2026-02", sku: "C", units: 4 },
    ];
    const r = computeInsight(
      { kind: "movers", valueField: "units", categoryField: "sku", dateField: "month", topN: 3 },
      rows,
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(text(r.lead)).toBe("Biggest changes in units, Feb 2026 against Jan 2026:");
    expect(r.items!.map(text)).toEqual([
      "A ▲ +200% (+20), to 30",
      "B ▼ −10.0% (−5), to 45",
      "C ▲ new, +4, to 4",
    ]);
  });

  it("fills an author's sentence from the data and leaves an unknown token visible", () => {
    const r = computeInsight(
      {
        kind: "change",
        valueField: "revenue",
        dateField: "month",
        template: "{{measure}} moved {{change_pct}} in {{period}} ({{nope}})",
      },
      monthly([80, 100]),
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(text(r.lead)).toBe("Revenue moved 25.0% in Feb 2026 ({{nope}})");
    expect(renderTemplate("{{ n }} of {{n}}", { n: "3" }).map((p) => p.text)).toEqual([
      "3",
      " of ",
      "3",
    ]);
  });

  it("says a column the query no longer returns is missing instead of ranking nothing", () => {
    // FOUND IN R498's UI test: the narrative kept ranking by `country` after
    // the query dropped it, and printed "(blank) $2.3M (100%)" as a finding.
    const r = computeInsight(
      { kind: "top", valueField: "sales", categoryField: "country" },
      [{ region: "EMEA", sales: 1 }],
      f,
    );
    expect(r).toEqual({
      ok: false,
      reason: "This query returns no country column — pick one it returns.",
    });
    const d = computeInsight(
      { kind: "change", valueField: "sales", dateField: "month" },
      [{ region: "EMEA", sales: 1 }],
      f,
    );
    expect(d.ok).toBe(false);
  });

  it("prints a change the way the KPI tile beside it does", () => {
    // FOUND IN R498's UI test: "▼ 19.5%" on the tile, "decreased by 19%" in
    // the sentence next to it.
    const r = computeInsight(
      { kind: "change", valueField: "v", dateField: "month" },
      [
        { month: "2026-01", v: 112.33 },
        { month: "2026-02", v: 90.47 },
      ],
      f,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.tokens.change_pct).toBe("19.5%");
  });

  it("names things like a person would", () => {
    expect(humanizeField("total_revenue")).toBe("Total revenue");
    expect(humanizeField("customerName")).toBe("Customer name");
    expect(pluralize("country")).toBe("countries");
    expect(pluralize("class")).toBe("classes");
    expect(pluralize("region")).toBe("regions");
  });
});

describe("table cells", () => {
  it("matches text rules ignoring case, and numeric rules on numbers only", () => {
    expect(
      condRuleMatchesValue("NEGATIVE", { op: "is", value: 0, text: "negative", color: "rose" }),
    ).toBe(true);
    expect(
      condRuleMatchesValue("very negative", {
        op: "is",
        value: 0,
        text: "negative",
        color: "rose",
      }),
    ).toBe(false);
    expect(
      condRuleMatchesValue("very negative", {
        op: "contains",
        value: 0,
        text: "NEG",
        color: "rose",
      }),
    ).toBe(true);
    expect(condRuleMatchesValue("12", { op: "gt", value: 10, color: "emerald" })).toBe(true);
    expect(condRuleMatchesValue("DNF", { op: "gt", value: 10, color: "emerald" })).toBe(false);
    expect(condRuleMatchesValue(5, { op: "is", value: 0, text: "", color: "rose" })).toBe(false);
  });

  it("takes the first rule that matches, in order", () => {
    const cf = {
      mode: "rules" as const,
      rules: [
        { op: "eq" as const, value: 1, color: "amber" },
        { op: "lte" as const, value: 3, color: "slate" },
      ],
    };
    expect(firstMatchingRule(1, cf)?.color).toBe("amber");
    expect(firstMatchingRule(3, cf)?.color).toBe("slate");
    expect(firstMatchingRule(4, cf)).toBeUndefined();
  });

  it("draws pictures and links only from absolute http(s) addresses", () => {
    expect(safeImageSrc("https://example.com/p.png")).toBe("https://example.com/p.png");
    expect(safeImageSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(safeImageSrc("javascript:alert(1)")).toBe("");
    expect(safeImageSrc("/api/secret")).toBe("");
    expect(safeImageSrc(42)).toBe("");
    expect(safeLinkHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeLinkHref("java\nscript:alert(1)")).toBe("");
    expect(safeLinkHref("//evil.example/x")).toBe("");
  });
});

describe("generated widgets", () => {
  const series = monthly([10, 12, 15]);

  it("makes a period KPI when one was planned and the rows are a series", () => {
    const shaped = shapeGeneratedChart(
      { chartType: "kpi", compare: "previous", title: "Monthly revenue" },
      ["month", "revenue"],
      series,
      { type: "line", xField: "month", yField: "revenue", format: "currency" },
    );
    expect(shaped).toEqual({
      type: "kpi",
      valueField: "revenue",
      label: "Monthly revenue",
      dateField: "month",
      compareTo: undefined,
      sparkline: true,
      format: "currency",
    });
  });

  it("leaves a single total as it is", () => {
    const kpi: ChartSpec = { type: "kpi", valueField: "revenue" };
    expect(
      shapeGeneratedChart(
        { chartType: "kpi", compare: "year" },
        ["revenue"],
        [{ revenue: 5 }],
        kpi,
      ),
    ).toBe(kpi);
  });

  it("chooses a narrative's kind from the columns when none was named", () => {
    expect(
      shapeGeneratedChart({ chartType: "insight" }, ["month", "revenue"], series, undefined),
    ).toMatchObject({
      type: "insight",
      kind: "change",
      dateField: "month",
    });
    expect(
      shapeGeneratedChart(
        { chartType: "insight" },
        ["region", "revenue"],
        [{ region: "EU", revenue: 1 }],
        undefined,
      ),
    ).toMatchObject({ type: "insight", kind: "top", categoryField: "region" });
    // A planned movers narrative with no category to move cannot be drawn.
    const bar: ChartSpec = { type: "bar", xField: "month", yField: "revenue" };
    expect(
      shapeGeneratedChart(
        { chartType: "insight", insightKind: "movers" },
        ["month", "revenue"],
        series,
        bar,
      ),
    ).toBe(bar);
  });

  it("reads the planner's words for compare and kind", () => {
    expect(parseCompare("YoY")).toBe("year");
    expect(parseCompare("prior_period")).toBe("previous");
    expect(parseCompare("weekly")).toBeUndefined();
    expect(parseInsightKind("Forecast")).toBe("forecast");
    expect(parseInsightKind("top10")).toBeUndefined();
  });

  it("drops a KPI's date column the query did not return instead of refusing to draw", () => {
    const v = reconcileChartFields({
      chart: { type: "kpi", valueField: "revenue", dateField: "month" },
      columns: ["revenue"],
      rows: [{ revenue: 1 }],
    });
    expect(v.verdict).toBe("repaired");
    if (v.verdict === "repaired") expect(v.chart).toEqual({ type: "kpi", valueField: "revenue" });
  });
});

describe("deck export", () => {
  const widget = (chart: ChartSpec, rows: Record<string, unknown>[]): BiWidget => ({
    id: "w",
    kind: "chart",
    title: "Revenue",
    chart,
    rows,
    columns: Object.keys(rows[0] ?? {}),
  });

  it("puts a period KPI's latest value and change on the slide", () => {
    const kpi = kpiFromWidget(
      widget({ type: "kpi", valueField: "revenue", dateField: "month" }, monthly([200, 150])),
    );
    expect(kpi).toEqual({
      label: "Revenue · Feb 2026",
      value: "150",
      delta: "−25.0% vs Jan 2026",
      positive: false,
    });
  });

  it("turns a narrative into bullets", () => {
    expect(
      insightBullets(
        widget(
          { type: "insight", kind: "top", valueField: "revenue", categoryField: "region", topN: 1 },
          [
            { region: "EU", revenue: 3 },
            { region: "US", revenue: 1 },
          ],
        ),
      ),
    ).toEqual(["The top 1 region by revenue (of 2) is:", "EU 3 (75.0%)"]);
  });
});

describe("table totals", () => {
  it("does not add up rates and percentages", async () => {
    const { isPreAggregated } = await import("@/lib/biColumnKinds");
    // FOUND IN R498's UI test: a margin column's Total read 32.1 — three
    // regions' margins summed. These columns get no total.
    expect(isPreAggregated("margin")).toBe(true);
    expect(isPreAggregated("avg_order_value")).toBe(true);
    expect(isPreAggregated("sales")).toBe(false);
    const fs = await import("node:fs");
    const card = fs.readFileSync("src/components/bi/BiWidgetCard.tsx", "utf8");
    expect(card).toContain(
      'if (isPreAggregated(c) || columnFormats?.[c]?.format === "percent") continue;',
    );
  });
});
