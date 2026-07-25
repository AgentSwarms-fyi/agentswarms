-- Optimistic concurrency for the BI dashboard editor.
--
-- Concurrent editors (two browser tabs, or two people with edit access) used to
-- last-write-wins clobber each other's widget/layout edits: the debounced
-- autosave wrote the whole `pages` array with no check against what was already
-- stored. This adds a monotonic `version` the editor stamps on load and updates
-- conditionally (WHERE version = expected, SET version = expected + 1). A
-- mismatch means the dashboard changed underneath the editor, so the save is
-- rejected and surfaced instead of silently overwriting the other session.
--
-- Benign server-side updates (view_count / last_viewed_at via bi_touch_view,
-- publish + reader-model changes, scheduled refresh) run under the service role
-- and deliberately DO NOT touch `version`, so they never spuriously conflict an
-- open editor.

ALTER TABLE public.bi_dashboards
  ADD COLUMN version integer NOT NULL DEFAULT 0;
