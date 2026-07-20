-- Data preparation flows (BI Workspace → Data preparation tab).
--
-- A flow is a saved visual recipe: an ordered set of source tables, the
-- joins between them (type + key pair), and per-column output settings
-- (include/rename/type). Running a flow materialises the result as a
-- regular user_data_tables dataset (output_table_id/name), so prepared
-- data is immediately usable in the SQL IDE, the BI chart builder, the
-- AI analyst and agent tools. The recipe stays editable and re-runnable.

CREATE TABLE public.user_prep_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_table_id uuid,
  output_table_name text,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE public.user_prep_flows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own prep flows" ON public.user_prep_flows
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_user_prep_flows_user ON public.user_prep_flows(user_id);

CREATE TRIGGER update_user_prep_flows_updated_at
BEFORE UPDATE ON public.user_prep_flows
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
