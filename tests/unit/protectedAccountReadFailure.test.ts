// A protection that cannot be verified is not absent.
//
// FOUND IN R236, closing the "a failed read that fails open" sweep's last named
// row. Three callers asked "is this account a superadmin?" before doing
// something destructive, each with its own `const { data: role } = await …`,
// each dropping the error:
//
//   scim.server  assertNotProtected — the guard whose own comment says "SCIM
//                may never remove the last way in". A failed read answered "not
//                a superadmin", and SCIM deactivated or DELETED the account
//                that administers the instance, on the word of an identity
//                provider, unattended.
//   iam.functions  ban and delete — "Demote this superadmin before deleting
//                them" skipped, and auth.admin.deleteUser called.
//
// isBootstrapAdmin had the same hole one level down: a failed account lookup
// left `email` empty, which is not the bootstrap address, so the bootstrap
// admin came back unprotected too. Both halves of the protection failed open at
// once, which is why neither covered for the other.
//
// requireSuperadmin in the same file has been guarded since R53, with the same
// reasoning spelled out above it. This round applies it to the other four.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const admin = vi.hoisted(() => ({
  role: { data: null, error: null } as Resp,
  getUserById: { data: { user: null }, error: null } as {
    data: { user: { email?: string; email_confirmed_at?: string } | null };
    error: { message: string } | null;
  },
  deleted: [] as string[],
  banned: [] as string[],
}));

// The server functions run without TanStack Start's server runtime, which its
// newer versions require (they read their options from it): the handler is
// called directly, as in every other server-function test.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      inputValidator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = () => Promise.resolve(admin.role);
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(admin.role).then(res, rej);
    return b;
  };
  return {
    supabaseAdmin: {
      from: () => chain(),
      auth: {
        admin: {
          getUserById: async () => admin.getUserById,
          deleteUser: async (id: string) => {
            admin.deleted.push(id);
            return { error: null };
          },
          updateUserById: async (id: string) => {
            admin.banned.push(id);
            return { error: null };
          },
        },
      },
    },
  };
});

// The guard these server functions run first; not what is under test here.
vi.mock("@/utils/iam.server", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    requireSuperadmin: async () => ({ ok: true, userId: "admin-1", email: "a@b.c" }),
  };
});

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

// bootstrapAdminEmail() reads this; without it isBootstrapAdmin returns
// early and the account lookup — the other half of the protection — is
// never made, so the test would pass for the wrong reason.
process.env.ADMIN_EMAIL = "root@example.com";

const FAILED = { data: null, error: { message: "connection reset" } };
const NO_ROLE = { data: null, error: null };

function reset() {
  admin.role = NO_ROLE;
  admin.getUserById = { data: { user: null }, error: null };
  admin.deleted = [];
  admin.banned = [];
}

describe("isProtectedAccount", () => {
  it("is true for a superadmin", async () => {
    reset();
    admin.role = { data: { id: "r1" }, error: null };
    const { isProtectedAccount } = await import("@/utils/iam.server");
    await expect(isProtectedAccount("u1")).resolves.toBe(true);
  });

  it("is false for an ordinary account", async () => {
    reset();
    const { isProtectedAccount } = await import("@/utils/iam.server");
    await expect(isProtectedAccount("u1")).resolves.toBe(false);
  });

  it("throws when the role read fails, rather than answering false", async () => {
    reset();
    admin.role = FAILED;
    const { isProtectedAccount } = await import("@/utils/iam.server");
    await expect(isProtectedAccount("u1")).rejects.toThrow(/could not read roles/);
  });

  it("throws when the ACCOUNT lookup fails — the other half of the protection", async () => {
    reset();
    admin.getUserById = { data: { user: null }, error: { message: "gateway timeout" } };
    const { isProtectedAccount } = await import("@/utils/iam.server");
    await expect(isProtectedAccount("u1")).rejects.toThrow(/could not read the account/);
  });
});

// Each refusal is the function's answer, { ok: false, error }, read as such. Under the
// old TanStack Start a direct call turned that answer into a rejection carrying
// its text, which is what these were first written against.
describe("the destructive admin actions, when the protection cannot be read", () => {
  it("does not delete the account, and says why", async () => {
    reset();
    admin.role = FAILED;
    const { iamDeleteUser } = await import("@/utils/iam.functions");
    expect(
      await iamDeleteUser({
        data: { access_token: "t", user_id: "11111111-1111-4111-8111-111111111111" },
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/so it was not deleted/) });
    expect(admin.deleted, "nothing was deleted").toEqual([]);
  });

  it("does not ban the account either", async () => {
    reset();
    admin.role = FAILED;
    const { iamSetUserBan } = await import("@/utils/iam.functions");
    expect(
      await iamSetUserBan({
        data: { access_token: "t", user_id: "11111111-1111-4111-8111-111111111111", banned: true },
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/so it was not banned/) });
    expect(admin.banned, "nothing was banned").toEqual([]);
  });

  it("still deletes an ordinary account when the read works", async () => {
    // The guard has to refuse the unreadable case WITHOUT refusing the normal
    // one, or it is just an outage with a tidier message.
    reset();
    const { iamDeleteUser } = await import("@/utils/iam.functions");
    expect(
      await iamDeleteUser({
        data: { access_token: "t", user_id: "22222222-2222-4222-8222-222222222222" },
      }),
    ).toEqual({ ok: true });
    expect(admin.deleted).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("still refuses a real superadmin with the demote-first message", async () => {
    reset();
    admin.role = { data: { id: "r1" }, error: null };
    const { iamDeleteUser } = await import("@/utils/iam.functions");
    expect(
      await iamDeleteUser({
        data: { access_token: "t", user_id: "33333333-3333-4333-8333-333333333333" },
      }),
    ).toEqual({ ok: false, error: "Demote this superadmin before deleting them" });
    expect(admin.deleted).toEqual([]);
  });
});

describe("no caller asks the question privately any more", () => {
  it.each([["src/utils/scim.server.ts"], ["src/utils/iam.functions.ts"]])(
    "%s does not read user_roles for a superadmin check of its own",
    (path) => {
      const src = readFileSync(path, "utf8");
      expect(src).toContain("isProtectedAccount");
      expect(src, "a private superadmin role read is back").not.toMatch(
        /\.eq\("role", "superadmin"\)\s*\n\s*\.maybeSingle\(\)/,
      );
    },
  );
});
