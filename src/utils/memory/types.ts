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
  /**
   * How long chat history (and any documents generated in it) is kept before
   * the scheduled purge deletes it. Minimum / default is 7 days; the DB CHECK
   * and the purge job both enforce the floor.
   */
  chat_retention_days: number;
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
  chat_retention_days: 7,
};

/** Hard floor for chat retention — the setting can lengthen but never shorten it. */
export const MIN_CHAT_RETENTION_DAYS = 7;

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
