// Centralized pricing + token approximation for the app's LLM usage.
// Used by /api/chat, swarm runtime, /api/bi, KB ingest, memory work, etc.
// Prices are USD per 1K tokens; image models use a flat per-call price.
// Model ids use the vendor/model naming convention (matches OpenRouter's
// model catalog) — keep in sync; unknown models fall back to 0 (so usage is
// still recorded with real tokens/requests even when cost can't be computed).

export type TokenPrice = { in: number; out: number };

export const TEXT_COST_TABLE: Record<string, TokenPrice> = {
  // Google Gemini
  "google/gemini-2.5-flash": { in: 0.0003, out: 0.0025 },
  "google/gemini-2.5-flash-lite": { in: 0.0001, out: 0.0004 },
  "google/gemini-2.5-pro": { in: 0.00125, out: 0.005 },
  "google/gemini-3-flash-preview": { in: 0.0003, out: 0.0025 },
  "google/gemini-3.1-flash-lite-preview": { in: 0.0001, out: 0.0004 },
  "google/gemini-3.1-pro-preview": { in: 0.00125, out: 0.005 },
  "google/gemini-3.5-flash": { in: 0.0003, out: 0.0025 },
  // OpenAI GPT-5 family
  "openai/gpt-5": { in: 0.00125, out: 0.01 },
  "openai/gpt-5-mini": { in: 0.00025, out: 0.002 },
  "openai/gpt-5-nano": { in: 0.00005, out: 0.0004 },
  "openai/gpt-5.2": { in: 0.00125, out: 0.01 },
  "openai/gpt-5.4": { in: 0.00125, out: 0.01 },
  "openai/gpt-5.4-mini": { in: 0.00025, out: 0.002 },
  "openai/gpt-5.4-nano": { in: 0.00005, out: 0.0004 },
  "openai/gpt-5.4-pro": { in: 0.0025, out: 0.02 },
  "openai/gpt-5.5": { in: 0.00125, out: 0.01 },
  "openai/gpt-5.5-pro": { in: 0.0025, out: 0.02 },

  // ── Added because they were OFFERED IN THE UI AND UNPRICED ────────────────
  // The model pickers in AgentForm, BiModelSelect and ModelFallbackDialog list
  // all of these, and none had a price, so every call through them cost $0 —
  // including openai/gpt-4o-mini, which is the DEFAULT for embedded agents.
  // A budget sums cost_usd, so those calls never accumulated and the cap never
  // fired for anyone who picked one.
  //
  // !! VERIFY THESE BEFORE RELYING ON THEM FOR BILLING. They are public list
  // prices per 1K tokens as understood at the time of writing, not values read
  // from a live price feed, and vendors change them. They are here because an
  // approximate figure makes a SAFETY CAP work, while zero switches it off —
  // and because hasKnownPrice() now marks anything still missing, so a stale
  // or absent entry shows up instead of silently reading as free.
  "openai/gpt-4o": { in: 0.0025, out: 0.01 },
  "openai/gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  "anthropic/claude-3.5-sonnet": { in: 0.003, out: 0.015 },
  "anthropic/claude-3.5-haiku": { in: 0.0008, out: 0.004 },
  "anthropic/claude-sonnet-4": { in: 0.003, out: 0.015 },
  "meta-llama/llama-3.3-70b-instruct": { in: 0.00012, out: 0.0003 },
  "meta-llama/Meta-Llama-3.1-70B-Instruct": { in: 0.00012, out: 0.0003 },
  "meta-llama/Meta-Llama-3.1-8B-Instruct": { in: 0.00002, out: 0.00005 },
  "deepseek/deepseek-chat": { in: 0.00028, out: 0.00042 },
  "mistralai/mistral-large": { in: 0.002, out: 0.006 },
  "mistralai/mistral-large-2-instruct": { in: 0.002, out: 0.006 },
  "mistralai/Mistral-7B-Instruct-v0.3": { in: 0.00003, out: 0.00006 },
  "mistralai/mixtral-8x22b-instruct-v0.1": { in: 0.0009, out: 0.0009 },
  "qwen/qwen-2.5-72b-instruct": { in: 0.00035, out: 0.0004 },
  "qwen/qwen2.5-coder-32b-instruct": { in: 0.00018, out: 0.00018 },
  "qwen/qwq-32b": { in: 0.00018, out: 0.00018 },
  "Qwen/Qwen2.5-72B-Instruct": { in: 0.00035, out: 0.0004 },
  "Qwen/Qwen2.5-7B-Instruct": { in: 0.00005, out: 0.0001 },
  "x-ai/grok-2-1212": { in: 0.002, out: 0.01 },
  "google/gemma-3-27b-it": { in: 0.0001, out: 0.0002 },
};

// Embedding models — cost per 1K input tokens (no output side). Called
// directly against OpenAI's API, so ids are bare (no vendor/ prefix).
export const EMBED_COST_TABLE: Record<string, number> = {
  "text-embedding-3-small": 0.00002,
  "text-embedding-3-large": 0.00013,
};

// Per-image price (USD) for image-generation models. Output tokens are
// always 0 for these; cost is flat per generated image.
export const IMAGE_COST_TABLE: Record<string, number> = {
  "google/gemini-2.5-flash-image": 0.039, // Nano Banana
  "google/gemini-3.1-flash-image-preview": 0.039,
  "google/gemini-3-pro-image-preview": 0.12,
  // The image playground offers these two non-preview ids; without them a
  // generated image cost nothing, and isImageModel() also missed them — so the
  // call was priced as TEXT with zero output tokens, which is zero again.
  "google/gemini-3.1-flash-image": 0.039,
  "google/gemini-3-pro-image": 0.12,
};

export function isImageModel(model: string): boolean {
  return model in IMAGE_COST_TABLE;
}

/**
 * Look a model up under both spellings it can arrive in.
 *
 * Gateway ids are `vendor/model` (`openai/text-embedding-3-small`); a call made
 * straight to a provider's own API uses the bare id
 * (`text-embedding-3-small`), and EMBED_COST_TABLE is keyed that way. The
 * knowledge page names the prefixed form, so an embedding run priced at exactly
 * zero depending on which caller reached it. Both spellings resolve now.
 */
function lookup<T>(table: Record<string, T>, model: string): T | undefined {
  const key = (model ?? "").trim();
  if (!key) return undefined;
  return table[key] ?? table[key.split("/").pop() ?? ""];
}

/**
 * Is this model's price actually known?
 *
 * AN UNKNOWN MODEL COSTS ZERO, and zero is indistinguishable from "cheap" in
 * every report and every budget comparison downstream. That is the difference
 * between a cap that holds and a cap that quietly does not: getBudgetDecision
 * sums cost_usd, so calls on an unpriced model never accumulate, the monthly
 * total stays under the limit for ever, and the hard stop never fires.
 *
 * Returning the cost alone cannot express this, so callers ask separately and
 * mark the trace. A missing price must be visible, not silent.
 */
export function hasKnownPrice(model: string, kind: "text" | "embedding" | "image"): boolean {
  const table =
    kind === "image" ? IMAGE_COST_TABLE : kind === "embedding" ? EMBED_COST_TABLE : TEXT_COST_TABLE;
  return lookup(table as Record<string, unknown>, model) !== undefined;
}

export function estimateTextCost(model: string, tokensIn: number, tokensOut: number): number {
  const c = lookup(TEXT_COST_TABLE, model);
  if (!c) return 0;
  return (tokensIn / 1000) * c.in + (tokensOut / 1000) * c.out;
}

export function estimateEmbeddingCost(model: string, tokensIn: number): number {
  const c = lookup(EMBED_COST_TABLE, model);
  if (typeof c !== "number") return 0;
  return (tokensIn / 1000) * c;
}

export function estimateImageCost(model: string, imageCount: number): number {
  const c = lookup(IMAGE_COST_TABLE, model);
  if (typeof c !== "number") return 0;
  return c * Math.max(0, imageCount);
}

// Best-effort token approximation when the upstream gateway does not return
// a `usage` block. ~3.8 chars/token across the models we serve.
export function approxTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3.8));
}
