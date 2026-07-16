-- Semantic layer: per-user metadata for each dataset table
CREATE TABLE public.user_data_semantics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  table_id uuid NOT NULL REFERENCES public.user_data_tables(id) ON DELETE CASCADE,
  table_description text,
  business_name text,
  column_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  primary_key text,
  join_hints jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, table_id)
);

CREATE INDEX idx_user_data_semantics_table ON public.user_data_semantics(table_id);
CREATE INDEX idx_user_data_semantics_user ON public.user_data_semantics(user_id);

ALTER TABLE public.user_data_semantics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View own or sample semantics"
  ON public.user_data_semantics FOR SELECT
  USING (is_sample = true OR auth.uid() = user_id);

CREATE POLICY "Insert own semantics (non-sample)"
  ON public.user_data_semantics FOR INSERT
  WITH CHECK (auth.uid() = user_id AND is_sample = false);

CREATE POLICY "Update own semantics"
  ON public.user_data_semantics FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Delete own semantics"
  ON public.user_data_semantics FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_user_data_semantics_updated_at
  BEFORE UPDATE ON public.user_data_semantics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Saved metrics: reusable named formulas per user
CREATE TABLE public.user_saved_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  table_id uuid REFERENCES public.user_data_tables(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  sql_expression text NOT NULL,
  example_question text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_saved_metrics_user ON public.user_saved_metrics(user_id);
CREATE INDEX idx_user_saved_metrics_table ON public.user_saved_metrics(table_id);

ALTER TABLE public.user_saved_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own saved metrics"
  ON public.user_saved_metrics FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_user_saved_metrics_updated_at
  BEFORE UPDATE ON public.user_saved_metrics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();