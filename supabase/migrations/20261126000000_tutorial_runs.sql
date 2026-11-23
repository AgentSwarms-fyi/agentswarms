-- Tutorials (R529): when a person started each one.
--
-- A tutorial's steps are not stored. Each is worked out when it is read, from
-- what the person has really made since they started (a dashboard reading the
-- sample sales, a check on a lakehouse table, a swarm run whose question was
-- answered), so a step cannot be ticked by anything but doing it. All this
-- table holds is the start that "since" is measured from, when every step was
-- first seen done, and whether the guide was put away.
--
-- WHO MAY READ AND WRITE. Only the person the row belongs to.

CREATE TABLE IF NOT EXISTS public.tutorial_runs (
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The tutorial's id in the app (src/lib/tutorials.ts). Not a CHECK list: a
  -- tutorial is added in the app, and a list here would refuse it until a
  -- migration caught up.
  tutorial_id text NOT NULL CHECK (tutorial_id ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- Starting again moves this, and with it what counts as done.
  started_at timestamptz NOT NULL DEFAULT now(),
  -- The first time every step was seen done; cleared by starting again.
  finished_at timestamptz,
  -- The guide that follows the person from page to page was closed.
  hidden boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, tutorial_id)
);

ALTER TABLE public.tutorial_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "People read their own tutorials" ON public.tutorial_runs;
CREATE POLICY "People read their own tutorials"
  ON public.tutorial_runs FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "People start their own tutorials" ON public.tutorial_runs;
CREATE POLICY "People start their own tutorials"
  ON public.tutorial_runs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "People change their own tutorials" ON public.tutorial_runs;
CREATE POLICY "People change their own tutorials"
  ON public.tutorial_runs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "People remove their own tutorials" ON public.tutorial_runs;
CREATE POLICY "People remove their own tutorials"
  ON public.tutorial_runs FOR DELETE
  USING (auth.uid() = user_id);

-- The guide asks for the tutorial started last on every page.
CREATE INDEX IF NOT EXISTS tutorial_runs_started_idx
  ON public.tutorial_runs (user_id, started_at DESC);
