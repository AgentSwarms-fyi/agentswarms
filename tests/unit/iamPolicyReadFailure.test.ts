// A policy read that fails must fail closed.
//
// getEffectiveModelRules read four tables and dropped the error of each:
//
//   const [{ data: memberships }, { data: rules }, { data: roles }, { data: settings }] = …
//   const mode = settings?.model_access_default === "deny" ? "deny" : "allow";
//
// Under allow mode collapseModelPolicy turns "no applicable rules" into null —
// unrestricted. So a failed iam_settings read evaluated a deny-by-default org
// as allow, and a failed iam_group_members read dropped every group rule; in
// both cases a model the policy forbade was called. resolveGrantedResourceIds
// dropped both of its reads the same way, which is how everything shared with
// a user vanishes from a listing on one transient failure; requireSuperadmin
// dropped its role read and fell through to the bootstrap claim, which writes.
//
// Behavioural: the real functions, a client whose reads fail one table at a
// time, and the assertion is on what comes back — or does not. Against the
// unpatched source the settings case resolved null, the memberships and rules
// cases resolved [], the grants case resolved an empty Set, and the role case
// answered "Forbidden: superadmin access only".
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };
type Table =
  | "iam_group_members"
  | "iam_model_rules"
  | "user_roles"
  | "iam_settings"
  | "iam_resource_grants";

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

// The module-level admin client requireSuperadmin uses; configured per test.
const admin = vi.hoisted(() => ({
  responses: {} as Partial<Record<Table, Resp>>,
  user: { id: "u1", email: "someone@example.com" } as { id: string; email: string } | null,
  writes: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: admin.user }, error: null }) },
    from: (table: Table) => {
      const c = fakeClient(admin.responses).from(table) as Record<string, unknown>;
      c.upsert = () => {
        admin.writes += 1;
        return c;
      };
      return c;
    },
  },
}));

const DENY = { data: { model_access_default: "deny" }, error: null };
const FAILED = { data: null, error: { message: "connection reset" } };

describe("getEffectiveModelRules, when a policy read fails", () => {
  it("still fails closed under deny mode when every read succeeds", async () => {
    const { getEffectiveModelRules } = await import("@/utils/iam.server");
    const rules = await getEffectiveModelRules(fakeClient({ iam_settings: DENY }) as never, "u1");
    expect(rules).toEqual([]);
  });

  it("a failed settings read is not allow mode", async () => {
    // Before: settings null → mode allow → no applicable rules → null →
    // unrestricted. A deny-by-default org, evaluated as allow.
    const { getEffectiveModelRules } = await import("@/utils/iam.server");
    await expect(
      getEffectiveModelRules(fakeClient({ iam_settings: FAILED }) as never, "u1"),
    ).rejects.toThrow(/could not read model access policy: connection reset/);
  });

  it("a failed memberships read does not drop the group's rules", async () => {
    const { getEffectiveModelRules } = await import("@/utils/iam.server");
    await expect(
      getEffectiveModelRules(
        fakeClient({ iam_settings: DENY, iam_group_members: FAILED }) as never,
        "u1",
      ),
    ).rejects.toThrow(/could not read model access policy/);
  });

  it("a failed rules read is not an empty rule set", async () => {
    const { getEffectiveModelRules } = await import("@/utils/iam.server");
    await expect(
      getEffectiveModelRules(
        fakeClient({ iam_settings: DENY, iam_model_rules: FAILED }) as never,
        "u1",
      ),
    ).rejects.toThrow(/could not read model access policy/);
  });

  it("a failed roles read is not 'not a superadmin'", async () => {
    const { getEffectiveModelRules } = await import("@/utils/iam.server");
    await expect(
      getEffectiveModelRules(fakeClient({ iam_settings: DENY, user_roles: FAILED }) as never, "u1"),
    ).rejects.toThrow(/could not read model access policy/);
  });
});

describe("resolveGrantedResourceIds, when a grants read fails", () => {
  const GRANTS = {
    data: [{ principal_type: "user", principal_id: "u1", resource_id: "t-shared" }],
    error: null,
  };

  it("returns the granted ids when every read succeeds", async () => {
    const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
    const ids = await resolveGrantedResourceIds(
      fakeClient({ iam_resource_grants: GRANTS }) as never,
      "u1",
      "data_table",
    );
    expect([...ids]).toEqual(["t-shared"]);
  });

  it("a failed grants read is not an empty grant list", async () => {
    const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
    await expect(
      resolveGrantedResourceIds(
        fakeClient({ iam_resource_grants: FAILED }) as never,
        "u1",
        "data_table",
      ),
    ).rejects.toThrow(/could not read resource grants: connection reset/);
  });

  it("a failed memberships read is not 'no groups'", async () => {
    const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
    await expect(
      resolveGrantedResourceIds(
        fakeClient({ iam_resource_grants: GRANTS, iam_group_members: FAILED }) as never,
        "u1",
        "data_table",
      ),
    ).rejects.toThrow(/could not read resource grants/);
  });
});

describe("requireSuperadmin, when the role read fails", () => {
  it("refuses with the reason instead of falling through to the bootstrap claim", async () => {
    admin.responses = { user_roles: FAILED };
    admin.writes = 0;
    const { requireSuperadmin } = await import("@/utils/iam.server");
    const guard = await requireSuperadmin("token");
    expect(guard.ok).toBe(false);
    expect(guard.ok ? "" : guard.error).toMatch(/could not read roles: connection reset/);
    expect(admin.writes, "a failed read must never reach the claim's upsert").toBe(0);
  });

  it("still admits a superadmin whose role row reads", async () => {
    admin.responses = { user_roles: { data: { id: "r1" }, error: null } };
    const { requireSuperadmin } = await import("@/utils/iam.server");
    const guard = await requireSuperadmin("token");
    expect(guard.ok).toBe(true);
  });
});

describe("the two callers that used to catch the resolver and answer 'no grants'", () => {
  const SHARED = readFileSync("src/utils/data/sharedDatasets.server.ts", "utf8");
  const CREDS = readFileSync("src/utils/providers/credentials.server.ts", "utf8");

  function fnBody(src: string, name: string): string {
    const i = src.indexOf(`async function ${name}(`);
    expect(i, `${name} is gone`).toBeGreaterThan(0);
    const j = src.indexOf("\n}\n", i);
    return src.slice(i, j);
  }

  it("grantedDatasetIds lets a failed grants read fail the job", () => {
    const body = fnBody(SHARED, "grantedDatasetIds");
    expect(body).not.toMatch(/catch/);
    expect(body).not.toMatch(/new Set\(\)/);
    expect(body).toMatch(/return await resolveGrantedResourceIds\(sb, viewerId, "data_table"\);/);
  });

  it("grantedIdsFor rethrows with the reason instead of answering an empty set", () => {
    const body = fnBody(CREDS, "grantedIdsFor");
    expect(body).toMatch(
      /throw new Error\(`could not read credential grants: \$\{\(e as Error\)\.message\}`\);/,
    );
    expect(body).not.toMatch(/return new Set\(\)/);
  });
});
