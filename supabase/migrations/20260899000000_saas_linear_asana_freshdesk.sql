-- Linear, Asana and Freshdesk join the SaaS sources.
--
-- Ten sources covered finance, commerce, CRM, support, the issue tracker, the
-- ITSM instance, the customer inbox and the repositories. These three add the
-- work-management side: the issue tracker engineering teams actually moved to,
-- the project tool the rest of the company plans in, and a second helpdesk.
--
-- All three take a pasted credential: a Linear personal API key (sent BARE,
-- with no Bearer prefix), an Asana personal access token, and a Freshdesk API
-- key used as the basic-auth username. None needs an OAuth redirect a
-- self-hosted deployment behind a firewall cannot provide.
--
-- The list below is pinned against SAAS_PROVIDERS by a test, because a CHECK
-- that lags the code is invisible until somebody runs the thing.
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
    'zendesk',
    'servicenow',
    'intercom',
    'github',
    'linear',
    'asana',
    'freshdesk'
  ));
