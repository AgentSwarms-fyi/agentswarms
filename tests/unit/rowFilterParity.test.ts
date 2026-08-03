// One row filter, three code paths, two different answers.
//
// A grant on a SQL table or a BI dashboard can carry a row filter — a column
// and the values the grantee is allowed to see. It is applied in three places:
//
//   1. biDirectQuery.buildDirectQuerySql  — live "direct" widget queries
//   2. biDashboards.applyRowFilters       — stored widget snapshots (the DEFAULT
//                                           render mode, and the only one public
//                                           embeds and share links ever use)
//   3. sharedDatasets.restrictSharedDataset — dataset rows read with the service
//                                           role, e.g. by the sql_query tool
//
// They disagreed about the case that matters most: a result that does not carry
// the filter column at all. (1) and (3) treated it as unenforceable and returned
// nothing. (2) let every row through, with this reasoning:
//
//   "A filter only constrains rows that actually carry its column — widgets that
//    never select the column are left intact"
//
// which reads as reasonable and is exactly backwards. The typical dashboard
// widget aggregates the filter column away — `SELECT product, sum(revenue) FROM
// sales GROUP BY product` has no `region` in its output — so a grantee
// restricted to EMEA received the GLOBAL total. The filter silently applied to
// none of the widgets it most needed to apply to, on the path public embeds use.
//
// Measured before fixing: applyRowFilters kept 2 of 2 non-EMEA rows.
import { describe, expect, it } from "vitest";

import { applyRowFilters, mergeGrantRowFilters } from "@/lib/biDashboards";
import { buildDirectQuerySql } from "@/lib/biDirectQuery";
import { restrictSharedDataset, type MaskableRow } from "@/utils/data/sharedDatasets.server";

const EMEA = [{ row_filter: { column: "region", values: ["EMEA"] }, column_mask: null }];

/** Rows as a widget that grouped `region` away would produce them. */
const NO_COLUMN: MaskableRow[] = [
  { product: "A", revenue: 100 },
  { product: "B", revenue: 200 },
];

const WITH_COLUMN: MaskableRow[] = [
  { product: "A", region: "EMEA", revenue: 100 },
  { product: "B", region: "APAC", revenue: 200 },
];

describe("a filter that cannot be enforced admits nothing", () => {
  it("drops rows that do not carry the filter column", () => {
    const filters = mergeGrantRowFilters(EMEA as never);
    expect(filters, "the grant did not survive merging").toHaveLength(1);
    expect(
      applyRowFilters(NO_COLUMN, filters),
      "a restricted grantee received rows the filter could not vet",
    ).toEqual([]);
  });

  it("still admits the rows it can vet", () => {
    // Fail-closed must not mean fail-always: the filter has to keep working.
    const kept = applyRowFilters(WITH_COLUMN, mergeGrantRowFilters(EMEA as never));
    expect(kept).toEqual([{ product: "A", region: "EMEA", revenue: 100 }]);
  });

  it("treats a null in the filter column as unvettable too", () => {
    const kept = applyRowFilters(
      [{ product: "A", region: null, revenue: 100 }],
      mergeGrantRowFilters(EMEA as never),
    );
    expect(kept).toEqual([]);
  });

  it("leaves an unrestricted viewer alone", () => {
    // mergeGrantRowFilters returns null for the owner, and for anyone holding
    // one grant that carries no filter. Null must mean "everything".
    expect(applyRowFilters(NO_COLUMN, null)).toEqual(NO_COLUMN);
    expect(mergeGrantRowFilters([{ row_filter: null }])).toBeNull();
  });

  it("unions across grants rather than intersecting", () => {
    // Two teams each granting one region must add up, not cancel out.
    const both = mergeGrantRowFilters([
      { row_filter: { column: "region", values: ["EMEA"] } as never },
      { row_filter: { column: "region", values: ["APAC"] } as never },
    ]);
    expect(applyRowFilters(WITH_COLUMN, both)).toHaveLength(2);
  });
});

describe("the live path agrees with the snapshot path", () => {
  const sql = (columns: string[]) =>
    buildDirectQuerySql({
      baseSql: "SELECT product, sum(revenue) AS revenue FROM sales GROUP BY product",
      columns,
      rowFilters: [{ column: "region", values: ["EMEA"] }],
    });

  it("returns nothing when the filter column is absent from the result", () => {
    expect(sql(["product", "revenue"])).toContain("WHERE 1=0");
  });

  it("filters normally when it is present", () => {
    const out = sql(["product", "region", "revenue"]);
    expect(out).not.toContain("1=0");
    expect(out).toMatch(/region.* IN \('EMEA'\)/);
  });
});

describe("the dataset path agrees too", () => {
  // The REAL restrictSharedDataset, with only its two table reads stubbed —
  // the access logic under test is production's, not a copy of it.
  const sbWith = (grants: unknown[]) =>
    ({
      from(table: string) {
        const rows =
          table === "iam_group_members"
            ? [{ group_id: "g1" }]
            : (grants as Record<string, unknown>[]);
        const chain = {
          select: () => chain,
          eq: () => chain,
          then: (res: (v: { data: unknown }) => unknown) => Promise.resolve(res({ data: rows })),
        };
        return chain;
      },
    }) as never;

  const COLS = [
    { name: "product", type: "string" as const },
    { name: "revenue", type: "number" as const },
  ];

  it("drops rows that do not carry the filter column", async () => {
    const out = await restrictSharedDataset(
      sbWith([{ principal_type: "user", principal_id: "u1", ...EMEA[0] }]),
      "t1",
      "u1",
      COLS,
      NO_COLUMN,
    );
    expect(out.rows, "the service-role reader ignored the filter").toEqual([]);
  });

  it("returns nothing at all when no grant applies", async () => {
    const out = await restrictSharedDataset(sbWith([]), "t1", "u1", COLS, WITH_COLUMN);
    expect(out.rows).toEqual([]);
    expect(out.columns).toEqual([]);
  });
});

describe("the three paths share one predicate", () => {
  // The reason they drifted is that each had its own copy. Two of the three
  // now call the same exported function; the SQL builder cannot (it emits a
  // WHERE clause rather than testing rows) so it is covered by the tests above.
  it("the dataset path does not re-implement the row test", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/data/sharedDatasets.server.ts", "utf8");
    expect(src, "a fourth copy of the predicate").not.toMatch(
      /rows\.filter\(\(r\) => filters\.some/,
    );
    expect(src).toContain("applyRowFilters");
    expect(src).toContain("mergeGrantRowFilters");
  });
});
