// Rows keyed to an account must go, or be detached, when the account does.
//
// FOUND BY MEASUREMENT while deleting seven fixture accounts that earlier test
// runs had left behind. Tables that declare `references auth.users(id) on
// delete cascade` — bi_dashboards, agents, conversations, notifications,
// profiles — came away with zero orphans. Three tables that key off a user and
// never declared the reference did not:
//
//   budget_settings     24 orphaned rows, oldest 2026-07-22
//   user_data_tables     4 orphaned rows
//   execution_traces   260 orphaned rows
//
// none of them from the seven accounts deleted that day — they were the
// residue of clean-ups going back weeks, accumulating silently.
//
// The orphaned DATASETS are the sharp edge: RLS on user_data_rows is
// `user_id = auth.uid()`, so once the owner is gone nobody can list, read or
// delete them through the application. They are storage that only grows.
//
// 20260818000000 adds the three constraints, with a different rule for each,
// and cleans up the existing violations (a foreign key cannot be added to a
// table that already breaks it). These tests pin the rules and the code that
// now has to cope with a null owner.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = "supabase/migrations";
const MIGRATION = readFileSync(join(DIR, "20260818000000_owner_fk_cascades.sql"), "utf8");
const ALL_SQL = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .join("\n");
const DASHBOARD = readFileSync("src/utils/dashboard.functions.ts", "utf8");
const GROUP_BUDGETS = readFileSync("src/components/admin/GroupBudgetsTab.tsx", "utf8");
const TYPES = readFileSync("src/integrations/supabase/types.ts", "utf8");

describe("every owner column reaches auth.users", () => {
  it("a user's datasets are deleted with them", () => {
    // CASCADE and not SET NULL: an unowned dataset is unreachable under RLS.
    expect(MIGRATION).toMatch(
      /alter table public\.user_data_tables\s+add constraint [\w_]+\s+foreign key \(user_id\) references auth\.users\(id\) on delete cascade;/i,
    );
  });

  it("a user's budget settings are deleted with them", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.budget_settings\s+add constraint [\w_]+\s+foreign key \(user_id\) references auth\.users\(id\) on delete cascade;/i,
    );
  });

  it("a user's traces are DETACHED, not destroyed", () => {
    // Deliberately different. This is cost history: deleting it would silently
    // reduce recorded instance spend, which is the same class of dishonesty as
    // a truncated total.
    expect(MIGRATION).toMatch(
      /alter table public\.execution_traces\s+add constraint [\w_]+\s+foreign key \(user_id\) references auth\.users\(id\) on delete set null;/i,
    );
    expect(MIGRATION, "SET NULL needs a nullable column").toMatch(
      /alter table public\.execution_traces alter column user_id drop not null;/i,
    );
    expect(MIGRATION, "traces must not be cascade-deleted").not.toMatch(
      /execution_traces[\s\S]{0,200}on delete cascade/i,
    );
  });

  it("clears the existing violations first, or the constraint cannot be added", () => {
    expect(MIGRATION).toMatch(/delete from public\.user_data_tables/i);
    expect(MIGRATION).toMatch(/delete from public\.budget_settings/i);
    // `\w*` allows the table alias the UPDATE uses.
    expect(MIGRATION).toMatch(/update public\.execution_traces\s+\w*\s*set user_id = null/i);
  });

  it("spares sample datasets, which are owned by nobody on purpose", () => {
    // `user_id is not null` in the cleanup predicate. Without it the delete
    // would take every bundled sample with it, since NOT EXISTS is true for a
    // null id — and the samples are what a new account has to look at.
    const cleanup = MIGRATION.slice(
      MIGRATION.indexOf("delete from public.user_data_tables"),
      MIGRATION.indexOf("alter table public.user_data_tables"),
    );
    expect(cleanup, "the sample datasets would be deleted").toMatch(/user_id is not null/i);
  });

  it("the tables that were already correct still are", () => {
    // Guard on the guard: these are the ones that came away clean, and they
    // are the reason the other three were visible at all.
    for (const t of ["bi_dashboards", "agents", "profiles"]) {
      expect(ALL_SQL, `${t} lost its cascade`).toMatch(
        new RegExp(`references auth\\.users\\(id\\) on delete cascade`, "i"),
      );
    }
  });
});

describe("the code copes with a trace that has no owner", () => {
  it("the generated type says the column is nullable", () => {
    const block = TYPES.slice(TYPES.indexOf("      execution_traces: {"));
    expect(block.slice(0, 1200)).toMatch(/user_id: string \| null;/);
  });

  it("per-person spend buckets detached rows instead of dropping them", () => {
    // Dropping them would make the per-person rows stop summing to the
    // headline total — the quiet kind of wrong this dashboard has had before.
    expect(DASHBOARD).toContain("DETACHED_OWNER");
    expect(DASHBOARD).toMatch(/const key = r\.user_id \?\? DETACHED_OWNER;/);
  });

  it("and labels them as a removed account rather than as a raw key", () => {
    expect(DASHBOARD).toMatch(/id === DETACHED_OWNER \? "Removed account"/);
  });

  it("per-team spend excludes them, because they are in no team", () => {
    expect(DASHBOARD).toMatch(/r\.user_id !== null && ids\.has\(r\.user_id\)/);
  });

  it("the group budgets panel does not bucket them under one phantom user", () => {
    // Keying a Map on null would have attributed every detached trace to a
    // single non-existent person and shown that as a team's spend.
    expect(GROUP_BUDGETS).toMatch(/if \(!t\.user_id\) continue;/);
  });
});
