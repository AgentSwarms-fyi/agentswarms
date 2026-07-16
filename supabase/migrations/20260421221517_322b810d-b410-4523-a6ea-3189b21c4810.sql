-- 1. agent_memory_config
CREATE TABLE public.agent_memory_config (
  agent_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  stm_enabled BOOLEAN NOT NULL DEFAULT true,
  stm_window_messages INTEGER NOT NULL DEFAULT 20,
  stm_summarize BOOLEAN NOT NULL DEFAULT true,
  stm_summary_model TEXT,
  ltm_enabled BOOLEAN NOT NULL DEFAULT false,
  ltm_auto_extract BOOLEAN NOT NULL DEFAULT true,
  ltm_max_items INTEGER NOT NULL DEFAULT 200,
  ltm_recall_top_k INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_memory_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own memory config"
  ON public.agent_memory_config
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_agent_memory_config_updated_at
  BEFORE UPDATE ON public.agent_memory_config
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 2. conversation_memory
CREATE TABLE public.conversation_memory (
  conversation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  summary TEXT,
  summary_token_estimate INTEGER NOT NULL DEFAULT 0,
  last_summarized_message_id UUID,
  scratchpad JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own conversation memory"
  ON public.conversation_memory
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_conversation_memory_updated_at
  BEFORE UPDATE ON public.conversation_memory
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 3. agent_memory_items
CREATE TABLE public.agent_memory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  conversation_id UUID,
  kind TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  score REAL NOT NULL DEFAULT 1.0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT agent_memory_items_kind_check
    CHECK (kind IN ('fact','preference','episodic','instruction'))
);

ALTER TABLE public.agent_memory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own memory items"
  ON public.agent_memory_items
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_agent_memory_items_keywords
  ON public.agent_memory_items USING GIN (keywords);

CREATE INDEX idx_agent_memory_items_user_agent_recent
  ON public.agent_memory_items (user_id, agent_id, last_used_at DESC NULLS LAST);

-- 4. Trigger: derive keywords from content (lowercase tokens, strip punctuation,
-- drop short tokens and a small stop-word set).
CREATE OR REPLACE FUNCTION public.derive_memory_keywords()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cleaned TEXT;
  toks TEXT[];
  stop TEXT[] := ARRAY[
    'the','and','for','with','this','that','from','have','has','had',
    'are','was','were','will','would','could','should','about','into',
    'your','their','they','them','our','out','not','but','any','all',
    'you','user','users','agent','agents','some','one','two','three'
  ];
BEGIN
  cleaned := lower(regexp_replace(coalesce(NEW.content,''), '[^a-z0-9 ]+', ' ', 'gi'));
  SELECT array_agg(DISTINCT t)
    INTO toks
  FROM (
    SELECT unnest(regexp_split_to_array(cleaned, '\s+')) AS t
  ) s
  WHERE length(t) >= 4 AND NOT (t = ANY (stop));
  NEW.keywords := COALESCE(toks, ARRAY[]::TEXT[]);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_derive_memory_keywords
  BEFORE INSERT OR UPDATE OF content ON public.agent_memory_items
  FOR EACH ROW
  EXECUTE FUNCTION public.derive_memory_keywords();

-- 5. Helper RPC: prune oldest low-score items beyond a per-agent cap.
CREATE OR REPLACE FUNCTION public.prune_agent_memory_items(_user_id UUID, _agent_id UUID, _max INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             ORDER BY score DESC, COALESCE(last_used_at, created_at) DESC
           ) AS rn
    FROM public.agent_memory_items
    WHERE user_id = _user_id AND agent_id = _agent_id
  )
  DELETE FROM public.agent_memory_items
  WHERE id IN (SELECT id FROM ranked WHERE rn > _max);

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;