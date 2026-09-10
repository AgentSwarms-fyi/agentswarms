-- Google Analytics 4 joins the SaaS sources, completing the connector set.
--
-- The odd one out, and the reason it came last. Every other app source syncs
-- RECORDS — a charge, an issue, a contact, each with an id and a modified
-- time. GA4 has no records: its Data API answers a question (these dimensions,
-- these metrics, this date range) and returns aggregated rows that exist only
-- because you asked for them. So a stream here is a REPORT DEFINITION, the
-- cursor is a date, and the primary key is composed from the dimension tuple
-- because an aggregate has no id of its own.
--
-- Auth is a service account, like Google Sheets — and, like Google Sheets, the
-- key alone reads nothing: its client_email must be added to the property as a
-- Viewer.
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
    'ga4'
  ));
