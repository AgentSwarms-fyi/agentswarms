// Sharing a warehouse connection through IAM.
//
// A shared connection is the one place in this codebase where widening a
// filter widens access to a CREDENTIAL. Everything here is about the two ways
// that goes wrong: a grantee reaching a connection nobody granted them, and a
// grantee receiving the credential rather than merely the use of it.
//
// The query is built as a PostgREST filter string, so these read the source.
// That is unusual in a test and it is the only way to check a decision that
// otherwise needs a live database and two real tenants.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const loaderSrc = readFileSync("src/utils/warehouse/connections.server.ts", "utf8");
const iamSrc = readFileSync("src/utils/iam.server.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260778000000_connection_grants.sql", "utf8");

describe("the grant is the only thing that widens access", () => {
  it("falls back to owner-only when no grants are passed", () => {
    // The default must stay exactly what it was before sharing existed.
    expect(loaderSrc).toContain('query.eq("user_id", ownerUserId)');
  });

  it("widens to owner-OR-granted only when ids are supplied", () => {
    expect(loaderSrc).toContain('user_id.eq.${ownerUserId},id.in.(${granted.join(",")})');
  });

  it("does NOT resolve the grant itself", () => {
    // Deliberate: the caller has to go and fetch the grant. A loader that
    // looked it up would silently widen every existing call site — including
    // the service-role ones, where RLS is off.
    // Matches a CALL, not a mention: the doc comment names the function the
    // caller is expected to use, and an over-broad check would flag that.
    const fn = loaderSrc.slice(loaderSrc.indexOf("export async function loadWarehouseConnection"));
    expect(fn).not.toMatch(/resolveGrantedResourceIds\s*\(/);
  });

  it("validates every granted id as a uuid before interpolating it", () => {
    // `id.in.(…)` is a filter STRING. An unvalidated value there is an
    // injection into the query, not merely a row that fails to match.
    expect(loaderSrc).toContain("UUID_RE.test(x)");
    expect(loaderSrc).toMatch(/const UUID_RE = \/\^\[0-9a-f\]\{8\}/);
  });

  it("keeps the owner filter when the granted list is empty after validation", () => {
    // A list of nothing but malformed ids must not degrade into "no filter".
    expect(loaderSrc).toContain("granted.length");
  });
});

describe("a grantee uses the connection without receiving it", () => {
  it("resolves secret references as the OWNER, not the caller", () => {
    // On a shared connection those differ. Resolving as the caller looks up
    // {{secret:PROD_PW}} in the GRANTEE's vault — finding nothing, or worse a
    // different secret that happens to share the name.
    expect(loaderSrc).toContain("const secretScope = row.user_id ?? ownerUserId");
    expect(loaderSrc).toContain("resolveSecretRefsInObject(\n      secretScope,");
  });

  it("reports whether the connection was reached by grant", () => {
    // Callers need this to mark a shared connection read-only in the UI.
    expect(loaderSrc).toContain("shared: !!ownerUserId && row.user_id !== ownerUserId");
  });

  it("returns config but never the stored ciphertext", () => {
    const ret = loaderSrc.slice(loaderSrc.lastIndexOf("return {"));
    expect(ret).not.toContain("credentials");
    expect(ret).not.toContain("ciphertext");
  });
});

describe("the migration", () => {
  it("permits the two new grant types", () => {
    expect(migration).toContain("'warehouse_connection'");
    expect(migration).toContain("'saas_connection'");
  });

  it("keeps every previously grantable type", () => {
    // A DROP + ADD that forgot one would silently revoke live grants.
    for (const t of [
      "knowledge_base",
      "data_table",
      "secret",
      "bi_dashboard",
      "semantic_model",
      "catalog_source",
      "integration",
      "provider_credential",
    ]) {
      expect(migration, `${t} dropped from the grantable list`).toContain(`'${t}'`);
    }
  });

  it("adds NO row-level policy to the connection tables", () => {
    // Unlike semantic_models, these rows carry the encrypted credential. An
    // RLS SELECT policy for grantees would let them fetch that ciphertext
    // straight from PostgREST with their own JWT.
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*data_warehouse_connections/i);
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*saas_connections/i);
  });
});

describe("resolveGrantedResourceIds accepts the new types", () => {
  it("lists them in its resourceType union", () => {
    expect(iamSrc).toContain('| "warehouse_connection"');
    expect(iamSrc).toContain('| "saas_connection"');
  });
});
