-- The Community feature (publish/browse/remix agents & swarms) has been
-- removed from the app. Strip references to it from the seeded How-To
-- knowledge base consumed by the built-in Demo Assistant so it doesn't
-- describe a page that no longer exists.
UPDATE public.knowledge_documents
SET content = replace(
  content,
  E'- /community/agents and /community/swarms — community gallery\n',
  ''
)
WHERE id = 'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b01';

UPDATE public.knowledge_documents
SET content = replace(
  content,
  E'EXPORT / SHARE\n- Each agent has Export (JSON) and Share/Publish to Community buttons on the agent card.\n- Import other people''s agents from /community/agents.\n',
  E'EXPORT / SHARE\n- Each agent has Export (JSON) and Share buttons on the agent card.\n'
)
WHERE id = 'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b05';
