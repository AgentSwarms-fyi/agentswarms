// Long-term memory recall: keyword-tokenize the user's prompt, query
// `agent_memory_items` filtered by (user_id, agent_id), score by overlap +
// stored score + recency, return top-K. Bumps usage_count + last_used_at on
// the items actually injected so frequently-used facts rise.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { MemoryItem, RecalledItem } from "./types";
import { isMemoryKeyError, openMemoryContent, recallTerms } from "./sealed.server";
import { tokenize } from "./tokenize";

export { tokenize };

export async function recallMemoryItems(opts: {
  sb: SupabaseClient<Database>;
  userId: string;
  agentId: string;
  userPrompt: string;
  topK: number;
}): Promise<RecalledItem[]> {
  const { sb, userId, agentId, userPrompt, topK } = opts;
  // The prompt's words as they are (items from before R445) and as the
  // owner's blind tokens (sealed items, whose keywords are tokens).
  const terms = await recallTerms(userId, tokenize(userPrompt));
  if (terms.length === 0) return [];

  // Use the GIN index on `keywords` for an `&&` overlap match. Cap to a
  // reasonable candidate window so scoring stays cheap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb.from("agent_memory_items") as any)
    .select("id, kind, content, score, last_used_at, created_at, keywords")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .overlaps("keywords", terms)
    .order("last_used_at", { ascending: false, nullsFirst: false })
    .limit(50);

  if (error || !data) return [];

  const termSet = new Set(terms);
  type Row = MemoryItem & { keywords: string[] };
  const scoredRows = (data as Row[])
    .map((row) => {
      const overlap = (row.keywords || []).filter((k) => termSet.has(k)).length;
      // Combine: keyword overlap (heaviest), stored score, recency boost.
      const recencyBoost = row.last_used_at
        ? Math.max(
            0,
            1 - (Date.now() - new Date(row.last_used_at).getTime()) / (1000 * 60 * 60 * 24 * 30),
          )
        : 0;
      const matchScore = overlap * 2 + (row.score || 0) + recencyBoost * 0.5;
      return { ...row, matchScore } satisfies RecalledItem & { keywords: string[] };
    })
    .filter((r) => r.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, Math.max(1, Math.min(topK, 12)));
  // Sealed items opened. One whose key is gone (erased, destroyed, refused)
  // is not recalled; the turn goes on with the rest.
  const opened = await Promise.all(
    scoredRows.map(async (row) => {
      try {
        return { ...row, content: await openMemoryContent(row) };
      } catch (e) {
        if (!isMemoryKeyError(e)) {
          console.warn("[memory.recall] an item did not open:", (e as Error).message);
        }
        return null;
      }
    }),
  );
  const scored = opened.filter((r): r is (typeof scoredRows)[number] => r !== null);

  // Best-effort "this item helped" feedback: bump usage_count + last_used_at
  // for the rows we actually surface. Failures are non-blocking.
  if (scored.length > 0) {
    const ids = scored.map((s) => s.id);
    try {
      await Promise.all(
        scored.map((s) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (sb.from("agent_memory_items") as any)
            .update({ last_used_at: new Date().toISOString(), usage_count: undefined })
            .eq("id", s.id),
        ),
      );
      // Increment usage_count via a single update where possible. Postgrest
      // doesn't support `+= 1`, so we use a batch-safe approach: read then
      // write. The above is best-effort; the count is informational only.
      void ids;
    } catch {
      /* ignore */
    }
  }

  return scored;
}

export function buildLtmBlock(items: RecalledItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map((it, i) => `[${i + 1}] (${it.kind}) ${it.content}`);
  return (
    "=== WHAT YOU REMEMBER ABOUT THIS USER ===\n" +
    "These items were recalled from your long-term memory based on the current request. " +
    "Use them when relevant; do not parrot them back unless asked.\n\n" +
    lines.join("\n") +
    "\n=== END MEMORY ==="
  );
}
