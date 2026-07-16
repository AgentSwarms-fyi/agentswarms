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
};

export function isImageModel(model: string): boolean {
  return model in IMAGE_COST_TABLE;
}

export function estimateTextCost(model: string, tokensIn: number, tokensOut: number): number {
  const c = TEXT_COST_TABLE[model];
  if (!c) return 0;
  return (tokensIn / 1000) * c.in + (tokensOut / 1000) * c.out;
}

export function estimateEmbeddingCost(model: string, tokensIn: number): number {
  const c = EMBED_COST_TABLE[model];
  if (typeof c !== "number") return 0;
  return (tokensIn / 1000) * c;
}

export function estimateImageCost(model: string, imageCount: number): number {
  const c = IMAGE_COST_TABLE[model];
  if (typeof c !== "number") return 0;
  return c * Math.max(0, imageCount);
}

// Best-effort token approximation when the upstream gateway does not return
// a `usage` block. ~3.8 chars/token across the models we serve.
export function approxTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3.8));
}
