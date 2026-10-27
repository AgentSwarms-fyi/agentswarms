// A signed-in user reads their own profile, not everyone's.
//
// VA-2026-10-25-16. public.profiles had a SELECT policy USING (true) for
// `authenticated`, so any user could read every other user's name, avatar,
// role, designation, organization and bio — and list every user_id — straight
// from PostgREST. No feature needed it: the browser only ever reads the
// signed-in user's own row, and every place that shows other people's names is
// a server function reading as the service role. So the migration drops the
// instance-wide policy and keeps the owner-only one, and proves both on apply
// (as a stranger and as the owner), so the push succeeding is the live proof.
//
// Here: the migration's shape, and the invariant that made dropping the policy
// safe — no browser code reads another user's profile.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION = "supabase/migrations/20261029000000_profiles_own_row_only.sql";
const mig = readFileSync(MIGRATION, "utf8");

describe("the migration scopes profiles to their owner", () => {
  it("drops the instance-wide policy, and the older anon one", () => {
    expect(mig).toMatch(
      /DROP POLICY IF EXISTS "Authenticated users can view profiles" ON public\.profiles;/,
    );
    expect(mig).toMatch(/DROP POLICY IF EXISTS "Public can view profiles" ON public\.profiles;/);
  });

  it("creates only the owner-only SELECT policy", () => {
    const creates = [...mig.matchAll(/CREATE POLICY[\s\S]*?;/g)].map((m) => m[0]);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatch(
      /"Users can view own profile"\s+ON public\.profiles\s+FOR SELECT\s+USING \(auth\.uid\(\) = user_id\)/,
    );
  });

  it("proves on apply that no policy reads other profiles", () => {
    expect(mig).toContain("cmd IN ('SELECT', 'ALL')");
    expect(mig).toContain("permissive = 'PERMISSIVE'");
    expect(mig).toContain("coalesce(qual, '') <> '(auth.uid() = user_id)'");
    expect(mig).toMatch(/RAISE EXCEPTION 'profiles own-row: a policy still lets users read/);
  });

  it("proves it as Postgres enforces it: a stranger sees nothing, the owner sees their row", () => {
    expect(mig).toMatch(/set_config\('role', 'authenticated', true\)/);
    expect(mig).toMatch(/IF seen_as_stranger <> 0 THEN\s+RAISE EXCEPTION/);
    expect(mig).toMatch(/IF seen_as_owner <> 1 THEN\s+RAISE EXCEPTION/);
    // the role is put back before anything else runs
    expect(mig.indexOf("EXECUTE 'RESET ROLE'")).toBeGreaterThan(
      mig.indexOf("SELECT count(*) INTO seen_as_owner"),
    );
  });
});

/** Every .ts/.tsx file under dir. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe("no browser code reads another user's profile", () => {
  // Server code (supabaseAdmin) is unaffected by the policy; what the policy
  // change could break is a read through the signed-in user's client.
  const reads = sources("src").flatMap((file) => {
    const text = readFileSync(file, "utf8");
    // `sb` is the service role only where the file says so; elsewhere (chat.ts)
    // it is the caller's client.
    const sbIsAdmin = /const sb = supabaseAdmin;|sb: typeof supabaseAdmin\b/.test(text);
    return [...text.matchAll(/(\w+)\s*\.from\("profiles"\)([\s\S]{0,240})/g)].map((m) => ({
      file: file.replace(/\\/g, "/"),
      client: m[1],
      admin: m[1] === "supabaseAdmin" || (m[1] === "sb" && sbIsAdmin),
      chain: m[2],
    }));
  });

  it("finds the reads it is checking", () => {
    expect(reads.length).toBeGreaterThan(5);
  });

  it("every read through a user's client is of the signed-in user's own row", () => {
    const userSelects = reads.filter((r) => !r.admin && /^\s*\.select/.test(r.chain));
    expect(userSelects.map((r) => r.file).sort()).toEqual(
      [
        "src/components/OnboardingDialog.tsx",
        "src/components/UserMenu.tsx",
        "src/components/settings/ProfileSettingsPanel.tsx",
        "src/routes/_authenticated/dashboard.tsx",
      ].sort(),
    );
    for (const r of userSelects) {
      expect(r.chain, r.file).toMatch(/\.eq\("user_id", (user\.id|uid)\)/);
    }
  });

  it("server code that lists other people's names reads as the service role", () => {
    for (const f of [
      "src/utils/swarmApprovals.functions.ts",
      "src/utils/iam.functions.ts",
      "src/utils/sheets/people.server.ts",
      "src/lib/email/budgetAlertTrigger.server.ts",
      "src/utils/scim.server.ts",
    ]) {
      const forFile = reads.filter((r) => r.file === f);
      expect(forFile.length, f).toBeGreaterThan(0);
      for (const r of forFile) expect(r.admin, `${f}: ${r.client}`).toBe(true);
    }
  });
});
