-- Sheets version history: a workbook's sheets as they stood at a moment,
-- to look back at and restore. A version is taken automatically while
-- people edit (at most one per SHEETS_VERSION_INTERVAL_MINUTES), by hand
-- with a name (File → Version history → Save version), and before every
-- restore, so a restore can itself be undone. Automatic versions beyond
-- SHEETS_VERSIONS_MAX are pruned oldest first; named ones are kept.

CREATE TABLE IF NOT EXISTS public.sheet_workbook_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id uuid NOT NULL REFERENCES public.sheet_workbooks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Who took it (the owner, or an editor the workbook is shared with).
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  label text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('auto', 'named', 'before_restore')),
  -- [{name, kind, position, grid, table_config}] in sheet order.
  snapshot jsonb NOT NULL,
  sheet_count integer NOT NULL DEFAULT 0,
  size_bytes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sheet_workbook_versions_idx
  ON public.sheet_workbook_versions (workbook_id, created_at DESC);

ALTER TABLE public.sheet_workbook_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own workbook versions" ON public.sheet_workbook_versions;
CREATE POLICY "Users read own workbook versions" ON public.sheet_workbook_versions FOR SELECT
  USING (auth.uid() = user_id);

-- Restoring a version replaces what people see; it is audited, as a
-- workbook's shape is. Taking one is not (it happens as people type).
DROP TRIGGER IF EXISTS audit_sheet_workbook_versions ON public.sheet_workbook_versions;
CREATE TRIGGER audit_sheet_workbook_versions
  AFTER DELETE ON public.sheet_workbook_versions
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('sheet_workbook_version');

ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS sheets_version_interval_minutes integer,
  ADD COLUMN IF NOT EXISTS sheets_versions_max integer;

COMMENT ON COLUMN public.notebook_runtime_settings.sheets_version_interval_minutes IS
  'Sheets: the least time between two automatic versions of a workbook (SHEETS_VERSION_INTERVAL_MINUTES, default 30).';
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_versions_max IS
  'Sheets: automatic versions kept per workbook, oldest pruned first (SHEETS_VERSIONS_MAX, default 50).';
