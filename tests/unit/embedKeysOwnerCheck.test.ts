// An embed key must name a resource its owner owns (R402, VA-2026-10-25-32).
//
// embed_keys' policy checked only that the KEY was the caller's, so a client
// could insert a key naming someone else's agent, swarm, BI dashboard or AI
// analyst, or point its own key at one with an UPDATE. The loaders re-check
// the owner, so nothing was served; this puts the rule where the row is
// written. There is no database in CI: the migration's text is pinned here
// and the migration proves its own policy on apply (a throwaway Postgres run
// is recorded in the assessment's status log).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync("supabase/migrations/20261101000000_embed_keys_owner_check.sql", "utf8");
const flat = SQL.replace(/\s+/g, " ");
const owns = (table: string, alias: string) =>
  `EXISTS ( SELECT 1 FROM public.${table} ${alias} WHERE ${alias}.id = embed_keys.resource_id AND ${alias}.user_id = auth.uid())`;

describe("the embed_keys policy", () => {
  it("lets the owner see every key of theirs, and write only keys naming what they own", () => {
    // The whole policy, pinned: `AND CASE` turned into `OR CASE` would let
    // the key-owner test alone admit a key naming someone else's resource.
    expect(flat).toContain(
      `CREATE POLICY "Users manage their own embed keys" ON public.embed_keys FOR ALL` +
        ` USING (auth.uid() = user_id)` +
        ` WITH CHECK ( auth.uid() = user_id AND CASE resource_type` +
        ` WHEN 'agent' THEN ${owns("agents", "a")}` +
        ` WHEN 'swarm' THEN ${owns("swarms", "s")}` +
        ` WHEN 'bi_dashboard' THEN ${owns("bi_dashboards", "d")}` +
        ` WHEN 'ai_analyst' THEN ${owns("ai_analysts", "x")}` +
        ` ELSE false END );`,
    );
  });

  it("covers every resource type a key may name", () => {
    // The column's CHECK lists the types; a new one must get a branch here,
    // or its keys could not be written at all (ELSE false), not silently pass.
    const types = readFileSync("supabase/migrations/20260830000000_embed_ai_analyst.sql", "utf8")
      .match(/CHECK \(resource_type IN \(([^)]*)\)\)/)?.[1]
      .match(/'[a-z_]+'/g);
    expect(types).toEqual(["'agent'", "'swarm'", "'bi_dashboard'", "'ai_analyst'"]);
    for (const t of types!) expect(flat).toContain(`WHEN ${t} THEN EXISTS`);
  });

  it("removes keys already naming someone else's resource, and leaves orphans to their owner", () => {
    for (const [type, table, alias] of [
      ["agent", "agents", "a"],
      ["swarm", "swarms", "s"],
      ["bi_dashboard", "bi_dashboards", "d"],
      ["ai_analyst", "ai_analysts", "x"],
    ]) {
      expect(flat).toContain(
        `(k.resource_type = '${type}' AND EXISTS (SELECT 1 FROM public.${table} ${alias} WHERE ${alias}.id = k.resource_id AND ${alias}.user_id <> k.user_id))`,
      );
    }
    // Only cross-owner keys: no "resource missing" clause in the DELETE.
    const del = flat.slice(
      flat.indexOf("DELETE FROM public.embed_keys"),
      flat.indexOf("GET DIAGNOSTICS"),
    );
    expect(del).not.toMatch(/NOT EXISTS/);
  });

  it("fails the migration if the deployed policy is not this one", () => {
    expect(flat).toContain("expected exactly one policy on embed_keys");
    expect(flat).toContain("embed_keys policy lacks the resource-ownership check");
    expect(flat).toContain("embed_keys policy combines its checks with OR");
    // As a word: Postgres prints `... OR` and then the CASE on the next line,
    // so the ' OR ' search R375 uses let an OR-ed version of this policy pass
    // in a throwaway Postgres.
    expect(SQL).toContain("IF p.with_check ~ '\\mOR\\M' THEN");
    expect(SQL).not.toContain("position(' OR ' in p.with_check)");
  });
});

describe("the embed form", () => {
  it("offers only the caller's own resources to embed", () => {
    const ui = readFileSync("src/components/embed/EmbedSection.tsx", "utf8");
    for (const t of ["agents", "swarms", "bi_dashboards", "ai_analysts"]) {
      expect(ui).toContain(`supabase.from("${t}").select("id, name").eq("user_id", uid)`);
    }
  });
});
