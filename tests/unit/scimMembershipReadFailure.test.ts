// A group whose members cannot be read is not a group with no members.
//
// FOUND IN R248, from the sweep-7 queue: "SCIM group deprovisioning removes no
// one when the members cannot be read, and answers 200". A PUT or PATCH on a
// group works out who to remove as `before.filter(m => !after.includes(m))`,
// and `before` came from membersOf, which dropped its read error. A failed
// read made `before` empty, so the removal set was empty: the identity
// provider was told the user had left the group, and every grant the group
// carries stayed with them. Deprovisioning is the one SCIM call whose whole
// purpose is to take access away; failing open there is the worst direction.
//
// groupsFor (a user's groups, on every User response) and assertUsersExist (a
// failed account lookup answered "is not a user", a 400 blaming the IdP) dropped
// their errors the same way.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  /** What a read of each table answers. */
  reads: {} as Record<string, Resp>,
  /** Every write, in order: [table, op, detail]. */
  writes: [] as [string, string, unknown][],
  getUserById: { data: { user: { id: "u" } }, error: null } as {
    data: { user: unknown };
    error: { message: string } | null;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    const b: Record<string, unknown> = {};
    let op = "select";
    for (const m of ["select", "eq", "in", "order", "ilike", "limit", "range"]) b[m] = () => b;
    b.delete = () => {
      op = "delete";
      return b;
    };
    b.update = (patch: unknown) => {
      db.writes.push([table, "update", patch]);
      op = "update";
      return b;
    };
    b.upsert = (rows: unknown) => {
      db.writes.push([table, "upsert", rows]);
      return Promise.resolve({ data: null, error: null });
    };
    const answer = () => {
      if (op === "delete") {
        db.writes.push([table, "delete", null]);
        return { data: null, error: null };
      }
      if (op === "update") return { data: null, error: null };
      return db.reads[table] ?? { data: [], error: null };
    };
    b.maybeSingle = () => Promise.resolve(answer());
    b.single = () => Promise.resolve(answer());
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(res, rej);
    return b;
  };
  return {
    supabaseAdmin: {
      from: (t: string) => chain(t),
      auth: { admin: { getUserById: async () => db.getUserById } },
    },
  };
});

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

const GROUP = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "Contractors",
  external_id: null,
  created_at: "2026-10-04T00:00:00Z",
};
const LEAVER = "11111111-1111-1111-1111-111111111111";
const STAYER = "22222222-2222-2222-2222-222222222222";
const ACTOR = { tokenId: "t1", label: "okta", createdBy: "admin-1" };

function reset() {
  db.writes = [];
  db.reads = {
    iam_groups: { data: GROUP, error: null },
    iam_group_members: {
      data: [
        { group_id: GROUP.id, user_id: LEAVER },
        { group_id: GROUP.id, user_id: STAYER },
      ],
      error: null,
    },
    profiles: { data: [], error: null },
  };
  db.getUserById = { data: { user: { id: "u" } }, error: null };
}

const removeLeaver = {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  Operations: [{ op: "remove", path: `members[value eq "${LEAVER}"]` }],
};

describe("SCIM group membership, when the members cannot be read", () => {
  it("removes the leaver when the read works (the baseline this must not break)", async () => {
    reset();
    const { patchScimGroup } = await import("@/utils/scim.server");
    await patchScimGroup(GROUP.id, removeLeaver, ACTOR, "http://x/scim/v2");
    expect(
      db.writes.filter(([t, op]) => t === "iam_group_members" && op === "delete"),
    ).toHaveLength(1);
  });

  it("refuses a PATCH that removes a member, instead of removing no one and answering 200", async () => {
    reset();
    db.reads.iam_group_members = { data: null, error: { message: "connection reset" } };
    const { patchScimGroup } = await import("@/utils/scim.server");
    await expect(
      patchScimGroup(GROUP.id, removeLeaver, ACTOR, "http://x/scim/v2"),
    ).rejects.toMatchObject({ status: 503 });
    // Nothing was written on a guess.
    expect(db.writes.filter(([t]) => t === "iam_group_members")).toEqual([]);
  });

  it("refuses a PUT that replaces the members, for the same reason", async () => {
    reset();
    db.reads.iam_group_members = { data: null, error: { message: "connection reset" } };
    const { replaceScimGroup } = await import("@/utils/scim.server");
    await expect(
      replaceScimGroup(
        GROUP.id,
        { displayName: "Contractors", members: [{ value: STAYER }] },
        ACTOR,
        "http://x/scim/v2",
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(db.writes.filter(([t]) => t === "iam_group_members")).toEqual([]);
  });

  it("does not report a group as empty to the IdP when its members cannot be read", async () => {
    reset();
    db.reads.iam_group_members = { data: null, error: { message: "connection reset" } };
    const { getScimGroup } = await import("@/utils/scim.server");
    await expect(getScimGroup(GROUP.id, "http://x/scim/v2")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("does not blame the IdP for a member id when the account lookup itself failed", async () => {
    reset();
    db.getUserById = { data: { user: null }, error: { message: "auth unavailable" } };
    const { replaceScimGroup } = await import("@/utils/scim.server");
    const err = await replaceScimGroup(
      GROUP.id,
      {
        displayName: "Contractors",
        members: [
          { value: LEAVER },
          { value: STAYER },
          { value: "33333333-3333-3333-3333-333333333333" },
        ],
      },
      ACTOR,
      "http://x/scim/v2",
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503 });
    expect(String((err as Error).message)).not.toMatch(/is not a user/);
  });
});

describe("the other answers SCIM gives an IdP", () => {
  it("answers 503, not 404 No group, when the group row cannot be read", async () => {
    reset();
    db.reads.iam_groups = { data: null, error: { message: "connection reset" } };
    const { getScimGroup } = await import("@/utils/scim.server");
    await expect(getScimGroup(GROUP.id, "http://x/scim/v2")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("still answers 404 for a group that is not there", async () => {
    reset();
    db.reads.iam_groups = { data: null, error: null };
    const { getScimGroup } = await import("@/utils/scim.server");
    await expect(getScimGroup(GROUP.id, "http://x/scim/v2")).rejects.toMatchObject({
      status: 404,
    });
  });

  // GoTrue reports a missing user AS an error with status 404, so the split is
  // on the status, not on whether there was an error.
  it("answers 404 for a user GoTrue says is missing, and 503 for a lookup that failed", async () => {
    reset();
    const { getScimUser } = await import("@/utils/scim.server");
    db.getUserById = {
      data: { user: null },
      error: Object.assign({ message: "User not found" }, { status: 404 }),
    };
    await expect(getScimUser(LEAVER, "http://x/scim/v2")).rejects.toMatchObject({ status: 404 });
    db.getUserById = {
      data: { user: null },
      error: Object.assign({ message: "upstream timeout" }, { status: 500 }),
    };
    await expect(getScimUser(LEAVER, "http://x/scim/v2")).rejects.toMatchObject({ status: 503 });
  });

  // A User response carries the user's groups and name. Reporting "in no
  // groups" or "no name" to an IdP that reconciles against it is the same
  // false statement as an empty group.
  it.each([
    ["their groups", () => (db.reads.iam_group_members = { data: null, error: { message: "x" } })],
    ["their profile", () => (db.reads.profiles = { data: null, error: { message: "x" } })],
  ])("answers a User GET with 503 when %s cannot be read", async (_what, breakIt) => {
    reset();
    db.getUserById = {
      data: {
        user: { id: LEAVER, email: "leaver@example.com", created_at: "2026-01-01T00:00:00Z" },
      },
      error: null,
    };
    breakIt();
    const { getScimUser } = await import("@/utils/scim.server");
    await expect(getScimUser(LEAVER, "http://x/scim/v2")).rejects.toMatchObject({ status: 503 });
  });

  it("drops no read error anywhere in the file", () => {
    const src = readFileSync("src/utils/scim.server.ts", "utf8");
    const dropped = [...src.matchAll(/const \{ data(?::\s*\w+)? \} = await/g)].map((m) => m[0]);
    // Was 9 on 2026-10-04: the token lookup, profiles, a user's groups (two
    // reads), a profile before a write, a group's members, a group's row, a
    // member's account, and the name clash on create.
    expect(dropped).toEqual([]);
  });

  it("answers an unreadable token table with 503, not 401", () => {
    const src = readFileSync("src/utils/scim.server.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function authenticateScim"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/if \(tokenErr\) \{\s*return \{\s*ok: false,\s*response: scimFail\(503,/);
  });
});
