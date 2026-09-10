-- Two functions that split retrieval into "which chunks" and "what are they".
--
-- Until now `match_kb_chunks_v2` did both: it searched the pgvector index and
-- returned the rows in one call. That is fine while pgvector is the only place
-- a vector can live. It stops being fine the moment the vectors can live in a
-- store outside this database, because then the search and the fetch happen in
-- two different systems and there is no single function that can do both.
--
-- So:
--
--   match_kb_chunk_ids  — the pgvector implementation of "which chunks",
--                         returning ids and similarities and nothing else.
--   kb_chunks_by_ids    — "what are they", shared by EVERY store, including
--                         pgvector.
--
-- The second one is also the security boundary. Both are SECURITY INVOKER, so
-- row-level security applies as the caller: an external store that returned an
-- id belonging to somebody else's knowledge base gets nothing back. `kb_ids` is
-- passed as well and filtered on, because defence that depends on one mechanism
-- is defence that ends when that mechanism is misconfigured.
--
-- `match_kb_chunks_v2` is left exactly as it is. Nothing in the app calls it
-- after this change, but a deployment that has written its own SQL against it
-- should not have that break on an upgrade.

-- ── Which chunks ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.match_kb_chunk_ids(
  query_embedding vector(1536),
  kb_ids uuid[],
  match_count int DEFAULT 8
)
RETURNS TABLE(
  id uuid,
  similarity float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, 1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.kb_chunks c
  WHERE c.knowledge_base_id = ANY(kb_ids)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── What are they ────────────────────────────────────────────────────────────
-- Same columns match_kb_chunks_v2 returned, minus the similarity, which now
-- comes from whichever store did the searching. Order is NOT preserved here —
-- a uuid array has no rank — so the caller re-orders by its own match list.
CREATE OR REPLACE FUNCTION public.kb_chunks_by_ids(
  chunk_ids uuid[],
  kb_ids uuid[]
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
  parent_content text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.document_id, c.knowledge_base_id, c.chunk_index, c.content,
         c.question, c.chunk_kind, c.parent_id, p.content AS parent_content
  FROM public.kb_chunks c
  LEFT JOIN public.kb_chunk_parents p ON p.id = c.parent_id
  WHERE c.id = ANY(chunk_ids)
    AND c.knowledge_base_id = ANY(kb_ids);
$$;

COMMENT ON FUNCTION public.match_kb_chunk_ids(vector, uuid[], int) IS
  'pgvector nearest-neighbour search returning chunk ids and similarities. Hydrate with kb_chunks_by_ids.';
COMMENT ON FUNCTION public.kb_chunks_by_ids(uuid[], uuid[]) IS
  'Fetch chunk rows by id, filtered to the given knowledge bases. Shared by every vector store backend.';
