// Code must not write an enum value the database refuses.
//
// notebook_runtime_sessions.kind has been CHECK (kind IN ('interactive',
// 'batch')) since 20260730000000. The MCP Builder, added later, runs each
// server as a session of kind 'service' — and no migration ever widened the
// constraint. Pressing Deploy therefore failed on every deployment, always,
// with the raw Postgres text shown to the user:
//
//   new row for relation "notebook_runtime_sessions" violates check
//   constraint "notebook_runtime_sessions_kind_check"
//
// Nothing caught it. tsc cannot see a database constraint, the tests never
// deployed an MCP server, and the symptom — 0 tools, an inactive dot, "0
// connected servers" — reads as "not set up yet" rather than "impossible".
//
// This compares the two sides that drifted: the values the CHECK allows, and
// the literals the code writes. Both are read from the repo, so it costs
// nothing and runs everywhere.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Values a column's CHECK permits, after every migration has been applied in
 * filename order — later ALTERs replace earlier ones, which is how the
 * constraint is widened (see 20260742000000 for the pattern).
 */
function allowedValues(table: string, column: string): Set<string> {
  const dir = resolve("supabase/migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let allowed: Set<string> | null = null;

  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    // Both shapes: an inline column CHECK in CREATE TABLE, and a later
    // ADD CONSTRAINT … CHECK (col IN (…)).
    const re = new RegExp(
      `${column}\\s+(?:text|varchar)[^,]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
      "is",
    );
    const alter = new RegExp(
      `ADD\\s+CONSTRAINT\\s+\\S*${column}_check[\\s\\S]{0,200}?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
      "i",
    );

    const mentionsTable = new RegExp(table, "i").test(sql);
    if (!mentionsTable) continue;

    const m = alter.exec(sql) ?? re.exec(sql);
    if (!m) continue;
    allowed = new Set(
      m[1]
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, ""))
        .filter(Boolean),
    );
  }
  return allowed ?? new Set<string>();
}

describe("notebook_runtime_sessions.kind", () => {
  const allowed = allowedValues("notebook_runtime_sessions", "kind");

  it("parses the constraint out of the migrations at all", () => {
    // Guard on the guard: an empty set would make every assertion below pass
    // vacuously, which is exactly how this bug survived.
    expect(allowed.size).toBeGreaterThan(1);
    expect(allowed.has("interactive")).toBe(true);
  });

  it("permits every kind the code actually writes", () => {
    // Every `kind: "…"` literal in a file that also touches this table.
    const written = new Map<string, string>();
    for (const file of walk(resolve("src"))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("notebook_runtime_sessions") && !/startSession\(/.test(src)) continue;
      for (const m of src.matchAll(/\bkind:\s*["']([a-z_]+)["']/g)) {
        written.set(m[1], file.replace(/\\/g, "/").split("/src/")[1]);
      }
    }

    expect(written.size, "found no kind literals — the scan needs re-anchoring").toBeGreaterThan(0);

    const rejected = [...written.entries()]
      .filter(([value]) => !allowed.has(value))
      .map(([value, file]) => `${file} writes kind "${value}"`);

    expect(
      rejected,
      `the CHECK allows [${[...allowed].join(", ")}]. Postgres will refuse these inserts:\n  ` +
        rejected.join("\n  "),
    ).toEqual([]);
  });

  it("allows 'service', which is what an MCP server runs as", () => {
    // Named on its own so a regression points at the feature it breaks rather
    // than at a generic list mismatch.
    expect(allowed.has("service")).toBe(true);
  });
});
