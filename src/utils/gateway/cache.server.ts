// The semantic cache's database and embedding side.
//
// Every function here fails soft. A cache that cannot embed, cannot reach
// pgvector, or finds nothing simply misses, and the gateway calls the
// provider as it always did — a cache is an optimisation, and an
// optimisation that can break the thing it optimises is a liability.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { roundSimilarity, vectorLiteral, type CacheScope } from "@/utils/gateway/cache";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";

export type CacheHit = {
  id: string;
  /** The question the stored answer was written for, not the one just asked. */
  question: string;
  answer: string;
  model: string;
  similarity: number;
};

/**
 * The question as a vector, using whatever embedding provider the OWNER has
 * connected — the same resolution the knowledge bases use, so an install with
 * no embedding provider gets a miss rather than a surprise bill on somebody
 * else's key.
 */
async function embedQuestion(userId: string, question: string): Promise<number[] | null> {
  try {
    const { resolveEmbedArgs } = await import("@/utils/tools/embedTarget.server");
    const target = await resolveEmbedArgs(userId);
    if (!target) return null;
    const { embedTexts } = await import("@/utils/tools/embedding.server");
    const [vector] = await embedTexts([question], target.openaiKey, target.defaults.model, {
      userId,
      surface: "Gateway: semantic cache",
      endpoint: target.endpoint,
      allowCustomModel: target.allowCustomModel,
    });
    return vector ?? null;
  } catch (e) {
    // Worth a line, because a cache that never hits looks like a cache that
    // is switched off, and the reason is usually here.
    console.warn("[gateway] could not embed for the cache:", (e as Error).message);
    return null;
  }
}

/** The instance's cache settings: a row first, then env, then a default. */
export async function cacheSettings(): Promise<{
  similarity: number;
  ttlHours: number;
  maxTemperature: number;
}> {
  const s = await getPlatformResources();
  return {
    similarity: s.gatewayCacheSimilarity,
    ttlHours: s.gatewayCacheTtlHours,
    maxTemperature: s.gatewayCacheMaxTemperature,
  };
}

/**
 * The best cached answer for this exact scope, or null.
 *
 * The owner is passed to the RPC rather than inferred: the gateway holds a
 * key, not a session, and the function is SECURITY DEFINER, so that argument
 * is the whole boundary between one account's cache and another's.
 */
export async function lookupCached(
  scope: CacheScope,
  question: string,
  minSimilarity: number,
): Promise<{ hit: CacheHit; embedding: number[] } | { hit: null; embedding: number[] | null }> {
  const embedding = await embedQuestion(scope.userId, question);
  if (!embedding) return { hit: null, embedding: null };
  try {
    const { data, error } = await supabaseAdmin.rpc("match_gateway_cache", {
      p_user_id: scope.userId,
      p_target_key: scope.targetKey,
      p_prompt_hash: scope.promptHash,
      query_embedding: vectorLiteral(embedding) as unknown as string,
      min_similarity: minSimilarity,
    });
    if (error) throw new Error(error.message);
    const row = (data as CacheHit[] | null)?.[0];
    if (!row) return { hit: null, embedding };
    return {
      hit: { ...row, similarity: roundSimilarity(row.similarity) },
      embedding,
    };
  } catch (e) {
    console.warn("[gateway] semantic cache lookup failed:", (e as Error).message);
    return { hit: null, embedding };
  }
}

/** Count a hit. Best effort: a lost counter is not worth failing a request for. */
export function recordCacheHit(id: string): void {
  void (async () => {
    try {
      await supabaseAdmin.rpc("increment_gateway_cache_hit", { p_id: id });
    } catch {
      // Deliberately silent. The hit itself is already in the audit chain and
      // in the response header; this counter only decorates the editor's list.
    }
  })();
}

/**
 * Store an answer, reusing the embedding the lookup already paid for.
 *
 * Fire and forget: the caller has a reply to return, and a cache write that
 * fails must not turn a good answer into an error.
 */
export function storeCached(args: {
  scope: CacheScope;
  question: string;
  answer: string;
  model: string;
  embedding: number[];
  ttlHours: number;
}): void {
  const expires = new Date(Date.now() + args.ttlHours * 3_600_000).toISOString();
  void supabaseAdmin
    .from("gateway_cache")
    .insert({
      user_id: args.scope.userId,
      target_key: args.scope.targetKey,
      prompt_hash: args.scope.promptHash,
      question: args.question.slice(0, 8000),
      answer: args.answer,
      model: args.model,
      embedding: vectorLiteral(args.embedding) as unknown as string,
      expires_at: expires,
    })
    .then(({ error }) => {
      if (error) console.warn("[gateway] semantic cache write failed:", error.message);
    });
  // Sweep this owner's expired rows on the way past. The lookup already
  // refuses to serve them, so they are dead weight rather than a correctness
  // problem — but a table that only grows needs a scheduler nobody asked for,
  // and the one moment an owner is certainly writing is the cheapest time to
  // take them out.
  void supabaseAdmin
    .from("gateway_cache")
    .delete()
    .eq("user_id", args.scope.userId)
    .lt("expires_at", new Date().toISOString())
    .then(() => undefined);
}

/** Everything cached for one owner, newest first — what the editor shows. */
export async function listCacheEntries(
  userId: string,
  limit = 50,
): Promise<
  {
    id: string;
    question: string;
    model: string;
    hits: number;
    created_at: string;
    expires_at: string;
  }[]
> {
  const { data } = await supabaseAdmin
    .from("gateway_cache")
    .select("id, question, model, hits, created_at, expires_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** Empty one owner's cache. Returns how many rows went. */
export async function clearCache(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("gateway_cache")
    .delete()
    .eq("user_id", userId)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}
