-- Widen the integrations.type CHECK to every type the app actually writes.
--
-- The original CREATE TABLE (20260416100227) allowed only
-- ('llm_provider','llm_gateway','n8n') and was never altered — which means on
-- a FRESH database the Firecrawl connector's save has been failing the CHECK
-- (23514) ever since it shipped, silently: the UI didn't inspect that save's
-- result. Long-lived databases created before the constraint migration never
-- noticed. Caught by the notification-channel verification suite, which hit
-- the same wall.
--
-- Keep a CHECK (a typo'd type should fail loudly) but list the real set.

ALTER TABLE public.integrations
  DROP CONSTRAINT IF EXISTS integrations_type_check;
ALTER TABLE public.integrations
  ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('llm_provider', 'llm_gateway', 'n8n', 'firecrawl', 'notification'));
