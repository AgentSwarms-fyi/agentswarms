// BI model selections carry both the provider (which integration executes
// the call) and the model id, encoded as one opaque string so the whole BI
// pipeline can thread it through a single parameter:
//
//   "openai::gpt-4o-mini"   → the user's OpenAI integration
//   "openrouter::google/gemini-2.5-flash"
//   "google/gemini-2.5-flash" (legacy, no delimiter) → OpenRouter
//
// Pure module — safe to import from both client and server code.

/** OpenAI-compatible providers the BI endpoint can execute against. */
export const BI_COMPAT_PROVIDERS = [
  "openrouter",
  "openai",
  "gemini",
  "grok",
  "groq",
  "qwen",
  "ollama",
  "vllm",
  "nvidia",
] as const;

export type BiCompatProvider = (typeof BI_COMPAT_PROVIDERS)[number];

export function isBiCompatProvider(p: string): p is BiCompatProvider {
  return (BI_COMPAT_PROVIDERS as readonly string[]).includes(p);
}

// Model ids that generate/consume non-text modalities (image, video, audio,
// embeddings, moderation…). BI generative features are text-only (they ask the
// model for JSON widget specs / prose insights), so their pickers exclude these.
// Note: multimodal *input* text models (e.g. gpt-4o, gemini-flash — vision in,
// text out) are NOT matched here; only non-text OUTPUT / non-chat models are.
const NON_TEXT_MODEL_RE =
  /(embed|embedding|whisper|tts|text-to-speech|(^|[-/.])speech([-/.]|$)|(^|[-/.])audio([-/.]|$)|voice|moderation|rerank|transcri|realtime|dall-?e|imagen|(^|[-/.])image([-/.\d]|$)|image-gen|flux|stable-diffusion|sdxl|midjourney|ideogram|recraft|(^|[-/.])photon([-/.]|$)|(^|[-/.])veo([-/.\d]|$)|(^|[-/.])sora([-/.]|$)|(^|[-/.])video([-/.]|$)|kling|runway|(^|[-/.])luma([-/.]|$))/i;

/** True when a model id looks like a text/chat model usable by BI features. */
export function isTextModelId(id: string): boolean {
  return !NON_TEXT_MODEL_RE.test(id);
}

export function encodeModelChoice(provider: string, model: string): string {
  return `${provider}::${model}`;
}

export function parseModelChoice(
  v: string | null | undefined,
): { provider: string; model: string } | null {
  if (!v) return null;
  const idx = v.indexOf("::");
  if (idx === -1) return { provider: "openrouter", model: v };
  return { provider: v.slice(0, idx) || "openrouter", model: v.slice(idx + 2) };
}
