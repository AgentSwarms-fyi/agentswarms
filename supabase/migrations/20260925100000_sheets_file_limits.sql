-- Sheets: how many sheets one Excel import may bring in, and how many rows a
-- table sheet contributes to a downloaded .xlsx or .csv. Editable under
-- Admin -> Developer runtime; NULL = the env variable, then the default.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS sheets_import_max_sheets integer,
  ADD COLUMN IF NOT EXISTS sheets_export_max_rows integer;
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_import_max_sheets IS
  'Most sheets one Sheets file import brings in; NULL = env SHEETS_IMPORT_MAX_SHEETS, then 100.';
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_export_max_rows IS
  'Most rows of a table sheet written into a downloaded workbook; NULL = env SHEETS_EXPORT_MAX_ROWS, then 100000.';
