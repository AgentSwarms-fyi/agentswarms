-- Org-shared LLM credentials + notification channels.
--
-- 1) LLM credentials join the polymorphic IAM grant system: a superadmin can
--    grant a user's connected provider key ('integration' = integrations-table
--    rows, 'provider_credential' = the encrypted signed-request store) to a
--    user or group. Grantees can USE the credential — resolution happens
--    server-side in credentials.server.ts, own-key-first — but can never READ
--    it: integrations/provider_credentials RLS is deliberately untouched, so
--    no grant ever ships ciphertext (or legacy plaintext) to another browser.
--
-- 2) Notification channels are integrations rows with type='notification' and
--    provider in (slack, teams, discord, webhook); the webhook URL is the
--    secret (capability URL) and is AES-GCM encrypted at rest like every
--    other integration secret. One row per (user, channel kind).

ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT iam_resource_grants_resource_type_check;
ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (
    resource_type IN (
      'knowledge_base',
      'data_table',
      'secret',
      'bi_dashboard',
      'semantic_model',
      'catalog_source',
      'integration',
      'provider_credential'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integrations_notification_channel
  ON public.integrations(user_id, type, provider)
  WHERE type = 'notification' AND provider IS NOT NULL;
