-- Document intelligence: scanned PDFs and images uploaded to a knowledge base
-- are read page by page with a vision-capable model. The instance decides the
-- model and how many pages one document may have; NULL = env.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS document_vision_model text,
  ADD COLUMN IF NOT EXISTS document_vision_max_pages integer;
COMMENT ON COLUMN public.notebook_runtime_settings.document_vision_model IS
  'provider/model that reads scanned pages and images on knowledge-base upload; NULL = env DOCUMENT_VISION_MODEL, then openrouter/google/gemini-3-flash-preview.';
COMMENT ON COLUMN public.notebook_runtime_settings.document_vision_max_pages IS
  'Pages one uploaded document may have read by the vision model; NULL = env DOCUMENT_VISION_MAX_PAGES, then 200.';
