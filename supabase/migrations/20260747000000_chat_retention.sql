-- Chat history retention + a private bucket that keeps generated documents.
--
-- Two things make "keep this chat (and its generated docs) for N days" real:
--   1. a per-agent retention setting (default + hard floor of 7 days), and
--   2. somewhere durable to park the generated .pptx/.docx/.xlsx so the
--      download still works after a reload — the message row only carries a
--      thumbnail + filename, not the bytes.
-- A scheduled purge (runCronPass → purgeExpiredChats) deletes messages older
-- than the owning agent's retention and removes their files from this bucket.

-- 1. Per-agent retention window. Floor of 7 days is enforced both here (CHECK)
--    and in the purge job, so the setting can only ever lengthen retention.
ALTER TABLE public.agent_memory_config
  ADD COLUMN IF NOT EXISTS chat_retention_days INTEGER NOT NULL DEFAULT 7
    CHECK (chat_retention_days >= 7);

-- 2. Private bucket for generated documents. NOT public — downloads go through
--    short-lived signed URLs minted for the owner.
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-docs', 'chat-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Owner-scoped storage policies: files live under a `<user_id>/…` prefix and
-- only that user may read/write/delete them. Mirrors the avatars bucket, minus
-- the public-read policy.
DROP POLICY IF EXISTS "Users read own chat docs" ON storage.objects;
CREATE POLICY "Users read own chat docs"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-docs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users upload own chat docs" ON storage.objects;
CREATE POLICY "Users upload own chat docs"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-docs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users update own chat docs" ON storage.objects;
CREATE POLICY "Users update own chat docs"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'chat-docs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users delete own chat docs" ON storage.objects;
CREATE POLICY "Users delete own chat docs"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-docs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
