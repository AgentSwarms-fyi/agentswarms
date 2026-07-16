// Maps Model Registry provider slugs (set in modelRegistry.server.ts via
// devToSlug) to whether AgentSwarms ships a first-class integration for that
// provider today. Used by the Model Registry page and ModelRegistryPicker to
// show "Integration available" vs "Not yet supported" badges.
//
// Keep this list in sync with src/utils/providers/types.ts (ProviderId) and
// the provider cards on the Integrations page.

export const SUPPORTED_PROVIDER_SLUGS: ReadonlySet<string> = new Set([
  // Direct integrations on the Integrations page
  "openai",
  "anthropic",
  "google",      // Gemini direct + Vertex
  "xai",         // Grok
  "alibaba",     // Qwen via DashScope
  "meta",        // served via Bedrock / Groq / vLLM / OpenRouter / NVIDIA NIM
  "mistral",     // served via Bedrock / Groq / vLLM / OpenRouter / NVIDIA NIM
  "deepseek",    // served via Groq / vLLM / OpenRouter / NVIDIA NIM
  "nvidia",      // NVIDIA NIM (build.nvidia.com) — Nemotron family, free tier
  // Anything routable via OpenRouter is effectively supported too —
  // most other providers are reachable through it.
]);

// Modalities the platform can route end-to-end today.
//   - "text"  : OpenAI-compatible chat completions (all integrated providers).
//   - "image" : Gemini image-generation models routed through the AgentSwarms
//               AI gateway with `modalities: ["image","text"]`. Returns a
//               base64 data URL we render and offer for download. Supported
//               only on the `google` provider slug for now (the gateway
//               doesn't ship Flux/Runway/Imagen image surfaces yet).
export const SUPPORTED_MODALITIES: ReadonlySet<string> = new Set([
  "text",
  "image",
]);

// Canonical list of image-generation model ids served by the AgentSwarms AI
// gateway. Used by:
//   - chat.ts            → routes these through the image-modality flow
//   - swarmRuntime.ts    → forwards image inputs as image_url parts
//   - AgentForm /
//     NodeInspector      → tags the dropdown row with an "Image" badge
//   - providerSupport    → marks the registry row "Available"
export const IMAGE_MODEL_IDS: ReadonlySet<string> = new Set([
  "google/gemini-2.5-flash-image",
  "google/gemini-3-pro-image-preview",
  "google/gemini-3.1-flash-image-preview",
]);

export function isImageModelId(modelId: string): boolean {
  if (!modelId) return false;
  if (IMAGE_MODEL_IDS.has(modelId)) return true;
  // Tolerate the "bare" gemini ids used when the user picks the Gemini
  // provider directly (without the `google/` gateway prefix).
  const bare = modelId.replace(/^google\//, "");
  return (
    bare === "gemini-2.5-flash-image" ||
    bare === "gemini-3-pro-image-preview" ||
    bare === "gemini-3.1-flash-image-preview"
  );
}

export function isModalitySupported(modality: string): boolean {
  return SUPPORTED_MODALITIES.has(modality);
}

// A model is usable end-to-end only if BOTH its provider has an integration
// AND we have a runtime for its modality. Image generation is currently
// limited to the `google` slug (Gemini image models via the AgentSwarms AI
// gateway). Audio / video / embedding models stay flagged unsupported.
export function isModelSupported(slug: string, modality: string): boolean {
  if (!SUPPORTED_PROVIDER_SLUGS.has(slug)) return false;
  if (modality === "text") return true;
  if (modality === "image") return slug === "google";
  return false;
}

export function isProviderSupported(slug: string): boolean {
  return SUPPORTED_PROVIDER_SLUGS.has(slug);
}
