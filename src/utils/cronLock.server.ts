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
//
// R463, for running several replicas for availability:
//
// - The lease is short (2 min) and RENEWED while a pass runs, every third of
//   its length. It used to be 10 minutes and never renewed, so a holder that
//   died mid-pass stopped all scheduled work across the fleet for up to ten
//   minutes, and a pass that ran longer than ten could overlap the next one.
// - It fails CLOSED. An error claiming it used to count as holding it, which
//   on several replicas meant every replica ran the pass at once whenever the
//   database stumbled — the one moment duplicate side effects are least
//   welcome. Now an error skips this pass; the next minute's tick tries again.
//   A missing table (a database the migration has not reached) still runs
//   unleased, as a single instance always did.
// - A holder that cannot renew stops counting as the holder once the time it
//   last secured has passed, and the pass stops starting steps from then on.
import { randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Stable per-process identity so a holder only ever releases its own lease.
const HOLDER = `${process.pid}-${randomUUID()}`;

function leaseTtlMs(): number {
  const n = Number(process.env.SCHEDULER_LEASE_TTL_MS);
  return Number.isFinite(n) && n >= 30_000 ? Math.trunc(n) : 2 * 60_000;
}

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // Postgres undefined_table (42P01) or PostgREST "not found in schema cache".
  return (
    error.code === "42P01" ||
    /schema cache|does not exist|could not find the table/i.test(error.message ?? "")
  );
}

/** How a claim attempt ended. `unleased`: no table yet, so this runner works alone. */
export type LeaseClaim = "held" | "busy" | "unleased" | "error";

/** Try to claim the named lease for `ttlMs`. */
export async function claimCronLease(
  name: string,
  ttlMs: number = leaseTtlMs(),
): Promise<LeaseClaim> {
  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + ttlMs).toISOString();
  try {
    // Atomic at the row level: concurrent updates on this row serialize, so
    // only the runner that finds it free/expired wins; the others match zero
    // rows.
    const { data, error } = await supabaseAdmin
      .from("cron_locks")
      .update({ locked_until: untilIso, holder: HOLDER, updated_at: nowIso })
      .eq("name", name)
      .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
      .select("name");
    if (error) {
      if (isMissingTable(error)) return "unleased";
      console.warn(`[cron-lock] could not claim "${name}"; skipping this pass:`, error.message);
      return "error";
    }
    return Array.isArray(data) && data.length > 0 ? "held" : "busy";
  } catch (e) {
    console.warn(
      `[cron-lock] could not claim "${name}"; skipping this pass:`,
      e instanceof Error ? e.message : String(e),
    );
    return "error";
  }
}

/**
 * Try to acquire the named lease. True iff this process may run the work: it
 * holds the lease, or the lease table does not exist yet. An error is false —
 * see the header.
 */
export async function acquireCronLease(
  name: string,
  ttlMs: number = leaseTtlMs(),
): Promise<boolean> {
  const claim = await claimCronLease(name, ttlMs);
  return claim === "held" || claim === "unleased";
}

/** Extend a lease this process holds. "lost" when someone else holds it now. */
async function renewCronLease(name: string, ttlMs: number): Promise<"held" | "lost" | "error"> {
  try {
    const { data, error } = await supabaseAdmin
      .from("cron_locks")
      .update({ locked_until: new Date(Date.now() + ttlMs).toISOString() })
      .eq("name", name)
      .eq("holder", HOLDER)
      .select("name");
    if (error) return "error";
    return Array.isArray(data) && data.length > 0 ? "held" : "lost";
  } catch {
    return "error";
  }
}

export type HeldLease = {
  /** True once this process can no longer be sure it is the only runner. */
  lost(): boolean;
  /** Stop renewing (call once the work is done, before releasing). */
  stop(): void;
};

/**
 * Keep a lease this process just acquired alive while it works. Renews every
 * third of `ttlMs`. `lost()` turns true when a renewal finds another holder,
 * or when renewals have failed for long enough that the last secured expiry
 * has passed (from then on another runner may have taken over).
 */
export function holdCronLease(
  name: string,
  claim: LeaseClaim = "held",
  ttlMs: number = leaseTtlMs(),
): HeldLease {
  // Without a table there is nothing to renew and nobody to lose it to.
  if (claim === "unleased") return { lost: () => false, stop: () => {} };
  let securedUntil = Date.now() + ttlMs;
  let taken = false;
  let renewing = false;
  const timer = setInterval(
    () => {
      if (renewing || taken) return;
      renewing = true;
      void renewCronLease(name, ttlMs)
        .then((r) => {
          if (r === "held") securedUntil = Date.now() + ttlMs;
          else if (r === "lost") {
            taken = true;
            console.warn(`[cron-lock] "${name}" is held by another runner now; stopping this pass`);
          }
        })
        .finally(() => {
          renewing = false;
        });
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  timer.unref?.();
  return {
    lost: () => taken || Date.now() >= securedUntil,
    stop: () => clearInterval(timer),
  };
}

/**
 * When the named lease was last claimed, by any runner: `claimCronLease`
 * stamps `updated_at` on the claim and renewals do not, so for the
 * `scheduler` lease this is when the latest pass began anywhere. Null when it
 * cannot be read (no table yet, a failed read); the caller then knows nothing
 * fleet-wide and says so by falling back.
 */
export async function lastCronLeaseClaimAt(name: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("cron_locks")
      .select("updated_at")
      .eq("name", name)
      .maybeSingle();
    if (error || !data) return null;
    return typeof data.updated_at === "string" ? data.updated_at : null;
  } catch {
    return null;
  }
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
