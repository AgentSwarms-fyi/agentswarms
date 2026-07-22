-- Multi-page BI dashboards: a dashboard becomes an ordered list of pages, each
-- with its own widgets + layout. Theme and filters remain dashboard-global.
--
-- `pages` is the source of truth going forward. The legacy top-level
-- widgets/layout columns are kept in sync with page 1 so any older reader keeps
-- working. Backfill wraps each existing dashboard's widgets/layout as "Page 1".
ALTER TABLE public.bi_dashboards
  ADD COLUMN IF NOT EXISTS pages jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.bi_dashboards
SET pages = jsonb_build_array(
  jsonb_build_object(
    'id', gen_random_uuid(),
    'name', 'Page 1',
    'widgets', COALESCE(widgets, '[]'::jsonb),
    'layout', COALESCE(layout, '[]'::jsonb)
  )
)
WHERE pages = '[]'::jsonb OR pages IS NULL;
