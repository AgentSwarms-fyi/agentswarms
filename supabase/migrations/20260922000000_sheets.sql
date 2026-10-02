-- Sheets: spreadsheets under Data & BI, with Excel formulas, whose large
-- tables live in the lakehouse rather than in the browser.
--
-- A workbook holds sheets of two kinds. A GRID sheet is the familiar cell
-- grid; its cells (what was typed, formats, styles) are stored here as jsonb
-- and computed in the browser. A TABLE sheet is a data table backed by the
-- lakehouse: this row stores only its definition (source, calculated
-- columns, filters, sort), and the rows are read, sorted, filtered and
-- aggregated by the lakehouse engine, which is what lets a sheet hold far
-- more rows than a browser could.

CREATE TABLE IF NOT EXISTS public.sheet_workbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sheet_workbooks_user_idx
  ON public.sheet_workbooks (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.sheet_tabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id uuid NOT NULL REFERENCES public.sheet_workbooks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('grid', 'table')),
  position integer NOT NULL DEFAULT 0,
  -- grid sheets: {cells: {"r,c": {i, f?, s?}}, colWidths?, rowHeights?, frozenRows?, frozenCols?}
  grid jsonb NOT NULL DEFAULT '{"cells": {}}'::jsonb,
  -- table sheets: {source, columns, calculated, filters, sort}
  table_config jsonb,
  -- Bumped on every save; a save names the version it read, so two editors
  -- never silently overwrite each other.
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'table' OR table_config IS NOT NULL)
);

-- Formulas refer to sheets by name, case-insensitively, as Excel does.
CREATE UNIQUE INDEX IF NOT EXISTS sheet_tabs_name_idx
  ON public.sheet_tabs (workbook_id, lower(name));
CREATE INDEX IF NOT EXISTS sheet_tabs_workbook_idx
  ON public.sheet_tabs (workbook_id, position);

ALTER TABLE public.sheet_workbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_tabs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own workbooks" ON public.sheet_workbooks;
CREATE POLICY "Users manage own workbooks" ON public.sheet_workbooks FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users manage own sheet tabs" ON public.sheet_tabs;
CREATE POLICY "Users manage own sheet tabs" ON public.sheet_tabs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS sheet_workbooks_updated_at ON public.sheet_workbooks;
CREATE TRIGGER sheet_workbooks_updated_at
  BEFORE UPDATE ON public.sheet_workbooks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS sheet_tabs_updated_at ON public.sheet_tabs;
CREATE TRIGGER sheet_tabs_updated_at
  BEFORE UPDATE ON public.sheet_tabs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A workbook's existence and name are governance; a cell edit is not, and
-- auditing every keystroke would bury the log. The sheet's shape (created,
-- renamed, its table definition) is audited; its cells are not.
DROP TRIGGER IF EXISTS audit_sheet_workbooks ON public.sheet_workbooks;
CREATE TRIGGER audit_sheet_workbooks
  AFTER INSERT OR DELETE OR UPDATE OF name, description
  ON public.sheet_workbooks
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('sheet_workbook');
DROP TRIGGER IF EXISTS audit_sheet_tabs ON public.sheet_tabs;
CREATE TRIGGER audit_sheet_tabs
  AFTER INSERT OR DELETE OR UPDATE OF name, kind, table_config
  ON public.sheet_tabs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('sheet_tab');

-- Instance limits, editable under Admin -> Developer runtime; NULL = env.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS sheets_max_cells integer,
  ADD COLUMN IF NOT EXISTS sheets_page_rows integer;
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_max_cells IS
  'Most non-empty cells one grid sheet may hold; NULL = env SHEETS_MAX_CELLS, then 200000.';
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_page_rows IS
  'Rows a table sheet fetches from the lakehouse per page; NULL = env SHEETS_PAGE_ROWS, then 500.';
