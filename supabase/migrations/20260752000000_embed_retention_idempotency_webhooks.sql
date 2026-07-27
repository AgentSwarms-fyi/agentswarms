-- Three operational gaps on the public surfaces.
--
-- 1. Embed transcript retention. The chat-retention work covers signed-in
--    conversations via the owning agent's chat_retention_days; embed traffic
--    is anonymous and wasn't covered at all. Embeds don't persist transcripts
--    today, but their model calls DO land in execution_traces with the prompt
--    text — so "how long do we keep what strangers typed into my widget?" had
--    no answer. This adds a per-key retention window and a purge.
--
-- 2. Idempotency on POST /api/swarm/run. A retried request (client timeout,
--    proxy retry, at-least-once queue) re-ran the whole swarm and re-billed
--    it. Callers can now send an Idempotency-Key and get the original result
--    back instead of a second execution.
--
-- 3. Async runs. The API was synchronous only, so a ten-minute swarm held an
--    HTTP connection open for ten minutes. A run can now be started in the
--    background and its result delivered to a callback URL, signed with a
--    per-key secret so the receiver can verify it.

-- ── 1. Embed transcript retention ───────────────────────────────────────────
ALTER TABLE public.embed_keys
  ADD COLUMN IF NOT EXISTS transcript_retention_days integer NOT NULL DEFAULT 30
    CHECK (transcript_retention_days BETWEEN 1 AND 3650);

-- ── 2. Idempotency records ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.swarm_run_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES public.swarm_api_keys(id) ON DELETE CASCADE,
  -- Client-supplied key, unique per API key so two tenants can't collide.
  idempotency_key text NOT NULL,
  -- Hash of the request body: replaying the SAME key with a DIFFERENT payload
  -- is a client bug and must be rejected loudly rather than silently returning
  -- someone else's answer.
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  response jsonb,
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (api_key_id, idempotency_key)
);

ALTER TABLE public.swarm_run_idempotency ENABLE ROW LEVEL SECURITY;
-- Written only by the service role on the public endpoint; owners may read
-- their own records for debugging.
DROP POLICY IF EXISTS "Owners read their idempotency records" ON public.swarm_run_idempotency;
CREATE POLICY "Owners read their idempotency records"
  ON public.swarm_run_idempotency FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.swarm_api_keys k
      WHERE k.id = swarm_run_idempotency.api_key_id AND k.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_swarm_run_idem_created
  ON public.swarm_run_idempotency(created_at);

-- ── 3. Async callbacks ──────────────────────────────────────────────────────
ALTER TABLE public.swarm_api_keys
  -- Secret used to sign webhook payloads (HMAC-SHA256). Generated with the key.
  ADD COLUMN IF NOT EXISTS webhook_secret text,
  -- Optional default callback; a request may override it per run.
  ADD COLUMN IF NOT EXISTS callback_url text;
