// SCIM 2.0 provisioning: the protocol reading (filters, PATCH, resources)
// and the wiring that keeps the IdP from taking the last superadmin away.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SCIM_GROUP_SCHEMA,
  SCIM_MAX_RESULTS,
  SCIM_SCHEMA,
  ScimError,
  applyGroupPatch,
  applyUserPatch,
  displayNameFrom,
  generateScimToken,
  hashScimToken,
  listResponse,
  looksLikeScimToken,
  parseScimFilter,
  readPage,
  readPatch,
  readScimUser,
  scimErrorBody,
  scimTokenPrefix,
  serviceProviderConfig,
  type ScimUserState,
} from "@/lib/scim";

const rd = (p: string) => readFileSync(p, "utf8");

describe("filters — the one shape IdPs send", () => {
  it("parses attr eq value, quoted or not, any case of attribute", () => {
    expect(parseScimFilter('userName eq "ann@example.com"')).toEqual({
      attribute: "username",
      value: "ann@example.com",
    });
    expect(parseScimFilter("externalId eq 00u1abc")).toEqual({
      attribute: "externalid",
      value: "00u1abc",
    });
    expect(parseScimFilter('emails[type eq "work"].value eq "a@b.co"')).toEqual({
      attribute: 'emails[type eq "work"].value',
      value: "a@b.co",
    });
    expect(parseScimFilter(null)).toBeNull();
    expect(parseScimFilter("  ")).toBeNull();
  });

  it("refuses what it cannot honour rather than matching nothing", () => {
    // A silently-empty result reads to an IdP as "no such user", and it then
    // creates a duplicate. invalidFilter is the honest answer.
    for (const bad of [
      'userName co "ann"',
      'a eq "x" and b eq "y"',
      "userName pr",
      'userName eq "unterminated',
    ]) {
      expect(() => parseScimFilter(bad)).toThrow(ScimError);
      try {
        parseScimFilter(bad);
      } catch (e) {
        expect((e as ScimError).status).toBe(400);
        expect((e as ScimError).scimType).toBe("invalidFilter");
      }
    }
  });
});

describe("reading a User", () => {
  it("takes the email from userName, or from the primary email when userName is not one", () => {
    expect(readScimUser({ userName: "Ann@Example.com" }).email).toBe("ann@example.com");
    const entra = readScimUser({
      userName: "ann.x",
      emails: [
        { value: "other@example.com", primary: false },
        { value: "ann@example.com", primary: true },
      ],
      name: { givenName: "Ann", familyName: "Xu" },
      active: "True",
    });
    expect(entra.email).toBe("ann@example.com");
    expect(entra.userName).toBe("ann.x");
    expect(entra.name?.givenName).toBe("Ann");
    expect(entra.active).toBe(true);
  });

  it("refuses a user without an email address — an account nobody can sign into", () => {
    expect(() => readScimUser({ userName: "no-email" })).toThrow(/email/);
    expect(() => readScimUser(null)).toThrow(ScimError);
  });

  it("derives a display name in the order people expect", () => {
    expect(displayNameFrom({ displayName: "Ann X", email: "a@b.co" })).toBe("Ann X");
    expect(displayNameFrom({ name: { givenName: "Ann", familyName: "Xu" }, email: "a@b.co" })).toBe(
      "Ann Xu",
    );
    expect(displayNameFrom({ name: { formatted: "Dr Ann" }, email: "a@b.co" })).toBe("Dr Ann");
    expect(displayNameFrom({ email: "ann@b.co" })).toBe("ann");
  });
});

const user: ScimUserState = {
  email: "ann@example.com",
  userName: "ann@example.com",
  externalId: "00u1",
  givenName: "Ann",
  familyName: "Xu",
  displayName: null,
  active: true,
};

describe("PATCH on a User — Okta's path-less values and Entra's paths", () => {
  it("deactivates the Okta way", () => {
    const ops = readPatch({ Operations: [{ op: "replace", value: { active: false } }] });
    expect(applyUserPatch(user, ops).active).toBe(false);
  });

  it("deactivates the Entra way, and reads its string booleans", () => {
    const ops = readPatch({ Operations: [{ op: "Replace", path: "active", value: "False" }] });
    expect(applyUserPatch(user, ops).active).toBe(false);
  });

  it("changes names, userName and externalId; a new email userName moves the email", () => {
    const ops = readPatch({
      Operations: [
        { op: "replace", path: "name.givenName", value: "Anne" },
        { op: "add", path: "name.familyName", value: "Xu-Li" },
        { op: "replace", path: "userName", value: "anne@example.com" },
        { op: "remove", path: "externalId" },
      ],
    });
    const next = applyUserPatch(user, ops);
    expect(next.givenName).toBe("Anne");
    expect(next.familyName).toBe("Xu-Li");
    expect(next.email).toBe("anne@example.com");
    expect(next.externalId).toBeNull();
  });

  it("ignores attributes this server does not store, refuses a wrongly typed active", () => {
    const ops = readPatch({
      Operations: [{ op: "replace", value: { title: "CFO", locale: "en" } }],
    });
    expect(applyUserPatch(user, ops)).toEqual(user);
    expect(() =>
      applyUserPatch(
        user,
        readPatch({ Operations: [{ op: "replace", path: "active", value: "maybe" }] }),
      ),
    ).toThrow(/boolean/);
  });

  it("refuses an empty or malformed PatchOp", () => {
    expect(() => readPatch({ Operations: [] })).toThrow(ScimError);
    expect(() => readPatch({ Operations: [{ op: "move", path: "x" }] })).toThrow(
      /Unsupported PATCH op/,
    );
    expect(() => readPatch({ Operations: [{ op: "remove" }] })).toThrow(/needs a path/);
  });
});

describe("PATCH on a Group — members in step with the IdP", () => {
  const group = { displayName: "Finance", externalId: "g1", members: ["u1", "u2"] };

  it("adds members without duplicates, removes one by filter, clears all", () => {
    const added = applyGroupPatch(
      group,
      readPatch({
        Operations: [{ op: "add", path: "members", value: [{ value: "u3" }, { value: "u2" }] }],
      }),
    );
    expect(added.members).toEqual(["u1", "u2", "u3"]);
    const removed = applyGroupPatch(
      group,
      readPatch({ Operations: [{ op: "remove", path: 'members[value eq "u1"]' }] }),
    );
    expect(removed.members).toEqual(["u2"]);
    const cleared = applyGroupPatch(
      group,
      readPatch({ Operations: [{ op: "remove", path: "members" }] }),
    );
    expect(cleared.members).toEqual([]);
  });

  it("replaces the member list wholesale and renames", () => {
    const next = applyGroupPatch(
      group,
      readPatch({
        Operations: [
          { op: "replace", path: "members", value: [{ value: "u9" }] },
          { op: "replace", value: { displayName: "Finance EMEA" } },
        ],
      }),
    );
    expect(next.members).toEqual(["u9"]);
    expect(next.displayName).toBe("Finance EMEA");
    expect(next.externalId).toBe("g1");
  });

  it("refuses to remove what it cannot", () => {
    expect(() =>
      applyGroupPatch(group, readPatch({ Operations: [{ op: "remove", path: "displayName" }] })),
    ).toThrow(/Cannot remove/);
  });
});

describe("lists, tokens and discovery", () => {
  it("pages 1-based and clamps count to the maximum", () => {
    const url = new URL("https://x/api/scim/v2/Users?startIndex=3&count=1000");
    expect(readPage(url)).toEqual({ startIndex: 3, count: SCIM_MAX_RESULTS });
    expect(readPage(new URL("https://x/Users?startIndex=0&count=-1"))).toEqual({
      startIndex: 1,
      count: 0,
    });
    const page = listResponse(["a", "b", "c", "d"], { startIndex: 2, count: 2 });
    expect(page).toEqual({
      schemas: [SCIM_SCHEMA.list],
      totalResults: 4,
      startIndex: 2,
      itemsPerPage: 2,
      Resources: ["b", "c"],
    });
  });

  it("tokens are prefixed, long, hashed with SHA-256 and shown only as a stub", async () => {
    const t = generateScimToken();
    expect(t.startsWith("scim_")).toBe(true);
    expect(t.length).toBe(5 + 32);
    expect(looksLikeScimToken(t)).toBe(true);
    expect(looksLikeScimToken("gw_" + "a".repeat(40))).toBe(false);
    expect(await hashScimToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashScimToken(t)).toBe(await hashScimToken(t));
    expect(scimTokenPrefix(t)).toBe(t.slice(0, 11));
    expect(generateScimToken()).not.toBe(t);
  });

  it("states what is unsupported instead of half-building it", () => {
    const cfg = serviceProviderConfig("https://x/api/scim/v2");
    expect(cfg.patch.supported).toBe(true);
    expect(cfg.filter.supported).toBe(true);
    expect(cfg.bulk.supported).toBe(false);
    expect(cfg.sort.supported).toBe(false);
    expect(cfg.etag.supported).toBe(false);
    expect(cfg.documentationUri).toBe("https://x/docs/iam");
    expect(SCIM_GROUP_SCHEMA).toBe("urn:ietf:params:scim:schemas:core:2.0:Group");
    expect(scimErrorBody(404, "gone", "noTarget")).toEqual({
      schemas: [SCIM_SCHEMA.error],
      status: "404",
      scimType: "noTarget",
      detail: "gone",
    });
  });
});

describe("the wiring", () => {
  const server = rd("src/utils/scim.server.ts");
  const routes = [
    "src/routes/api/scim.v2.Users.ts",
    "src/routes/api/scim.v2.Users.$id.ts",
    "src/routes/api/scim.v2.Groups.ts",
    "src/routes/api/scim.v2.Groups.$id.ts",
    "src/routes/api/scim.v2.ServiceProviderConfig.ts",
    "src/routes/api/scim.v2.ResourceTypes.ts",
    "src/routes/api/scim.v2.Schemas.ts",
  ];

  it("every handler authenticates before it does anything else", () => {
    for (const path of routes) {
      const src = rd(path);
      const handlers = src.match(/(GET|POST|PUT|PATCH|DELETE): async/g) ?? [];
      const auths = src.match(/await authenticateScim\(request\)/g) ?? [];
      expect(auths.length, path).toBe(handlers.length);
      expect(src).not.toContain("supabaseAdmin"); // routes hold no data access of their own
    }
  });

  it("a superadmin cannot be deactivated or deleted from the IdP", () => {
    // The last way in must not depend on the IdP being right.
    expect(server).toContain('await assertNotProtected(u.id, "deactivate")');
    expect(server).toContain('await assertNotProtected(u.id, "delete")');
    expect(server).toContain("isBootstrapAdmin(userId)");
    const guard = server.indexOf("async function assertNotProtected");
    expect(server.slice(guard, guard + 600)).toContain('.eq("role", "superadmin")');
  });

  it("the token is looked up by hash, never stored, and denials are rate limited", () => {
    expect(server).toContain('.eq("token_hash", hash)');
    expect(server).toContain('rateLimitedGlobal("scim", limit)');
    expect(server).toContain('envInt("SCIM_RATE_LIMIT_PER_MIN", 300)');
    const fn = rd("src/utils/iam.functions.ts");
    expect(fn).toContain("export const iamCreateScimToken");
    expect(fn).toContain("export const iamRevokeScimToken");
    expect(fn).toContain("token_hash: await hashScimToken(token)");
    expect(fn).not.toMatch(/token:\s*token\b[^,]*,\s*token_hash/); // plaintext never inserted
  });

  it("a user the IdP pushes passes the invite-only gate", () => {
    const sql = rd("supabase/migrations/20260887000000_scim.sql");
    expect(sql).toContain("NOT IN ('admin', 'scim')");
    expect(server).toContain('provisioned_by: "scim"');
  });

  it("every SCIM write is audited under the token's label", () => {
    for (const action of [
      "scim.user.create",
      "scim.user.update",
      "scim.user.deactivate",
      "scim.user.delete",
      "scim.group.create",
      "scim.group.update",
      "scim.group.delete",
    ]) {
      expect(server, action).toContain(`"${action}"`);
    }
    expect(server).toContain("actorEmail: `scim:${actor.label}`");
  });

  it("the SSO tab holds the tokens and the docs and README say SCIM exists", () => {
    expect(rd("src/routes/_authenticated/admin.iam.tsx")).toContain("<ScimCard");
    expect(rd("docs/IAM.md")).toContain("/api/scim/v2");
    expect(rd("src/routes/docs.iam.tsx")).toContain("scim");
    expect(rd("README.md")).not.toContain("No SCIM");
  });
});
