-- Re-run a saved analysis on a cadence.
--
-- Keyed on the THREAD, not the analyst: an analyst answers many questions, and
-- what a schedule refreshes is one analysis. UNIQUE on thread_id for the same
-- reason bi_schedules is unique on dashboard_id — two schedules over the same
-- thread would race each other writing the same turns.
--
-- Owner-managed under RLS; the processor runs with the service role, exactly
-- like bi_schedules. A schedule re-runs the analysis's PINNED SQL, so it
-- inherits nothing from the analyst's sharing: the queries execute as the
-- schedule's owner, which is the person who created it and the only person it
-- notifies.
CREATE TABLE IF NOT EXISTS public.ai_analyst_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL UNIQUE REFERENCES public.ai_analyst_threads (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  cadence text NOT NULL DEFAULT 'daily' CHECK (cadence IN ('hourly', 'daily', 'weekly')),
  -- Daily/weekly run time, in UTC — the same convention as bi_schedules, so a
  -- workspace does not have two meanings for "6".
  at_hour int NOT NULL DEFAULT 6 CHECK (at_hour BETWEEN 0 AND 23),
  weekday int NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  -- Email the digest as well as raising an in-app notification.
  email_report boolean NOT NULL DEFAULT false,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_analyst_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_analyst_schedules_owner_all" ON public.ai_analyst_schedules;
CREATE POLICY "ai_analyst_schedules_owner_all" ON public.ai_analyst_schedules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS ai_analyst_schedules_due_idx
  ON public.ai_analyst_schedules (next_run_at) WHERE enabled;
