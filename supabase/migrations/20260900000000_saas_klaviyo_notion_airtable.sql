-- Klaviyo, Notion and Airtable join the SaaS sources, completing the set.
--
-- Thirteen sources covered finance, commerce, CRM, support, engineering and
-- work management. These three add the places a company keeps the rest of what
-- it knows: the marketing profile store, the wiki that became a database, and
-- the spreadsheet that became an app.
--
-- Klaviyo takes a private API key (sent as `Klaviyo-API-Key`, with a required
-- `revision` header). Notion takes an internal integration secret AND needs
-- each database shared with it from Notion's own UI. Airtable takes a personal
-- access token scoped to specific bases.
--
-- Airtable is FULL REFRESH by decision rather than omission: it exposes no
-- universal modified timestamp, and guessing at a likely field name would
-- follow the wrong column on some bases and miss edits silently.
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
    'airtable'
  ));
