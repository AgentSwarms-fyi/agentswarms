// What makes an audit log worth having.
//
// Two defects, both of the kind that only surface when someone actually needs
// the log — which is the worst time to find out.
//
//   1. user_id was `REFERENCES auth.users(id) ON DELETE CASCADE`, and
//      iamDeleteUser calls auth.admin.deleteUser(). Removing an account
//      therefore erased the record of everything that account had ever done.
//      "Offboard the departing employee" and "destroy the evidence" were the
//      same button, and nothing said so.
//
//   2. The INSERT policy was `WITH CHECK (auth.uid() = user_id)` — any browser
//      could write ANY action string attributed to itself. A user could
//      fabricate an `iam.access.grant` in their own trail, or flood the table
//      to push real entries out through retention.
//
// Retention was already right: migration 20260735000000 moved the default from
// 14 days to 365 AND back-filled existing rows, and expiring rows are emitted
// as NDJSON before deletion so a log shipper keeps them.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const MIGRATION = "supabase/migrations/20260781000000_audit_integrity.sql";
const sql = readFileSync(MIGRATION, "utf8");
const emitter = readFileSync("src/utils/audit.server.ts", "utf8");

/**
 * The migration with its comments stripped.
 *
 * The header quotes the OLD definition to explain what was wrong with it, so
 * an assertion that "ON DELETE CASCADE no longer appears" matches the
 * explanation and fails against correct code. Assertions about what the schema
 * DOES go through here; assertions about what it SAYS use the raw text.
 */
const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("the trail outlives its subject", () => {
  it("no longer cascades a user deletion into the audit log", () => {
    expect(ddl).toMatch(/DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey/);
    expect(ddl).toMatch(/REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(ddl, "the cascade is back").not.toMatch(/ON DELETE CASCADE/);
  });

  it("allows the orphaned row to exist at all", () => {
    // SET NULL against a NOT NULL column fails the delete instead — which
    // would block user deletion entirely rather than preserve the trail.
    expect(sql).toMatch(/ALTER COLUMN user_id DROP NOT NULL/);
  });

  it("keeps attribution after the account is gone", () => {
    // A NULL user_id with nothing beside it is an unattributable row, which is
    // not much better than deleting it.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS actor_email text/);
    expect(emitter).toContain("actor_email");
  });

  it("shows orphaned rows only to superadmins", () => {
    // There is no owner left to show them to, and they must not become
    // invisible either — that would be the cascade by another route.
    const policy = sql.slice(sql.indexOf('CREATE POLICY "View own or all audit events"'));
    const body = policy.slice(0, policy.indexOf(";"));
    expect(body).toMatch(/user_id IS NOT NULL AND auth\.uid\(\) = user_id/);
    expect(body).toMatch(/is_superadmin/);
  });
});

describe("the subject cannot write their own trail", () => {
  it("restricts browser inserts to a named list of actions", () => {
    const policy = sql.slice(sql.indexOf('CREATE POLICY "Insert own audit events"'));
    const body = policy.slice(0, policy.indexOf(";"));
    expect(body).toMatch(/auth\.uid\(\) = user_id/);
    expect(body).toMatch(/action IN \(SELECT a\.action FROM public\.audit_client_actions a\)/);
  });

  it("keeps that list in a table, so adding to it is reviewable", () => {
    // A literal list inside the policy would be edited in a migration nobody
    // reads as a permission change.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.audit_client_actions/);
    expect(sql).toMatch(/'dataset\.query'/);
  });

  it("does not let a client add to the allow-list itself", () => {
    // RLS on, SELECT policy only: no INSERT/UPDATE/DELETE policy exists, so
    // those are denied for every non-service role.
    const section = sql.slice(sql.indexOf("audit_client_actions ENABLE ROW LEVEL SECURITY"));
    const upToNext = section.slice(0, section.indexOf('DROP POLICY IF EXISTS "Insert own audit'));
    expect(upToNext).toMatch(/FOR SELECT/);
    expect(upToNext).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it("excludes governance actions a client should never emit", () => {
    // The forgery that mattered: an entry that looks like the server granted
    // someone access.
    const list = sql.slice(
      sql.indexOf("INSERT INTO public.audit_client_actions"),
      sql.indexOf("ON CONFLICT (action)"),
    );
    for (const forbidden of ["iam.", "swarm.api_key", "provider_credential"]) {
      expect(list, `${forbidden} is client-writable`).not.toContain(forbidden);
    }
  });
});

describe("entries are append-only once written", () => {
  it("defines no UPDATE or DELETE policy on the events table", () => {
    // With RLS enabled and no policy, the operation is denied outright. That
    // is what makes a written entry immutable for everyone but the purge,
    // which runs under the service role.
    const events = sql
      .split("\n")
      .filter((l) => /ON public\.audit_events/.test(l))
      .join("\n");
    expect(events).not.toMatch(/FOR (UPDATE|DELETE|ALL)/);
  });

  it("says so, so nobody adds one by accident", () => {
    expect(sql).toMatch(/No UPDATE or DELETE policy on audit_events, deliberately/);
  });
});

describe("the emitter still never blocks its caller", () => {
  it("stays fire-and-forget", () => {
    // An audit write must not be able to fail a user's action, or people
    // start removing audit writes to fix outages.
    expect(emitter).toMatch(/void \(async \(\) => \{/);
    expect(emitter).toMatch(/if \(error\) console\.warn\("\[audit\] insert failed:/);
  });

  it("accepts an email the caller already has, rather than looking it up", () => {
    // requireSuperadmin returns one, and governance events are exactly the
    // ones worth not spending a round trip on.
    expect(emitter).toMatch(/actorEmail\?: string \| null/);
    expect(emitter).toMatch(/args\.actorEmail !== undefined \? args\.actorEmail/);
  });

  it("caches the lookup, since events are per-action not per-token", () => {
    expect(emitter).toContain("emailCache");
    expect(emitter).toMatch(/EMAIL_TTL_MS/);
  });
});
