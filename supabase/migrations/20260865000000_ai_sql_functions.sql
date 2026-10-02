-- AI functions in SQL: ai_complete / ai_classify / ai_extract / ai_sentiment /
-- ai_summarize / ai_translate / ai_filter as scalar functions in lakehouse
-- statements. Every answer is cached per user and per model, so the same call
-- costs once, and the instance caps how many model calls one statement may
-- make.

CREATE TABLE IF NOT EXISTS public.ai_function_cache (
  key text PRIMARY KEY,                       -- sha256(user, function, model, arguments)
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fn text NOT NULL,
  model text NOT NULL,
  answer text,                                -- NULL is an answer: the model found no fit
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_function_cache_user_idx
  ON public.ai_function_cache (user_id, expires_at);

-- Service-role only: the runner reads and writes it on the user's behalf and
-- nothing in the browser needs the rows. RLS on with no policies is the
-- narrowest grant Postgres offers.
ALTER TABLE public.ai_function_cache ENABLE ROW LEVEL SECURITY;

-- Instance defaults, editable under Admin -> Developer runtime; NULL = env.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ai_sql_max_calls_per_statement integer,
  ADD COLUMN IF NOT EXISTS ai_sql_default_model text,
  ADD COLUMN IF NOT EXISTS ai_sql_cache_ttl_days integer;
COMMENT ON COLUMN public.notebook_runtime_settings.ai_sql_max_calls_per_statement IS
  'Model calls one SQL statement may make through ai_* functions; NULL = env AI_SQL_MAX_CALLS_PER_STATEMENT, then 200.';
COMMENT ON COLUMN public.notebook_runtime_settings.ai_sql_default_model IS
  'provider/model an ai_* function uses when the statement names none; NULL = env AI_SQL_DEFAULT_MODEL, then openrouter/google/gemini-3-flash-preview.';
COMMENT ON COLUMN public.notebook_runtime_settings.ai_sql_cache_ttl_days IS
  'Days an ai_* answer is reused before the model is asked again; NULL = env AI_SQL_CACHE_TTL_DAYS, then 30.';
