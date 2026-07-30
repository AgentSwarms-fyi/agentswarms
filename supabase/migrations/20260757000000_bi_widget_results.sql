-- Widget data snapshots, split out of the dashboard document.
--
-- Until now every widget's row snapshot lived inside bi_dashboards.widgets
-- (and again inside `pages`, and again in every bi_dashboard_versions copy).
-- The document grew with the DATA, not the definition: version history
-- multiplied it ~30x, every autosave rewrote it all, and the refresh-vs-edit
-- conflict existed only because data and definition shared one row.
--
-- This table holds one result per (dashboard, widget). The document keeps the
-- definition plus small metadata (columns, refreshed_at, truncated), and
-- readers merge results back in at load time — falling back to any rows still
-- embedded in the document, so pre-existing dashboards, samples, and promoted
-- copies keep rendering without a backfill.

CREATE TABLE IF NOT EXISTS public.bi_widget_results (
  dashboard_id uuid NOT NULL REFERENCES public.bi_dashboards(id) ON DELETE CASCADE,
  -- Widget ids are strings inside the document JSON; text avoids a cast trap
  -- if any legacy widget carries a non-uuid id.
  widget_id text NOT NULL,
  -- Owner, denormalised from the dashboard so RLS is one indexed comparison.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  truncated boolean NOT NULL DEFAULT false,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, widget_id)
);

ALTER TABLE public.bi_widget_results ENABLE ROW LEVEL SECURITY;

-- Owners read and write their own widgets' results.
CREATE POLICY "Owners manage own widget results"
  ON public.bi_widget_results FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Dashboard grantees (users/groups shared via IAM) read, never write — the
-- same read-only semantics as the dashboard share itself. Anonymous viewers
-- (public share links, embeds) get no policy at all: those surfaces are served
-- by server routes that hydrate with the service role and sanitise the payload.
CREATE POLICY "Grantees read shared widget results"
  ON public.bi_widget_results FOR SELECT
  USING (public.has_resource_access('bi_dashboard', dashboard_id, auth.uid()));
