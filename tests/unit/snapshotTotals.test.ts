// Correct SQL, wrong number.
//
// The NL-to-SQL eval grades the QUERY: it runs the SQL and compares rows. A
// dashboard does not show query rows — it shows a chart drawn from a stored
// SNAPSHOT, capped at the widget row cap, with duplicate categories summed in the
// BROWSER by aggregateByField.
//
// Put those together and a widget over a table larger than the cap displays
// the sum of an arbitrary prefix as if it were the total. No error, no empty
// state, a perfectly normal-looking bar chart that is simply wrong — and the
// eval cannot see it, because the eval never goes through this path.
//
// That gap is why "80% on the eval" and "the dashboard shows the right number"
// are different claims, and it widens exactly as datasets get bigger.
//
// Everything here drives the REAL functions: snapshotRows, aggregateByField,
// aggregationPlan.
import { describe, expect, it } from "vitest";

import { aggregateByField } from "@/components/bi/BiChartRender";
import { aggregationPlan, isAggregatableChart, renderAggregateClauses } from "@/lib/biAggregate";
import { WIDGET_ROW_CAP_DEFAULT, snapshotRows, widgetRowCap } from "@/lib/biDashboards";

/** Raw rows as a warehouse would return them: one per transaction. */
function salesRows(n: number): Record<string, unknown>[] {
  const regions = ["AMER", "EMEA", "APAC", "LATAM"];
  return Array.from({ length: n }, (_, i) => ({
    region: regions[i % regions.length],
    amount: 10,
  }));
}

describe("a capped snapshot turns a correct query into a wrong total", () => {
  const ALL = salesRows(5_000);
  const trueTotal = ALL.length * 10;

  it("caps the snapshot at the documented row count", () => {
    // The cap is configurable now (VITE_BI_SNAPSHOT_ROWS_CAP); unset, it is
    // the documented default, which is what this scenario is written against.
    expect(widgetRowCap()).toBe(WIDGET_ROW_CAP_DEFAULT);
    expect(snapshotRows(ALL)).toHaveLength(WIDGET_ROW_CAP_DEFAULT);
    expect(WIDGET_ROW_CAP_DEFAULT).toBe(500);
  });

  it("sums the WHOLE table correctly when nothing is dropped", () => {
    // The control. Without the cap the browser-side aggregation is right, so
    // the failure below is the cap and not the arithmetic.
    const full = aggregateByField(ALL, "region", ["amount"]);
    const summed = full.reduce((s, r) => s + Number(r.amount), 0);
    expect(summed).toBe(trueTotal);
  });

  it("reports a tenth of the real total from the snapshot, with no error", () => {
    // THE BUG, stated as an assertion. 5,000 rows of 10 is 50,000; the chart
    // draws 5,000 and looks entirely normal doing it.
    const charted = aggregateByField(snapshotRows(ALL), "region", ["amount"]);
    const shown = charted.reduce((s, r) => s + Number(r.amount), 0);

    expect(shown).toBe(WIDGET_ROW_CAP_DEFAULT * 10);
    expect(shown).toBeLessThan(trueTotal);
    expect(shown / trueTotal).toBeCloseTo(0.1, 6);

    // And it is not detectable from the chart's own shape: the same four
    // regions, all present, all plausible.
    expect(charted).toHaveLength(4);
    expect(charted.every((r) => Number(r.amount) > 0)).toBe(true);
  });

  it("gets worse as the table grows, which is the wrong direction", () => {
    const ratio = (n: number) => {
      const rows = salesRows(n);
      const shown = aggregateByField(snapshotRows(rows), "region", ["amount"]).reduce(
        (s, r) => s + Number(r.amount),
        0,
      );
      return shown / (n * 10);
    };
    expect(ratio(1_000)).toBeCloseTo(0.5, 6);
    expect(ratio(10_000)).toBeCloseTo(0.05, 6);
    expect(ratio(100_000)).toBeCloseTo(0.005, 6);
  });

  it("is invisible below the cap, which is why it survives testing", () => {
    // Every small dataset — every demo, every sample, every screenshot — is
    // correct. The bug only appears on data big enough to matter.
    const small = salesRows(400);
    const shown = aggregateByField(snapshotRows(small), "region", ["amount"]).reduce(
      (s, r) => s + Number(r.amount),
      0,
    );
    expect(shown).toBe(400 * 10);
  });
});

describe("aggregating in SQL is the fix, and it applies to the charts that need it", () => {
  it("builds a GROUP BY plan for a categorical chart", () => {
    // With one row per category returned, the cap stops mattering: four
    // regions fit in 500 rows however large the table is.
    //
    // NOTE the signature — the second argument is { preserve }, NOT the result
    // columns. A first version of this test passed an array of columns there,
    // which silently became an options object with no `preserve` key, so the
    // plan was built regardless and the test "proved" a validation that lives
    // one stage later, in renderAggregateClauses.
    const plan = aggregationPlan({ type: "bar", xField: "region", yField: "amount" } as never);
    expect(plan, "no plan means the widget silently keeps summing raw rows").not.toBeNull();
    expect(plan!.dims).toEqual(["region"]);
    expect(plan!.measures).toHaveLength(1);
    expect(plan!.measures[0].field).toBe("amount");
    expect(plan!.measures[0].agg).toBe("sum");
  });

  it("recognises the chart types where the cap can corrupt a total", () => {
    for (const type of ["bar", "hbar", "line", "area", "pie"]) {
      expect(
        isAggregatableChart({ type, xField: "region", yField: "amount" } as never),
        `${type} should be aggregatable`,
      ).toBe(true);
    }
  });

  it("emits SQL only when every field is a real result column", () => {
    // Field names come from a stored spec a model may have authored, so an
    // unknown one must abandon the WHOLE plan rather than be interpolated —
    // a partial GROUP BY changes the grain and quietly alters the numbers.
    const plan = aggregationPlan({ type: "bar", xField: "region", yField: "amount" } as never)!;

    const good = renderAggregateClauses(plan, ["region", "amount"], "duckdb");
    expect(good, "a valid plan produced no SQL").not.toBeNull();
    expect(good!.select).toMatch(/SUM\(/i);
    expect(good!.groupBy).toMatch(/region/i);

    // Measure column absent.
    expect(renderAggregateClauses(plan, ["region"], "duckdb")).toBeNull();
    // Dimension column absent.
    expect(renderAggregateClauses(plan, ["amount"], "duckdb")).toBeNull();
  });

  it("refuses a field name that is not a safe identifier", () => {
    const evil = aggregationPlan({
      type: "bar",
      xField: "region; DROP TABLE sales--",
      yField: "amount",
    } as never)!;
    expect(
      renderAggregateClauses(evil, ["region; DROP TABLE sales--", "amount"], "duckdb"),
      "an unsafe identifier reached the SQL",
    ).toBeNull();
  });
});

describe("the widget says so when it is showing a partial total", () => {
  const card = readFile("src/components/bi/BiWidgetCard.tsx");

  it("badges a truncated widget that is not aggregating in SQL", () => {
    // The only signal a viewer gets. Its absence would make the wrong number
    // completely undetectable from the dashboard.
    expect(card).toContain("truncated && !widget.agg_pushdown");
    expect(card).toContain("Partial");
  });

  it("explains that the totals are partial, not just that rows were capped", () => {
    // "Truncated" reads like a display limit. The number being wrong is the
    // point, and the badge's tooltip has to say it.
    expect(card).toMatch(/totals are computed from part of the table|not all of it/i);
  });

  it("does not badge a widget that IS aggregating in SQL", () => {
    // Pushdown returns one row per category, so hitting the cap there means
    // 500+ categories — a different problem, and not a wrong total.
    expect(card).toMatch(/!widget\.agg_pushdown/);
  });
});

function readFile(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(p, "utf8");
}
