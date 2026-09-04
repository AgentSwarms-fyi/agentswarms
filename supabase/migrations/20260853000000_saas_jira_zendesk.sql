-- Jira and Zendesk join the SaaS sources.
--
-- Five SaaS sources covered finance, commerce and CRM. The two the support and
-- engineering halves of a company actually live in -- the ticket queue and the
-- issue tracker -- were missing, and they are the ones whose questions ("what
-- is open for ENG this sprint", "how long do P1 tickets take to close") most
-- need a dataset rather than a dashboard someone else owns.
--
-- Both authenticate with email + API token, matching the platform's
-- paste-a-credential pattern; neither needs an OAuth redirect a self-hosted
-- deployment behind a firewall cannot provide.
ALTER TABLE public.saas_connections
  DROP CONSTRAINT IF EXISTS saas_connections_provider_check;

ALTER TABLE public.saas_connections
  ADD CONSTRAINT saas_connections_provider_check
  CHECK (provider IN (
    'google_sheets',
    'stripe',
    'shopify',
    'hubspot',
    'salesforce',
    'jira',
    'zendesk'
  ));
