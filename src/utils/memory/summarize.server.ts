// Short-term memory summarization. When the conversation grows past the
// sliding window, fold the *older* messages into a single rolling summary
// stored on `conversation_memory.summary`, prepended to every future request.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { OPENROUTER_CHAT_URL } from "@/utils/providers/openrouterDefault.server";

const SUMMARY_MODEL_FALLBACK = "openai/gpt-4o-mini";

type DbMessage = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

async function callOpenRouterForSummary(opts: {
  apiKey: string;
  model: string;
  previousSummary: string;
  newTurns: DbMessage[];
  userId?: string | null;
}): Promise<string | null> {
  const { apiKey, model, previousSummary, newTurns, userId } = opts;
  if (newTurns.length === 0) return previousSummary || null;

  const turnsText = newTurns
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
    .join("\n\n");

  const systemPrompt =
    "You compress chat transcripts into a tight running summary an LLM can read on the next turn. " +
    "Preserve facts the user shared (names, preferences, decisions, in-progress tasks, key numbers, links). " +
    "Drop pleasantries and resolved tangents. Keep it under 350 words. Write in third person.";

  const userMessage =
    (previousSummary ? `EXISTING SUMMARY:\n${previousSummary}\n\n` : "") +
    `NEW TURNS TO FOLD IN:\n${turnsText}\n\n` +
    "Return only the updated summary as plain prose. No preamble, no bullet headers.";

  const tStart = Date.now();
  try {
    const r = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 600,
      }),
    });
    if (!r.ok) {
      console.warn(`[memory.summarize] gateway ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const j = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const out = j.choices?.[0]?.message?.content?.trim();
    if (userId) {
      const { recordGatewayCall } = await import("@/utils/observability/recordGatewayUsage.server");
      await recordGatewayCall({
        userId,
        surface: "Memory: Summarize",
        model,
        tokensIn: j.usage?.prompt_tokens,
        tokensOut: j.usage?.completion_tokens,
        promptText: userMessage,
        responseText: out ?? "",
        latencyMs: Date.now() - tStart,
      });
    }
    return out || null;
  } catch (e) {
    console.warn("[memory.summarize] exception:", (e as Error).message);
    return null;
  }
}

export async function summarizeIfNeeded(opts: {
  sb: SupabaseClient<Database>;
  userId: string;
  conversationId: string;
  windowMessages: number;
  summaryModel: string | null;
  apiKey: string;
}): Promise<{ summary: string | null; foldedCount: number }> {
  const { sb, userId, conversationId, windowMessages, summaryModel, apiKey } = opts;

  // Pull current memory row + all conversation messages ordered oldest-first.

  const [{ data: memRow }, { data: msgs }] = await Promise.all([
    (sb.from("conversation_memory") as any)
      .select("summary, last_summarized_message_id")
      .eq("conversation_id", conversationId)
      .maybeSingle(),
    sb
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(500),
  ]);

  const all = (msgs ?? []) as DbMessage[];
  if (all.length <= windowMessages) {
    return { summary: memRow?.summary ?? null, foldedCount: 0 };
  }

  // The "to summarize" slice is everything older than the live window.
  const toFold = all.slice(0, all.length - windowMessages);

  // Skip already-summarized turns.
  const lastSummarizedId: string | null = memRow?.last_summarized_message_id ?? null;
  let startIdx = 0;
  if (lastSummarizedId) {
    const idx = toFold.findIndex((m) => m.id === lastSummarizedId);
    if (idx >= 0) startIdx = idx + 1;
  }
  const fresh = toFold.slice(startIdx);
  if (fresh.length === 0) {
    return { summary: memRow?.summary ?? null, foldedCount: 0 };
  }

  const previousSummary = memRow?.summary ?? "";
  const newSummary = await callOpenRouterForSummary({
    apiKey,
    model: summaryModel || SUMMARY_MODEL_FALLBACK,
    previousSummary,
    newTurns: fresh,
    userId,
  });
  if (!newSummary) {
    return { summary: previousSummary || null, foldedCount: 0 };
  }

  const lastFolded = toFold[toFold.length - 1];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (sb.from("conversation_memory") as any).upsert(
    {
      conversation_id: conversationId,
      user_id: userId,
      summary: newSummary,
      summary_token_estimate: Math.round(newSummary.length / 4),
      last_summarized_message_id: lastFolded?.id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id" },
  );

  return { summary: newSummary, foldedCount: fresh.length };
}

export function buildSummaryBlock(summary: string | null): string {
  if (!summary || !summary.trim()) return "";
  return (
    "=== CONVERSATION SUMMARY (older turns, compressed) ===\n" +
    summary.trim() +
    "\n=== END SUMMARY ==="
  );
}
