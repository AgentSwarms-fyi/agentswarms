// Row-level security on BI dashboards, and its agreement with the dataset path.
//
// The same grants are enforced in two places: sharedDatasets.server.ts filters
// rows in JS after the query, bi.direct-query.ts pushes them into the WHERE.
// They disagreed, so the same person saw different data depending on which
// surface they opened:
//
//   grants                                dataset view     dashboard view
//   region IN (EMEA) + region IN (APAC)   EMEA + APAC      NOTHING
//   region IN (EMEA) + unfiltered         all rows         EMEA only
//
// Neither direction leaked — the dashboard was always the more restrictive —
// so this is a correctness bug, and a quiet one: an empty dashboard with no
// error looks like missing data, not like a policy that cannot be satisfied.
import { describe, expect, it } from "vitest";

import { buildDirectQuerySql } from "@/lib/biDirectQuery";

const base = {
  baseSql: "SELECT region, dept, amount FROM sales",
  columns: ["region", "dept", "amount"],
};

describe("grants are additive", () => {
  it("unions two grants on the same column instead of intersecting them", () => {
    // THE BUG. Two group grants produced `region IN ('EMEA') AND
    // region IN ('APAC')`, which no row can satisfy.
    const sql = buildDirectQuerySql({
      ...base,
      rowFilters: [
        { column: "region", values: ["EMEA"] },
        { column: "region", values: ["APAC"] },
      ],
    });
    expect(sql).toContain("OR");
    expect(sql).not.toMatch(/IN \('EMEA'\) AND "?region"? IN \('APAC'\)/);
  });

  it("unions grants on different columns too", () => {
    // Holding a region grant and a department grant admits both slices;
    // requiring both would again be less than either grant alone.
    const sql = buildDirectQuerySql({
      ...base,
      rowFilters: [
        { column: "region", values: ["EMEA"] },
        { column: "dept", values: ["Sales"] },
      ],
    });
    expect(sql).toMatch(/\(.*region.*OR.*dept.*\)/s);
  });

  it("parenthesises the union so a dashboard filter cannot bind to one branch", () => {
    // Without the parentheses, `a OR b AND c` binds as `a OR (b AND c)` and the
    // dashboard filter would apply to only half the permitted rows.
    const sql = buildDirectQuerySql({
      ...base,
      rowFilters: [
        { column: "region", values: ["EMEA"] },
        { column: "region", values: ["APAC"] },
      ],
      filters: [{ kind: "select", column: "dept", values: ["Sales"] }],
    });
    // `[^)]*` cannot work here: the group's own branches contain parentheses,
    // as in `region IN ('EMEA')`. Matching the real shape instead.
    expect(sql).toContain("WHERE (region IN ('EMEA') OR region IN ('APAC')) AND dept IN ('Sales')");
  });

  it("emits a single grant without a redundant wrapper", () => {
    const sql = buildDirectQuerySql({
      ...base,
      rowFilters: [{ column: "region", values: ["EMEA"] }],
    });
    expect(sql).toContain("IN ('EMEA')");
    expect(sql).not.toContain("OR");
  });
});

describe("fail-closed, which matters more under OR than under AND", () => {
  // Skipping a filter that cannot be enforced would now WIDEN access rather
  // than narrow it, so an unenforceable filter has to kill the whole query.
  it("returns no rows when a filter names a column the query does not produce", () => {
    const sql = buildDirectQuerySql({
      ...base,
      rowFilters: [{ column: "not_a_column", values: ["x"] }],
    });
    expect(sql).toContain("WHERE 1=0");
  });

  it("fails closed even when another grant is perfectly valid", () => {
    // The dangerous shape: one good filter and one broken one. Dropping the
    // broken one and OR-ing the rest would hand over more than intended.
    const sql = buildDirectQuerySql({
      ...base,
      rowFilters: [
        { column: "region", values: ["EMEA"] },
        { column: "not_a_column", values: ["x"] },
      ],
    });
    expect(sql).toContain("WHERE 1=0");
    expect(sql).not.toContain("EMEA");
  });

  it("fails closed on an empty value list rather than admitting everything", () => {
    expect(
      buildDirectQuerySql({ ...base, rowFilters: [{ column: "region", values: [] }] }),
    ).toContain("WHERE 1=0");
  });

  it("fails closed on a column name that is not a safe identifier", () => {
    const sql = buildDirectQuerySql({
      ...base,
      rowFilters: [{ column: "region; DROP TABLE sales--", values: ["EMEA"] }],
    });
    expect(sql).toContain("WHERE 1=0");
    expect(sql).not.toContain("DROP TABLE");
  });
});

describe("no row filters means no row restriction", () => {
  it("adds no WHERE clause when the viewer holds an unrestricted grant", () => {
    // The route passes an EMPTY list when any grant is unfiltered, so this is
    // the shape that must not invent a restriction.
    const sql = buildDirectQuerySql({ ...base, rowFilters: [] });
    expect(sql).not.toContain("WHERE");
  });

  it("is unaffected when the field is omitted entirely", () => {
    expect(buildDirectQuerySql(base)).not.toContain("WHERE");
  });
});

describe("the route decides unrestricted the same way the dataset path does", () => {
  // A source assertion: the alternative is standing up a warehouse connection
  // and a Supabase client to observe one boolean. Both files must agree that a
  // single unfiltered grant makes the others moot.
  it("treats an unfiltered grant as admitting everything", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/routes/api/bi.direct-query.ts", "utf8");
    const dataset = readFileSync("src/utils/data/sharedDatasets.server.ts", "utf8");
    for (const src of [route, dataset]) {
      expect(src).toContain("anyUnfiltered");
      expect(src).toMatch(/typeof rf\.column !== "string" \|\| !Array\.isArray\(rf\.values\)/);
    }
    expect(route).toContain("if (!anyUnfiltered)");
  });
});
