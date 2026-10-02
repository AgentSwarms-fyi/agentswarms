-- Experiment tracking: what was tried, with what settings, and how it scored.
--
-- The registry records what SHIPPED. Every version has its metrics, its
-- leaderboard and the snapshot it learned from. What nothing recorded was the
-- work before that: the twenty runs in a notebook that led to the one worth
-- keeping. They lived in the notebook's output cells until somebody re-ran it,
-- and then they were gone — so "why is this the learning rate" had no answer a
-- month later, and a colleague could not see that the obvious idea was tried
-- and did not work.
--
-- An EXPERIMENT is a named question. A RUN is one attempt at it: its
-- parameters, its metrics, whether it finished. Anything that can reach the
-- platform can log one — a notebook with its session token, a script with a
-- user token — and a run that produced an artifact can be registered as a
-- model version afterwards, which is the seam between trying things and
-- shipping one.
--
-- Runs are DATA, not configuration. Creating an experiment is audited through
-- the row trigger; a metric is not, or a training loop logging per epoch would
-- write more audit rows than the audit log is for. Promoting a run into the
-- registry IS audited, because that is the moment something becomes servable.

CREATE TABLE IF NOT EXISTS public.ml_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  -- The model this experiment is about, when it is about one. Null for the
  -- exploratory case, which is most of them at the start.
  model_id uuid REFERENCES public.ml_models(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS public.ml_experiment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.ml_experiments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'finished', 'failed')),
  -- Flat maps on purpose: a parameter is a name and a value, and a run whose
  -- params need a schema is a run nobody will compare with another.
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('notebook', 'api', 'ui')),
  -- Which sandbox logged it, when one did. The link is the answer to "where
  -- did this come from" long after the kernel is gone.
  session_id uuid REFERENCES public.notebook_runtime_sessions(id) ON DELETE SET NULL,
  -- An artifact the run produced, if it saved one. Without both of these a run
  -- is a record and cannot be registered — a version whose artifact nobody can
  -- verify is not a version.
  artifact_uri text,
  artifact_sha256 text,
  -- Set once the run has been promoted into the registry.
  registered_version_id uuid REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);

CREATE INDEX IF NOT EXISTS ml_experiment_runs_idx
  ON public.ml_experiment_runs (experiment_id, started_at DESC);

ALTER TABLE public.ml_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_experiment_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own experiments"
  ON public.ml_experiments FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own experiment runs"
  ON public.ml_experiment_runs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- The experiment is configuration — a name people will cite. Its runs are the
-- measurements taken under it, and are deliberately not audited per write.
DROP TRIGGER IF EXISTS audit_ml_experiments ON public.ml_experiments;
CREATE TRIGGER audit_ml_experiments
  AFTER INSERT OR DELETE OR UPDATE OF name, description, model_id
  ON public.ml_experiments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('ml_experiment');
