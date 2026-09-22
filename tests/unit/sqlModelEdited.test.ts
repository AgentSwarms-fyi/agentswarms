// A model edited after its last build must not wear that build's stamps.
//
// FOUND FROM THE UI. "built · 9,994 rows" beside SQL that had just been
// replaced: the save writes the definition and none of the stamps, and the
// page read last_status as if it were about the row it sat on. The database
// now marks a definition change (a BEFORE UPDATE trigger, so no writer can
// skip it), the runner clears the mark only for a build that loaded that
// definition, and the page derives what it may claim from both.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { modelBuildState } from "@/lib/sqlModels";

const rd = (p: string) => readFileSync(p, "utf8");
const migration = rd("supabase/migrations/20260921000000_sql_models_edited_since_build.sql");
const runner = rd("src/utils/sqlModels/run.server.ts");
const page = rd("src/routes/_authenticated/sql-models.tsx");
const types = rd("src/integrations/supabase/types.ts");

describe("modelBuildState", () => {
  it("is 'never' for a model with no build and no edit", () => {
    expect(modelBuildState({ last_status: null })).toBe("never");
    expect(modelBuildState({ last_status: null, definition_changed_at: null })).toBe("never");
  });

  it("repeats the last outcome while the definition is the one that was built", () => {
    for (const s of ["built", "failed", "skipped"] as const) {
      expect(modelBuildState({ last_status: s, definition_changed_at: null })).toBe(s);
    }
  });

  it("is 'edited' once the definition changed, whatever the last build said", () => {
    // The whole round: a "built" that describes the previous definition.
    expect(
      modelBuildState({ last_status: "built", definition_changed_at: "2026-09-21T10:00:00Z" }),
    ).toBe("edited");
    expect(
      modelBuildState({ last_status: "failed", definition_changed_at: "2026-09-21T10:00:00Z" }),
    ).toBe("edited");
  });

  it("is 'edited' even when nothing was ever built — the stamps are absent, the edit is not", () => {
    expect(
      modelBuildState({ last_status: null, definition_changed_at: "2026-09-21T10:00:00Z" }),
    ).toBe("edited");
  });

  it("does not trust an unknown status", () => {
    expect(modelBuildState({ last_status: "running", definition_changed_at: null })).toBe("never");
  });
});

describe("the mark is set by the database", () => {
  const fn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.sql_model_mark_edited"),
  );

  it("in a BEFORE UPDATE trigger, so no writer can skip it", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS definition_changed_at timestamptz");
    expect(migration).toMatch(/BEFORE UPDATE ON public\.sql_models\s+FOR EACH ROW/);
    expect(migration).toContain("EXECUTE FUNCTION public.sql_model_mark_edited()");
  });

  it("on a change to anything a build vouches for", () => {
    for (const col of ["sql", "schema_name", "name", "materialization", "tests"]) {
      expect(fn, col).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
    expect(fn).toContain("NEW.definition_changed_at := now()");
  });

  it("and not on a change to what a build does not vouch for", () => {
    // A paused or rescheduled model still holds the table its last build wrote.
    for (const col of [
      "description",
      "tags",
      "schedule",
      "cron_expr",
      "timezone",
      "is_active",
      "next_run_at",
    ]) {
      expect(fn, col).not.toContain(`NEW.${col}`);
    }
  });

  it("is never cleared by the trigger itself", () => {
    // A trigger cannot tell a build that read the new definition from one
    // that started before the edit; the runner can (below).
    expect(fn).not.toContain("definition_changed_at := NULL");
  });
});

describe("the mark is cleared by the runner", () => {
  const stamp = runner.slice(runner.indexOf("async function stampModel"));

  it("only when the mark on the row is still the one this build loaded", () => {
    expect(stamp).toContain("markAtLoad: string | null");
    expect(stamp).toMatch(
      /\.update\(\{ definition_changed_at: null \}\)\s*\.eq\("id", id\)\s*\.eq\("definition_changed_at", markAtLoad\)/,
    );
    // Truthy, not `!== null`: a row from an un-migrated database has no mark
    // at all, and a guard on a column the database lacks fails the stamp.
    expect(stamp).toContain("if (markAtLoad) {");
    expect(stamp).not.toContain("markAtLoad !== null");
  });

  it("with the mark taken from the row the build was planned from", () => {
    // Both outcomes stamp; both pass the mark they loaded, not a fresh read.
    // Whitespace-tolerant: since R83 the call reads the stamp's answer and
    // prettier breaks its arguments across lines.
    expect(runner).toMatch(
      /await stampModel\(\s*model\.id,\s*outcome,\s*error,\s*rows,\s*ms,\s*model\.definition_changed_at,?\s*\)/,
    );
    expect(runner).toMatch(
      /await stampModel\(\s*model\.id,\s*"failed",\s*message,\s*null,\s*ms,\s*model\.definition_changed_at,?\s*\)/,
    );
    expect(runner).toContain("definition_changed_at: string | null;");
  });
});

describe("the page claims only what the state supports", () => {
  it("colours every dot from the state, never from last_status", () => {
    expect(page).toContain(
      "function StatusDot({ state, active }: { state: BuildState; active: boolean })",
    );
    expect(page).not.toMatch(/StatusDot\s+status=/);
    expect(page).not.toContain("StatusDot status=");
    expect((page.match(/<StatusDot state=\{modelBuildState\(m\)\}/g) ?? []).length).toBe(2);
    expect(page).toContain('<StatusDot state={selectedState ?? "never"}');
  });

  it("names an edited model as edited, and the previous build as the previous definition's", () => {
    expect(page).toContain("· not built since");
    expect(page).toContain("last build, of the previous definition:");
    // The time beside the status is the edit's, not the previous build's.
    expect(page).toMatch(
      /selectedState === "edited" && selected\.definition_changed_at\s*\?\s*`edited \$\{relTime\(selected\.definition_changed_at\)\}/,
    );
  });

  it("carries the column through the generated types", () => {
    const block = types.slice(
      types.indexOf("      sql_models: {"),
      types.indexOf("      Relationships: [];", types.indexOf("      sql_models: {")),
    );
    expect(block).toContain("definition_changed_at: string | null;");
    expect((block.match(/definition_changed_at\?: string \| null;/g) ?? []).length).toBe(2);
  });
});
