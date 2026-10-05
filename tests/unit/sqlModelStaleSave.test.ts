// Two tabs on one SQL model, and the editor's own Pause (R285, sweep 9). The
// save wrote the whole definition over whatever was stored: a save from a
// second tab undid the first's SQL, and the next Save after Pause resumed the
// model. Runs write this row too, so `updated_at` cannot say who changed it;
// the save now compares a fingerprint of the stored definition with the one
// the page opened. The fingerprint is tested as functions; the wiring is
// pinned by reading the server function and the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "@/lib/definitionFingerprint";
import { sqlModelDefinition, type SqlModelTest } from "@/lib/sqlModels";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const server = read("src/utils/sqlModels.functions.ts");
const page = read("src/routes/_authenticated/sql-models.tsx");

describe("canonicalJson", () => {
  it("reads the same whatever order the keys come in, at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: [2, { x: 2, y: 1 }] }, b: 1 }),
    );
  });

  it("keeps array order and leaves out undefined fields", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("fingerprintOf", () => {
  it("is 64 hex characters, equal for equal definitions and different for a changed one", async () => {
    const a = await fingerprintOf({ sql: "SELECT 1", n: [1, 2] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprintOf({ n: [1, 2], sql: "SELECT 1" })).toBe(a);
    expect(await fingerprintOf({ sql: "SELECT 2", n: [1, 2] })).not.toBe(a);
  });
});

describe("sqlModelDefinition", () => {
  const tests: SqlModelTest[] = [{ kind: "not_null", column: "id", severity: "error" }];
  const saved = {
    name: "r178_after",
    description: null,
    schema_name: "analytics",
    sql: "SELECT 1782 AS id",
    materialization: "table" as const,
    tests,
    tags: [],
    is_active: true,
    schedule: "manual",
    cron_expr: null,
    timezone: "UTC",
  };

  it("fingerprints a stored row as the save that wrote it, run state and jsonb key order aside", async () => {
    const storedRow = {
      ...saved,
      // jsonb hands the test object back with its keys in another order.
      tests: [{ severity: "error", column: "id", kind: "not_null" }] as SqlModelTest[],
      last_run_at: "2026-10-05T08:00:00+00:00",
      last_status: "built",
      next_run_at: null,
      definition_changed_at: null,
      updated_at: "2026-10-05T08:00:01+00:00",
    };
    expect(await fingerprintOf(sqlModelDefinition(storedRow))).toBe(
      await fingerprintOf(sqlModelDefinition(saved)),
    );
  });

  it("fills the same defaults a save writes", () => {
    expect(
      sqlModelDefinition({
        ...saved,
        description: undefined,
        tags: undefined,
        cron_expr: undefined,
        timezone: undefined,
      }),
    ).toEqual(sqlModelDefinition(saved));
  });

  it("changes with each field the editor saves, pausing included", async () => {
    const base = await fingerprintOf(sqlModelDefinition(saved));
    for (const change of [
      { sql: "SELECT 1782 AS id -- A285" },
      { description: "r285 B" },
      { is_active: false },
      { schedule: "daily" },
      { materialization: "view" as const },
    ]) {
      expect(await fingerprintOf(sqlModelDefinition({ ...saved, ...change }))).not.toBe(base);
    }
  });
});

describe("sqlModelSave and the list", () => {
  it("hands each model to the page with its definition's fingerprint", () => {
    expect(server).toMatch(
      /models\.map\(async \(m\) => \(\{\s*\.\.\.m,\s*fingerprint: await fingerprintOf\(sqlModelDefinition\(m\)\),?\s*\}\)\)/,
    );
  });

  it("refuses a save whose stored definition moved on since the page read it", () => {
    expect(server).toContain("expected_fingerprint: z.string().length(64).optional(),");
    expect(server).toMatch(
      /const stored = data\.id \? existing\.find\(\(m\) => m\.id === data\.id\) : undefined;\s*if \(stored && data\.expected_fingerprint\) \{\s*if \(\(await fingerprintOf\(sqlModelDefinition\(stored\)\)\) !== data\.expected_fingerprint\) \{\s*return \{\s*ok: false,\s*stale: true,/,
    );
    // Checked before anything is written.
    expect(server.indexOf("stale: true,")).toBeLessThan(server.indexOf(".update(patch)"));
  });

  it("lands only on the row it checked, and returns the fingerprint of what it wrote", () => {
    expect(server).toMatch(/if \(stored\) q = q\.eq\("updated_at", stored\.updated_at\);/);
    expect(server).toMatch(
      /fingerprint: await fingerprintOf\(\s*sqlModelDefinition\(\{ \.\.\.patch, tests: data\.tests as SqlModelTest\[\] \}\),?\s*\),/,
    );
  });
});

describe("the SQL models page", () => {
  it("opens a model with its fingerprint and sends it back, unless overwriting", () => {
    expect(page).toContain("openDraft(draftOf(m), m.fingerprint);");
    expect(page).toContain(
      "expected_fingerprint: overwrite ? undefined : (fingerprintRef.current ?? undefined),",
    );
    expect(page).toMatch(
      /if \(!res\.ok\) \{\s*if \(res\.stale\) setStale\(true\);\s*return toast\.error\(res\.error\);\s*\}\s*fingerprintRef\.current = res\.fingerprint;/,
    );
  });

  it("gives the open draft the setting Pause or Resume wrote", () => {
    expect(page).toMatch(
      /const row = fresh\?\.find\(\(x\) => x\.id === m\.id\);\s*if \(row && draft\?\.id === m\.id\) \{\s*setDraft\(\(d\) => \(d \? \{ \.\.\.d, is_active: row\.is_active \} : d\)\);[^]*?is_active: row\.is_active[^]*?fingerprintRef\.current = row\.fingerprint;/,
    );
  });

  it("says so, with Reload and Overwrite with mine", () => {
    expect(page).toMatch(/\{stale && \(\s*<div[^>]*data-testid="model-stale"/);
    expect(page).toMatch(/if \(row\) openDraft\(draftOf\(row\), row\.fingerprint\);[^]*?Reload/);
    expect(page).toMatch(/onClick=\{\(\) => void save\(true\)\}\s*>\s*Overwrite with mine/);
  });
});
