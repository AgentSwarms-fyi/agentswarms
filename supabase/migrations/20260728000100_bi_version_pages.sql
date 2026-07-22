-- Version-history snapshots carry pages too, so restoring an old version
-- restores the full multi-page structure (not just page 1).
ALTER TABLE public.bi_dashboard_versions
  ADD COLUMN IF NOT EXISTS pages jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.bi_dashboard_versions
SET pages = jsonb_build_array(
  jsonb_build_object(
    'id', gen_random_uuid(),
    'name', 'Page 1',
    'widgets', COALESCE(widgets, '[]'::jsonb),
    'layout', COALESCE(layout, '[]'::jsonb)
  )
)
WHERE pages = '[]'::jsonb OR pages IS NULL;
