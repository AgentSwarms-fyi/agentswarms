// Source-based access control for KB retrieval.
//
// The rule under test is the one place that decides whether a candidate
// document reaches the model: isDocVisibleToPrincipal, called from
// retrieveCitationsServer's 4b step for BOTH the vector and keyword paths.
// The stakes are asymmetric — a wrong deny loses a citation, a wrong allow
// hands a private Drive document to an anonymous embed visitor — so every
// deny-side rule here is exercised explicitly.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isDocVisibleToPrincipal } from "@/utils/tools/kb.server";

const KB_SERVER = readFileSync("src/utils/tools/kb.server.ts", "utf8");
const EMBED_CHAT = readFileSync("src/routes/api/embed.chat.ts", "utf8");
const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function doc(overrides: {
  source_id?: string | null;
  acl?: string[] | null;
  scope?: string;
  owner?: string | null;
}) {
  const hasSource = overrides.source_id !== null;
  return {
    id: "doc-1",
    source_id: hasSource ? (overrides.source_id ?? "src-1") : null,
    acl_principals: overrides.acl ?? null,
    source: hasSource
      ? { access_scope: overrides.scope ?? "inherit", user_id: overrides.owner ?? OWNER }
      : null,
  };
}

describe("documents outside the connector system are untouched", () => {
  it("a legacy document with no source is visible to everyone", () => {
    const d = doc({ source_id: null });
    expect(isDocVisibleToPrincipal(d, OWNER, "owner@x.com")).toBe(true);
    expect(isDocVisibleToPrincipal(d, OTHER, "other@x.com")).toBe(true);
    expect(isDocVisibleToPrincipal(d, null, null)).toBe(true); // anonymous
  });

  it("'inherit' reproduces pre-ACL behaviour exactly", () => {
    const d = doc({ scope: "inherit" });
    expect(isDocVisibleToPrincipal(d, OTHER, null)).toBe(true);
    expect(isDocVisibleToPrincipal(d, null, null)).toBe(true);
  });
});

describe("'private' scope", () => {
  it("is visible to the connecting user", () => {
    expect(isDocVisibleToPrincipal(doc({ scope: "private" }), OWNER, null)).toBe(true);
  });

  it("is invisible to another signed-in user", () => {
    expect(isDocVisibleToPrincipal(doc({ scope: "private" }), OTHER, "other@x.com")).toBe(false);
  });

  it("is invisible to an anonymous embed visitor", () => {
    expect(isDocVisibleToPrincipal(doc({ scope: "private" }), null, null)).toBe(false);
  });
});

describe("'source_acl' scope mirrors the provider's sharing", () => {
  it("always lets the source owner through", () => {
    expect(isDocVisibleToPrincipal(doc({ scope: "source_acl", acl: [] }), OWNER, null)).toBe(true);
  });

  it("matches an exact email, case-insensitively", () => {
    const d = doc({ scope: "source_acl", acl: ["person@company.com"] });
    expect(isDocVisibleToPrincipal(d, OTHER, "person@company.com")).toBe(true);
    expect(isDocVisibleToPrincipal(d, OTHER, "Person@Company.COM")).toBe(true);
    expect(isDocVisibleToPrincipal(d, OTHER, "someone-else@company.com")).toBe(false);
  });

  it("matches domain entries against the email's domain", () => {
    const d = doc({ scope: "source_acl", acl: ["domain:company.com"] });
    expect(isDocVisibleToPrincipal(d, OTHER, "anyone@company.com")).toBe(true);
    expect(isDocVisibleToPrincipal(d, OTHER, "anyone@other.com")).toBe(false);
    // A domain entry must not be fooled by a lookalike local part.
    expect(isDocVisibleToPrincipal(d, OTHER, "company.com@evil.com")).toBe(false);
  });

  it("public-at-provider ('*') is visible to everyone, anonymous included", () => {
    const d = doc({ scope: "source_acl", acl: ["*"] });
    expect(isDocVisibleToPrincipal(d, null, null)).toBe(true);
    expect(isDocVisibleToPrincipal(d, OTHER, null)).toBe(true);
  });

  it("'org' entries do NOT match non-owners — tenant membership is unverifiable", () => {
    const d = doc({ scope: "source_acl", acl: ["org"] });
    expect(isDocVisibleToPrincipal(d, OTHER, "person@company.com")).toBe(false);
    expect(isDocVisibleToPrincipal(d, null, null)).toBe(false);
  });

  it("no ACL from the provider means owner-only, not open", () => {
    for (const acl of [null, []]) {
      const d = doc({ scope: "source_acl", acl });
      expect(isDocVisibleToPrincipal(d, OTHER, "person@company.com")).toBe(false);
      expect(isDocVisibleToPrincipal(d, OWNER, null)).toBe(true);
    }
  });

  it("a principal with no email cannot match email or domain entries", () => {
    const d = doc({ scope: "source_acl", acl: ["person@company.com", "domain:company.com"] });
    expect(isDocVisibleToPrincipal(d, OTHER, null)).toBe(false);
  });
});

describe("the filter is wired where it must be", () => {
  it("embed chat marks its visitors anonymous, whatever userId resolves creds", () => {
    // userId there is the KEY OWNER; without this flag every private connector
    // document would be retrievable by anyone holding the embed URL.
    expect(EMBED_CHAT).toContain("principal: { anonymous: true }");
  });

  it("chat passes the asker's email for provider-ACL matching", () => {
    expect(CHAT).toContain("principal: { email: principalEmail }");
  });

  it("anonymous principals never inherit the credential user's identity", () => {
    expect(KB_SERVER).toMatch(
      /opts\.principal\?\.anonymous\s*\?\s*null\s*:\s*\(opts\.scopeUserId \?\? opts\.userId \?\? null\)/,
    );
  });

  it("filters before the re-ranker, so restricted text never reaches it", () => {
    const filterAt = KB_SERVER.indexOf("Source-based access control");
    const rerankAt = KB_SERVER.indexOf("if (reranker && merged.length > 1");
    expect(filterAt).toBeGreaterThan(-1);
    expect(rerankAt).toBeGreaterThan(-1);
    expect(filterAt).toBeLessThan(rerankAt);
  });

  it("drops candidates the ACL query could not judge", () => {
    expect(KB_SERVER).toContain("if (!row) return false;");
  });
});
