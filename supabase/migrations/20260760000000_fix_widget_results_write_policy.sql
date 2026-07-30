-- Close a write hole in bi_widget_results found by the CLS verification suite.
--
-- The original owner policy checked only `auth.uid() = user_id`, which any
-- authenticated user satisfies by stamping their OWN id on a row for someone
-- else's dashboard_id. Owner-scoped reads never surfaced such rows, but the
-- service-role hydration paths (public shares, embeds, scheduled refresh) read
-- by dashboard_id alone — so a hostile row with a future refreshed_at could
-- win the merge and be served to anonymous viewers as the dashboard's data.
--
-- The policy now also requires owning the dashboard the row points at. The
-- subquery runs as the caller against bi_dashboards' own RLS (no recursion:
-- bi_dashboards policies never reference bi_widget_results).

DROP POLICY IF EXISTS "Owners manage own widget results" ON public.bi_widget_results;

CREATE POLICY "Dashboard owners manage widget results"
  ON public.bi_widget_results FOR ALL
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.bi_dashboards d
      WHERE d.id = dashboard_id AND d.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.bi_dashboards d
      WHERE d.id = dashboard_id AND d.user_id = auth.uid()
    )
  );
