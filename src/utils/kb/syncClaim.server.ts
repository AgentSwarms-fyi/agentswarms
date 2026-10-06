// Claiming a knowledge-base source's sync (R313).
//
// FOUND IN R313. Nothing claimed a sync: "Sync now" could run beside a
// scheduled sync or a second tab's. Both read the same documents and inserted
// the same new ones, and the second hit their unique key and recorded "error"
// alongside a sync that had succeeded; whichever finished last decided what the
// source read. Driven: Sync now pressed in two tabs on one website source.
//
// A claim is the move to "syncing". It is made only from another status, or
// from a "syncing" that a dead sync left behind: one whose row has not changed
// for KB_SYNC_LEASE_MINUTES (60 by default). A trigger keeps the row's
// updated_at, and a sync writes the row only at its start and at its end.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const KB_SYNC_RUNNING =
  "A sync of this source is already running, so this one did not start. Its result will show here when it finishes.";

type SourcePatch = Database["public"]["Tables"]["kb_sources"]["Update"];

function leaseMinutes(): number {
  const n = Number.parseInt(process.env.KB_SYNC_LEASE_MINUTES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * Move the source to "syncing" if no live sync holds it. "running": a live
 * sync does; "missing": there is no such source (for this user, when given).
 */
export async function claimKbSync(
  sb: SupabaseClient<Database>,
  sourceId: string,
  opts: { userId?: string; patch?: SourcePatch } = {},
): Promise<{ outcome: "claimed" | "running" | "missing"; error: string | null }> {
  const staleBefore = new Date(Date.now() - leaseMinutes() * 60_000).toISOString();
  let claim = sb
    .from("kb_sources")
    .update({ ...opts.patch, status: "syncing", error: null })
    .eq("id", sourceId)
    // Quoted: a timestamp's dots and colons are separators in this filter.
    .or(`status.neq.syncing,updated_at.lt."${staleBefore}"`);
  if (opts.userId) claim = claim.eq("user_id", opts.userId);
  const { data, error } = await claim.select("id");
  if (error) return { outcome: "missing", error: error.message };
  if ((data ?? []).length > 0) return { outcome: "claimed", error: null };
  let seen = sb.from("kb_sources").select("id").eq("id", sourceId);
  if (opts.userId) seen = seen.eq("user_id", opts.userId);
  const { data: row } = await seen.maybeSingle();
  return { outcome: row ? "running" : "missing", error: null };
}
