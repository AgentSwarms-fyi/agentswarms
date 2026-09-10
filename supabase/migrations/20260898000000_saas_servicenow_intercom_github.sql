-- ServiceNow, Intercom and GitHub join the SaaS sources.
--
-- Seven sources covered finance, commerce, CRM, support and the issue
-- tracker. These three add the parts of a company those miss: the ITSM
-- instance an enterprise runs its operations on, the inbox its customers
-- actually write into, and the repositories its engineering happens in.
--
-- All three authenticate with a pasted credential — basic auth for a
-- ServiceNow integration user, an access token for an Intercom app in your own
-- workspace, a personal access token for GitHub. None needs an OAuth redirect
-- a self-hosted deployment behind a firewall cannot provide, which is the
-- constraint that decides what can be a connector here at all.
--
-- FOUND FROM A PREVIOUS MILESTONE: a CHECK that lags the code is invisible
-- until somebody runs the thing. `workflow_node_runs_kind_check` admitted four
-- of fifteen kinds and a graph saved and drew fine before failing at run with
-- a raw Postgres constraint name. A test pins this list against
-- `SAAS_PROVIDERS` so the two cannot drift apart.
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
    'github'
  ));
