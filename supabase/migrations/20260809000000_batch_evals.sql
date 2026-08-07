-- Batch evaluations: run a dataset of test cases through a swarm headlessly,
-- score every output with an evaluator (LLM judge or deterministic check),
-- and keep the results as a first-class, comparable record.
--
-- Shape mirrors the rest of the platform:
--   eval_datasets  — a named collection of test cases (per user)
--   eval_cases     — one test case: input text + typed input-form values +
--                    an optional expected/reference answer
--   eval_runs      — one execution of dataset × swarm × evaluator; counters
--                    are maintained server-side as cases finish
--   eval_results   — one row per case per run. Case name/input are DENORMALISED
--                    so a run's history stays intact when the dataset is edited
--                    or a case deleted afterwards; swarm_run_id links the trace.
--
-- RLS is owner-only on all four tables (the strictest posture in the app —
-- sharing can be added later through IAM grants if wanted). Server functions
-- use the service role and re-assert ownership in TypeScript, same as the
-- rest of the headless machinery.

CREATE TABLE public.eval_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE public.eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES public.eval_datasets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sort integer NOT NULL DEFAULT 0,
  name text NOT NULL DEFAULT '',
  -- The free-text input seeded into flow state as `input`.
  input text NOT NULL DEFAULT '',
  -- Values for the swarm's typed start form, keyed by field name.
  input_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Reference answer / criteria. Deterministic evaluators compare against it;
  -- the LLM judge receives it as reference context.
  expected text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  swarm_id uuid REFERENCES public.swarms(id) ON DELETE SET NULL,
  swarm_name text NOT NULL DEFAULT '',
  -- Latest saved version at launch time, for attribution across edits.
  swarm_version_id uuid,
  dataset_id uuid REFERENCES public.eval_datasets(id) ON DELETE SET NULL,
  dataset_name text NOT NULL DEFAULT '',
  label text NOT NULL DEFAULT '',
  -- Evaluator config (kind llm_judge | contains | exact | regex, see
  -- src/lib/evalScoring.ts). One evaluator per run keeps runs comparable.
  evaluator jsonb NOT NULL,
  reject_approvals boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'error', 'cancelled')),
  case_count integer NOT NULL DEFAULT 0,
  done_count integer NOT NULL DEFAULT 0,
  pass_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  avg_score numeric(6,4),
  total_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id uuid NOT NULL REFERENCES public.eval_runs(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting a case from the dataset must not rewrite
  -- the history of runs that already executed it.
  case_id uuid REFERENCES public.eval_cases(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  case_name text NOT NULL DEFAULT '',
  case_input text NOT NULL DEFAULT '',
  case_expected text,
  status text NOT NULL CHECK (status IN ('pass', 'fail', 'error')),
  score numeric(6,4),
  -- Full judge scorecard (metrics, reasons, summary) for llm_judge runs.
  judge jsonb,
  output text NOT NULL DEFAULT '',
  error text,
  swarm_run_id uuid,
  duration_ms integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One verdict per case per run — the idempotency anchor for resume.
  UNIQUE (eval_run_id, case_id)
);

CREATE INDEX idx_eval_cases_dataset ON public.eval_cases(dataset_id, sort);
CREATE INDEX idx_eval_runs_user ON public.eval_runs(user_id, created_at DESC);
CREATE INDEX idx_eval_runs_dataset ON public.eval_runs(dataset_id, created_at DESC);
CREATE INDEX idx_eval_results_run ON public.eval_results(eval_run_id, created_at);

ALTER TABLE public.eval_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own eval datasets" ON public.eval_datasets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage their own eval cases" ON public.eval_cases
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage their own eval runs" ON public.eval_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- Results are written by the server executor (service role); clients read and
-- delete their own but never insert or edit verdicts.
CREATE POLICY "Users read their own eval results" ON public.eval_results
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users delete their own eval results" ON public.eval_results
  FOR DELETE USING (auth.uid() = user_id);
