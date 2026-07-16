-- 1) Add source_id to knowledge_documents (nullable for backwards compatibility)
ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS source_id uuid;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_source_id
  ON public.knowledge_documents(source_id);

-- 2) Create kb_sources table
CREATE TABLE IF NOT EXISTS public.kb_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('manual','pdf','csv','url','github')),
  label text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','syncing','ok','error')),
  last_synced_at timestamptz,
  error text,
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_sources_kb_id ON public.kb_sources(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_sources_user_id ON public.kb_sources(user_id);

-- 3) Add FK from knowledge_documents.source_id -> kb_sources.id (nullable; ON DELETE SET NULL keeps docs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_source_id_fkey'
  ) THEN
    ALTER TABLE public.knowledge_documents
      ADD CONSTRAINT knowledge_documents_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES public.kb_sources(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4) Enable RLS
ALTER TABLE public.kb_sources ENABLE ROW LEVEL SECURITY;

-- 5) Policies
DROP POLICY IF EXISTS "kb_sources_select_own_or_sample" ON public.kb_sources;
CREATE POLICY "kb_sources_select_own_or_sample"
  ON public.kb_sources FOR SELECT
  USING (
    is_sample = true
    OR (auth.uid() IS NOT NULL AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "kb_sources_insert_own" ON public.kb_sources;
CREATE POLICY "kb_sources_insert_own"
  ON public.kb_sources FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.knowledge_bases kb
      WHERE kb.id = kb_sources.knowledge_base_id
        AND kb.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "kb_sources_update_own" ON public.kb_sources;
CREATE POLICY "kb_sources_update_own"
  ON public.kb_sources FOR UPDATE
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid())
  WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

DROP POLICY IF EXISTS "kb_sources_delete_own" ON public.kb_sources;
CREATE POLICY "kb_sources_delete_own"
  ON public.kb_sources FOR DELETE
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid());

-- 6) Trigger for updated_at
DROP TRIGGER IF EXISTS update_kb_sources_updated_at ON public.kb_sources;
CREATE TRIGGER update_kb_sources_updated_at
  BEFORE UPDATE ON public.kb_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();