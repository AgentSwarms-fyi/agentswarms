// Where embeddings run — resolved in ONE place so ingest and retrieval cannot
// disagree.
//
// This matters more than it looks: vectors from two different models are not
// comparable, so if documents are embedded with model A and the query is
// embedded with model B, similarity search returns confident nonsense rather
// than an error. Both paths call this, and every embedded document is stamped
// with what was actually used (see embedAndStoreDocuments), so retrieval can
// reproduce it exactly.
import { resolveOpenAICompatTransport } from "@/utils/providers/credentials.server";
import type { ProviderId } from "@/utils/providers/types";

/** The operator's OPENAI_API_KEY rather than a per-user integration. */
export const BUILTIN_PROVIDER = "openai_builtin";

/**
 * Preferred provider when the caller doesn't name one and the user has it
 * connected. OpenRouter keeps embedding off the OpenAI quota that chat, doc
 * generation and retrieval otherwise share — once that quota is exhausted,
 * knowledge-base search goes down with it.
 */
export const DEFAULT_EMBED_PROVIDER = "openrouter";

/**
 * Default embedding model per provider, used when the caller names none.
 *
 * OpenRouter routes to text-embedding-3-small rather than one of the nemotron
 * embedding models on purpose: it is the same vector space the built-in OpenAI
 * key produces, so moving a collection to OpenRouter to escape an exhausted
 * OpenAI quota does not invalidate chunks that are already embedded. A model
 * with a different space (or width) is selectable, but means a re-embed.
 */
export const PROVIDER_EMBED_MODEL: Record<string, string> = {
  openrouter: "openai/text-embedding-3-small",
  openai: "text-embedding-3-small",
  [BUILTIN_PROVIDER]: "text-embedding-3-small",
  gemini: "gemini-embedding-001",
  nvidia: "nvidia/nv-embed-v1",
  qwen: "text-embedding-v3",
  ollama: "nomic-embed-text",
};

/** Providers that can serve an OpenAI-compatible /embeddings endpoint. */
const EMBED_CAPABLE: string[] = [
  "openrouter",
  "openai",
  "gemini",
  "nvidia",
  "qwen",
  "ollama",
  "vllm",
];

export type EmbedTarget = {
  provider: string;
  model: string;
  apiKey: string;
  /** Absent for the built-in key (embedTexts defaults to the OpenAI endpoint). */
  endpoint?: string;
  allowCustomModel: boolean;
};

function builtinTarget(model?: string): EmbedTarget | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return {
    provider: BUILTIN_PROVIDER,
    model: model || PROVIDER_EMBED_MODEL[BUILTIN_PROVIDER],
    apiKey: key,
    allowCustomModel: false,
  };
}

async function integrationTarget(
  userId: string,
  provider: string,
  model?: string,
): Promise<EmbedTarget | null> {
  const t = await resolveOpenAICompatTransport({ userId, provider: provider as ProviderId });
  // Ollama and vLLM are keyless local servers; everything else needs a key.
  if (!t || (!t.apiKey && provider !== "ollama" && provider !== "vllm")) return null;
  return {
    provider,
    model: model || PROVIDER_EMBED_MODEL[provider] || "",
    apiKey: t.apiKey ?? "",
    endpoint: t.endpointUrl.replace(/\/chat\/completions\/?$/, "/embeddings"),
    allowCustomModel: true,
  };
}

/**
 * Resolve the embedding target.
 *
 * An explicit provider is honoured exactly — a caller that says "openai_builtin"
 * gets that or nothing, because silently substituting a different provider is
 * how vector spaces get mixed. Only when none is named do we fall back:
 * OpenRouter → the built-in key → any other connected embedding provider.
 */
export async function resolveEmbedTarget(
  userId: string,
  opts: { provider?: string | null; model?: string | null } = {},
): Promise<EmbedTarget | null> {
  const model = opts.model || undefined;
  const requested = opts.provider || undefined;

  if (requested) {
    return requested === BUILTIN_PROVIDER
      ? builtinTarget(model)
      : integrationTarget(userId, requested, model);
  }

  const preferred = await integrationTarget(userId, DEFAULT_EMBED_PROVIDER, model);
  if (preferred) return preferred;

  const builtin = builtinTarget(model);
  if (builtin) return builtin;

  for (const p of EMBED_CAPABLE) {
    if (p === DEFAULT_EMBED_PROVIDER) continue;
    const t = await integrationTarget(userId, p, model);
    if (t) return t;
  }
  return null;
}
