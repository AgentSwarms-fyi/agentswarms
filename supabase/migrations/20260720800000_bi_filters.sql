-- Dashboard-level filter definitions (BI Workspace).
--
-- The owner configures named filters (value slicers / date ranges) bound to
-- a column name; they render as a filter bar on the dashboard and apply
-- client-side to every widget snapshot that contains that column. Filter
-- SELECTIONS are runtime state and never stored — only the definitions are.
ALTER TABLE public.bi_dashboards
  ADD COLUMN filters jsonb NOT NULL DEFAULT '[]'::jsonb;
