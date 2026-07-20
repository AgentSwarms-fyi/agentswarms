-- Business Intelligence dashboards ("BI projects" in the BI Workspace).
--
-- Widgets and their grid layout are stored as JSON. Each chart widget carries
-- a capped data snapshot, so published dashboards render for viewers without
-- re-querying the owner's data sources (local datasets or external
-- warehouses) and without ever exposing connection credentials.
--
-- Access model:
--   - Owners have full control (RLS below).
--   - Superadmins / owners can share read-only with users or groups through
--     the existing polymorphic iam_resource_grants system (new resource type
--     'bi_dashboard'); grantees see the dashboard in their BI Workspace.
--   - "Publish" additionally exposes a public read-only page at
--     /share/bi/<public_slug>, served via the service role (no anon RLS
--     policy — the slug is unguessable and lookups happen server-side only).

CREATE TABLE public.bi_dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  layout jsonb NOT NULL DEFAULT '[]'::jsonb,
  published boolean NOT NULL DEFAULT false,
  public_slug text UNIQUE,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_dashboards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own dashboards" ON public.bi_dashboards
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Granted dashboards are visible" ON public.bi_dashboards
  FOR SELECT USING (public.has_resource_access('bi_dashboard', id, auth.uid()));

CREATE INDEX idx_bi_dashboards_user ON public.bi_dashboards(user_id);

CREATE TRIGGER update_bi_dashboards_updated_at
BEFORE UPDATE ON public.bi_dashboards
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Dashboards join the polymorphic IAM grant system.
ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT iam_resource_grants_resource_type_check;
ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (resource_type IN ('knowledge_base', 'data_table', 'secret', 'bi_dashboard'));
