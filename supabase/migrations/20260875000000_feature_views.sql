-- Feature views: score by key, so serving cannot compute features differently
-- from how training computed them.
--
-- The skew this closes is specific and quiet. A model trains on a table whose
-- columns were built by SQL — days_since_signup, orders_last_30d, whatever —
-- and then a caller scores one row by POSTing those same column NAMES with
-- values it computed itself, in its own code, months later. Nothing checks
-- that its arithmetic matches the training set's. The model receives numbers
-- that are the right shape and the wrong meaning, and answers confidently.
--
-- A feature view removes the caller's arithmetic entirely. It names a table,
-- the column(s) that identify a row, and which columns are features. Serving
-- then takes a KEY — {"customer_id": "c-1"} — reads the feature values from
-- the same table training read, and scores those. There is nothing left for
-- the caller to get wrong, because there is nothing left for it to compute.
--
-- It deliberately does not materialise anything of its own. The table is
-- whatever built it, and a SQL model is the natural author: the model's name
-- IS its table, its schedule keeps the table fresh, its `unique` test can
-- assert the key, and its lineage is already recorded. A second scheduler and
-- a second materialisation here would duplicate all of that badly.

CREATE TABLE IF NOT EXISTS public.feature_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  description text,
  -- The table holding the features. Access is checked as the OWNER at every
  -- lookup, never trusted from this row.
  schema_name text NOT NULL,
  table_name text NOT NULL,
  -- What identifies a row. An array because a key is often composite — the
  -- same shape ETL already uses for an upsert key.
  key_columns text[] NOT NULL CHECK (cardinality(key_columns) BETWEEN 1 AND 8),
  -- Which columns are features. Empty means every column that is not a key,
  -- which is what people mean when they have built a table for this purpose.
  feature_columns text[] NOT NULL DEFAULT '{}',
  -- When set, a key may appear more than once and the LATEST row wins. Absent,
  -- the key is expected to be unique and a duplicate is reported rather than
  -- silently resolved — picking one of two rows arbitrarily is how a feature
  -- store starts lying.
  timestamp_column text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE public.feature_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own feature views"
  ON public.feature_views FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Which table a model's features come from, and what a key means, is
-- configuration with a blast radius: change it and every prediction after it
-- is answered from different numbers.
DROP TRIGGER IF EXISTS audit_feature_views ON public.feature_views;
CREATE TRIGGER audit_feature_views
  AFTER INSERT OR DELETE OR UPDATE OF
    schema_name, table_name, key_columns, feature_columns, timestamp_column
  ON public.feature_views
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('feature_view');

-- A model may serve from a view. Null keeps today's behaviour exactly: the
-- caller supplies whole rows and is responsible for them.
ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS feature_view_id uuid
    REFERENCES public.feature_views(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.ml_models.feature_view_id IS
  'When set, /api/ml/predict accepts keys instead of rows and reads the feature values from this view''s table.';
