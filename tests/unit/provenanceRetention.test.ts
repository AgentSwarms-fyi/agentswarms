// Retention must not quietly destroy the evidence behind an answer.
//
// THE HAZARD. Retention was already configurable and knew nothing about what
// it deleted. Setting trace_retention_days to 30 removed traces that carried a
// decision_id -- the record behind an answer someone was given -- leaving the
// decision row pointing at nothing and its passport empty. Nobody would see
// that happen; they would just find, months later, that the evidence was gone.
//
// THE RULE. A row carrying a decision_id is held for at least
// provenance_retention_days (default 183: the EU AI Act Article 26(6)
// six-month deployer floor). The floor never SHORTENS retention -- where the
// ordinary window is longer, the longer window wins.
//
// These are asserted on the FILTERS actually sent to the database, because the
// bug this prevents is a missing filter, not a wrong number.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260849000000_provenance_retention.sql",
  "utf8",
);
const retention = readFileSync("src/utils/observability/retention.server.ts", "utf8");
const audit = readFileSync("src/utils/audit.server.ts", "utf8");

/** Strip comments: the prose in these files names every symbol asserted on. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the floor", () => {
  it("is a setting with the six-month default, not a hard-coded constant", () => {
    // An operator outside the EU AI Act's scope must be able to lower it, and
    // one keeping technical documentation to Article 18's ten years must be
    // able to raise it. What they cannot do is destroy evidence by accident.
    expect(migration).toMatch(/provenance_retention_days integer NOT NULL DEFAULT 183/);
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
  });

  it("says in the database what the number means", () => {
    // The next person to read this column should not have to guess why 183.
    expect(migration).toMatch(/COMMENT ON COLUMN public\.iam_settings\.provenance_retention_days/);
    expect(migration).toMatch(/Article 26\(6\)/);
  });
});

describe("trace purge", () => {
  it("splits the table by whether a row is evidence", () => {
    const c = code(retention);
    expect(c).toContain('q.not("decision_id", "is", null)');
    expect(c).toContain('q.is("decision_id", null)');
    // Both halves purged, on their own clocks.
    expect(c).toContain('purgeOlderThan("execution_traces", cutoff, false)');
    expect(c).toContain('purgeOlderThan("execution_traces", evidenceCutoff, true)');
  });

  it("takes the EARLIER cutoff, so a longer window is never shortened", () => {
    // The subtle one. Comparing day counts and taking the larger would be
    // equivalent here, but comparing timestamps and taking the earlier is what
    // actually means "keep longer" — and it stays correct if either input
    // changes shape.
    expect(code(retention)).toMatch(/Math\.min\(cutoffMs, now - floorDays \* 86_400_000\)/);
  });

  it("expires decisions with their evidence, never before it", () => {
    // A decision whose chain was deleted renders as an answer with no reads --
    // indistinguishable from an answer that genuinely read nothing. They go
    // together or not at all.
    const c = code(retention);
    expect(c).toContain('.from("decisions" as any) as any)');
    expect(c).toMatch(/\.delete\(\)\s*\.lt\("created_at", evidenceCutoff\)/);
  });

  it("defaults to the floor when the setting is absent", () => {
    expect(code(retention)).toContain("settings?.provenance_retention_days ?? 183");
  });
});

describe("audit purge", () => {
  it("holds evidence rows to the floor and ordinary rows to the window", () => {
    const c = code(audit);
    // Two deletes, each with its own cutoff AND its own decision_id filter.
    expect(c).toMatch(/\.lt\("created_at", cutoff\)\s*\.is\("decision_id", null\)/);
    expect(c).toMatch(/\.lt\("created_at", evidenceCutoff\)\s*\.not\("decision_id", "is", null\)/);
  });

  it("archives exactly what it deletes", () => {
    // Archiving a different set than the purge removes would lose rows with no
    // trace of the loss. One helper, called once per delete, with the same
    // cutoff and the same filter.
    const c = code(audit);
    expect(c).toContain("archive(cutoff, false)");
    expect(c).toContain("archive(evidenceCutoff, true)");
    expect(c).toMatch(
      /withDecision \? q\.not\("decision_id", "is", null\) : q\.is\("decision_id", null\)/,
    );
  });

  it("still refuses to delete what it could not archive", () => {
    // Pre-existing guarantee; the rewrite must not have dropped it.
    expect(code(audit)).toContain("if (!(await archive(cutoff, false))) return;");
    expect(code(audit)).toContain("if (!(await archive(evidenceCutoff, true))) return;");
  });
});
