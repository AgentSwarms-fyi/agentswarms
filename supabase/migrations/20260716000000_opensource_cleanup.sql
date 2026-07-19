-- Open-source build cleanup.
--
-- 1) The managed platform's built-in "lovable_ai" gateway is retired in the
--    self-hosted build: the app-wide default provider is "openrouter"
--    (operator-configured via OPENROUTER_API_KEY, or per-user keys under
--    /integrations). Update column defaults and re-seed the sample agents so
--    a fresh database contains no rows pointing at a provider that no longer
--    exists.
--
-- 2) The managed platform delivered transactional email through a pgmq queue
--    consumed by an external dispatcher. The self-hosted build sends directly
--    (see src/routes/api/email/send.ts), so the queue infrastructure is
--    dropped. The suppression list, unsubscribe tokens, and send log remain in
--    use.

-- ── 1a · Column defaults ─────────────────────────────────────────────────────
ALTER TABLE public.agents
  ALTER COLUMN llm_provider SET DEFAULT 'openrouter';
ALTER TABLE public.agents
  ALTER COLUMN llm_model SET DEFAULT 'openai/gpt-4o-mini';
ALTER TABLE public.execution_traces
  ALTER COLUMN llm_provider SET DEFAULT 'openrouter';

-- ── 1b · Re-seed sample agents onto the default provider ────────────────────
-- Image agents keep an image-capable model (the same id the image playground
-- and notebook image proxy default to on OpenRouter); text agents use the
-- app-wide default chat model.
UPDATE public.agents
SET llm_provider = 'openrouter',
    llm_model = CASE
      WHEN llm_model LIKE '%image%' THEN 'google/gemini-2.5-flash-image'
      ELSE 'openai/gpt-4o-mini'
    END
WHERE llm_provider = 'lovable_ai';

UPDATE public.execution_traces
SET llm_provider = 'openrouter'
WHERE llm_provider = 'lovable_ai';

-- ── 2 · Drop the unused email queue infrastructure ───────────────────────────
DROP FUNCTION IF EXISTS public.enqueue_email;
DROP FUNCTION IF EXISTS public.read_email_batch;
DROP FUNCTION IF EXISTS public.delete_email;
DROP FUNCTION IF EXISTS public.move_to_dlq;
DROP TABLE IF EXISTS public.email_send_state;

DO $$ BEGIN PERFORM pgmq.drop_queue('auth_emails'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.drop_queue('transactional_emails'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.drop_queue('auth_emails_dlq'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.drop_queue('transactional_emails_dlq'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ── 3 · Drop tables for features not present in the open-source build ───────
-- The blog is exclusive to the hosted product; its routes and content modules
-- are not part of this repository.
DROP TABLE IF EXISTS public.blog_comments;
DROP TABLE IF EXISTS public.blog_reactions;
DROP TABLE IF EXISTS public.blog_view_counts;

