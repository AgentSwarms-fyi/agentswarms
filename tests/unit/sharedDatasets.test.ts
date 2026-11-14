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
  columnsVisibleTo,
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
 * A Supabase stand-in shaped like the calls the module makes, which since R239
 * go through readApplicableGrants:
 *   from("iam_group_members").select(...).eq(...)
 *   from("iam_resource_grants").select(...).eq(...).in(...)
 * Each link is chainable AND awaitable, because the real builder is.
 *
 * `failOn` is a read that REPORTS a failure, the way PostgREST does — an
 * `error` on the result. `throwOn` is something unexpected blowing up inside
 * the call. R239 made those two different: the first reaches the viewer, the
 * second still fails closed.
 */
function fakeDb(opts: {
  groups?: string[];
  grants?: Grant[];
  throwOn?: "iam_group_members" | "iam_resource_grants";
  failOn?: "iam_group_members" | "iam_resource_grants";
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
      const result =
        opts.failOn === table
          ? { data: null, error: { message: "connection reset" } }
          : { data, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
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

  it("TELLS THE CALLER when the grants read fails, instead of showing an empty table", async () => {
    // R239. An access decision must never default to "allow" because a query
    // broke — and it must not default to "there is nothing here" either. An
    // empty dataset is the same screen a viewer sees when nothing was shared
    // with them, so answering a failed read that way states something this
    // code cannot know. The caller surfaces the error; the attribute refusal
    // has reached the viewer the same way since it was added.
    await expect(run(fakeDb({ failOn: "iam_resource_grants" }))).rejects.toThrow(
      /could not read access grants/i,
    );
  });

  it("tells the caller when the MEMBERSHIP read fails too", async () => {
    // The half that was unguarded before R235: a grant to a group applies only
    // when the membership list can be read.
    await expect(run(fakeDb({ failOn: "iam_group_members" }))).rejects.toThrow(
      /could not read access grants/i,
    );
  });

  it("still fails closed when something unexpected blows up", async () => {
    // The rule that has not changed: an error we cannot name is not a reason
    // to show rows. Only a read that REPORTED its failure is re-raised.
    const out = await run(fakeDb({ throwOn: "iam_resource_grants" }));
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

// R489. A LISTING (the sql_query tool description, the doc-gen context, the
// semantic-model source picker) shows a dataset's columns without reading its
// rows, and used to show the owner's full list. columnsVisibleTo is the
// listing's half of the rule; these pin it to the SAME answer restrictSharedDataset
// gives for the same grants, so the two cannot drift.
describe("columnsVisibleTo — the listing hides what the rows path hides", () => {
  const userGrant = (column_mask: string[] | null, principal_id = VIEWER): Grant => ({
    principal_type: "user",
    principal_id,
    row_filter: null,
    column_mask,
  });
  // The listing reads several datasets' grants at once and tells them apart by
  // resource_id, which restrictSharedDataset (one dataset) never needs.
  const withId = (gs: Grant[]) => gs.map((g) => ({ ...g, resource_id: "table-1" }));
  const listed = (db: unknown) =>
    columnsVisibleTo(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      VIEWER,
      [{ id: "table-1", user_id: "owner-1", is_sample: false, columns }],
    ).then((m) => m.get("table-1"));

  const cases: [string, { groups?: string[]; grants: Grant[] }][] = [
    ["no grant", { grants: [] }],
    ["another user's grant", { grants: [userGrant(null, "someone-else")] }],
    ["an unmasked grant", { grants: [userGrant(null)] }],
    ["a mask", { grants: [userGrant(["salary"])] }],
    ["a mask in another case", { grants: [userGrant(["SALARY"])] }],
    [
      "two masks (they intersect)",
      { grants: [userGrant(["salary", "name"]), userGrant(["salary"])] },
    ],
    [
      "a masked grant to a group the viewer is in",
      {
        groups: ["group-a"],
        grants: [
          {
            principal_type: "group",
            principal_id: "group-a",
            row_filter: null,
            column_mask: ["region"],
          },
        ],
      },
    ],
  ];

  for (const [label, opts] of cases) {
    it(`agrees with restrictSharedDataset: ${label}`, async () => {
      const db = fakeDb({ ...opts, grants: withId(opts.grants) });
      const rowsPath = await run(db);
      expect(await listed(db)).toEqual(rowsPath.columns);
    });
  }

  it("lists no columns, and does not throw, when the grants read fails", async () => {
    // restrictSharedDataset re-raises this (R239) so a reader hears why. A
    // listing still has every other table to show: the table stays, its
    // columns go, and reading it reports the reason.
    expect(await listed(fakeDb({ failOn: "iam_resource_grants" }))).toEqual([]);
    expect(await listed(fakeDb({ failOn: "iam_group_members" }))).toEqual([]);
    expect(await listed(fakeDb({ throwOn: "iam_resource_grants" }))).toEqual([]);
  });

  it("leaves own datasets and samples alone, without reading a grant", async () => {
    const reads: string[] = [];
    const out = await columnsVisibleTo(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: (t: string) => (reads.push(t), fakeDb({}).from(t)) } as any,
      VIEWER,
      [
        { id: "mine", user_id: VIEWER, is_sample: false, columns },
        { id: "sample", user_id: null, is_sample: true, columns },
      ],
    );
    expect(out.get("mine")).toEqual(columns);
    expect(out.get("sample")).toEqual(columns);
    expect(reads).toEqual([]);
  });

  it("treats every non-sample dataset as shared when there is no viewer", async () => {
    const out = await columnsVisibleTo(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeDb({ grants: withId([userGrant(null)]) }) as any,
      null,
      [{ id: "table-1", user_id: null, is_sample: false, columns }],
    );
    expect(out.get("table-1")).toEqual([]);
  });
});
