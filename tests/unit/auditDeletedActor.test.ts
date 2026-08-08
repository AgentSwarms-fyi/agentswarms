// The audit trail outlives the account, and the page has to survive that.
//
// Migration 20260781000000 made this deliberate: it dropped NOT NULL on
// audit_events.user_id, re-pointed the FK at ON DELETE SET NULL, and added
// actor_email so a deleted subject's rows stay attributable. Nothing downstream
// was updated — AuditRow still typed user_id as `string`, the query never
// selected actor_email, and the table rendered `r.user_id.slice(0, 8)`.
//
// One deleted user therefore took the WHOLE PAGE down with "Cannot read
// properties of null (reading 'slice')" — the app has no per-component error
// boundary, only the router's per-route one. Found on a live instance with 705
// such rows.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FN = readFileSync(resolve("src/utils/audit.functions.ts"), "utf8");
const UI = readFileSync(resolve("src/components/observability/AuditLog.tsx"), "utf8");
const TYPES = readFileSync(resolve("src/integrations/supabase/types.ts"), "utf8");
const MIGRATION = readFileSync(
  resolve("supabase/migrations/20260781000000_audit_integrity.sql"),
  "utf8",
);

describe("a deleted actor is a normal state, not a crash", () => {
  it("the migration really does allow a null user_id", () => {
    // If this ever stops being true the rest of these tests are guarding
    // nothing, so it is asserted rather than assumed.
    expect(MIGRATION).toMatch(/ALTER COLUMN user_id DROP NOT NULL/);
    expect(MIGRATION).toMatch(/ON DELETE SET NULL/);
  });

  it("AuditRow types user_id as nullable", () => {
    const row = FN.slice(FN.indexOf("export type AuditRow"), FN.indexOf("const FETCH_CAP"));
    expect(row).toMatch(/user_id: string \| null/);
  });

  it("the generated types agree with the database", () => {
    // types.ts said `user_id: string` and had no actor_email at all, so
    // TypeScript happily accepted the code that crashed at runtime.
    const blk = TYPES.slice(TYPES.indexOf("      audit_events: {"));
    const row = blk.slice(blk.indexOf("Row: {"), blk.indexOf("Insert: {"));
    expect(row).toMatch(/user_id: string \| null/);
    expect(row).toMatch(/actor_email: string \| null/);
  });

  it("selects actor_email, which exists for exactly this purpose", () => {
    expect(FN).toMatch(/select\(\s*\n?\s*"id, user_id, actor_email,/);
    expect(FN).toMatch(/emailFor\(e\.user_id\) \?\? e\.actor_email \?\? null/);
  });

  it("email lookup tolerates a null id", () => {
    expect(FN).toMatch(/const emailFor = \(uid: string \| null\)/);
  });

  it("never dereferences user_id unguarded in the table", () => {
    // The actual crash site. Match the BUGGY SHAPE — `?? r.user_id.slice` —
    // rather than the substring `r.user_id.slice`, which the guarded ternary
    // legitimately contains too. The first version of this test failed on the
    // fix itself.
    expect(UI).not.toMatch(/\?\?\s*r\.user_id\.slice/);
    expect(UI).toMatch(/r\.user_id \? r\.user_id\.slice\(0, 8\) : "deleted account"/);
  });
});
