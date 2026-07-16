// Shared types for the agent memory subsystem (STM + LTM).

export type MemoryConfig = {
  stm_enabled: boolean;
  stm_window_messages: number;
  stm_summarize: boolean;
  stm_summary_model: string | null;
  ltm_enabled: boolean;
  ltm_auto_extract: boolean;
  ltm_max_items: number;
  ltm_recall_top_k: number;
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  stm_enabled: true,
  stm_window_messages: 20,
  stm_summarize: true,
  stm_summary_model: null,
  ltm_enabled: false,
  ltm_auto_extract: true,
  ltm_max_items: 200,
  ltm_recall_top_k: 5,
};

export type MemoryItemKind = "fact" | "preference" | "episodic" | "instruction";

export type MemoryItem = {
  id: string;
  kind: MemoryItemKind;
  content: string;
  score: number;
  last_used_at: string | null;
  created_at: string;
};

export type RecalledItem = MemoryItem & { matchScore: number };
