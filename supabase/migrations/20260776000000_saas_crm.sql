-- Permit HubSpot and Salesforce as SaaS sources.
--
-- A new migration rather than an edit to 20260775000000, for the same reason
-- that one was new: editing an already-applied migration is a no-op against
-- the database while looking correct in the repo.

ALTER TABLE public.saas_connections
  DROP CONSTRAINT IF EXISTS saas_connections_provider_check;

ALTER TABLE public.saas_connections
  ADD CONSTRAINT saas_connections_provider_check
  CHECK (provider IN (
    'google_sheets',
    'stripe',
    'shopify',
    'hubspot',
    'salesforce'
  ));
