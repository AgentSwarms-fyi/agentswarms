-- Permit Stripe and Shopify as SaaS sources.
--
-- A separate migration rather than an edit to 20260774000000, which may
-- already have been applied. Editing an applied migration is a no-op against
-- the database while looking correct in the repo — the drift is invisible
-- until a save fails on a constraint nobody thinks is still there.

ALTER TABLE public.saas_connections
  DROP CONSTRAINT IF EXISTS saas_connections_provider_check;

ALTER TABLE public.saas_connections
  ADD CONSTRAINT saas_connections_provider_check
  CHECK (provider IN (
    'google_sheets',
    'stripe',
    'shopify'
  ));
