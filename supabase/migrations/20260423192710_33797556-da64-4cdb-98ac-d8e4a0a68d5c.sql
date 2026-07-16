
-- Public read-only model registry, populated by a weekly sync job.
CREATE TABLE public.model_registry (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  model_id TEXT NOT NULL,                  -- canonical id used at the API (e.g. gpt-5)
  alias TEXT,                              -- preferred copy-paste alias (e.g. openai/gpt-5)
  display_name TEXT NOT NULL,              -- human-friendly name
  developer TEXT NOT NULL,                 -- "OpenAI", "Anthropic", "Google", ...
  provider_slug TEXT NOT NULL,             -- normalized lowercase slug used for filtering
  description TEXT,
  context_length INTEGER,
  output_max INTEGER,
  modality TEXT NOT NULL DEFAULT 'text',   -- text | image | video | audio | embedding | other
  capabilities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], -- chat, code, vision, tools, audio, ...
  docs_url TEXT,
  source TEXT NOT NULL DEFAULT 'aimlapi',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, model_id, modality)
);

CREATE INDEX idx_model_registry_provider ON public.model_registry (provider_slug);
CREATE INDEX idx_model_registry_modality ON public.model_registry (modality);
CREATE INDEX idx_model_registry_capabilities ON public.model_registry USING GIN (capabilities);
CREATE INDEX idx_model_registry_search ON public.model_registry USING GIN (to_tsvector('simple', coalesce(display_name,'') || ' ' || coalesce(model_id,'') || ' ' || coalesce(developer,'') || ' ' || coalesce(description,'')));

ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can browse the registry.
CREATE POLICY "Authenticated users can read model registry"
  ON public.model_registry FOR SELECT
  TO authenticated
  USING (true);

-- Single-row metadata table to track sync timing/status.
CREATE TABLE public.model_registry_meta (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_count INTEGER,
  last_sync_error TEXT,
  CHECK (id = 1)
);

INSERT INTO public.model_registry_meta (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.model_registry_meta ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read sync status"
  ON public.model_registry_meta FOR SELECT
  TO authenticated
  USING (true);

CREATE TRIGGER set_model_registry_updated_at
  BEFORE UPDATE ON public.model_registry
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
