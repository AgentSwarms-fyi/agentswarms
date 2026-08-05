// Scheduled KB source syncs. Runs on the same triggers as the BI refresh
// engine and the SaaS scheduler: the in-process 60s scheduler and /api/bi/cron
// both call processDueKbSyncs().
//
// The claim is the saas/schedule.server.ts pattern verbatim: next_sync_at is
// both the due time and the claim token. The conditional UPDATE
// (`lte(next_sync_at, now)`) pushes it forward and only matches while the row
// is still due, so of two instances polling the same second exactly one syncs
// the source. Pushing the time forward BEFORE running also means a hard
// failure cannot tight-loop — the next attempt is a whole interval away.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { nextSyncAt, syncKbSource } from "./sync.server";

const MIN_PROCESS_INTERVAL_MS = 60_000;

/**
 * Sources per pass. A KB sync is a listing plus downloads for changed items —
 * usually light thanks to the version/hash dedup, but a first sync of a big
 * folder is hundreds of downloads plus embedding calls, so keep the parallel
 * burst small the same way the SaaS scheduler does.
 */
const SOURCES_PER_RUN = 2;

let lastProcessed = 0;
let processing = false;

type DueRow = {
  id: string;
  user_id: string | null;
  knowledge_base_id: string;
  kind: string;
  label: string | null;
  config: unknown;
  credentials: unknown;
  access_scope: string;
  sync_schedule: string;
  next_sync_at: string | null;
};

async function claim(row: DueRow, nowIso: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("kb_sources")
    .update({ next_sync_at: nextSyncAt(row.sync_schedule) })
    .eq("id", row.id)
    .lte("next_sync_at", nowIso)
    .select("id");
  return (data ?? []).length > 0;
}

async function notify(row: DueRow, title: string, body: string): Promise<void> {
  if (!row.user_id) return;
  await supabaseAdmin.from("notifications").insert({
    user_id: row.user_id,
    kind: "error",
    title: title.slice(0, 200),
    body: body.slice(0, 500),
    link: "/knowledge",
  });
}

/** Sync every due KB source (idempotent, internally throttled). */
export async function processDueKbSyncs(force = false): Promise<number> {
  const now = Date.now();
  if (processing) return 0;
  if (!force && now - lastProcessed < MIN_PROCESS_INTERVAL_MS) return 0;
  processing = true;
  lastProcessed = now;

  const nowIso = new Date().toISOString();
  try {
    const { data: due } = await supabaseAdmin
      .from("kb_sources")
      .select(
        "id, user_id, knowledge_base_id, kind, label, config, credentials, access_scope, sync_schedule, next_sync_at",
      )
      .neq("sync_schedule", "manual")
      .lte("next_sync_at", nowIso)
      .order("next_sync_at")
      .limit(SOURCES_PER_RUN);

    let ran = 0;
    for (const row of (due ?? []) as DueRow[]) {
      if (!(await claim(row, nowIso))) continue;
      ran++;
      const label = row.label || row.kind;
      try {
        const outcome = await syncKbSource(supabaseAdmin, row);
        if (outcome.status === "error") {
          await notify(
            row,
            `Scheduled KB sync failed — "${label}"`,
            outcome.error ?? "unknown error",
          );
        } else if (outcome.status === "embedding_failed") {
          await notify(
            row,
            `KB sync indexed nothing — "${label}"`,
            outcome.error ?? "embedding failed",
          );
        }
      } catch (e) {
        // syncKbSource records outcomes on the row itself; this catches the
        // paths before that (a row shape problem, a crash in the claim
        // machinery). Without it one bad source would end the whole pass.
        await supabaseAdmin
          .from("kb_sources")
          .update({
            status: "error",
            error: (e as Error).message.slice(0, 2000),
            last_synced_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        await notify(row, `Scheduled KB sync failed — "${label}"`, (e as Error).message);
      }
    }
    return ran;
  } finally {
    processing = false;
  }
}
