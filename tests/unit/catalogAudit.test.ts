// What a read of the migrated catalog found (R454).
//
// The behaviour was proved by attacking a real Postgres as its real roles, before and
// after, in a rolled-back transaction: docs/security/assessments/2026-11-06-schema.md.
// A unit test cannot run that, so these hold what would quietly undo it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const AUDIT = readFileSync("docs/security/scripts/schema-audit.sql", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20261110000000_catalog_audit_fixes.sql",
  "utf8",
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The audit's SQL, without its comments and psql's own commands. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.startsWith("--") && !l.startsWith("\\"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("the schema audit", () => {
  it("runs read-only, and rolls back", () => {
    const all = statements(AUDIT);
    expect(all[0].toLowerCase()).toBe("begin transaction read only");
    expect(all[all.length - 1].toLowerCase()).toBe("rollback");
  });

  it("does nothing but read", () => {
    const body = statements(AUDIT).slice(1, -1);
    expect(body.length).toBeGreaterThan(10);
    for (const statement of body) expect(statement).toMatch(/^select\s/i);
  });

  it("keeps an apostrophe out of its labels, where psql would read an open quote", () => {
    for (const line of AUDIT.split("\n").filter((l) => l.startsWith("\\echo"))) {
      expect(line).not.toContain("'");
    }
  });
});

describe("the R454 migration", () => {
  it("makes the spend guard refuse when it comes out NULL", () => {
    expect(MIGRATION).toMatch(/IF NOT COALESCE\(\s*\(_scope_type IS NULL AND _user_ids IS NULL/);
    expect(MIGRATION).toMatch(/'service_role',\s*false\s*\) THEN/);
  });

  it("guards every table with a sample flag, and proves that on apply", () => {
    const flagged = [
      "user_data_tables",
      "user_data_semantics",
      "knowledge_bases",
      "knowledge_documents",
      "kb_chunks",
      "kb_chunk_parents",
      "kb_sources",
      "kb_graph_entities",
      "kb_graph_mentions",
      "kb_graph_relations",
    ];
    for (const table of flagged) {
      expect(MIGRATION).toContain(
        `CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.${table}\n`,
      );
    }
    expect(MIGRATION).toContain("table(s) with is_sample have no guard");
  });

  it("allows the same avatars in the bucket as the page does, and no SVG", () => {
    const bucket = /ARRAY\[('image[^\]]+)\]/.exec(MIGRATION)?.[1];
    const page = readFileSync("src/components/settings/ProfileSettingsPanel.tsx", "utf8");
    const allowed = /AVATAR_TYPES = \[([^\]]+)\]/.exec(page)?.[1];
    const types = (list?: string) => list?.match(/image\/[a-z+]+/g);
    expect(types(bucket)).toEqual(types(allowed));
    expect(types(bucket)).not.toContain("image/svg+xml");
  });

  it("tells people the same types the page accepts", () => {
    const page = readFileSync("src/components/settings/ProfileSettingsPanel.tsx", "utf8");
    expect(page).toContain("PNG, JPEG, WebP or GIF, up to 5 MB.");
  });

  it("uses the same size limit in the bucket as in the page", () => {
    expect(MIGRATION).toContain("file_size_limit = 5242880");
    expect(readFileSync("src/components/settings/ProfileSettingsPanel.tsx", "utf8")).toContain(
      "file.size > 5 * 1024 * 1024",
    );
  });
});

describe("nothing still reaches what the migration removes", () => {
  it("no code calls the dropped sample functions", () => {
    const callers = walk("src").filter(
      (f) =>
        /\.tsx?$/.test(f) &&
        !f.endsWith(path.join("supabase", "types.ts")) &&
        /upsert_sample_dataset|insert_sample_rows/.test(readFileSync(f, "utf8")),
    );
    expect(callers).toEqual([]);
  });

  it("the contact form writes with the service role", () => {
    const route = readFileSync("src/routes/api/contact.ts", "utf8");
    expect(route).toContain("supabaseServiceKey");
    expect(route).not.toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY|SUPABASE_PUBLISHABLE_KEY/);
  });

  it("the browser asks only for its own spend, with no scope", () => {
    const client = readFileSync("src/lib/budgetSpendClient.ts", "utf8");
    expect(client).toMatch(/budget_spend_since", \{\s*_user_id: userId,\s*_since: since,\s*\}/);
  });
});
