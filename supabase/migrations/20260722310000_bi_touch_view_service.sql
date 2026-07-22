-- bi_touch_view v2: also count anonymous public/embed views, which are
-- stamped server-side with the service role (auth.uid() is NULL there).
-- Signed-in callers still only bump dashboards they own or were granted.
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
END;
$$;
