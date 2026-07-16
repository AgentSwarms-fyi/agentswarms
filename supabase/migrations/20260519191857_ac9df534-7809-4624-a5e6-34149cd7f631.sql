CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  is_sample boolean NOT NULL DEFAULT false,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  token_estimate integer,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON public.kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON public.kb_chunks(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON public.kb_chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "View own or sample chunks" ON public.kb_chunks;
CREATE POLICY "View own or sample chunks" ON public.kb_chunks
  FOR SELECT USING (is_sample = true OR auth.uid() = user_id);

DROP POLICY IF EXISTS "Insert own chunks" ON public.kb_chunks;
CREATE POLICY "Insert own chunks" ON public.kb_chunks
  FOR INSERT WITH CHECK (auth.uid() = user_id AND is_sample = false);

DROP POLICY IF EXISTS "Delete own chunks" ON public.kb_chunks;
CREATE POLICY "Delete own chunks" ON public.kb_chunks
  FOR DELETE USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.match_kb_chunks(
  query_embedding vector(1536),
  kb_ids uuid[],
  match_count int DEFAULT 8
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  knowledge_base_id uuid,
  chunk_index int,
  content text,
  similarity float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.document_id, c.knowledge_base_id, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.kb_chunks c
  WHERE c.knowledge_base_id = ANY(kb_ids)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;