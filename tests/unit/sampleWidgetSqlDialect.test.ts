// The browser SQL engine is DuckDB — sample-dashboard widget SQL must be the
// DuckDB dialect, or ↻ silently fails and widgets can only ever show their
// shipped snapshots (the AlaSQL-era regression repaired by
// 20260808000000_fix_sample_widget_sql_duckdb.sql).
//
// Guards two things:
//   1. Every sample-dashboard migration EXCEPT the two frozen AlaSQL-era ones
//      ships widget SQL free of the dialect problems DuckDB rejects:
//      [bracket] identifiers, strftime(format, value) argument order,
//      '+' string concatenation, and the DATE() scalar (not a DuckDB
//      function).
//   2. The repair migration is complete and honest: every "old" it replaces
//      still exists verbatim in a legacy migration, every flagged legacy SQL
//      has a replacement, and every "new" passes the same dialect rules.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIG = resolve(__dirname, "../../supabase/migrations");

// Frozen history: these two predate the DuckDB engine and are repaired by the
// fix migration below. Everything newer must be born clean.
const LEGACY = new Set([
  "20260721300000_bi_sample_dashboards.sql",
  "20260722000000_bi_samples_sports_health_energy.sql",
]);
const FIX_MIGRATION = "20260808000000_fix_sample_widget_sql_duckdb.sql";

/** All "sql" string values found in a migration's dollar-quoted JSON blobs. */
function widgetSqls(file: string): string[] {
  const s = readFileSync(resolve(MIG, file), "utf-8");
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.sql === "string" && o.sql) out.push(o.sql);
      Object.values(o).forEach(walk);
    }
  };
  for (const m of s.matchAll(/\$sample\$(.*?)\$sample\$/gs)) {
    const t = m[1].trim();
    if (!t.startsWith("[") && !t.startsWith("{")) continue;
    try {
      walk(JSON.parse(t));
    } catch {
      // Non-JSON blob (names, descriptions that happen to start with a brace).
    }
  }
  return out;
}

function dialectProblems(sql: string): string[] {
  const problems: string[] = [];
  if (/\[[^\]]*\]/.test(sql)) problems.push("bracket identifier");
  if (/strftime\(\s*'/.test(sql)) problems.push("strftime(format, value) argument order");
  if (/'\s*\+|\+\s*'/.test(sql)) problems.push("'+' string concatenation");
  if (/\bDATE\s*\(/.test(sql)) problems.push("DATE() scalar (DuckDB has no date() function)");
  return problems;
}

const sampleMigrations = readdirSync(MIG).filter(
  (f) => f.includes("bi_sample") && f.endsWith(".sql") && f !== FIX_MIGRATION,
);

const fixMap: { old: string; new: string }[] = (() => {
  const s = readFileSync(resolve(MIG, FIX_MIGRATION), "utf-8");
  const m = s.match(/\$map\$(.*?)\$map\$/s);
  if (!m) throw new Error("fix migration lost its $map$ block");
  return JSON.parse(m[1]);
})();

describe("sample dashboard widget SQL is DuckDB dialect", () => {
  it("finds the sample migrations (extraction is not vacuous)", () => {
    expect(sampleMigrations.length).toBeGreaterThanOrEqual(4);
    // The scan itself must see real SQL, or every assertion below is hollow.
    const total = sampleMigrations.reduce((n, f) => n + widgetSqls(f).length, 0);
    expect(total).toBeGreaterThan(80);
  });

  it("every migration after the AlaSQL era ships clean SQL", () => {
    for (const f of sampleMigrations) {
      if (LEGACY.has(f)) continue;
      for (const sql of widgetSqls(f)) {
        const problems = dialectProblems(sql);
        expect(problems, `${f}: ${sql}`).toEqual([]);
      }
    }
  });

  it("repair map: every replacement is clean SQL", () => {
    expect(fixMap.length).toBeGreaterThan(50);
    for (const { new: fixed } of fixMap) {
      expect(dialectProblems(fixed), fixed).toEqual([]);
    }
  });

  it("repair map is complete: every broken legacy SQL has a replacement", () => {
    const olds = new Set(fixMap.map((p) => p.old));
    for (const f of [...LEGACY]) {
      for (const sql of widgetSqls(f)) {
        if (dialectProblems(sql).length === 0) continue;
        expect(olds.has(sql), `${f} has unrepaired SQL: ${sql}`).toBe(true);
      }
    }
  });

  it("repair map is honest: every old SQL exists verbatim in a legacy migration", () => {
    const legacySqls = new Set([...LEGACY].flatMap((f) => widgetSqls(f)));
    for (const { old } of fixMap) {
      expect(legacySqls.has(old), `stale map entry: ${old}`).toBe(true);
    }
  });
});
