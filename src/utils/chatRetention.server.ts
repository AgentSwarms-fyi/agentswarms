// Chat history retention purge.
//
// Each agent has a `chat_retention_days` (default + floor of 7). This job runs
// from the shared scheduler (runCronPass) and deletes messages older than the
// owning agent's window, plus any generated documents (.pptx/.docx/.xlsx) those
// messages parked in the private `chat-docs` storage bucket.
//
// Design notes:
//   • Grouped by retention value so the delete set is one range filter per
//     bucket, not one query per conversation.
//   • Conversations whose agent has no memory-config row fall back to the 7-day
//     default — the setting only ever lengthens retention.
//   • Storage files are removed BEFORE the rows, so a crash mid-purge leaves
//     orphaned rows (recoverable next pass) rather than orphaned blobs.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { MIN_CHAT_RETENTION_DAYS } from "@/utils/memory/types";

const DAY_MS = 86_400_000;
// Throttle: retention is a slow-moving policy; one pass an hour is plenty and
// keeps the scheduler tick cheap even on a busy instance.
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
// Keep IN() lists and storage.remove() batches bounded.
const CHUNK = 100;
const DOC_BUCKET = "chat-docs";

let lastPurge = 0;
let lastEmbedPurge = 0;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type DocMeta = { path?: unknown } | null | undefined;

/**
 * Delete chat messages (and their generated docs) past each agent's retention.
 * Returns the number of messages deleted. Best-effort: individual failures are
 * logged and never abort the rest of the scheduler pass.
 */
export async function purgeExpiredChats(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPurge < PURGE_INTERVAL_MS) return 0;
  lastPurge = now;

  // agent_id → retention days (floored). Missing agents default to the floor.
  const retentionByAgent = new Map<string, number>();
  {
    const { data, error } = await supabaseAdmin
      .from("agent_memory_config")
      .select("agent_id, chat_retention_days");
    if (error) {
      console.warn("[chat-retention] config read failed:", error.message);
      return 0;
    }
    for (const row of data ?? []) {
      retentionByAgent.set(
        row.agent_id,
        Math.max(MIN_CHAT_RETENTION_DAYS, row.chat_retention_days ?? MIN_CHAT_RETENTION_DAYS),
      );
    }
  }

  // Group conversation ids by their effective retention window.
  const convosByRetention = new Map<number, string[]>();
  {
    const { data, error } = await supabaseAdmin.from("conversations").select("id, agent_id");
    if (error) {
      console.warn("[chat-retention] conversation read failed:", error.message);
      return 0;
    }
    for (const cv of data ?? []) {
      const days = retentionByAgent.get(cv.agent_id) ?? MIN_CHAT_RETENTION_DAYS;
      const list = convosByRetention.get(days);
      if (list) list.push(cv.id);
      else convosByRetention.set(days, [cv.id]);
    }
  }

  let deleted = 0;
  for (const [days, convoIds] of convosByRetention) {
    const cutoff = new Date(now - days * DAY_MS).toISOString();
    for (const ids of chunk(convoIds, CHUNK)) {
      // 1. Remove generated docs for expired messages from storage first.
      const { data: docMsgs, error: docErr } = await supabaseAdmin
        .from("messages")
        .select("metadata")
        .in("conversation_id", ids)
        .lt("created_at", cutoff)
        .not("metadata->doc->>path", "is", null);
      if (docErr) {
        console.warn("[chat-retention] doc scan failed:", docErr.message);
      } else if (docMsgs && docMsgs.length) {
        const paths = docMsgs
          .map((m) => (m.metadata as { doc?: DocMeta } | null)?.doc?.path)
          .filter((p): p is string => typeof p === "string" && p.length > 0);
        if (paths.length) {
          const { error: rmErr } = await supabaseAdmin.storage.from(DOC_BUCKET).remove(paths);
          if (rmErr) console.warn("[chat-retention] storage cleanup failed:", rmErr.message);
        }
      }

      // 2. Delete the expired messages themselves.
      const { data: removed, error: delErr } = await supabaseAdmin
        .from("messages")
        .delete()
        .in("conversation_id", ids)
        .lt("created_at", cutoff)
        .select("id");
      if (delErr) {
        console.warn("[chat-retention] message delete failed:", delErr.message);
        continue;
      }
      deleted += removed?.length ?? 0;
    }
  }

  if (deleted > 0) console.log(`[chat-retention] purged ${deleted} expired message(s)`);
  return deleted;
}

/**
 * Purge what embed visitors typed, past each key's retention window.
 *
 * Embeds don't persist a transcript of their own, but every model call lands
 * in execution_traces WITH the prompt text — so an anonymous widget quietly
 * accumulates whatever strangers typed into it. This deletes those traces once
 * the key's `transcript_retention_days` has elapsed. Signed-in conversations
 * are covered separately by purgeExpiredChats above.
 */
export async function purgeExpiredEmbedTranscripts(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastEmbedPurge < PURGE_INTERVAL_MS) return 0;
  lastEmbedPurge = now;

  const { data: keys, error } = await supabaseAdmin
    .from("embed_keys")
    .select("id, transcript_retention_days");
  if (error) {
    console.warn("[embed-retention] key read failed:", error.message);
    return 0;
  }

  let deleted = 0;
  for (const k of keys ?? []) {
    const days = Math.max(1, k.transcript_retention_days ?? 30);
    const cutoff = new Date(now - days * DAY_MS).toISOString();
    const { data: removed, error: delErr } = await supabaseAdmin
      .from("execution_traces")
      .delete()
      .eq("cost_scope_type", "embed_key")
      .eq("cost_scope_id", k.id)
      .lt("created_at", cutoff)
      .select("id");
    if (delErr) {
      console.warn("[embed-retention] delete failed:", delErr.message);
      continue;
    }
    deleted += removed?.length ?? 0;
  }

  if (deleted > 0) console.log(`[embed-retention] purged ${deleted} expired embed trace(s)`);
  return deleted;
}
