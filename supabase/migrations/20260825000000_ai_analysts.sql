-- Dedicated AI Analysts (Spotter-style conversational analysis).
--
-- An analyst is a pinned pair: the reasoning model it thinks with and the
-- data it is scoped to (local datasets/uploads, or one warehouse
-- connection). Conversations are threads of TURNS — each turn stores the
-- full reasoning trace (approach, steps with SQL + trimmed result samples +
-- self-check verdicts, final answer) so an analysis reloads exactly as it
-- ran and exports to PDF without re-running anything.
--
-- Owner-only on both tables: an analyst runs with ITS OWNER's data access
-- (local tables in the owner's browser engine, warehouse credentials under
-- the owner's JWT), so sharing a row here would imply sharing that access.
CREATE TABLE IF NOT EXISTS public.ai_analysts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Encoded "provider::model" choice from the caller's connected
  -- integrations (see modelChoice) — the reasoning model this analyst uses.
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  -- {"kind":"local","tables":[...]} (empty tables = every local dataset) or
  -- {"kind":"warehouse","connection_id":"..."}.
  source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_analyst_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analyst_id uuid NOT NULL REFERENCES public.ai_analysts (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Analysis',
  -- AnalystTurn[] — see src/lib/aiAnalyst.ts. Result rows are TRIMMED before
  -- storage (same discipline as widget snapshots): the trace is the record
  -- of the analysis, not a data store.
  turns jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_analyst_threads_analyst_idx
  ON public.ai_analyst_threads (analyst_id, updated_at DESC);

ALTER TABLE public.ai_analysts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_analyst_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own analysts" ON public.ai_analysts;
CREATE POLICY "own analysts" ON public.ai_analysts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own analyst threads" ON public.ai_analyst_threads;
CREATE POLICY "own analyst threads" ON public.ai_analyst_threads
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
