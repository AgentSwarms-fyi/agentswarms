// The provider ids a "provider/model" string may start with. Shared by the
// AI gateway (which resolves gateway keys' model specs) and the AI functions
// in SQL (which read the optional model argument the same way), so one list
// decides what counts as a provider prefix everywhere.
import type { ProviderId } from "@/utils/providers/types";

export const GATEWAY_PROVIDERS = [
  "bedrock",
  "vertex",
  "anthropic",
  "azure_openai",
  "oci_genai",
  "qwen",
  "grok",
  "openai",
  "gemini",
  "ollama",
  "openrouter",
  "groq",
  "vllm",
  "nvidia",
] as const satisfies readonly ProviderId[];
