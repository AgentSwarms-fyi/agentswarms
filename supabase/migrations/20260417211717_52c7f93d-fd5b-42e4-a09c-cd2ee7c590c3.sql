-- Remove duplicate inactive integration rows so future saves stay unique.
-- Keep only the most recently updated row per (user_id, provider, type).
DELETE FROM public.integrations a
USING public.integrations b
WHERE a.user_id = b.user_id
  AND a.provider = b.provider
  AND a.type = b.type
  AND a.id <> b.id
  AND (a.updated_at, a.created_at, a.id) < (b.updated_at, b.created_at, b.id);

-- Prevent future duplicates at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_user_provider_type_uniq
  ON public.integrations (user_id, provider, type)
  WHERE provider IS NOT NULL;