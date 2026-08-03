// The grant-type list exists in two places that must agree, and one of them is
// rewritten every time a feature becomes shareable.
//
// iamCreateGrant validates resource_type with a zod enum. The database enforces
// its own CHECK constraint, which has been DROPped and re-ADDed six times as
// features were added (secrets → bi_dashboard → semantic_model → catalog_source
// → provider_credential/integration → warehouse/saas connections). Nothing kept
// the two in step.
//
// They agree today — checked, not assumed. The failure this guards against is
// one-sided and quiet in opposite directions:
//   - a type in the app but not the DB: every grant of it fails on a CHECK
//     violation, in an admin screen, with a Postgres error string
//   - a type in the DB but not the app: dead surface nobody can reach
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const MIGRATIONS = "supabase/migrations";

/** Resource types the LAST migration to define the constraint permits. */
function dbGrantTypes(): string[] {
  // Filename order is apply order, so the final definition wins — the same way
  // Postgres sees it. An earlier migration permits only three types; reading
  // the first match rather than the last would be badly wrong.
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let last: string | null = null;
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS}/${f}`, "utf8");
    const idx = sql.lastIndexOf("ADD CONSTRAINT iam_resource_grants_resource_type_check");
    if (idx >= 0) last = sql.slice(idx, sql.indexOf(";", idx));
  }
  expect(last, "no migration defines the grant-type constraint").not.toBeNull();
  return [...last!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Resource types iamCreateGrant's zod enum accepts. */
function appGrantTypes(): string[] {
  const src = readFileSync("src/utils/iam.functions.ts", "utf8");
  const at = src.indexOf("export const iamCreateGrant");
  expect(at, "iamCreateGrant not found").toBeGreaterThan(-1);
  const enumAt = src.indexOf("resource_type: z.enum([", at);
  const body = src.slice(enumAt, src.indexOf("])", enumAt));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("the app and the database permit the same grant types", () => {
  it("has no type the database would reject", () => {
    // This direction is the painful one: the admin fills in the share dialog,
    // submits, and gets a CHECK constraint violation.
    expect([...appGrantTypes()].sort()).toEqual([...dbGrantTypes()].sort());
  });

  it("still covers the types features actually depend on", () => {
    // A guard that only compares two lists passes happily when both are
    // emptied. These are the types with enforcement paths in the codebase.
    const app = new Set(appGrantTypes());
    for (const t of [
      "knowledge_base",
      "data_table",
      "secret",
      "bi_dashboard",
      "semantic_model",
      "catalog_source",
      "integration",
      "provider_credential",
      "warehouse_connection",
      "saas_connection",
    ]) {
      expect(app.has(t), `${t} is no longer grantable`).toBe(true);
    }
  });
});

describe("every grantable type is enforced somewhere", () => {
  // A grant that no code reads is worse than no grant: the admin sees it
  // listed and believes access was given. Enforcement lives in three places —
  // the JS resolver, inline route queries, and RLS policies calling the
  // has_resource_access RPC — so all three are searched.
  const jsSources = [
    "src/utils/iam.server.ts",
    "src/utils/providers/credentials.server.ts",
    "src/utils/secrets.server.ts",
    "src/utils/data/sharedDatasets.server.ts",
    "src/routes/api/bi.direct-query.ts",
    "src/utils/integrations.functions.ts",
    "src/utils/bi.functions.ts",
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const sqlSources = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
    .join("\n");

  it("names each type in an enforcement path, not only in the grant editor", () => {
    for (const t of dbGrantTypes()) {
      const inJs = jsSources.includes(`"${t}"`);
      const inRls = sqlSources.includes(`has_resource_access('${t}'`);
      expect(inJs || inRls, `${t} grants are created but never read`).toBe(true);
    }
  });
});

describe("the two resolvers agree on what a grant means", () => {
  // resolveGrantedResourceIds (TypeScript) and has_resource_access (SQL) answer
  // the same question for different callers. Both must honour a direct user
  // grant AND a grant to a group the user belongs to; if one forgot groups,
  // access would depend on which code path happened to run.
  it("both honour user grants and group membership", () => {
    const ts = readFileSync("src/utils/iam.server.ts", "utf8");
    const resolver = ts.slice(ts.indexOf("export async function resolveGrantedResourceIds"));
    expect(resolver).toContain('principal_type === "user"');
    expect(resolver).toContain('principal_type === "group"');
    expect(resolver).toContain("groupIds.has(g.principal_id)");

    const iam = readFileSync(`${MIGRATIONS}/20260720000000_iam.sql`, "utf8");
    const fn = iam.slice(iam.indexOf("FUNCTION public.has_resource_access"));
    const body = fn.slice(0, fn.indexOf("$$;"));
    expect(body).toContain("g.principal_type = 'user'");
    expect(body).toContain("g.principal_type = 'group'");
    expect(body).toContain("iam_group_members");
  });
});
