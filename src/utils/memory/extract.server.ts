// Long-term memory extraction. After each assistant turn, ask a small
// structured-output prompt for facts/preferences/episodic notes worth keeping
// across sessions, and upsert them into `agent_memory_items`. Best-effort —
// failures are logged, never surfaced.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { MemoryItemKind } from "./types";
import { OPENROUTER_CHAT_URL } from "@/utils/providers/openrouterDefault.server";

const EXTRACT_MODEL = "openai/gpt-4o-mini";

type Extracted = {
  kind: MemoryItemKind;
  content: string;
};

const VALID_KINDS = new Set<MemoryItemKind>(["fact", "preference", "episodic", "instruction"]);

async function callOpenRouterForExtraction(opts: {
  apiKey: string;
  userMessage: string;
  assistantMessage: string;
  userId?: string | null;
}): Promise<Extracted[]> {
  const { apiKey, userMessage, assistantMessage, userId } = opts;
  const systemPrompt =
    "You extract durable memory items from a single chat turn. " +
    "Keep ONLY information that will plausibly be useful in a future, separate conversation: " +
    "stable user facts (name, role, location), preferences, decisions, ongoing projects, episodic notes (events the user described), or explicit instructions for the assistant. " +
    "DO NOT extract: greetings, restatements of the assistant's own answer, ephemeral context, redacted PII placeholders ([EMAIL], [PHONE], [SSN], [CARD]), or anything containing what looks like raw PII. " +
    'Reply with a JSON object: {"items":[{"kind":"fact|preference|episodic|instruction","content":"…"}]} — empty array when nothing qualifies. No prose.';

  const user =
    `USER MESSAGE:\n${userMessage.slice(0, 4000)}\n\n` +
    `ASSISTANT REPLY:\n${assistantMessage.slice(0, 4000)}\n\n` +
    "Return the JSON object now.";

  const tStart = Date.now();
  try {
    const r = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 600,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) {
      console.warn(`[memory.extract] gateway ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return [];
    }
    const j = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = j.choices?.[0]?.message?.content || "{}";
    if (userId) {
      const { recordGatewayCall } = await import("@/utils/observability/recordGatewayUsage.server");
      await recordGatewayCall({
        userId,
        surface: "Memory: Extract",
        model: EXTRACT_MODEL,
        tokensIn: j.usage?.prompt_tokens,
        tokensOut: j.usage?.completion_tokens,
        promptText: user,
        responseText: text,
        latencyMs: Date.now() - tStart,
      });
    }
    const parsed = JSON.parse(text) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    const out: Extracted[] = [];
    for (const raw of parsed.items) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as { kind?: unknown; content?: unknown };
      const kind = typeof o.kind === "string" ? (o.kind as MemoryItemKind) : "fact";
      const content = typeof o.content === "string" ? o.content.trim() : "";
      if (!content || content.length < 8 || content.length > 500) continue;
      if (!VALID_KINDS.has(kind)) continue;
      // Skip anything that still looks like a redaction placeholder.
      if (/\[(EMAIL|PHONE|SSN|CARD|IP|ADDRESS)\]/i.test(content)) continue;
      out.push({ kind, content });
    }
    return out.slice(0, 8);
  } catch (e) {
    console.warn("[memory.extract] exception:", (e as Error).message);
    return [];
  }
}

export async function extractMemoriesFromTurn(opts: {
  sb: SupabaseClient<Database>;
  userId: string;
  agentId: string;
  conversationId: string | null;
  userMessage: string;
  assistantMessage: string;
  apiKey: string;
  maxItems: number;
}): Promise<number> {
  const { sb, userId, agentId, conversationId, userMessage, assistantMessage, apiKey, maxItems } =
    opts;
  if (!userMessage.trim() || !assistantMessage.trim()) return 0;
  const items = await callOpenRouterForExtraction({
    apiKey,
    userMessage,
    assistantMessage,
    userId,
  });
  if (items.length === 0) return 0;

  const rows = items.map((it) => ({
    user_id: userId,
    agent_id: agentId,
    conversation_id: conversationId,
    kind: it.kind,
    content: it.content,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (sb.from("agent_memory_items") as any).insert(rows);
  if (error) {
    console.warn("[memory.extract] insert failed:", error.message);
    return 0;
  }

  // Enforce the per-agent cap. Server-side RPC prunes oldest low-score items.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb.rpc as any)("prune_agent_memory_items", {
      _user_id: userId,
      _agent_id: agentId,
      _max: maxItems,
    });
  } catch (e) {
    console.warn("[memory.extract] prune failed:", (e as Error).message);
  }
  return rows.length;
}
