-- Sheets: the largest CSV an upload may bring into the lakehouse, editable
-- under Admin -> Developer runtime; NULL = env SHEETS_UPLOAD_MAX_MB, then 50.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS sheets_upload_max_mb integer;
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_upload_max_mb IS
  'Largest CSV (MB) a Sheets upload brings into the lakehouse; NULL = env SHEETS_UPLOAD_MAX_MB, then 50.';
