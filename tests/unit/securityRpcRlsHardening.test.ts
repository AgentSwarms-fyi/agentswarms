// Authorization hardening migration (security assessment 2026-10-25).
//
// There is no database in CI, so this pins the migration's text: the revokes
// and the ownership policies are a security boundary, and a later edit that
// drops one should fail here rather than silently re-open a cross-tenant hole.
// VA-2026-10-25-03/05/06/09.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  "supabase/migrations/20261025000000_security_rpc_rls_hardening.sql",
  "utf8",
);

describe("service-only SECURITY DEFINER RPCs are revoked from client roles", () => {
  // Every function that keys off a caller-supplied id/uid instead of auth.uid().
  for (const fn of [
    "match_gateway_cache",
    "increment_gateway_cache_hit",
    "ml_job_record_shard",
    "ml_job_advance_phase",
    "increment_ml_deployment_use",
    "record_ml_shadow_result",
    "record_ml_canary_result",
    "seed_bi_sample_dashboards",
    "seed_bi_sample_extras",
  ]) {
    it(`names ${fn} in the revoke set`, () => {
      expect(SQL).toContain(`'${fn}'`);
    });
  }

  it("revokes every overload from public, anon and authenticated, and keeps service_role", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION %s TO service_role");
    expect(SQL).toContain("oid::regprocedure"); // by signature, so new overloads are covered
    expect(SQL).not.toMatch(/REVOKE[^;]*service_role/);
  });

  it("fails the migration unless the revoke actually took", () => {
    // A name that matched nothing would have revoked nothing, silently.
    expect(SQL).toContain("RAISE EXCEPTION 'security hardening: no function named %', missing;");
    expect(SQL).toContain("has_function_privilege('anon', r.fn, 'EXECUTE')");
    expect(SQL).toContain("has_function_privilege('authenticated', r.fn, 'EXECUTE')");
    expect(SQL).toContain("NOT has_function_privilege('service_role', r.fn, 'EXECUTE')");
    expect(SQL).toContain("still callable by a client role");
  });
});

describe("the key-table policies are proved, not assumed", () => {
  it("fails the migration if either policy lacks its ownership check or another policy exists", () => {
    expect(SQL).toContain("ml_api_keys policy lacks the model-ownership check");
    expect(SQL).toContain("mcp_app_keys policy lacks the app-ownership check");
    // Permissive policies are OR'd, so a second one could reopen the hole.
    expect(SQL).toContain("expected exactly one policy on each key table");
  });
});

describe("api-key tables require ownership of the resource they name", () => {
  // The exact policy text, whitespace collapsed. A pattern that only looked
  // for the ownership subquery passed with `AND EXISTS` turned into
  // `OR EXISTS` — which lets the row-owner test alone admit a key naming
  // someone else's model, the very hole this closes. Pin the whole thing.
  const flat = SQL.replace(/\s+/g, " ");
  const ownsModel =
    "EXISTS ( SELECT 1 FROM public.ml_models m WHERE m.id = ml_api_keys.model_id AND m.user_id = auth.uid() )";
  const ownsApp =
    "EXISTS ( SELECT 1 FROM public.mcp_apps a WHERE a.id = mcp_app_keys.app_id AND a.user_id = auth.uid() )";

  it("ml_api_keys: the named model must belong to the caller, on read and on write", () => {
    expect(flat).toContain(
      `CREATE POLICY "Users manage own ml api keys" ON public.ml_api_keys FOR ALL` +
        ` USING ( auth.uid() = user_id AND ${ownsModel} )` +
        ` WITH CHECK ( auth.uid() = user_id AND ${ownsModel} );`,
    );
    // and the remediation removes keys planted on another user's model
    expect(flat).toContain(
      "DELETE FROM public.ml_api_keys k USING public.ml_models m WHERE m.id = k.model_id AND m.user_id <> k.user_id;",
    );
  });

  it("mcp_app_keys: the named app must belong to the caller, and no client-issued internal key", () => {
    expect(flat).toContain(
      `CREATE POLICY "Users manage own mcp app keys" ON public.mcp_app_keys FOR ALL` +
        ` USING ( auth.uid() = user_id AND ${ownsApp} )` +
        ` WITH CHECK ( auth.uid() = user_id AND is_internal = false AND ${ownsApp} );`,
    );
    expect(flat).toContain(
      "DELETE FROM public.mcp_app_keys k USING public.mcp_apps a WHERE a.id = k.app_id AND a.user_id <> k.user_id;",
    );
  });

  it("the migration refuses a deployed policy that combines its checks with OR", () => {
    expect(SQL).toContain(
      "IF position(' OR ' in p.qual) > 0 OR position(' OR ' in p.with_check) > 0 THEN",
    );
  });
});
