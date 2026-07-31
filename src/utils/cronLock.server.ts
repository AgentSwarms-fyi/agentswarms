// Cross-instance leader lease for the scheduled-work pass.
//
// When AgentSwarms runs as multiple instances behind a load balancer, every
// instance's in-process scheduler (and any external cron) would otherwise
// process the same due schedules and double-fire side effects — duplicate
// alert emails, scheduled report digests, swarm runs, catalog crawls. A
// single-row lease in `cron_locks`, claimed with an atomic conditional UPDATE
// (the PostgREST equivalent of a `SELECT ... FOR UPDATE SKIP LOCKED` claim),
// lets exactly one runner do the work at a time. The lease carries a TTL, so a
// crashed holder never wedges scheduling — the next runner takes over once it
// expires.
import { randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Stable per-process identity so a holder only ever releases its own lease.
const HOLDER = `${process.pid}-${randomUUID()}`;

const DEFAULT_TTL_MS = 10 * 60_000; // generous; a normal pass releases in seconds

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // Postgres undefined_table (42P01) or PostgREST "not found in schema cache".
  return (
    error.code === "42P01" ||
    /schema cache|does not exist|could not find the table/i.test(error.message ?? "")
  );
}

/**
 * Try to acquire the named lease for `ttlMs`. Returns true iff this process now
 * holds it.
 *
 * Fails OPEN (returns true) when the `cron_locks` table doesn't exist yet
 * (a deployment that hasn't applied the 20260732000000 migration) or on an
 * unexpected error — so scheduling never silently stops. The worst case then is
 * the pre-existing single-instance behaviour (possible duplicate work), never a
 * stalled scheduler.
 */
export async function acquireCronLease(
  name: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + ttlMs).toISOString();
  // Atomic at the row level: concurrent updates on this row serialize, so only
  // the runner that finds it free/expired wins; the others match zero rows.
  const { data, error } = await supabaseAdmin
    .from("cron_locks")
    .update({ locked_until: untilIso, holder: HOLDER, updated_at: nowIso })
    .eq("name", name)
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .select("name");
  if (error) {
    if (isMissingTable(error)) return true; // pre-migration → behave as single runner
    console.warn("[cron-lock] acquire failed, proceeding without lease:", error.message);
    return true;
  }
  return Array.isArray(data) && data.length > 0;
}

/** Release the lease if (and only if) this process still holds it. */
export async function releaseCronLease(name: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("cron_locks")
      .update({ locked_until: null })
      .eq("name", name)
      .eq("holder", HOLDER);
  } catch {
    /* best-effort — the TTL expires the lease anyway */
  }
}
