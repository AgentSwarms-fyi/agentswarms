-- The Sheets assistant and Fill with AI: which model they call, and how
-- often one person may call it. Calls go through the chat channel, so IAM
-- model rules, budgets, traces and cost apply as to any chat.

ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS sheets_assist_model text,
  ADD COLUMN IF NOT EXISTS sheets_assist_per_minute integer,
  ADD COLUMN IF NOT EXISTS sheets_ai_fill_max_rows integer;

COMMENT ON COLUMN public.notebook_runtime_settings.sheets_assist_model IS
  'Sheets: provider/model the assistant and Fill with AI call (SHEETS_ASSIST_MODEL, default openrouter/google/gemini-3-flash-preview).';
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_assist_per_minute IS
  'Sheets: model calls one person''s assistant and Fill with AI may make in a minute (SHEETS_ASSIST_PER_MINUTE, default 30).';
COMMENT ON COLUMN public.notebook_runtime_settings.sheets_ai_fill_max_rows IS
  'Sheets: most rows one Fill with AI works through (SHEETS_AI_FILL_MAX_ROWS, default 2000).';
