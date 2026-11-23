-- "Any REST API" joins the app sources (R528).
--
-- Each built-in source so far was code, and each needed this constraint
-- widened. This one is different: the connector is DATA, a spec held in the
-- connection's encrypted config and checked by the app before every use, so a
-- new API needs no new provider and no further migration. The constraint
-- names it once.
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
    'freshdesk',
    'klaviyo',
    'notion',
    'airtable',
    'ga4',
    'rest_api'
  ));
