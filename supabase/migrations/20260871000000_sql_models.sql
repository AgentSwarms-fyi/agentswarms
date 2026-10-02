-- SQL models: a transformation layer over the lakehouse.
--
-- A materialized view already turns one SELECT into one table on a schedule.
-- What it cannot do is the thing every warehouse team actually has: a set of
-- models that name EACH OTHER, built in dependency order, so a staging table
-- is always rebuilt before the fact that reads it.
--
-- The vocabulary is dbt's. A model is one SELECT; `ref('other')` names another
-- model and both declares the dependency and resolves to its table; a build
-- walks the graph in topological order. What is deliberately absent: Jinja,
-- macros, seeds, packages. The gap being closed is ordered transformation, not
-- a templating language.
--
-- The model's NAME is its table name, as in dbt, so there is exactly one way
-- to refer to it and no chance of a model whose ref name and physical name
-- have drifted apart.

CREATE TABLE IF NOT EXISTS public.sql_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Also the table name. Lower snake case, enforced in the app and here.
  name text NOT NULL CHECK (name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  description text,
  -- The schema it materialises into. Must be one the owner owns; a data-lake
  -- mount is read-only and is refused at save and again at every build.
  schema_name text NOT NULL,
  sql text NOT NULL,
  materialization text NOT NULL DEFAULT 'table'
    CHECK (materialization IN ('table', 'view')),
  -- Assertions run after the model builds. An `error` failure fails the model
  -- and skips everything downstream; a `warn` records and carries on.
  tests jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  -- A schedule on a model builds that model AND its ancestors, which is the
  -- only ordering that leaves the two agreeing.
  schedule text NOT NULL DEFAULT 'manual'
    CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly', 'cron')),
  cron_expr text,
  timezone text NOT NULL DEFAULT 'UTC',
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text CHECK (last_status IN ('built', 'failed', 'skipped')),
  last_error text,
  last_row_count bigint,
  last_duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The ref name has to be unambiguous for one owner, or ref('orders') means
  -- two different tables depending on which one the resolver saw first.
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS sql_models_due_idx
  ON public.sql_models (is_active, next_run_at)
  WHERE schedule <> 'manual';

-- One row per build, whatever triggered it.
CREATE TABLE IF NOT EXISTS public.sql_model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'api')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'error')),
  -- What was asked for: the selected model names, or empty for the whole set.
  selected text[] NOT NULL DEFAULT '{}',
  -- Per model: name, outcome, ms, rows, error, and each test's result. Kept as
  -- one document because it is read as one — a build log, not a fact table.
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);

CREATE INDEX IF NOT EXISTS sql_model_runs_user_idx
  ON public.sql_model_runs (user_id, started_at DESC);

ALTER TABLE public.sql_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sql_model_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own sql models"
  ON public.sql_models FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users read own sql model runs"
  ON public.sql_model_runs FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own sql model runs"
  ON public.sql_model_runs FOR DELETE
  USING (auth.uid() = user_id);

-- Defining a model is configuration: what SQL runs as its owner, where it
-- lands, and what has to be true of the result. Every change is audited
-- through the same trigger every other configuration table uses.
DROP TRIGGER IF EXISTS audit_sql_models ON public.sql_models;
CREATE TRIGGER audit_sql_models
  AFTER INSERT OR DELETE OR UPDATE OF
    name, schema_name, sql, materialization, tests, tags, is_active,
    schedule, cron_expr, timezone
  ON public.sql_models
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('sql_model');

/**
 * Lineage between two lakehouse tables has no catalog source behind it.
 *
 * Every edge until now came from crawling a Databricks catalog or from an ETL
 * run whose upstream node had a source, so the column could be NOT NULL. A
 * model reading another model is neither: both tables were written here. The
 * constraint is relaxed rather than worked around, because the alternative —
 * borrowing some unrelated source's id to satisfy it — puts a lie in the row
 * to keep a column happy.
 */
ALTER TABLE public.catalog_lineage
  ALTER COLUMN source_id DROP NOT NULL;

COMMENT ON COLUMN public.catalog_lineage.source_id IS
  'The catalog source an edge was crawled from; NULL for edges the platform wrote itself (SQL models).';
