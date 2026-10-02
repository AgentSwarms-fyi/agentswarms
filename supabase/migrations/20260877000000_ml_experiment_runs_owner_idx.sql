-- The runs table is read two ways, and only one of them was indexed.
--
-- `20260876000000` indexed (experiment_id, started_at DESC), which is the run
-- list for one experiment. But the Experiments page also counts every run a
-- user has, to show "12 runs · 1 running" beside each experiment name — that
-- query filters on user_id alone and had nothing to use.
--
-- It does not matter at ten runs. It matters at the limit the feature actually
-- allows: 5,000 runs per experiment and no cap on experiments, which is the
-- point at which a seq scan on every page load stops being free.
CREATE INDEX IF NOT EXISTS ml_experiment_runs_owner_idx
  ON public.ml_experiment_runs (user_id, experiment_id);
