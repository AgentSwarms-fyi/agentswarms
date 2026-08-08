-- RAG depth: parent-child chunking, Q&A indexing, and real hybrid retrieval.
--
-- Three separate gaps, one migration because they share the chunk table.
--
-- 1. PARENT-CHILD. Retrieval quality and answer quality want opposite chunk
--    sizes: small chunks match precisely, large chunks give the model enough
--    context to actually answer. Until now one size had to serve both. Now a
--    document splits into large PARENTS, each parent splits into small
--    CHILDREN, only children are embedded, and a matched child is expanded to
--    its parent before the text reaches the model.
--
-- 2. Q&A INDEXING. A user asks a question; prose is a statement. The cosine
--    distance between "How do I rotate an API key?" and a paragraph about key
--    rotation is dominated by that grammatical mismatch. Q&A mode generates
--    question/answer pairs at index time and embeds the QUESTION, so the
--    comparison is question-to-question.
--
-- 3. HYBRID. Keyword search already existed but only as a FALLBACK for
--    documents with no embeddings — it never ran alongside vector search over
--    the same corpus, so an exact term match in an embedded document could not
--    rescue a poor semantic match. This adds Postgres full-text search over
--    kb_chunks so both retrievers see the whole corpus and their results can be
--    fused by weight.

-- ── 1. Parents ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kb_chunk_parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  is_sample boolean NOT NULL DEFAULT false,
  parent_index integer NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_chunk_parents_doc ON public.kb_chunk_parents(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_parents_kb ON public.kb_chunk_parents(knowledge_base_id);

ALTER TABLE public.kb_chunk_parents ENABLE ROW LEVEL SECURITY;

-- Mirrors kb_chunks policy for policy. A parent holds the same text as its
-- children, so anything looser is a way around the chunk policy — and anything
-- STRICTER is worse than it sounds: a reader who can see the children but not
-- the parent gets silently degraded to child-only context instead of an error.
-- That is why the IAM sharing policy is mirrored too, not just the owner one.
DROP POLICY IF EXISTS "View own or sample chunk parents" ON public.kb_chunk_parents;
CREATE POLICY "View own or sample chunk parents"
  ON public.kb_chunk_parents FOR SELECT
  USING (is_sample = true OR auth.uid() = user_id);

DROP POLICY IF EXISTS "Shared KB chunk parents are readable" ON public.kb_chunk_parents;
CREATE POLICY "Shared KB chunk parents are readable"
  ON public.kb_chunk_parents FOR SELECT
  USING (public.has_resource_access('knowledge_base', knowledge_base_id, auth.uid()));

DROP POLICY IF EXISTS "Insert own chunk parents" ON public.kb_chunk_parents;
CREATE POLICY "Insert own chunk parents"
  ON public.kb_chunk_parents FOR INSERT
  WITH CHECK (auth.uid() = user_id AND is_sample = false);

DROP POLICY IF EXISTS "Delete own chunk parents" ON public.kb_chunk_parents;
CREATE POLICY "Delete own chunk parents"
  ON public.kb_chunk_parents FOR DELETE
  USING (auth.uid() = user_id);

-- ── 2. Chunk columns ─────────────────────────────────────────────────────────
ALTER TABLE public.kb_chunks
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.kb_chunk_parents(id) ON DELETE CASCADE,
  -- 'text'  → content is the passage, and it is what was embedded.
  -- 'qa'    → question was embedded; content is the answer.
  ADD COLUMN IF NOT EXISTS chunk_kind text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS question text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kb_chunks_chunk_kind_check'
  ) THEN
    ALTER TABLE public.kb_chunks
      ADD CONSTRAINT kb_chunks_chunk_kind_check CHECK (chunk_kind IN ('text', 'qa'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kb_chunks_parent ON public.kb_chunks(parent_id);

-- ── 3. Full-text search over chunks ──────────────────────────────────────────
-- Generated, so it can never drift from the content it indexes — there is no
-- code path that could update one and forget the other.
--
-- The question is indexed too: in Q&A mode the answer text may not contain the
-- asking words at all, and a keyword search that cannot find a Q&A pair by its
-- question would make hybrid retrieval actively worse in that mode.
ALTER TABLE public.kb_chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(question, '') || ' ' || content)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_kb_chunks_fts ON public.kb_chunks USING gin (fts);

-- ── 4. Per-KB retrieval settings ─────────────────────────────────────────────
-- Retrieval is a property of the collection being searched, not of one document
-- in it, so this sits on knowledge_bases while chunking settings stay per
-- document (a KB can legitimately mix chunk modes; it cannot mix weights).
ALTER TABLE public.knowledge_bases
  ADD COLUMN IF NOT EXISTS retrieval_settings jsonb;

COMMENT ON COLUMN public.knowledge_bases.retrieval_settings IS
  '{"mode":"semantic|keyword|hybrid","semantic_weight":0..1}. NULL = semantic, matching pre-hybrid behaviour.';

-- ── 5. Parent-aware vector match ─────────────────────────────────────────────
-- Replaces match_kb_chunks for callers that understand parents. The original is
-- left in place: older code paths and any external caller keep working.
CREATE OR REPLACE FUNCTION public.match_kb_chunks_v2(
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
  question text,
  chunk_kind text,
  parent_id uuid,
  parent_content text,
  similarity float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.document_id, c.knowledge_base_id, c.chunk_index, c.content,
         c.question, c.chunk_kind, c.parent_id, p.content AS parent_content,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.kb_chunks c
  LEFT JOIN public.kb_chunk_parents p ON p.id = c.parent_id
  WHERE c.knowledge_base_id = ANY(kb_ids)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── 6. Keyword match over the same chunks ────────────────────────────────────
-- websearch_to_tsquery, not plainto_tsquery: it accepts quoted phrases and OR,
-- and it does not throw on punctuation a user typed.
CREATE OR REPLACE FUNCTION public.keyword_kb_chunks(
  query_text text,
  kb_ids uuid[],
  match_count int DEFAULT 8
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  knowledge_base_id uuid,
  chunk_index int,
  content text,
  question text,
  chunk_kind text,
  parent_id uuid,
  parent_content text,
  rank float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.document_id, c.knowledge_base_id, c.chunk_index, c.content,
         c.question, c.chunk_kind, c.parent_id, p.content AS parent_content,
         ts_rank(c.fts, websearch_to_tsquery('english', query_text))::float AS rank
  FROM public.kb_chunks c
  LEFT JOIN public.kb_chunk_parents p ON p.id = c.parent_id
  WHERE c.knowledge_base_id = ANY(kb_ids)
    AND c.fts @@ websearch_to_tsquery('english', query_text)
  ORDER BY rank DESC
  LIMIT match_count;
$$;
