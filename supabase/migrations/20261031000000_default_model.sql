-- The instance default model.
--
-- Every surface that calls a model (agent chat, swarms, BI, Ask over an
-- ontology, AI in SQL, the Sheets assistant, document reading, memory, the
-- generators) runs on it when it has no model of its own, or when its own
-- can't run for the person: its provider isn't connected for them, or their
-- IAM model rules don't allow it. A superadmin sets it under Admin ->
-- Developer runtime -> AI services -> Default model. It replaces the
-- OPENROUTER_DEFAULT_MODEL environment variable, which is no longer read; NULL
-- means the built-in default (openrouter/google/gemini-2.5-flash).
--
-- The per-section models (sheets_assist_model, ai_sql_default_model,
-- document_vision_model) keep their meaning, except that NULL now means "the
-- default model" rather than an environment variable or a model written into
-- the code.

ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS default_model text;

COMMENT ON COLUMN public.notebook_runtime_settings.default_model IS
  'provider/model every surface falls back to; NULL = the built-in openrouter/google/gemini-2.5-flash.';

-- "provider/model": a lower-case provider id, a slash, then the model id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.notebook_runtime_settings'::regclass
      AND conname = 'notebook_runtime_settings_default_model_check'
  ) THEN
    ALTER TABLE public.notebook_runtime_settings
      ADD CONSTRAINT notebook_runtime_settings_default_model_check
      CHECK (default_model IS NULL OR default_model ~ '^[a-z][a-z0-9_]*/\S.*$');
  END IF;
END $$;

COMMENT ON COLUMN public.notebook_runtime_settings.sheets_assist_model IS
  'Sheets: provider/model the assistant and Fill with AI call; NULL = the default model.';
COMMENT ON COLUMN public.notebook_runtime_settings.ai_sql_default_model IS
  'AI in SQL: provider/model an ai_* function uses when the statement names none; NULL = the default model.';
COMMENT ON COLUMN public.notebook_runtime_settings.document_vision_model IS
  'Document intelligence: provider/model that reads scanned pages; NULL = the default model.';

-- The old settings form showed the hard-coded fallback in these fields and
-- saved it back with every save, so an instance whose settings were ever
-- saved holds it without anyone having chosen it. Left in place it would pin
-- those sections to it and the new default would never reach them. Exactly
-- that value is cleared; any other is kept as the section's own choice.
UPDATE public.notebook_runtime_settings
SET sheets_assist_model = NULL
WHERE sheets_assist_model = 'openrouter/google/gemini-3-flash-preview';
UPDATE public.notebook_runtime_settings
SET ai_sql_default_model = NULL
WHERE ai_sql_default_model = 'openrouter/google/gemini-3-flash-preview';
UPDATE public.notebook_runtime_settings
SET document_vision_model = NULL
WHERE document_vision_model = 'openrouter/google/gemini-3-flash-preview';
