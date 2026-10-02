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

/**
 * A LEGACY STAMP, not a provider you can choose any more.
 *
 * Embeddings used to be able to come from the operator's `OPENAI_API_KEY`,
 * which made a self-hosted install depend on an OpenAI account for retrieval
 * even when its models came from somewhere else entirely. That path is gone:
 * every embedding now comes from a connected model provider.
 *
 * The stamp has to keep resolving, though. Documents embedded before this
 * change carry `openai_builtin` in their metadata, and the vectors are still
 * good — so the stamp maps onto a connected provider serving the SAME vector
 * space (text-embedding-3-small), never a different one. Mixing spaces does not
 * error, it returns confident nonsense, which is the whole reason this module
 * exists.
 */
export const BUILTIN_PROVIDER = "openai_builtin";

/**
 * Who can reproduce the legacy built-in vector space, best first. OpenAI serves
 * the exact model; OpenRouter proxies the same one.
 */
const LEGACY_BUILTIN_EQUIVALENTS = ["openai", "openrouter"];

/**
 * Preferred provider when the caller doesn't name one and the user has it
 * connected. It is also the one provider whose resolution falls back to an
 * operator-wide key (OPENROUTER_API_KEY), so the instance that gets chat for
 * free gets retrieval for free from the same account.
 */
export const DEFAULT_EMBED_PROVIDER = "openrouter";

/**
 * Default embedding model per provider, used when the caller names none.
 *
 * OpenRouter routes to text-embedding-3-small rather than one of the nemotron
 * embedding models on purpose: it is the same vector space older collections
 * were written in, so a knowledge base embedded before this release stays
 * searchable without a re-index. A model with a different space (or width) is
 * selectable, but means a re-embed.
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
  /** Always set now that every target is a connected provider. */
  endpoint?: string;
  allowCustomModel: boolean;
};

/**
 * The same model, named the way a given provider names it.
 *
 * `text-embedding-3-small` on OpenAI is `openai/text-embedding-3-small` on
 * OpenRouter — one vector space, two spellings. Getting this wrong is the
 * silent-nonsense case, so it is spelled out rather than left to the caller.
 */
function sameSpaceModel(provider: string, model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (provider === "openrouter") {
    return model.includes("/") ? model : `openai/${model}`;
  }
  if (provider === "openai") return model.replace(/^openai\//, "");
  return model;
}

/**
 * Resolve a legacy `openai_builtin` stamp against connected providers.
 *
 * Returns null when the user has connected nothing that can reproduce the
 * space — which is honest: re-embedding under a provider they do have is the
 * only correct repair, and quietly answering from a different space would not
 * be.
 */
async function legacyBuiltinTarget(userId: string, model?: string): Promise<EmbedTarget | null> {
  const wanted = model || PROVIDER_EMBED_MODEL[BUILTIN_PROVIDER];
  for (const provider of LEGACY_BUILTIN_EQUIVALENTS) {
    const t = await integrationTarget(userId, provider, sameSpaceModel(provider, wanted));
    if (t) return t;
  }
  return null;
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
 * An explicit provider is honoured exactly, because silently substituting a
 * different one is how vector spaces get mixed. The single exception is the
 * legacy "openai_builtin" stamp, which no longer names anything that exists and
 * is mapped onto a connected provider serving the same space.
 *
 * When no provider is named: OpenRouter, then any other connected provider with
 * an embeddings endpoint. There is deliberately no operator-key fallback — an
 * install should not need an OpenAI account to search its own documents.
 */
export async function resolveEmbedTarget(
  userId: string,
  opts: { provider?: string | null; model?: string | null } = {},
): Promise<EmbedTarget | null> {
  return resolveEmbedTargetInner(userId, opts);
}

/**
 * The arguments every ingestion path needs to embed, resolved the same way.
 *
 * Four callers used to skip resolveEmbedTarget and read
 * `process.env.OPENAI_API_KEY` directly: the URL and GitHub ingest routes, the
 * connector sync engine, and template provisioning. So the ONLY path that
 * honoured the OpenRouter preference was the manual Back-fill button — every
 * automatic one went straight to the operator's OpenAI quota.
 *
 * That is the exact failure this module's own comment warns about, and it
 * happened here: a GitHub source ingested 4 files and then died with
 * `429 insufficient_quota / credit_balance_exhausted` on an instance where
 * OpenRouter was connected and would have worked.
 *
 * Returns null when nothing is available, so callers keep their existing
 * "documents saved, semantic search not updated" behaviour.
 */
export async function resolveEmbedArgs(
  userId: string | undefined,
  opts: { provider?: string | null; model?: string | null } = {},
): Promise<
  | (Pick<EmbedTarget, "endpoint" | "allowCustomModel"> & {
      /** embedAndStoreDocuments' parameter name; the value is whichever
       *  provider won, not necessarily an OpenAI key. */
      openaiKey: string;
      defaults: { model: string };
      stampProvider: string;
    })
  | null
> {
  // Without a user there is no connected provider to resolve, and there is no
  // longer an operator key to fall back on. Null is the honest answer; callers
  // already treat it as "documents saved, semantic search not updated".
  const target = userId ? await resolveEmbedTargetInner(userId, opts) : null;
  if (!target) return null;
  return {
    openaiKey: target.apiKey,
    endpoint: target.endpoint,
    allowCustomModel: target.allowCustomModel,
    defaults: { model: target.model },
    stampProvider: target.provider,
  };
}

async function resolveEmbedTargetInner(
  userId: string,
  opts: { provider?: string | null; model?: string | null } = {},
): Promise<EmbedTarget | null> {
  const model = opts.model || undefined;
  const requested = opts.provider || undefined;

  if (requested) {
    return requested === BUILTIN_PROVIDER
      ? legacyBuiltinTarget(userId, model)
      : integrationTarget(userId, requested, model);
  }

  // Connected providers only. OpenRouter first — it is the one that also
  // resolves the operator's OPENROUTER_API_KEY, so an instance configured for
  // zero-config chat gets zero-config embeddings from the same place instead of
  // needing a second account with a different vendor.
  const preferred = await integrationTarget(userId, DEFAULT_EMBED_PROVIDER, model);
  if (preferred) return preferred;

  for (const p of EMBED_CAPABLE) {
    if (p === DEFAULT_EMBED_PROVIDER) continue;
    const t = await integrationTarget(userId, p, model);
    if (t) return t;
  }
  return null;
}
