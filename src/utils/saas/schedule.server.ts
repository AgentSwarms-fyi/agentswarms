// Scheduled SaaS syncs. Runs on the same triggers as the BI refresh engine:
// the in-process 60s scheduler and /api/bi/cron both call
// processDueSaasSyncs().
//
// Each due source is synced with the service role — credentials decrypt
// server-side — and the owner is notified when a sync fails or comes back
// partial. Nothing here is user-facing until it goes wrong, which is exactly
// why the failure path gets the attention.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptJson } from "@/utils/providers/crypto.server";
import { nextSyncAt, runConnectionSync } from "./sync.server";
import type { SaasConfig } from "./types";

const MIN_PROCESS_INTERVAL_MS = 60_000;

/**
 * Sources per pass.
 *
 * Lower than the catalog crawler's: a sync is a full dataset replace over a
 * paged HTTP API, not a schema read, so one can run for minutes. Three
 * concurrent would be a burst against three vendors' rate limits at once.
 */
const SOURCES_PER_RUN = 2;

let lastProcessed = 0;
let processing = false;

type DueRow = {
  id: string;
  user_id: string;
  name: string;
  provider: string;
  config: unknown;
  streams: unknown;
  sync_schedule: string;
  next_sync_at: string | null;
};

/**
 * Claim a source by pushing its next run forward, atomically.
 *
 * `lte("next_sync_at", now)` in the UPDATE is the whole point: it only matches
 * while the row is still due, so of two instances polling the same second
 * exactly one gets a row back and the other gets none. Reading first and
 * updating after — which is the older pattern elsewhere in this codebase —
 * lets both read the same due row and sync it twice. For a full-replace sync
 * that means the dataset is rebuilt twice and its version history gains a
 * spurious snapshot.
 *
 * Pushing the time forward BEFORE running also means a hard failure cannot
 * tight-loop: the next attempt is a whole interval away.
 */
async function claim(row: DueRow, nowIso: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("saas_connections")
    .update({ next_sync_at: nextSyncAt(row.sync_schedule) })
    .eq("id", row.id)
    .lte("next_sync_at", nowIso)
    .select("id");
  return (data ?? []).length > 0;
}

async function notify(row: DueRow, title: string, body: string): Promise<void> {
  await supabaseAdmin.from("notifications").insert({
    user_id: row.user_id,
    kind: "error",
    title: title.slice(0, 200),
    body: body.slice(0, 500),
    link: "/integrations",
  });
}

/** Sync every due SaaS source (idempotent, internally throttled). */
export async function processDueSaasSyncs(force = false): Promise<number> {
  const now = Date.now();
  if (processing) return 0;
  if (!force && now - lastProcessed < MIN_PROCESS_INTERVAL_MS) return 0;
  processing = true;
  lastProcessed = now;

  const nowIso = new Date().toISOString();
  try {
    const { data: due } = await supabaseAdmin
      .from("saas_connections")
      .select("id, user_id, name, provider, config, streams, sync_schedule, next_sync_at")
      .neq("sync_schedule", "manual")
      .eq("is_active", true)
      .lte("next_sync_at", nowIso)
      .order("next_sync_at")
      .limit(SOURCES_PER_RUN);

    let ran = 0;
    for (const row of (due ?? []) as DueRow[]) {
      if (!(await claim(row, nowIso))) continue;
      ran++;

      try {
        const enc = row.config as { ciphertext?: string; iv?: string };
        if (!enc?.ciphertext || !enc?.iv) {
          throw new Error("no stored credentials — re-save this source");
        }
        const streamIds = Array.isArray(row.streams) ? (row.streams as string[]) : [];
        if (streamIds.length === 0) {
          // Not an error worth notifying about: a source with nothing selected
          // is a configuration the user made, not a failure.
          continue;
        }

        const result = await runConnectionSync(supabaseAdmin, {
          id: row.id,
          userId: row.user_id,
          name: row.name,
          config: await decryptJson<SaasConfig>(enc.ciphertext, enc.iv),
          streamIds,
        });

        if (result.failed.length > 0) {
          await notify(
            row,
            `Sync partly failed — "${row.name}"`,
            result.failed.map((f) => `${f.stream}: ${f.error}`).join("\n"),
          );
        }
      } catch (e) {
        // The row's own status is recorded by runConnectionSync only when the
        // sync got far enough to run. A failure before that — a credential
        // that no longer decrypts, a revoked token — has to be written here or
        // the source would sit showing its last success for ever.
        await supabaseAdmin
          .from("saas_connections")
          .update({
            last_sync_status: "error",
            last_sync_error: (e as Error).message.slice(0, 2000),
            last_synced_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("user_id", row.user_id);
        await notify(row, `Scheduled sync failed — "${row.name}"`, (e as Error).message);
      }
    }
    return ran;
  } finally {
    processing = false;
  }
}
