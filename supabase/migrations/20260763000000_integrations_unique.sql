-- Enforce the singleton shape the Integration Hub already assumes.
--
-- Every runtime reader of the gateway / n8n / firecrawl integration uses
-- .maybeSingle(), which ERRORS when two rows of the same type exist — and that
-- error is swallowed, so a duplicate row silently disables the integration
-- (gateway routing just stops applying, n8n tools report "not connected").
-- Nothing prevented duplicates: saveIntegration inserts when no id is passed,
-- so two tabs or a direct server-fn call could create one.
--
-- Fix in two parts: dedupe what exists (keeping the row the readers would
-- pick: active first, then newest), then unique partial indexes so it can
-- never happen again. saveIntegration also now resolves the existing row
-- server-side, so the constraint is a backstop, not the primary mechanism.

-- 1) Dedupe singleton types, keeping the reader-preferred row
--    (is_active DESC, updated_at DESC — same ordering loadLegacyConfig uses).
DELETE FROM public.integrations a
USING public.integrations b
WHERE a.user_id = b.user_id
  AND a.type = b.type
  AND a.type IN ('llm_gateway', 'n8n', 'firecrawl')
  AND a.id <> b.id
  AND (b.is_active, b.updated_at, b.created_at, b.id)
    > (a.is_active, a.updated_at, a.created_at, a.id);

-- 2) Dedupe llm_provider per (user, provider) the same way.
DELETE FROM public.integrations a
USING public.integrations b
WHERE a.user_id = b.user_id
  AND a.type = 'llm_provider'
  AND b.type = 'llm_provider'
  AND a.provider IS NOT DISTINCT FROM b.provider
  AND a.id <> b.id
  AND (b.is_active, b.updated_at, b.created_at, b.id)
    > (a.is_active, a.updated_at, a.created_at, a.id);

-- 3) One gateway / n8n / firecrawl connection per user.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integrations_singleton_type
  ON public.integrations(user_id, type)
  WHERE type IN ('llm_gateway', 'n8n', 'firecrawl');

-- 4) One connection per (user, LLM provider). Unknown/future types are
--    deliberately unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integrations_llm_provider
  ON public.integrations(user_id, type, provider)
  WHERE type = 'llm_provider' AND provider IS NOT NULL;
