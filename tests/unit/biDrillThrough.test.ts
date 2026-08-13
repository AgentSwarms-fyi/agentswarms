// Drill-through query building. The behaviour under test is mostly about
// what the query REFUSES to do, because the failure mode being fixed here was
// not an error — it was a plausible number. `SELECT * FROM t LIMIT 1000` then
// filtering in the browser returns rows, renders a table and prints a count,
// and every part of that is wrong when the table is bigger than the cap.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildDrillThroughSql,
  DRILL_THROUGH_ROW_CAP,
  explorePredicates,
  numericColumnsFrom,
  readCount,
  renderPredicate,
  unaggregateSql,
  unresolvablePredicates,
  type DrillPredicate,
} from "@/lib/biDrillThrough";

const drill = (column: string, value: string): DrillPredicate => ({
  column,
  value,
  origin: "drill",
});

describe("stripping a widget's aggregation", () => {
  it("keeps the row source and the widget's own filter, drops the aggregate tail", () => {
    expect(
      unaggregateSql(
        `SELECT region, SUM(sales) AS total FROM saas_sales
         WHERE fiscal_year = 2026 GROUP BY region ORDER BY total DESC LIMIT 10`,
      ),
    ).toBe("SELECT * FROM saas_sales\n         WHERE fiscal_year = 2026");
  });

  it("KEEPS joins and their aliases", () => {
    // The old code guessed the base table with a regex and rebuilt the query
    // around it. Any alias in the WHERE (`s.year`) then referred to nothing,
    // and a joined dimension disappeared entirely.
    const got = unaggregateSql(
      `SELECT r.name, SUM(s.amount) FROM sales s
       JOIN dim_region r ON r.id = s.region_id
       WHERE s.year = 2026 GROUP BY r.name`,
    );
    expect(got).toContain("FROM sales s");
    expect(got).toContain("JOIN dim_region r ON r.id = s.region_id");
    expect(got).toContain("WHERE s.year = 2026");
    expect(got).not.toContain("GROUP BY");
    expect(got).not.toContain("SUM(");
  });

  it("keeps a leading CTE, because the FROM refers to it", () => {
    const got = unaggregateSql(
      `WITH recent AS (SELECT * FROM orders WHERE d > '2026-01-01')
       SELECT region, COUNT(*) FROM recent GROUP BY region`,
    );
    expect(got).toMatch(/^WITH recent AS \(SELECT \* FROM orders WHERE d > '2026-01-01'\)/);
    expect(got).toContain("SELECT * FROM recent");
    expect(got).not.toContain("COUNT(*)");
  });

  it("keeps a subquery row source whole", () => {
    const got = unaggregateSql(
      `SELECT a, SUM(b) FROM (SELECT a, b FROM t WHERE x > 1 GROUP BY a, b) q GROUP BY a`,
    );
    // The INNER group-by belongs to the row source and must survive; only the
    // outer one is aggregation over it.
    expect(got).toBe("SELECT * FROM (SELECT a, b FROM t WHERE x > 1 GROUP BY a, b) q");
  });

  it("is not fooled by keywords inside literals, comments or quoted names", () => {
    expect(unaggregateSql(`SELECT a, SUM(b) FROM t WHERE note = 'group by hand' GROUP BY a`)).toBe(
      "SELECT * FROM t WHERE note = 'group by hand'",
    );
    // The comment survives into the body — it is not a clause, so there is
    // nothing to cut at. What matters is that `order by` inside it did not end
    // the WHERE. (What the WRAPPER does with that trailing comment is pinned
    // separately below; it is the more dangerous half.)
    expect(unaggregateSql(`SELECT a FROM t WHERE x = 1 -- order by whatever\n`)).toBe(
      "SELECT * FROM t WHERE x = 1 -- order by whatever",
    );
    expect(unaggregateSql(`SELECT "group", SUM(b) FROM t WHERE "order" = 2 GROUP BY "group"`)).toBe(
      `SELECT * FROM t WHERE "order" = 2`,
    );
  });

  it("does not read FROM inside a function call as the row source", () => {
    // EXTRACT(YEAR FROM d) — the first FROM in the text is not the query's.
    expect(unaggregateSql(`SELECT EXTRACT(YEAR FROM d) AS y, SUM(x) FROM t GROUP BY 1`)).toBe(
      "SELECT * FROM t",
    );
  });

  it("REFUSES a set operation — there is no single row grain to descend into", () => {
    expect(
      unaggregateSql(
        `SELECT a, SUM(b) FROM t GROUP BY a UNION ALL SELECT a, SUM(b) FROM u GROUP BY a`,
      ),
    ).toBeNull();
  });

  it("refuses what it cannot read rather than emitting a guess", () => {
    expect(unaggregateSql("SELECT 1")).toBeNull();
    expect(unaggregateSql("")).toBeNull();
    expect(unaggregateSql("   ")).toBeNull();
  });
});

describe("writing predicates", () => {
  it("escapes a value that would otherwise close the string", () => {
    expect(renderPredicate(drill("region", "O'Brien"), false)).toBe("region = 'O''Brien'");
    expect(renderPredicate(drill("region", "x' OR '1'='1"), false)).toBe(
      "region = 'x'' OR ''1''=''1'",
    );
  });

  it("writes a bare number for a numeric column, because not every engine coerces", () => {
    // BigQuery rejects `year = '2026'` against an INT64 outright.
    expect(renderPredicate(drill("year", "2026"), true)).toBe("year = 2026");
    expect(renderPredicate(drill("year", "2026"), false)).toBe("year = '2026'");
  });

  it("quotes a non-numeric value even on a numeric column", () => {
    expect(renderPredicate(drill("year", "unknown"), true)).toBe("year = 'unknown'");
    expect(renderPredicate(drill("year", ""), true)).toBe("year = ''");
  });

  it("refuses a column name that is not a plain identifier", () => {
    expect(renderPredicate(drill("region; DROP TABLE t", "x"), false)).toBeNull();
    expect(renderPredicate(drill("", "x"), false)).toBeNull();
  });
});

describe("deciding which columns are numeric", () => {
  it("reads the widget's own snapshot", () => {
    expect(
      numericColumnsFrom([
        { region: "EMEA", year: 2026, total: 10 },
        { region: "AMER", year: 2025, total: 20 },
      ]).sort(),
    ).toEqual(["total", "year"]);
  });

  it("treats a mixed column as text — quoting is the safe reading", () => {
    expect(numericColumnsFrom([{ code: 100 }, { code: "N/A" }])).toEqual([]);
  });

  it("ignores nulls and blanks rather than letting them decide", () => {
    expect(numericColumnsFrom([{ n: null }, { n: 5 }, { n: "" }])).toEqual(["n"]);
  });
});

describe("predicates the base rows cannot satisfy", () => {
  it("names a category computed in the select list", () => {
    // `DATE_TRUNC('month', d) AS month` exists in the widget's output and
    // nowhere in the rows underneath it.
    expect(
      unresolvablePredicates([drill("month", "2026-01")], ["order_id", "d", "amount"]),
    ).toHaveLength(1);
  });

  it("matches case-insensitively, since warehouses fold case differently", () => {
    expect(unresolvablePredicates([drill("Region", "EMEA")], ["REGION", "amount"])).toEqual([]);
  });
});

describe("the built query", () => {
  const widget = `SELECT region, SUM(sales) AS total FROM saas_sales WHERE fy = 2026 GROUP BY region`;

  it("CAPS AFTER FILTERING — the whole point", () => {
    // The bug: LIMIT 1000 first, narrow second, so "37 rows" meant "37 EMEA
    // rows inside an arbitrary 1,000-row slice", printed as a fact.
    const plan = buildDrillThroughSql({
      widgetSql: widget,
      predicates: [drill("region", "EMEA")],
      cap: 1000,
    })!;
    expect(plan.rows).toBe(
      "SELECT * FROM (SELECT * FROM saas_sales WHERE fy = 2026\n) AS _dt WHERE region = 'EMEA' LIMIT 1000",
    );
    expect(plan.rows.indexOf("WHERE region")).toBeLessThan(plan.rows.indexOf("LIMIT"));
  });

  it("a trailing line comment cannot comment out the wrapper", () => {
    // `--` runs to end of LINE. Inlined, it would swallow the closing paren
    // and every predicate after it: at best a syntax error, at worst a query
    // that runs unfiltered and is presented as one bar's rows.
    const plan = buildDrillThroughSql({
      widgetSql: "SELECT a, SUM(b) FROM t WHERE x = 1 -- keep only x\n GROUP BY a",
      predicates: [drill("a", "EMEA")],
    })!;
    const afterComment = plan.rows.slice(plan.rows.indexOf("-- keep only x"));
    expect(afterComment).toMatch(/^-- keep only x\n/);
    expect(plan.rows).toContain("WHERE a = 'EMEA'");
    expect(plan.count).toContain("\n) AS _dt");
  });

  it("carries the widget's own filter into the drill-through", () => {
    const plan = buildDrillThroughSql({ widgetSql: widget, predicates: [] })!;
    expect(plan.rows).toContain("WHERE fy = 2026");
    expect(plan.mode).toBe("raw");
  });

  it("counts the matches over the SAME predicates", () => {
    const plan = buildDrillThroughSql({
      widgetSql: widget,
      predicates: [drill("region", "EMEA")],
    })!;
    expect(plan.count).toBe(
      "SELECT COUNT(*) AS _n FROM (SELECT * FROM saas_sales WHERE fy = 2026\n) AS _dt WHERE region = 'EMEA'",
    );
    expect(plan.count).not.toContain("LIMIT");
  });

  it("ANDs several drill levels in order", () => {
    const plan = buildDrillThroughSql({
      widgetSql: widget,
      predicates: [drill("region", "EMEA"), drill("segment", "SMB")],
    })!;
    expect(plan.rows).toContain("WHERE region = 'EMEA' AND segment = 'SMB'");
    expect(plan.applied).toHaveLength(2);
  });

  it("falls back to the widget's OWN rows when the SQL cannot be stripped, and says so", () => {
    const plan = buildDrillThroughSql({
      widgetSql: `SELECT a, SUM(b) FROM t GROUP BY a UNION ALL SELECT a, SUM(b) FROM u GROUP BY a`,
      predicates: [drill("a", "x")],
    })!;
    // Narrowed correctly, but these are aggregate rows — the caller must not
    // present them as the rows underneath.
    expect(plan.mode).toBe("aggregated");
    expect(plan.rows).toContain("UNION ALL");
    expect(plan.rows).toContain("WHERE a = 'x'");
  });

  it("reports which predicates it actually applied", () => {
    const plan = buildDrillThroughSql({
      widgetSql: widget,
      predicates: [drill("region", "EMEA"), drill("bad name; --", "x")],
    })!;
    expect(plan.applied.map((p) => p.column)).toEqual(["region"]);
    expect(plan.rows).not.toContain("bad name");
  });

  it("uses the snapshot's types for quoting", () => {
    const plan = buildDrillThroughSql({
      widgetSql: widget,
      predicates: [drill("fy", "2026")],
      numericColumns: numericColumnsFrom([{ fy: 2026, total: 1 }]),
    })!;
    expect(plan.rows).toContain("fy = 2026");
    expect(plan.rows).not.toContain("fy = '2026'");
  });

  it("defaults the cap and refuses an empty query", () => {
    expect(buildDrillThroughSql({ widgetSql: widget, predicates: [] })!.rows).toContain(
      `LIMIT ${DRILL_THROUGH_ROW_CAP}`,
    );
    expect(buildDrillThroughSql({ widgetSql: "  ", predicates: [] })).toBeNull();
  });
});

describe("what narrows the drill-through", () => {
  const cross = { widgetId: "w1", column: "segment", value: "SMB" };

  it("carries the drill path — the part that never used to arrive", () => {
    // The dialog could only ever see the dashboard cross-filter, so drilling
    // two levels in and asking for the rows behind it answered for the TOP
    // level and said nothing about the difference.
    expect(
      explorePredicates(
        [
          { field: "region", value: "EMEA" },
          { field: "country", value: "France" },
        ],
        null,
      ),
    ).toEqual([
      { column: "region", value: "EMEA", origin: "drill" },
      { column: "country", value: "France", origin: "drill" },
    ]);
  });

  it("adds the cross-filter after the drill levels", () => {
    const got = explorePredicates([{ field: "region", value: "EMEA" }], cross);
    expect(got.map((p) => p.origin)).toEqual(["drill", "crossfilter"]);
    expect(got[1].column).toBe("segment");
  });

  it("lets the drill win over a cross-filter on the same column", () => {
    // Two different values for one column would read as a contradiction in
    // the disclosure line, and the drill is the more specific statement.
    const got = explorePredicates([{ field: "Segment", value: "Enterprise" }], cross);
    expect(got).toHaveLength(1);
    expect(got[0].value).toBe("Enterprise");
  });

  it("handles an empty drill and no cross-filter", () => {
    expect(explorePredicates([], null)).toEqual([]);
  });
});

describe("the dashboard actually wires it up", () => {
  // No render harness in this suite (vitest runs in node), so the plumbing is
  // asserted against the source. Without these, the whole feature can be
  // disconnected one prop at a time and every unit test still passes.
  const page = readFileSync("src/routes/_authenticated/bi_.$dashboardId.tsx", "utf8");
  const card = readFileSync("src/components/bi/BiWidgetCard.tsx", "utf8");
  const render = readFileSync("src/components/bi/BiChartRender.tsx", "utf8");

  it("passes each widget's drill path to the explore dialog", () => {
    expect(page).toMatch(/drillPath=\{exploreWidget \? \(drillPaths\[exploreWidget\.id\]/);
  });

  it("records the drill position reported by each widget", () => {
    expect(page).toMatch(/onDrillChange=\{\(path\)/);
    expect(page).toContain("setDrillPaths");
  });

  it("reports the drill path out of the chart, through the card", () => {
    expect(render).toMatch(/drillCb\.current\?\.\(drillPath\)/);
    expect(card).toContain("onDrillChange={onDrillChange}");
  });
});

describe("reading the count back", () => {
  it("accepts the string a warehouse returns as readily as a number", () => {
    expect(readCount([{ _n: 48213 }])).toBe(48213);
    expect(readCount([{ _N: "48213" }])).toBe(48213); // Snowflake folds and stringifies
  });

  it("returns null rather than 0 when there is nothing to read", () => {
    expect(readCount([])).toBeNull();
    expect(readCount([{ _n: "not a number" }])).toBeNull();
  });
});
