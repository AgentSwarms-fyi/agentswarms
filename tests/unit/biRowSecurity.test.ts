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

import { readFileSync } from "node:fs";

import { buildDirectQuerySql } from "@/lib/biDirectQuery";
import { applyColumnMask, mergeGrantRowFilters } from "@/lib/biDashboards";

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
  // This used to assert that both files contained the same `anyUnfiltered`
  // block — which is how you pin a copy in place rather than remove it. There
  // were four copies of this rule; the BI snapshot's disagreed with the other
  // three and fed unfiltered rows to restricted grantees for as long as it
  // existed. They now call one function, so the rule can be tested once and
  // the files only have to be checked for NOT having grown a copy back.
  it("treats an unfiltered grant as admitting everything", async () => {
    expect(mergeGrantRowFilters([{ row_filter: null }])).toBeNull();
    expect(
      mergeGrantRowFilters([
        { row_filter: { column: "region", values: ["EMEA"] } as never },
        { row_filter: null },
      ]),
      "a narrower grant survived alongside an unrestricted one",
    ).toBeNull();
  });

  it("does not read a corrupt filter as an absent one", async () => {
    // Widening on malformed data is the wrong direction to fail. An empty
    // values list is the unsatisfiable filter both consumers reject.
    for (const bad of [
      { column: "", values: ["EMEA"] },
      { column: "region", values: [] },
      { column: "region" }, // values missing entirely
      "not-an-object", // and a row_filter that is not a filter at all
    ]) {
      const merged = mergeGrantRowFilters([{ row_filter: bad as never }]);
      expect(merged, "a malformed filter was read as unrestricted").not.toBeNull();
      expect(merged![0].values).toEqual([]);
    }
  });

  it("keeps the merge in one place", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "src/routes/api/bi.direct-query.ts",
      "src/utils/data/sharedDatasets.server.ts",
      "src/utils/bi.functions.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} grew its own copy of the merge`).not.toContain("anyUnfiltered");
      expect(src).toContain("mergeGrantRowFilters");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Column masks, and the filter parameter that saw straight through them.
//
// A grant can hide columns from a grantee ("column_mask"). The mask was applied
// to the RESULT. `filters` arrive in the request body and went into the WHERE.
// So a grantee whose grant hides `salary` sent
//
//   filters: [{ kind: "numrange", column: "salary", min: 100000 }]
//
// the server issued `WHERE salary >= 100000`, stripped `salary` from the rows,
// and returned them. The value never appeared in the payload and came back out
// anyway: each request answers one yes/no question about it, and bisection does
// the rest — about 32 requests per row against a 120/min limit.
// ─────────────────────────────────────────────────────────────────────────────
describe("a column mask has to cover the filter parameter too", () => {
  const src = readFileSync("src/routes/api/bi.direct-query.ts", "utf8");

  it("filters the request's filters against the mask before building SQL", () => {
    expect(src).toContain("const usableFilters");
    expect(src).toContain('maskSet.has(String(f?.column ?? "").toLowerCase())');
  });

  it("passes the filtered list to the query builder, not the raw body", () => {
    expect(src).toContain("filters: usableFilters,");
    expect(src, "raw body filters reach buildDirectQuerySql again").not.toMatch(
      /filters: body\.filters/,
    );
  });

  it("keeps masked columns out of the aggregation plan as well", () => {
    // preserve[] decides which columns survive a GROUP BY pushdown; a masked
    // column preserved there is the same leak by another route.
    expect(src).toContain("preserve: usableFilters.map((f) => f.column)");
    expect(src).not.toMatch(/preserve: \(body\.filters/);
  });

  it("tells the caller a filter was dropped instead of ignoring it quietly", () => {
    // A filter that silently does nothing is the other way to be wrong: the
    // viewer reads the numbers as filtered when they are not.
    expect(src).toContain("dropped_filters");
  });

  it("drops rather than rejects, so one viewer's mask cannot break the dashboard", () => {
    // A dashboard's own global filter may name a column masked for a single
    // viewer; 400-ing there would break their whole dashboard over someone
    // else's configuration.
    expect(src).not.toMatch(/masked column[\s\S]{0,120}return json\(400/);
  });
});

describe("the mask itself still works on the result", () => {
  it("removes the column and its values from every row", () => {
    const out = applyColumnMask(
      ["name", "dept", "salary"],
      [
        { name: "A", dept: "Eng", salary: 150000 },
        { name: "B", dept: "Ops", salary: 90000 },
      ],
      ["salary"],
    );
    expect(out.columns).toEqual(["name", "dept"]);
    expect(JSON.stringify(out.rows)).not.toContain("150000");
    expect(out.rows.every((r) => !("salary" in r))).toBe(true);
  });

  it("matches case-insensitively on BOTH sides", () => {
    // The mask is stored as the admin typed it; the warehouse decides the case
    // it hands back. Both directions have to be covered — a first version only
    // capitalised the COLUMN, which is lowercased on both sides regardless, so
    // removing the normalisation from the MASK side changed nothing and the
    // mutation survived. The mask-capitalised case is the one that leaks.
    for (const [cols, rows, mask] of [
      [["Salary"], [{ Salary: 1 }], ["salary"]],
      [["salary"], [{ salary: 1 }], ["Salary"]],
      [["SALARY"], [{ SALARY: 1 }], ["sAlArY"]],
    ] as [string[], Record<string, unknown>[], string[]][]) {
      const out = applyColumnMask(cols, rows, mask);
      expect(out.columns, `${cols[0]} vs ${mask[0]}`).toEqual([]);
      expect(out.rows, `${cols[0]} vs ${mask[0]}`).toEqual([{}]);
    }
  });

  it("leaves everything alone when the mask is empty", () => {
    const rows = [{ a: 1 }];
    const out = applyColumnMask(["a"], rows, []);
    expect(out.rows).toBe(rows);
  });
});
