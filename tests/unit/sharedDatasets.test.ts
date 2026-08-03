// Access control for shared datasets, read with the SERVICE ROLE.
//
// The database enforces this for a user's own JWT via shared_dataset_rows().
// Server-side paths — the agents' sql_query tool, BI refresh, prep — read with
// the service role, which switches RLS OFF. restrictSharedDataset is then the
// ONLY thing standing between a grantee and the owner's full table.
//
// It had no tests. An access-control regression here is silent by construction:
// nothing fails, someone just sees a column or a row they were not granted, and
// the first evidence is an incident rather than a red build.
//
// The rules being pinned, from the module's own contract:
//   - column masks INTERSECT — a column is hidden only when EVERY applicable
//     grant hides it, so a second grant cannot reduce access below the first
//   - row filters UNION — any allowing grant admits the row, and one
//     unfiltered grant admits all
//   - anything unexpected FAILS CLOSED

import { describe, expect, it } from "vitest";

import {
  restrictSharedDataset,
  type MaskableColumn,
  type MaskableRow,
} from "@/utils/data/sharedDatasets.server";

type Grant = {
  principal_type: "user" | "group";
  principal_id: string;
  row_filter: { column: string; values: unknown[] } | null;
  column_mask: string[] | null;
};

/**
 * A Supabase stand-in shaped like the calls the module makes:
 *   from("iam_group_members").select(...).eq(...)
 *   from("iam_resource_grants").select(...).eq(...).eq(...)
 * Each link is chainable AND awaitable, because the real builder is.
 */
function fakeDb(opts: {
  groups?: string[];
  grants?: Grant[];
  throwOn?: "iam_group_members" | "iam_resource_grants";
}) {
  return {
    from(table: string) {
      if (opts.throwOn === table) {
        throw new Error("simulated lookup failure");
      }
      const data =
        table === "iam_group_members"
          ? (opts.groups ?? []).map((g) => ({ group_id: g }))
          : (opts.grants ?? []);
      const result = { data, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const columns: MaskableColumn[] = [
  { name: "region", type: "string" },
  { name: "salary", type: "number" },
  { name: "name", type: "string" },
];

const rows: MaskableRow[] = [
  { region: "west", salary: 100, name: "A" },
  { region: "east", salary: 200, name: "B" },
  { region: "north", salary: 300, name: "C" },
];

const VIEWER = "viewer-1";
const run = (db: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  restrictSharedDataset(db as any, "table-1", VIEWER, columns, rows);

describe("restrictSharedDataset — failing closed", () => {
  it("returns NOTHING when the viewer holds no grant", async () => {
    const out = await run(fakeDb({ grants: [] }));
    expect(out).toEqual({ columns: [], rows: [] });
  });

  it("returns NOTHING when the grants lookup fails", async () => {
    // An access decision must never default to "allow" because a query broke.
    const out = await run(fakeDb({ throwOn: "iam_resource_grants" }));
    expect(out).toEqual({ columns: [], rows: [] });
  });

  it("returns NOTHING when the membership lookup fails", async () => {
    const out = await run(fakeDb({ throwOn: "iam_group_members" }));
    expect(out).toEqual({ columns: [], rows: [] });
  });

  it("ignores a grant belonging to a DIFFERENT user", async () => {
    // The cross-tenant case. A grant on this dataset to somebody else must not
    // admit this viewer.
    const out = await run(
      fakeDb({
        grants: [
          {
            principal_type: "user",
            principal_id: "someone-else",
            row_filter: null,
            column_mask: null,
          },
        ],
      }),
    );
    expect(out).toEqual({ columns: [], rows: [] });
  });

  it("ignores a group grant when the viewer is not in that group", async () => {
    const out = await run(
      fakeDb({
        groups: ["group-a"],
        grants: [
          { principal_type: "group", principal_id: "group-b", row_filter: null, column_mask: null },
        ],
      }),
    );
    expect(out).toEqual({ columns: [], rows: [] });
  });
});

describe("restrictSharedDataset — grants that do apply", () => {
  it("an unfiltered, unmasked user grant returns everything", async () => {
    const out = await run(
      fakeDb({
        grants: [
          { principal_type: "user", principal_id: VIEWER, row_filter: null, column_mask: null },
        ],
      }),
    );
    expect(out.columns).toEqual(columns);
    expect(out.rows).toEqual(rows);
  });

  it("a group grant applies when the viewer is a member", async () => {
    const out = await run(
      fakeDb({
        groups: ["group-a"],
        grants: [
          { principal_type: "group", principal_id: "group-a", row_filter: null, column_mask: null },
        ],
      }),
    );
    expect(out.rows).toHaveLength(3);
  });
});

describe("restrictSharedDataset — column masks", () => {
  it("removes a masked column from the schema AND from every row", async () => {
    // Dropping it from `columns` alone would still ship the values in `rows` —
    // the mask would be cosmetic and the data would leak to any consumer that
    // reads rows directly.
    const out = await run(
      fakeDb({
        grants: [
          {
            principal_type: "user",
            principal_id: VIEWER,
            row_filter: null,
            column_mask: ["salary"],
          },
        ],
      }),
    );
    expect(out.columns.map((c) => c.name)).toEqual(["region", "name"]);
    for (const r of out.rows) {
      expect(Object.keys(r)).not.toContain("salary");
      expect(r.salary).toBeUndefined();
    }
  });

  it("matches a mask case-insensitively", async () => {
    const out = await run(
      fakeDb({
        grants: [
          {
            principal_type: "user",
            principal_id: VIEWER,
            row_filter: null,
            column_mask: ["SALARY"],
          },
        ],
      }),
    );
    expect(out.columns.map((c) => c.name)).not.toContain("salary");
  });

  it("INTERSECTS masks — a column is hidden only when EVERY grant hides it", async () => {
    // A second grant must never reduce access below the first. Here one grant
    // hides salary and name, the other hides only salary, so only salary goes.
    const out = await run(
      fakeDb({
        grants: [
          {
            principal_type: "user",
            principal_id: VIEWER,
            row_filter: null,
            column_mask: ["salary", "name"],
          },
          {
            principal_type: "user",
            principal_id: VIEWER,
            row_filter: null,
            column_mask: ["salary"],
          },
        ],
      }),
    );
    expect(out.columns.map((c) => c.name)).toEqual(["region", "name"]);
  });
});

describe("restrictSharedDataset — row filters", () => {
  const filtered = (values: unknown[]) => ({
    principal_type: "user" as const,
    principal_id: VIEWER,
    row_filter: { column: "region", values },
    column_mask: null,
  });

  it("keeps only rows the filter admits", async () => {
    const out = await run(fakeDb({ grants: [filtered(["west"])] }));
    expect(out.rows.map((r) => r.region)).toEqual(["west"]);
  });

  it("UNIONS filters across grants", async () => {
    const out = await run(fakeDb({ grants: [filtered(["west"]), filtered(["east"])] }));
    expect(out.rows.map((r) => r.region).sort()).toEqual(["east", "west"]);
  });

  it("one UNFILTERED grant admits every row", async () => {
    const out = await run(
      fakeDb({
        grants: [
          filtered(["west"]),
          { principal_type: "user", principal_id: VIEWER, row_filter: null, column_mask: null },
        ],
      }),
    );
    expect(out.rows).toHaveLength(3);
  });

  it("treats a malformed row_filter as unsatisfiable rather than as absent", async () => {
    // Grants are data; a filter missing its `values` must not throw inside an
    // access check. This used to assert that it admitted all three rows, on the
    // reasoning that not-throwing meant not-restricting — but those are two
    // different decisions, and only one of them widens access on corrupt input.
    //
    // A restriction nobody can parse has not been satisfied. The module's own
    // contract says so at the top of the file: any lookup error returns
    // nothing. An empty table is visible to the grantee and fixable by the
    // owner; a restricted grantee quietly seeing every row is neither.
    //
    // Unreachable via iamCreateGrant, which requires `values` with at least one
    // entry — this is about not depending on that.
    const out = await run(
      fakeDb({
        grants: [
          {
            principal_type: "user",
            principal_id: VIEWER,
            row_filter: { column: "region" } as { column: string; values: unknown[] },
            column_mask: null,
          },
        ],
      }),
    );
    expect(out.rows).toEqual([]);
  });

  it("does not throw on a malformed row_filter", async () => {
    // The guarantee the previous test was really protecting: a bad grant row
    // must not blow up the read path.
    await expect(
      run(
        fakeDb({
          grants: [
            {
              principal_type: "user",
              principal_id: VIEWER,
              row_filter: "not-an-object" as unknown as { column: string; values: unknown[] },
              column_mask: null,
            },
          ],
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('compares filter values as strings, so 1 matches "1"', async () => {
    const numericRows = [{ region: 1 }, { region: 2 }];
    const out = await restrictSharedDataset(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeDb({ grants: [{ ...filtered(["1"]) }] }) as any,
      "table-1",
      VIEWER,
      [{ name: "region", type: "number" }],
      numericRows,
    );
    expect(out.rows).toEqual([{ region: 1 }]);
  });

  it("admits no rows when the filter matches nothing", async () => {
    const out = await run(fakeDb({ grants: [filtered(["atlantis"])] }));
    expect(out.rows).toEqual([]);
    // The schema is still returned: an empty result is not the same as no access.
    expect(out.columns).toEqual(columns);
  });
});

describe("restrictSharedDataset — masks and filters together", () => {
  it("applies both", async () => {
    const out = await run(
      fakeDb({
        grants: [
          {
            principal_type: "user",
            principal_id: VIEWER,
            row_filter: { column: "region", values: ["west", "east"] },
            column_mask: ["salary"],
          },
        ],
      }),
    );
    expect(out.rows).toEqual([
      { region: "west", name: "A" },
      { region: "east", name: "B" },
    ]);
  });
});
