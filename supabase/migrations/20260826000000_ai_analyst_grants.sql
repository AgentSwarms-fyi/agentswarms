-- Sharing an AI analyst — the CONFIGURATION, never the owner's data access.
--
-- The analysts migration (20260825000000) made both tables owner-only because
-- an analyst runs with its owner's data access. That reasoning still holds and
-- is why this migration is narrow:
--
--   * ai_analysts gains a SELECT policy for granted principals, so a recipient
--     can open the analyst and ask their own questions. Writes stay with the
--     owner — the existing "own analysts" FOR ALL policy is unchanged, so only
--     the owner can rename it, repoint its source, or delete it.
--
--   * ai_analyst_threads is NOT touched. Saved threads hold result samples
--     fetched under the OWNER's access; showing them to a recipient whose row
--     filters are narrower would leak precisely the rows those filters exist
--     to withhold. Threads stay per-user (auth.uid() = user_id), which also
--     lets a recipient create their own conversations on a shared analyst
--     without any further policy.
--
-- Every query a recipient runs is still authorised as THEM: their dataset
-- grants, their warehouse credentials, their row filters and column masks. The
-- grant conveys the right to use the analyst, not the right to see the owner's
-- data through it.
-- The CHECK is REPLACED, not extended, so this list must be the full current
-- set — every type any earlier migration added, plus the new one. Copying the
-- list from an older migration silently REVOKES the types added since, and the
-- only symptom is a CHECK violation the next time someone shares one of them.
-- tests/unit/iamGrantTypes.test.ts compares this against the app's own list.
ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT IF EXISTS iam_resource_grants_resource_type_check;

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
      'provider_credential',
      'warehouse_connection',
      'saas_connection',
      -- New: a dedicated AI analyst.
      'ai_analyst'
    )
  );

DROP POLICY IF EXISTS "Shared analysts are readable" ON public.ai_analysts;
CREATE POLICY "Shared analysts are readable"
  ON public.ai_analysts FOR SELECT
  USING (public.has_resource_access('ai_analyst', id, auth.uid()));
