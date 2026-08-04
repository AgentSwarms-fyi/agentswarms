// Authorization on the API routes that were never audited.
//
// build-graph, skills.generate, templates.provision and the integration test
// adapters. All four hold up; none of the properties is enforced by anything,
// and each is the kind that is one refactor away from silently going missing.
//
// The interesting one is build-graph: it uses the SERVICE ROLE to write, which
// means RLS is not there to catch a missing check. It does the check itself,
// explicitly, and that explicitness is exactly what a future edit could drop
// without any test noticing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("build-graph authorises before it writes with the service role", () => {
  const src = readFileSync("src/routes/api/kb/build-graph.ts", "utf8");

  it("resolves the caller from their own token", () => {
    expect(src).toMatch(/userClient\.auth\.getUser\(\)/);
    expect(src).toMatch(
      /if \(!user\) return Response\.json\(\{ error: "Not signed in" \}, \{ status: 401 \}\)/,
    );
  });

  it("compares the knowledge base's owner to that caller", () => {
    // RLS cannot help here — the read and the writes are service-role. If this
    // comparison goes, any signed-in user can rebuild (and first WIPE) any
    // other tenant's graph.
    expect(src, "the ownership comparison is gone").toMatch(
      /if \(kb\.user_id !== user\.id\)[\s\S]{0,120}status: 403/,
    );
  });

  it("refuses sample knowledge bases", () => {
    // They are shared across every account, so "owner" does not mean anything
    // for them and a rebuild would affect everyone.
    expect(src).toMatch(/if \(kb\.is_sample\)/);
  });

  it("checks before ANY destructive step, not just the known one", () => {
    // The build wipes the prior graph. Ordering is the property: a check that
    // runs after the delete has authorised nothing.
    //
    // Keyed to the FIRST mutating call of any shape, not to the current
    // formatting of the known wipe. A version of this that searched for
    // `.from("kb_graph_entities")\n .delete()` survived a mutation inserting a
    // single-line delete above the check — it simply could not see the new
    // one, and reported the untouched original as still correctly ordered.
    const check = src.indexOf("if (kb.user_id !== user.id)");
    expect(check, "the ownership comparison is gone").toBeGreaterThan(-1);

    const mutating = [...src.matchAll(/\.(delete|update|insert|upsert)\(/g)].map((m) => ({
      at: m.index!,
      op: m[1],
    }));
    expect(mutating.length, "no mutating calls found to order against").toBeGreaterThan(0);
    const first = mutating[0];
    expect(
      check,
      `a .${first.op}() runs before the caller is authorised (offset ${first.at})`,
    ).toBeLessThan(first.at);
  });
});

describe("skills.generate bounds what a caller can ask for", () => {
  const src = readFileSync("src/routes/api/skills.generate.ts", "utf8");

  it("requires a signed-in user", () => {
    expect(src).toMatch(/if \(!token\) return json\(\{ error: "Unauthorized" \}, 401\)/);
    expect(src).toMatch(/if \(!user\) return json\(\{ error: "Unauthorized" \}, 401\)/);
  });

  it("caps the brief and rate-limits the endpoint", () => {
    // It spends model tokens per call, so an uncapped brief or an unlimited
    // rate is someone else's bill.
    expect(src).toMatch(/brief\.length > \d+/);
    expect(src).toMatch(/429/);
  });

  it("accepts only an allow-listed provider", () => {
    // The provider selects the transport that gets fetched. An arbitrary
    // string here would be choosing the destination.
    expect(src).toMatch(/isBiCompatProvider\(provider\)/);
    expect(src).toMatch(/can't be used to generate skills/);
  });
});

describe("templates.provision writes as the caller", () => {
  const src = readFileSync("src/routes/api/templates.provision.ts", "utf8");

  it("uses an RLS-scoped client rather than the service role", () => {
    // Provisioning creates agents, documents and approvals. Under the caller's
    // own token, RLS decides where they land; with the service role it would
    // be whatever user_id the code happened to pass.
    expect(src, "provisioning now uses the service role").not.toContain("supabaseAdmin");
    expect(src).toMatch(/function getUserSupabase\(authToken: string\)/);
    expect(src).toMatch(/getUserSupabase\(token\)/);
  });
});

describe("integration tests reach user-supplied hosts through the SSRF guard", () => {
  const src = readFileSync("src/utils/integrations/testAdapters.server.ts", "utf8");

  it("routes guardedFetch through safeFetch, with a timeout", () => {
    // Every credential test dials a base_url / endpoint / instance_url the
    // USER typed, from inside the server's network.
    expect(src).toMatch(/export async function guardedFetch/);
    expect(src).toMatch(
      /return safeFetch\(url, \{ \.\.\.init, signal: AbortSignal\.timeout\(timeoutMs\) \}\)/,
    );
  });

  it("leaves only fixed-host calls on plain fetch", () => {
    // One exception exists (Firecrawl, a constant host). Anything else on
    // plain fetch is a user-supplied URL escaping the guard.
    const plain = [...src.matchAll(/(?<!safe)\bawait fetch\(\s*([^\n,)]+)/g)].map((m) =>
      m[1].trim(),
    );
    for (const target of plain) {
      expect(target, `plain fetch on a non-literal target: ${target}`).toMatch(/^["'`]https:\/\//);
    }
  });
});
