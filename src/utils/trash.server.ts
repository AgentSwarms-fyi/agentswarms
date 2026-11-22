// The daily part of the trash: what has been in it past its time is deleted
// for good. Run by the scheduled pass; the database function it calls answers
// the service role only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Hourly is plenty: an entry is a day late at most once a day. */
export const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurge = 0;

/**
 * Deletes trash entries whose time is up. Returns how many, or null when it
 * did not run (too soon since the last time, or the database has no trash).
 */
export async function purgeExpiredTrash(force = false): Promise<number | null> {
  const now = Date.now();
  if (!force && now - lastPurge < TRASH_PURGE_INTERVAL_MS) return null;
  lastPurge = now;
  const { data, error } = await supabaseAdmin.rpc("purge_expired_trash");
  if (error) {
    // A database that has not had the migration has nothing to purge.
    if (error.code === "PGRST202" || error.code === "42883") return null;
    throw new Error(`trash purge: ${error.message}`);
  }
  return typeof data === "number" ? data : 0;
}
