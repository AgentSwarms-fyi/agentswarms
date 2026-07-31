// Shared setup for tests that reach a REAL Supabase project.
//
// These are excluded from the default run (see vitest.config.ts) and are never
// part of CI: they need credentials, and a test suite that can write to
// whatever project happens to be configured is a footgun pointed at
// production. Run them deliberately, against a throwaway project:
//
//   npx vitest run --dir tests/integration
//
// Everything created here is namespaced and removed in an afterAll, so a run
// leaves the project as it found it.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * True when this machine is configured to talk to a real project.
 *
 * Tests call `describe.skipIf(!hasSupabase)` rather than throwing, so a fork
 * with no credentials sees a clean skip instead of a wall of red — while an
 * operator who DID set credentials gets real coverage.
 */
export const hasSupabase = Boolean(URL && KEY);

/** Prefix for every row these tests create, so cleanup can be exact. */
export const TEST_PREFIX = "__itest__";

let client: SupabaseClient<Database> | null = null;

/** Service-role client. Only call after checking `hasSupabase`. */
export function admin(): SupabaseClient<Database> {
  if (!URL || !KEY) {
    throw new Error(
      "Integration tests need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. " +
        "Point them at a THROWAWAY project — these tests write real rows.",
    );
  }
  client ??= createClient<Database>(URL, KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** A bucket name unique to one test, so parallel runs cannot collide. */
export function testBucket(name: string): string {
  return `${TEST_PREFIX}${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
