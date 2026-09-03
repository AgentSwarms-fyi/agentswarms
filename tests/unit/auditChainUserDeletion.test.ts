// Deleting a user must not rewrite the audit trail.
//
// THE COLLISION. Two features, each right on its own, that contradicted each
// other on a live instance:
//
//   audit_events.user_id was ON DELETE SET NULL, so "the trail outlives the
//   account" — a deleted person's actions stay on record.
//
//   user_id is one of the fields hashed into the audit chain, so an event
//   cannot be silently re-attributed to someone else.
//
// Together, deleting ONE account rewrote a hashed field on every row that
// account had produced, and audit_chain_verify() then reported "an event was
// altered or removed" — from the first such row, forever. Measured before the
// fix: 167 rows with a NULL user_id, the earliest at chain_seq 324, and
// verification reporting the break at exactly 324.
//
// A compliance check that cries wolf is worse than none: the operator learns
// to dismiss the one signal meant to tell them the trail cannot be trusted.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260850000000_audit_chain_survives_user_deletion.sql",
  "utf8",
);
const chain = readFileSync("supabase/migrations/20260762000000_audit_hash_chain.sql", "utf8");
const fns = readFileSync("src/utils/audit.functions.ts", "utf8");

/** Strip comments: the prose in these files names every symbol asserted on. */
const code = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");

describe("the fix", () => {
  it("removes the constraint that rewrote history", () => {
    // Not "re-point it at something else": an append-only trail should have no
    // constraint whose job is to edit rows when another table changes.
    expect(code(migration)).toMatch(
      /ALTER TABLE public\.audit_events\s*DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey/,
    );
  });

  it("does not re-add a cascade or a null-out by another name", () => {
    expect(code(migration)).not.toMatch(/ON DELETE (CASCADE|SET NULL)/i);
    expect(code(migration)).not.toMatch(/ADD CONSTRAINT audit_events_user_id_fkey/);
  });

  it("leaves the column nullable, because the damaged rows cannot be repaired", () => {
    // The value that would verify those 167 rows was destroyed with the
    // account. Forcing NOT NULL now would either fail or invent data.
    expect(code(migration)).not.toMatch(/SET NOT NULL/i);
  });

  it("records why the column has no foreign key, where the next person will look", () => {
    expect(migration).toMatch(/COMMENT ON COLUMN public\.audit_events\.user_id/);
    expect(migration).toMatch(/append-only/i);
  });
});

describe("why it mattered", () => {
  it("user_id really is hashed into the chain", () => {
    // If this stops being true the whole hazard disappears — and so should the
    // migration above. Pinned so the two cannot drift apart silently.
    expect(chain).toMatch(/COALESCE\(NEW\.user_id::text, ''\)/);
  });
});

describe("reporting a break", () => {
  it("offers the benign cause when the broken row shows it", () => {
    const c = code(fns);
    expect(c).toContain("let likelyCause: string | null = null;");
    expect(c).toContain("broken.user_id === null");
    expect(c).toMatch(/likelyCause,?\s*\}/);
  });

  it("only offers it when the evidence fits", () => {
    // A blanket excuse attached to every break would be worse than the bare
    // accusation: it would explain away real tampering.
    const c = code(fns);
    const at = c.indexOf("likelyCause =");
    expect(at).toBeGreaterThan(-1);
    expect(c.slice(0, at)).toContain("if (broken && broken.user_id === null)");
  });
});
