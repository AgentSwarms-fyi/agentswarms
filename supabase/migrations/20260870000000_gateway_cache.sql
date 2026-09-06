-- A semantic cache in front of the AI gateway.
--
-- The same question asked twice a minute apart costs twice. A cache keyed on
-- the MEANING of the question rather than its bytes answers the second one
-- for the price of an embedding, which is three orders of magnitude cheaper
-- than a completion.
--
-- It is off unless a key turns it on, and that is deliberate: a cache that
-- answers a question with a NEARLY identical question's answer is a
-- correctness risk, and nobody should inherit one by upgrading. A key opts
-- in; the similarity floor, the lifetime and the temperature ceiling are the
-- instance's to set.
--
-- Scoping is the part that matters. An entry belongs to one OWNER, one TARGET
-- (an agent id, or a provider/model for a bare model call) and one SYSTEM
-- INSTRUCTION, so no answer can cross a user, an agent, or a differently
-- instructed run of the same agent. There is no global cache and no way to
-- ask for one.

CREATE TABLE IF NOT EXISTS public.gateway_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- "agent:<uuid>" or "<provider>/<model>". Part of the lookup, never a join.
  target_key text NOT NULL,
  -- sha256 of the system instruction the turn ran with. Two runs of one agent
  -- with different instructions are different questions.
  prompt_hash text NOT NULL,
  -- The question as asked, for the owner to inspect what their cache holds.
  question text NOT NULL,
  answer text NOT NULL,
  -- The model that produced the answer, so a hit can say what wrote it.
  model text NOT NULL,
  embedding vector(1536) NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  last_hit_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- The lookup filters on all three scope columns before it ranks, so they lead.
CREATE INDEX IF NOT EXISTS gateway_cache_scope_idx
  ON public.gateway_cache (user_id, target_key, prompt_hash, expires_at);

ALTER TABLE public.gateway_cache ENABLE ROW LEVEL SECURITY;

-- Owner-only, like every other row a key produces. The gateway reads with the
-- service role because the request carries a key rather than a session, and
-- it passes the key's owner explicitly.
CREATE POLICY "Users read own gateway cache"
  ON public.gateway_cache FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users clear own gateway cache"
  ON public.gateway_cache FOR DELETE
  USING (auth.uid() = user_id);

/**
 * The best cached answer for one owner, target and system instruction.
 *
 * SECURITY DEFINER because the gateway calls it as the service role on behalf
 * of a key's owner, and the owner is a parameter rather than auth.uid(). The
 * filter on p_user_id is therefore not decoration: it is the whole boundary,
 * and it is applied before the ranking rather than after it.
 *
 * Expired rows are excluded here rather than swept: a cache that answers from
 * a stale row while a cleanup job is late is worse than one that misses.
 */
CREATE OR REPLACE FUNCTION public.match_gateway_cache(
  p_user_id uuid,
  p_target_key text,
  p_prompt_hash text,
  query_embedding vector(1536),
  min_similarity float DEFAULT 0.97
)
RETURNS TABLE(id uuid, question text, answer text, model text, similarity float)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.question, c.answer, c.model,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.gateway_cache c
  WHERE c.user_id = p_user_id
    AND c.target_key = p_target_key
    AND c.prompt_hash = p_prompt_hash
    AND c.expires_at > now()
    AND 1 - (c.embedding <=> query_embedding) >= min_similarity
  ORDER BY c.embedding <=> query_embedding
  LIMIT 1;
$$;

/**
 * Count a hit, atomically. A read-then-write from the application would lose
 * counts under exactly the concurrency that makes a cache worth having.
 *
 * SECURITY DEFINER with the owner NOT a parameter: the id is already scoped
 * by the lookup that produced it, and this writes nothing a caller could use
 * to read another account's row.
 */
CREATE OR REPLACE FUNCTION public.increment_gateway_cache_hit(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.gateway_cache
  SET hits = hits + 1, last_hit_at = now()
  WHERE id = p_id;
$$;

-- Opt-in, per key. Existing keys keep calling the provider every time.
ALTER TABLE public.gateway_keys
  ADD COLUMN IF NOT EXISTS semantic_cache boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.gateway_keys.semantic_cache IS
  'When true, this key may answer from the semantic cache instead of calling the provider.';

-- Turning the cache on or off for a key is configuration, and audited as such.
DROP TRIGGER IF EXISTS audit_gateway_keys ON public.gateway_keys;
CREATE TRIGGER audit_gateway_keys
  AFTER INSERT OR DELETE OR UPDATE OF
    name, scopes, agent_ids, model_allow, fallback_models, semantic_model_ids,
    semantic_cache, rate_limit_per_min, is_active, expires_at, revoked_at
  ON public.gateway_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('gateway_key');

-- Instance defaults, editable under Admin -> Developer runtime; NULL = env.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS gateway_cache_similarity numeric,
  ADD COLUMN IF NOT EXISTS gateway_cache_ttl_hours integer,
  ADD COLUMN IF NOT EXISTS gateway_cache_max_temperature numeric;
COMMENT ON COLUMN public.notebook_runtime_settings.gateway_cache_similarity IS
  'Cosine similarity a cached question must reach to answer a new one; NULL = env AI_GATEWAY_CACHE_SIMILARITY, then 0.97.';
COMMENT ON COLUMN public.notebook_runtime_settings.gateway_cache_ttl_hours IS
  'Hours a cached answer may be reused; NULL = env AI_GATEWAY_CACHE_TTL_HOURS, then 24.';
COMMENT ON COLUMN public.notebook_runtime_settings.gateway_cache_max_temperature IS
  'Above this temperature a turn is never cached or served from cache; NULL = env AI_GATEWAY_CACHE_MAX_TEMPERATURE, then 0.3.';
