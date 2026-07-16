-- 1. Replace the permissive INSERT policy with one that also verifies KB ownership.
DROP POLICY IF EXISTS "Insert own chunks" ON public.kb_chunks;

CREATE POLICY "Insert own chunks"
ON public.kb_chunks
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND is_sample = false
  AND EXISTS (
    SELECT 1 FROM public.knowledge_bases kb
    WHERE kb.id = kb_chunks.knowledge_base_id
      AND kb.user_id = auth.uid()
  )
);

-- 2. Lock down user_id (verified: 0 NULL rows in production).
ALTER TABLE public.kb_chunks ALTER COLUMN user_id SET NOT NULL;

-- 3. Prevent duplicate chunk indices per document.
ALTER TABLE public.kb_chunks
  ADD CONSTRAINT kb_chunks_doc_chunk_unique UNIQUE (document_id, chunk_index);