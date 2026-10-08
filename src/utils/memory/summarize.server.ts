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

/** The most messages one fold reads beyond the live window (R350). */
const FOLD_BATCH = 100;

export async function summarizeIfNeeded(opts: {
  sb: SupabaseClient<Database>;
  userId: string;
  conversationId: string;
  windowMessages: number;
  summaryModel: string | null;
  apiKey: string;
  /**
   * The agent's PII policy for each side of the conversation (R351). The
   * stored messages hold what the person typed, so a fold without it sent a
   * redacted email to the summary model and kept it in the summary.
   */
  redact?: (text: string, side: "input" | "output") => string;
}): Promise<{ summary: string | null; foldedCount: number }> {
  const { sb, userId, conversationId, windowMessages, summaryModel, apiKey, redact } = opts;

  // The stored summary, and how far it reaches. A failed read is not "no
  // summary yet": a fold from nothing would replace the stored summary with
  // one of the turns it happened to read (R350).
  const { data: memRow, error: memErr } = await sb
    .from("conversation_memory")
    .select("summary, last_summarized_message_id")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (memErr) throw new Error(`could not read the conversation summary: ${memErr.message}`);
  const previousSummary = memRow?.summary ?? "";

  // When the last message the summary covers was written. If that message is
  // gone, the fold starts over from the first message, with the summary as
  // its starting point.
  let foldedThrough: string | null = null;
  if (memRow?.last_summarized_message_id) {
    const { data: last, error: lastErr } = await sb
      .from("messages")
      .select("created_at")
      .eq("id", memRow.last_summarized_message_id)
      .maybeSingle();
    if (lastErr) throw new Error(`could not read the conversation's messages: ${lastErr.message}`);
    foldedThrough = last?.created_at ?? null;
  }

  // The messages after it, oldest first: a batch to fold, then the live
  // window. This used to read the conversation's first 500 messages. Past
  // 500 it folded up to message 480 once, then found nothing new among them,
  // and everything after 480 and before the window dropped out of what the
  // agent was given (R350). A conversation that falls behind catches up a
  // batch per turn, and no fold is larger than one batch.
  let query = sb
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId);
  if (foldedThrough) query = query.gt("created_at", foldedThrough);
  const { data: msgs, error: msgErr } = await query
    .order("created_at", { ascending: true })
    .limit(FOLD_BATCH + windowMessages);
  if (msgErr) throw new Error(`could not read the conversation's messages: ${msgErr.message}`);
  const unfolded = (msgs ?? []) as DbMessage[];
  // The read's last `windowMessages` may be the live window, which the model
  // is sent whole; only what comes before them is folded.
  const fresh = unfolded.slice(0, Math.max(0, unfolded.length - windowMessages));
  if (fresh.length === 0) {
    return { summary: previousSummary || null, foldedCount: 0 };
  }

  const newSummary = await callOpenRouterForSummary({
    apiKey,
    model: summaryModel || SUMMARY_MODEL_FALLBACK,
    // A summary folded before R351 can hold what the policy redacts.
    previousSummary: redact ? redact(previousSummary, "input") : previousSummary,
    newTurns: redact
      ? fresh.map((m) => ({
          ...m,
          content:
            m.role === "user"
              ? redact(m.content, "input")
              : m.role === "assistant"
                ? redact(m.content, "output")
                : m.content,
        }))
      : fresh,
    userId,
  });
  if (!newSummary) {
    return { summary: previousSummary || null, foldedCount: 0 };
  }

  const { error: saveErr } = await sb.from("conversation_memory").upsert(
    {
      conversation_id: conversationId,
      user_id: userId,
      summary: newSummary,
      summary_token_estimate: Math.round(newSummary.length / 4),
      last_summarized_message_id: fresh[fresh.length - 1].id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id" },
  );
  // A summary that was not saved is folded again next turn; say so rather
  // than let the caller think it was kept.
  if (saveErr) throw new Error(`could not save the conversation summary: ${saveErr.message}`);

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
