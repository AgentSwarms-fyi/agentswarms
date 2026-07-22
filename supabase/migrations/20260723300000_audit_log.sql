-- Audit log: who did what, when — model calls live in execution_traces
-- already, so audit_events records the non-model activities (dashboard
-- views, dataset/warehouse queries, catalog crawls) and the audit view
-- merges both streams. Events are purged after a configurable retention
-- window (default 14 days) by the shared in-process scheduler.

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  resource_type text,
  resource_name text,
  resource_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_user_time ON public.audit_events(user_id, created_at DESC);
CREATE INDEX idx_audit_events_time ON public.audit_events(created_at);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
-- Users see their own trail; superadmins see everyone's.
CREATE POLICY "View own or all audit events" ON public.audit_events
  FOR SELECT USING (auth.uid() = user_id OR public.is_superadmin(auth.uid()));
-- Browser-side activities (local dataset queries) insert their own rows;
-- server-side emitters use the service role and bypass RLS.
CREATE POLICY "Insert own audit events" ON public.audit_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Configurable retention (days) on the single-row settings table.
ALTER TABLE public.iam_settings
  ADD COLUMN audit_retention_days integer NOT NULL DEFAULT 14
  CHECK (audit_retention_days BETWEEN 1 AND 365);

-- bi_touch_view v3: signed-in dashboard opens also leave an audit event.
CREATE OR REPLACE FUNCTION public.bi_touch_view(_dashboard_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _service boolean := COALESCE(auth.jwt() ->> 'role', '') = 'service_role';
BEGIN
  IF _uid IS NULL AND NOT _service THEN
    RETURN;
  END IF;
  UPDATE public.bi_dashboards
  SET view_count = view_count + 1, last_viewed_at = now()
  WHERE id = _dashboard_id
    AND (
      _service
      OR user_id = _uid
      OR public.has_resource_access('bi_dashboard', id, _uid)
    );
  IF FOUND AND _uid IS NOT NULL THEN
    INSERT INTO public.audit_events (user_id, action, resource_type, resource_name, resource_id)
    SELECT _uid, 'dashboard.view', 'dashboard', d.name, d.id
    FROM public.bi_dashboards d WHERE d.id = _dashboard_id;
  END IF;
END;
$$;

-- Admin spend aggregation over execution_traces (superadmin or service role).
CREATE OR REPLACE FUNCTION public.admin_spend_by_user(_since timestamptz)
RETURNS TABLE (user_id uuid, calls bigint, tokens bigint, cost numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.is_superadmin(auth.uid())
    OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role'
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
    SELECT t.user_id,
           count(*)::bigint,
           COALESCE(sum(t.tokens_in + t.tokens_out), 0)::bigint,
           COALESCE(sum(t.cost_usd), 0)::numeric
    FROM public.execution_traces t
    WHERE t.created_at >= _since
    GROUP BY t.user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_spend_by_user(timestamptz) FROM anon;
