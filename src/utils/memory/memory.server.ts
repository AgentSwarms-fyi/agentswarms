// High-level memory orchestration. Loads the per-agent memory config, the
// conversation's STM (summary + sliding window), and the LTM recall block.
// chat.ts calls `loadMemoryContext` once per request and stitches the result
// into the system prompt + outgoing message list.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, type RecalledItem } from "./types";
import { recallMemoryItems, buildLtmBlock } from "./recall.server";
import { buildSummaryBlock } from "./summarize.server";

export type MemoryOverrides = Partial<MemoryConfig> & {
  // Used by swarm nodes: when "swarm", use the swarm_run_id as the
  // conversation_id (so STM persists across nodes within one execution),
  // and treat LTM as agent-scoped only when "agent", or skip LTM when "none".
  ltm_scope?: "agent" | "swarm" | "none";
};

export async function resolveMemoryConfig(opts: {
  sb: SupabaseClient<Database>;
  agentId: string | null | undefined;
  overrides?: MemoryOverrides;
}): Promise<MemoryConfig> {
  const { sb, agentId, overrides } = opts;
  let stored: Partial<MemoryConfig> = {};
  if (agentId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (sb.from("agent_memory_config") as any)
        .select("*")
        .eq("agent_id", agentId)
        .maybeSingle();
      if (data) stored = data as Partial<MemoryConfig>;
    } catch {
      /* ignore — defaults apply */
    }
  }
  const merged: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...stored };
  if (overrides) {
    for (const k of Object.keys(overrides) as (keyof MemoryConfig)[]) {
      const v = overrides[k];
      if (v !== undefined && v !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as any)[k] = v;
      }
    }
  }
  // Honor the swarm scope: when "none", force LTM off for this run.
  if (overrides?.ltm_scope === "none") merged.ltm_enabled = false;
  return merged;
}

export type LoadedMemory = {
  config: MemoryConfig;
  summaryBlock: string; // formatted [SUMMARY] block, or ""
  ltmBlock: string; // formatted [LTM] block, or ""
  recalled: RecalledItem[]; // raw recalled items (for SSE chip)
  windowMessageIds: string[]; // diagnostics
};

export async function loadMemoryContext(opts: {
  sb: SupabaseClient<Database>;
  userId: string;
  agentId: string | null | undefined;
  conversationId: string | null | undefined;
  userPrompt: string;
  config: MemoryConfig;
}): Promise<LoadedMemory> {
  const { sb, userId, agentId, conversationId, userPrompt, config } = opts;
  let summaryBlock = "";
  let ltmBlock = "";
  let recalled: RecalledItem[] = [];

  if (config.stm_enabled && conversationId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: memRow } = await (sb.from("conversation_memory") as any)
        .select("summary")
        .eq("conversation_id", conversationId)
        .maybeSingle();
      summaryBlock = buildSummaryBlock(memRow?.summary ?? null);
    } catch {
      /* ignore */
    }
  }

  if (config.ltm_enabled && agentId && userPrompt.trim()) {
    try {
      recalled = await recallMemoryItems({
        sb,
        userId,
        agentId,
        userPrompt,
        topK: config.ltm_recall_top_k,
      });
      ltmBlock = buildLtmBlock(recalled);
    } catch (e) {
      console.warn("[memory.load] recall failed:", (e as Error).message);
    }
  }

  return {
    config,
    summaryBlock,
    ltmBlock,
    recalled,
    windowMessageIds: [],
  };
}

// Build the final system prompt by stitching the agent's existing system
// prompt with the LTM block + STM summary block. Order: base prompt → LTM →
// summary, since the LTM is more important to keep at the top of the model's
// attention window.
export function composeSystemPrompt(opts: {
  basePrompt: string | undefined | null;
  ltmBlock: string;
  summaryBlock: string;
}): string | undefined {
  const parts: string[] = [];
  const base = (opts.basePrompt || "").trim();
  if (base) parts.push(base);
  if (opts.ltmBlock) parts.push(opts.ltmBlock);
  if (opts.summaryBlock) parts.push(opts.summaryBlock);
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}
