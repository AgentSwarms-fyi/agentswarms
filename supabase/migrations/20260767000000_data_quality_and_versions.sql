-- Data quality tests + dataset version history.
--
-- Both exist for the same reason: prep flows now rebuild datasets
-- automatically on a schedule, at full volume. Unattended writes need
-- (a) something that ASSERTS the result is sane, and (b) a way back when it
-- isn't. Without them, a bad upstream change silently replaces good data and
-- there is no undo.

-- ── Quality tests ─────────────────────────────────────────────────────────
-- Deliberately the dbt/Great-Expectations vocabulary: these are the checks
-- analysts already know, not a bespoke rule language.
CREATE TABLE IF NOT EXISTS public.data_quality_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES public.user_data_tables(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'not_null', 'unique', 'accepted_values', 'range', 'row_count_min', 'freshness'
  )),
  -- NULL only for row_count_min, which is a table-level assertion.
  column_name text,
  -- accepted_values: { values: [...] } · range: { min, max }
  -- row_count_min:   { min }          · freshness: { max_age_hours }
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  -- 'error' fails the dataset's quality status; 'warn' reports without failing.
  severity text NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warn')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dq_tests_table ON public.data_quality_tests(table_id);

CREATE TABLE IF NOT EXISTS public.data_quality_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES public.data_quality_tests(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES public.user_data_tables(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pass', 'fail', 'error')),
  failing_rows integer NOT NULL DEFAULT 0,
  total_rows integer NOT NULL DEFAULT 0,
  detail text,
  ran_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dq_results_table_time
  ON public.data_quality_results(table_id, ran_at DESC);

ALTER TABLE public.data_quality_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_quality_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own quality tests" ON public.data_quality_tests
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Results are written by the server (service role) and read by the owner.
CREATE POLICY "Users read own quality results" ON public.data_quality_results
  FOR SELECT USING (auth.uid() = user_id);

-- ── Dataset versions ──────────────────────────────────────────────────────
-- A snapshot taken BEFORE a dataset is overwritten, so a bad upload or a
-- mis-edited prep flow is recoverable.
--
-- Rows live in a single jsonb array so a restore is one atomic write. That
-- only scales so far, which is deliberate and explicit: above the row cap the
-- version is METADATA-ONLY (`rows` NULL, `rows_omitted` true) — you still get
-- the audit trail of what changed and when, without silently copying
-- hundreds of megabytes on every scheduled refresh.
CREATE TABLE IF NOT EXISTS public.user_data_table_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.user_data_tables(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- What caused the overwrite: 'upload' | 'prep_run' | 'prep_refresh' | 'restore'
  reason text NOT NULL DEFAULT 'overwrite',
  row_count integer NOT NULL DEFAULT 0,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  rows jsonb,
  rows_omitted boolean NOT NULL DEFAULT false,
  note text
);
CREATE INDEX IF NOT EXISTS idx_data_versions_table_time
  ON public.user_data_table_versions(table_id, created_at DESC);

ALTER TABLE public.user_data_table_versions ENABLE ROW LEVEL SECURITY;

-- Owners only — a version holds the dataset's full contents, so it must never
-- follow the sharing rules of the live table (a grantee with a column mask
-- could otherwise read the unmasked history).
CREATE POLICY "Users read own dataset versions" ON public.user_data_table_versions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users delete own dataset versions" ON public.user_data_table_versions
  FOR DELETE USING (auth.uid() = user_id);
