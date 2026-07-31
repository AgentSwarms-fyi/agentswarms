// Memory tools the agent can call directly during a turn. Five tools:
//   memory_remember(content, kind?)  → write to LTM
//   memory_recall(query, top_k?)     → on-demand LTM recall
//   memory_forget(id)                → delete an LTM item
//   memory_set(key, value)           → write to the conversation scratchpad
//   memory_get(key?)                 → read from the conversation scratchpad
//
// All tools are scoped by RLS to the calling user. Memory_set/get require a
// conversation_id (passed via toolCtx.conversationId).

import type { ToolDef, AgentToolContext } from "@/utils/tools/registry.server";
import { recallMemoryItems, buildLtmBlock } from "./recall.server";

export type MemoryToolContext = AgentToolContext & { conversationId?: string | null };

const VALID_KINDS = ["fact", "preference", "episodic", "instruction"] as const;
type Kind = (typeof VALID_KINDS)[number];

// ─────────────────────────── memory_remember ───────────────────────────
export const memoryRememberTool: ToolDef = {
  type: "function",
  function: {
    name: "memory_remember",
    description:
      "Save a durable note to your long-term memory for this user. Use only for stable facts, preferences, decisions, or instructions that will help future conversations. Do NOT save raw PII (emails, phone numbers, SSNs, payment details).",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The note to remember (one sentence, < 500 chars)",
        },
        kind: {
          type: "string",
          enum: VALID_KINDS as readonly string[] as string[],
          description: "Category of the memory item. Defaults to 'fact'.",
        },
      },
      required: ["content"],
    },
  },
};

export async function runMemoryRemember(
  ctx: MemoryToolContext,
  args: { content?: string; kind?: string },
): Promise<string> {
  if (!ctx.agentId)
    return JSON.stringify({ error: "No agent context — memory_remember unavailable" });
  const content = String(args.content || "").trim();
  if (!content || content.length < 3 || content.length > 500) {
    return JSON.stringify({ error: "content must be 3–500 chars" });
  }
  if (/\[(EMAIL|PHONE|SSN|CARD|IP|ADDRESS)\]/i.test(content)) {
    return JSON.stringify({ error: "content contains a redaction placeholder; refuse to store" });
  }
  const kind = (VALID_KINDS as readonly string[]).includes(args.kind || "")
    ? (args.kind as Kind)
    : "fact";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (ctx.sb.from("agent_memory_items") as any)
    .insert({
      user_id: ctx.userId,
      agent_id: ctx.agentId,
      conversation_id: ctx.conversationId ?? null,
      kind,
      content,
    })
    .select("id")
    .single();
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ ok: true, id: data?.id, kind, content });
}

// ─────────────────────────── memory_recall ───────────────────────────
export const memoryRecallTool: ToolDef = {
  type: "function",
  function: {
    name: "memory_recall",
    description:
      "Search your long-term memory for items matching a query. Use when the user asks something that may be answered by an earlier session.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query" },
        top_k: { type: "number", description: "Max items (1-10)", default: 5 },
      },
      required: ["query"],
    },
  },
};

export async function runMemoryRecall(
  ctx: MemoryToolContext,
  args: { query?: string; top_k?: number },
): Promise<string> {
  if (!ctx.agentId) return JSON.stringify({ error: "No agent context" });
  const q = String(args.query || "").trim();
  if (!q) return JSON.stringify({ error: "query required" });
  const items = await recallMemoryItems({
    sb: ctx.sb,
    userId: ctx.userId,
    agentId: ctx.agentId,
    userPrompt: q,
    topK: Math.max(1, Math.min(args.top_k ?? 5, 10)),
  });
  if (items.length === 0)
    return JSON.stringify({ items: [], note: "No matches in long-term memory." });
  return JSON.stringify({
    items: items.map((it) => ({ id: it.id, kind: it.kind, content: it.content })),
    formatted: buildLtmBlock(items),
  });
}

// ─────────────────────────── memory_forget ───────────────────────────
export const memoryForgetTool: ToolDef = {
  type: "function",
  function: {
    name: "memory_forget",
    description:
      "Delete a single long-term memory item by id. Use when the user says something is no longer true.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory item id (returned by memory_recall)" },
      },
      required: ["id"],
    },
  },
};

export async function runMemoryForget(
  ctx: MemoryToolContext,
  args: { id?: string },
): Promise<string> {
  const id = String(args.id || "").trim();
  if (!id) return JSON.stringify({ error: "id required" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (ctx.sb.from("agent_memory_items") as any)
    .delete()
    .eq("id", id)
    .eq("user_id", ctx.userId);
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ ok: true, deleted: id });
}

// ─────────────────────────── memory_set / memory_get ─────────────────
export const memorySetTool: ToolDef = {
  type: "function",
  function: {
    name: "memory_set",
    description:
      "Write a key/value pair to this conversation's scratchpad. Useful for tracking state mid-conversation, or for swarm nodes to share notes.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Scratchpad key (alphanumeric + underscore)" },
        value: { description: "Any JSON-serializable value" },
      },
      required: ["key", "value"],
    },
  },
};

export const memoryGetTool: ToolDef = {
  type: "function",
  function: {
    name: "memory_get",
    description: "Read from this conversation's scratchpad. Omit `key` to dump all keys.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Scratchpad key to read; omit for full dump." },
      },
    },
  },
};

export async function runMemorySet(
  ctx: MemoryToolContext,
  args: { key?: string; value?: unknown },
): Promise<string> {
  if (!ctx.conversationId)
    return JSON.stringify({ error: "no conversation context — scratchpad unavailable" });
  const key = String(args.key || "").trim();
  if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) {
    return JSON.stringify({ error: "key must be alphanumeric + underscore" });
  }
  // Read-modify-write the scratchpad jsonb.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (ctx.sb.from("conversation_memory") as any)
    .select("scratchpad")
    .eq("conversation_id", ctx.conversationId)
    .maybeSingle();
  const sp = (
    row?.scratchpad && typeof row.scratchpad === "object" ? row.scratchpad : {}
  ) as Record<string, unknown>;
  sp[key] = args.value ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (ctx.sb.from("conversation_memory") as any).upsert(
    {
      conversation_id: ctx.conversationId,
      user_id: ctx.userId,
      scratchpad: sp,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id" },
  );
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ ok: true, key });
}

export async function runMemoryGet(
  ctx: MemoryToolContext,
  args: { key?: string },
): Promise<string> {
  if (!ctx.conversationId)
    return JSON.stringify({ error: "no conversation context — scratchpad unavailable" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (ctx.sb.from("conversation_memory") as any)
    .select("scratchpad")
    .eq("conversation_id", ctx.conversationId)
    .maybeSingle();
  const sp = (
    row?.scratchpad && typeof row.scratchpad === "object" ? row.scratchpad : {}
  ) as Record<string, unknown>;
  if (args.key) {
    return JSON.stringify({ key: args.key, value: sp[String(args.key)] ?? null });
  }
  return JSON.stringify({ keys: Object.keys(sp), values: sp });
}
