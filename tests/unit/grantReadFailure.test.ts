// A grant read that fails must not read as "unrestricted".
//
// FOUND IN R235, continuing the "a failed read that fails open" sweep. Four
// surfaces did the same two reads privately — the viewer's group memberships
// and the grants on the resource — and the enforcement file says what that
// costs: "Four private copies of one access rule is what let the snapshot path
// fail open for months." R53 had guarded the two in iam.server. Two of the
// others were still open:
//
//   bi.direct-query.ts  both reads dropped. An empty grant list means
//                       mergeGrantRowFilters -> null and intersectColumnMasks
//                       -> [], so the grantee's LIVE warehouse query ran with
//                       no row filter and no column mask, over every row and
//                       column the owner can see. Access itself was already
//                       checked and fails closed, so the viewer was through
//                       the door — only the limits vanished.
//
//   semantic/policy     the grants read was guarded; the membership read
//                       beside it was not. A restriction granted to a GROUP
//                       produced no applicable grant when the membership list
//                       could not be read, and the contract reads "no
//                       applicable grant" as "no share-level restriction".
//
// The other two copies (bi.functions, sharedDatasets) fail CLOSED — they answer
// "not shared with you" or an empty dataset — so they expose nothing, and they
// are on the queue for the message rather than for the hole.
//
// Behavioural: the real functions, a client whose reads fail one table at a
// time, and the assertion is on what comes back or is thrown.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };
type Table = "iam_group_members" | "iam_resource_grants" | "iam_user_attributes";

function fakeClient(responses: Partial<Record<Table, Resp>>) {
  const chain = (table: Table) => {
    const resp = responses[table] ?? { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
    b.maybeSingle = () => Promise.resolve(resp);
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resp).then(res, rej);
    return b;
  };
  return { from: (table: Table) => chain(table) };
}

const admin = vi.hoisted(() => ({ responses: {} as Partial<Record<string, Resp>> }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fakeClient(admin.responses as never).from(table as never),
  },
}));

const FAILED = { data: null, error: { message: "connection reset" } };

/** A grant on the model, to the group the viewer belongs to, hiding most rows. */
const GROUP_GRANT = {
  data: [
    {
      resource_id: "m1",
      principal_type: "group",
      principal_id: "g1",
      row_filter: { column: "region", values: ["EMEA"] },
      column_mask: ["salary"],
    },
  ],
  error: null,
};
const IN_GROUP = { data: [{ group_id: "g1" }], error: null };

describe("readApplicableGrants", () => {
  it("returns the grants that apply, directly or through a group", async () => {
    const { readApplicableGrants } = await import("@/utils/iam.server");
    const grants = await readApplicableGrants(
      fakeClient({
        iam_group_members: IN_GROUP,
        iam_resource_grants: {
          data: [
            { resource_id: "m1", principal_type: "group", principal_id: "g1", row_filter: null },
            { resource_id: "m1", principal_type: "user", principal_id: "u1", row_filter: null },
            { resource_id: "m1", principal_type: "user", principal_id: "u2", row_filter: null },
            { resource_id: "m1", principal_type: "group", principal_id: "g9", row_filter: null },
          ],
          error: null,
        },
      }) as never,
      "u1",
      "semantic_model",
      ["m1"],
    );
    // Theirs and their group's — not a colleague's, not a group they are not in.
    expect(grants.map((g) => g.principal_id).sort()).toEqual(["g1", "u1"]);
  });

  it("throws when the grants read fails, rather than returning none", async () => {
    const { readApplicableGrants } = await import("@/utils/iam.server");
    await expect(
      readApplicableGrants(
        fakeClient({ iam_group_members: IN_GROUP, iam_resource_grants: FAILED }) as never,
        "u1",
        "bi_dashboard",
        ["d1"],
      ),
    ).rejects.toThrow(/could not read access grants: connection reset/);
  });

  it("throws when the MEMBERSHIP read fails, which is the half that was missed", async () => {
    // The grants come back fine; only the viewer's groups cannot be read. The
    // grant is to a group, so dropping this read silently produces "no grant
    // applies" — indistinguishable from an unrestricted share.
    const { readApplicableGrants } = await import("@/utils/iam.server");
    await expect(
      readApplicableGrants(
        fakeClient({ iam_group_members: FAILED, iam_resource_grants: GROUP_GRANT }) as never,
        "u1",
        "semantic_model",
        ["m1"],
      ),
    ).rejects.toThrow(/could not read access grants: connection reset/);
  });

  it("asks nothing when there are no resources to ask about", async () => {
    const { readApplicableGrants } = await import("@/utils/iam.server");
    await expect(
      readApplicableGrants(
        fakeClient({ iam_group_members: FAILED }) as never,
        "u1",
        "data_table",
        [],
      ),
    ).resolves.toEqual([]);
  });
});

describe("semanticPoliciesFor, when a read fails", () => {
  it("applies a group's restriction when both reads succeed", async () => {
    admin.responses = { iam_group_members: IN_GROUP, iam_resource_grants: GROUP_GRANT };
    const { semanticPoliciesFor } = await import("@/utils/semantic/policy.server");
    const policies = await semanticPoliciesFor("u1", ["m1"]);
    expect(policies.has("m1"), "the group's restriction applies").toBe(true);
  });

  it("refuses when the membership read fails, instead of answering unrestricted", async () => {
    // Before: groupIds [] -> no applicable grant -> no entry in the map, which
    // the function's own contract defines as "no share-level restriction
    // exists". The model then ran with every row and every column.
    admin.responses = { iam_group_members: FAILED, iam_resource_grants: GROUP_GRANT };
    const { semanticPoliciesFor } = await import("@/utils/semantic/policy.server");
    await expect(semanticPoliciesFor("u1", ["m1"])).rejects.toThrow(
      /could not read access grants/i,
    );
  });

  it("still refuses when the grants read fails", async () => {
    admin.responses = { iam_group_members: IN_GROUP, iam_resource_grants: FAILED };
    const { semanticPoliciesFor } = await import("@/utils/semantic/policy.server");
    await expect(semanticPoliciesFor("u1", ["m1"])).rejects.toThrow(
      /could not read access grants/i,
    );
  });
});

describe("the enforcement surfaces read grants one way", () => {
  const DIRECT = readFileSync("src/routes/api/bi.direct-query.ts", "utf8");
  const POLICY = readFileSync("src/utils/semantic/policy.server.ts", "utf8");
  // R239 brought the last two onto it, so "four private copies" is now one.
  const BIFN = readFileSync("src/utils/bi.functions.ts", "utf8");
  const SHARED = readFileSync("src/utils/data/sharedDatasets.server.ts", "utf8");

  it.each([
    ["src/routes/api/bi.direct-query.ts", DIRECT],
    ["src/utils/semantic/policy.server.ts", POLICY],
    ["src/utils/bi.functions.ts", BIFN],
    ["src/utils/data/sharedDatasets.server.ts", SHARED],
  ])("%s reads no membership list of its own", (_name, src) => {
    // The membership read is the precise marker: a viewer's groups are only
    // ever needed to decide which grants apply to them, so a surface that
    // reads them is deciding access with a copy of the rule.
    expect(src).toContain("readApplicableGrants(");
    expect(src).not.toMatch(/from\("iam_group_members"\)/);
  });

  it.each([
    ["src/routes/api/bi.direct-query.ts", DIRECT],
    ["src/utils/semantic/policy.server.ts", POLICY],
    ["src/utils/data/sharedDatasets.server.ts", SHARED],
  ])("%s does not read the grants table either", (_name, src) => {
    // bi.functions is exempt and stays out of this list on purpose: it is the
    // owner's SHARING surface, so it lists, inserts and deletes grants. What
    // it must not do is decide a VIEWER's access with its own copy, which the
    // membership check above and the refusal test below pin.
    expect(src).not.toMatch(/from\("iam_resource_grants"\)/);
  });

  it("the dashboard read says what could not be read, not that it is unshared", () => {
    // R239: the membership read beside the guarded grants read was unguarded,
    // so a failure of it produced no applicable grant and answered "This
    // dashboard is not shared with you" — a definite sentence about a question
    // that was never asked. The reader acts on it by asking for access they
    // already have.
    const at = BIFN.indexOf('readApplicableGrants(supabaseAdmin, userId, "bi_dashboard"');
    expect(at, "bi.functions must go through the shared reader").toBeGreaterThan(-1);
    const around = BIFN.slice(at, at + 700);
    expect(around).toMatch(/\} catch \([^)]*\) \{\s*return \{\s*ok: false,/);
    expect(around).toMatch(/could not read your access/i);
    // And the "not shared" sentence survives only for a read that SUCCEEDED
    // and found nothing.
    const unshared = BIFN.indexOf("This dashboard is not shared with you");
    expect(unshared).toBeGreaterThan(at);
  });

  it("a shared dataset re-raises a failed grant read instead of showing an empty table", () => {
    // An empty dataset is the same screen as "nothing was shared with me".
    const at = SHARED.indexOf("} catch (e) {");
    const tail = SHARED.slice(at, at + 900);
    expect(tail).toMatch(/could not read access grants/i);
    expect(tail).toContain("throw e;");
    // The fail-closed default is still there for anything unnamed.
    expect(tail).toContain("return { columns: [], rows: [] };");
  });

  it("direct query refuses with a 503 rather than running unrestricted", () => {
    // Pinned on the catch block itself, not its neighbourhood: a mutant that
    // set `mine = []` and left an unreachable `return json(503` further down
    // satisfied a looser assertion while running the query unrestricted.
    const at = DIRECT.indexOf("readApplicableGrants(");
    const around = DIRECT.slice(at, at + 900);
    expect(around, "the refusal is the catch block's first act").toMatch(
      /\} catch \([^)]*\) \{\s*return json\(503/,
    );
    expect(around).toMatch(/could not be read/i);
    // And nothing downgrades the grants to "none" on the way past.
    const catchAt = around.indexOf("} catch");
    expect(around.slice(catchAt, catchAt + 400)).not.toMatch(/mine\s*=/);
  });
});
