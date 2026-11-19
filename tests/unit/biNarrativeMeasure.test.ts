// R512: a ranked narrative knows what its measure is.
//
// "Top" and "bottom" added the measure up per item. For a running total that
// counts every earlier round again: the Grand Prix points race (each driver's
// points so far, round by round) ranked drivers by the sum of twenty running
// totals. An average was summed the same way.
import { describe, expect, it } from "vitest";
import { isRunningTotal } from "@/lib/biColumnKinds";
import { computeInsight, type InsightSpec } from "@/lib/biInsights";
import { insightOptsFrom, insightSpec, INSIGHT_OPTS_DEFAULT } from "@/lib/biKpiInsightOpts";

const fmt = { value: (n: number) => String(Math.round(n * 100) / 100) };

// Points so far after each of three rounds. Added up, B leads (84 to 75);
// after the last round, A does (40 to 36).
const race = (measure: string) =>
  [
    ["A", 10],
    ["B", 18],
    ["A", 25],
    ["B", 30],
    ["A", 40],
    ["B", 36],
  ].map(([driver, v], i) => ({ round: Math.floor(i / 2) + 1, driver, [measure]: v }));

const text = (spec: InsightSpec, rows: Record<string, unknown>[]) => {
  const r = computeInsight(spec, rows, fmt);
  if (!r.ok) throw new Error(r.reason);
  return {
    lines: [r.lead, ...(r.items ?? [])].map((p) => p.map((x) => x.text).join("")),
    tokens: r.tokens,
  };
};

describe("a running total", () => {
  it("ranks each item by its latest value when its name says so", () => {
    const { lines, tokens } = text(
      { kind: "top", valueField: "cumulative_points", categoryField: "driver", topN: 2 },
      race("cumulative_points"),
    );
    expect(lines[1]).toMatch(/^A 40/);
    expect(lines[2]).toMatch(/^B 36/);
    expect(tokens.total).toBe("76");
  });

  it("does so when the author says so, whatever the column is called", () => {
    const spec: InsightSpec = {
      kind: "top",
      valueField: "total_points",
      categoryField: "driver",
      topN: 2,
    };
    // Unmarked, it is added up, as it always was.
    expect(text(spec, race("total_points")).lines[1]).toMatch(/^B 84/);
    expect(text({ ...spec, measureIs: "running" }, race("total_points")).lines[1]).toMatch(/^A 40/);
  });

  it("is recognised by name", () => {
    for (const n of ["running_total", "cumulative_points", "ytd_sales", "Sales YTD", "cum_rides"]) {
      expect(isRunningTotal(n), n).toBe(true);
    }
    for (const n of ["total_points", "document_count", "cumin_sales", "sales"]) {
      expect(isRunningTotal(n), n).toBe(false);
    }
  });
});

describe("an average", () => {
  const rows = [
    { dept: "Eng", avg_salary: 100 },
    { dept: "Eng", avg_salary: 120 },
    { dept: "Ops", avg_salary: 90 },
  ];

  it("is averaged, never summed, and has no share of a total", () => {
    const { lines, tokens } = text(
      { kind: "top", valueField: "avg_salary", categoryField: "dept", topN: 2 },
      rows,
    );
    expect(lines[1]).toBe("Eng 110");
    expect(lines[2]).toBe("Ops 90");
    expect(tokens.total).toBe("100");
    expect(lines.join(" ")).not.toMatch(/%/);
  });
});

describe("an ordinary measure", () => {
  it("is still added up, with each item's share", () => {
    const { lines } = text({ kind: "top", valueField: "sales", categoryField: "region" }, [
      { region: "EMEA", sales: 30 },
      { region: "EMEA", sales: 30 },
      { region: "APJ", sales: 40 },
    ]);
    expect(lines[1]).toBe("EMEA 60 (60.0%)");
  });
});

describe("the builder", () => {
  it("keeps the setting on a top or bottom narrative, and drops it elsewhere", () => {
    const top = insightSpec("total_points", "", {
      ...INSIGHT_OPTS_DEFAULT,
      kind: "top",
      categoryField: "driver",
      measureIs: "running",
    });
    expect(top?.measureIs).toBe("running");
    expect(insightOptsFrom(top!).measureIs).toBe("running");
    const change = insightSpec("total_points", "", {
      ...INSIGHT_OPTS_DEFAULT,
      kind: "change",
      dateField: "round",
      measureIs: "running",
    });
    expect(change?.measureIs).toBeUndefined();
    const auto = insightSpec("total_points", "", {
      ...INSIGHT_OPTS_DEFAULT,
      kind: "top",
      categoryField: "driver",
    });
    expect(auto?.measureIs).toBeUndefined();
  });
});
