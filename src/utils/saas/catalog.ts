// What each app source asks for, in one table.
//
// This is the single source of truth for a connector's FORM and for the
// VALIDATION that guards it. It used to be two: the dialog rendered from a
// table inside the component, while the server function carried a
// hand-written Zod union naming the providers somebody had remembered to add.
//
// FOUND FROM THE UI, and it had been wrong for four milestones: that union
// stopped at five providers, so twelve connectors rendered a form, accepted a
// key, and were refused by the server with "Invalid discriminator value"
// listing five providers the person had not chosen. Nothing failed at build
// time, nothing failed in a test, and the only way to see it was to press
// Connect. A list that must be updated in two places is a list that will be
// updated in one.
//
// So the Zod union is now BUILT from this table, over SAAS_PROVIDERS — a
// provider that exists cannot be missing from it. And each provider's field
// keys are typed against its own SaasConfig variant, so a key the config does
// not have is a compile error rather than a value the server quietly strips.

import type { SaasConfig, SaasProvider } from "./types";

/** The config keys one provider actually has, minus the discriminator. */
type ConfigKeys<P extends SaasProvider> = Exclude<
  keyof Extract<SaasConfig, { provider: P }>,
  "provider"
> &
  string;

export type Field<K extends string = string> = {
  key: K;
  label: string;
  placeholder?: string;
  type?: "password" | "textarea";
  hint?: string;
  /**
   * Blank is a real answer — Jira's project keys, Asana's workspace.
   *
   * Both the Connect button and the server schema read this, so a field whose
   * label says "optional" is one neither of them insists on. They disagreed
   * once: the label said optional and the button stayed disabled until it was
   * filled.
   */
  optional?: true;
};

export type ProviderCard<P extends SaasProvider = SaasProvider> = {
  description: string;
  setup: string;
  /**
   * Singular AND plural, both stated.
   *
   * English plurals are not derivable from the singular, and deriving them
   * shipped "Connect and list repositorys" to the UI.
   */
  unit: string;
  units: string;
  fields: Field<ConfigKeys<P>>[];
};

export const SAAS_CARDS: { [P in SaasProvider]: ProviderCard<P> } = {
  ga4: {
    description: "Sync Google Analytics 4 reports into datasets — traffic, pages, events and more.",
    setup:
      "Create a service account in Google Cloud, enable the Google Analytics Data API, and " +
      "download its JSON key. Then add the key's client_email to your GA4 property as a " +
      "Viewer under Admin → Property access management. The property id is the number in " +
      "Admin → Property settings, not the G-… measurement id.",
    unit: "report",
    units: "reports",
    fields: [
      { key: "property_id", label: "Property id", placeholder: "123456789" },
      {
        key: "service_account_json",
        label: "Service account key JSON",
        type: "textarea",
        placeholder: '{ "type": "service_account", … }',
      },
    ],
  },
  klaviyo: {
    description: "Sync profiles, events, lists, metrics and email campaigns into datasets.",
    setup:
      "Create a PRIVATE API key in Klaviyo under Settings → API keys — not the public site " +
      "id — and give it read scopes for the objects you want to sync.",
    unit: "object",
    units: "objects",
    fields: [{ key: "api_key", label: "Private API key", placeholder: "pk_…" }],
  },
  notion: {
    description: "Sync Notion databases into datasets — one per database.",
    setup:
      "Create an internal integration at notion.so/my-integrations and copy its secret. " +
      "Then SHARE each database with it from Notion: open the database, ••• → Connections → " +
      "add the integration. A token on its own sees nothing.",
    unit: "database",
    units: "databases",
    fields: [
      { key: "access_token", label: "Integration secret", placeholder: "ntn_… or secret_…" },
    ],
  },
  airtable: {
    description: "Sync Airtable tables into datasets — one per table.",
    setup:
      "Create a personal access token at airtable.com/create/tokens with the " +
      "data.records:read and schema.bases:read scopes, and add each base you want to its " +
      "access list. Airtable has no modified timestamp, so these are re-read in full.",
    unit: "table",
    units: "tables",
    fields: [{ key: "access_token", label: "Personal access token", placeholder: "pat…" }],
  },
  linear: {
    description: "Sync issues, projects, teams, users and cycles into datasets.",
    setup:
      "Create a personal API key in Linear under Settings → Security & access → API keys, " +
      "and paste it exactly as issued — it goes in without a Bearer prefix. The datasets " +
      "contain what that account can see.",
    unit: "object",
    units: "objects",
    fields: [{ key: "api_key", label: "API key", placeholder: "lin_api_…" }],
  },
  asana: {
    description: "Sync tasks from your Asana projects into datasets — one per project.",
    setup:
      "Create a personal access token under Settings → Apps → Developer apps. The token " +
      "sees exactly what its owner sees. Leave the workspace blank unless you belong to " +
      "several and want only one of them.",
    unit: "project",
    units: "projects",
    fields: [
      { key: "access_token", label: "Personal access token", placeholder: "2/1234…" },
      {
        key: "workspace_gid",
        optional: true,
        label: "Workspace id (optional)",
        placeholder: "blank for every workspace you can see",
      },
    ],
  },
  freshdesk: {
    description: "Sync tickets, contacts, companies and agents into datasets.",
    setup:
      "Copy your API key from Freshdesk under Profile settings. It is used as the username " +
      "with any password, which is Freshdesk's own scheme. Agents and companies need a key " +
      "belonging to an agent with admin rights.",
    unit: "object",
    units: "objects",
    fields: [
      { key: "domain", label: "Domain", placeholder: "acme (from https://acme.freshdesk.com)" },
      { key: "api_key", label: "API key", placeholder: "paste the key as issued" },
    ],
  },
  servicenow: {
    description: "Sync incidents, changes, problems and the CMDB into datasets.",
    setup:
      "Create an INTEGRATION USER on your instance and give it a read-only role for the " +
      "tables you want (snc_read_only is often enough). The datasets contain exactly what " +
      "that user can read — ServiceNow enforces its ACLs on the Table API, so a narrow role " +
      "gives a narrow dataset.",
    unit: "table",
    units: "tables",
    fields: [
      {
        key: "instance",
        label: "Instance",
        placeholder: "acme (from https://acme.service-now.com)",
      },
      { key: "username", label: "Integration user", placeholder: "svc_agentswarms" },
      { key: "password", label: "Password", placeholder: "the integration user's password" },
    ],
  },
  intercom: {
    description: "Sync contacts, conversations and admins into datasets.",
    setup:
      "In Intercom go to Settings → Integrations → Developer Hub, create an app in your own " +
      "workspace, and copy its access token. Grant it read access to contacts and " +
      "conversations. No OAuth redirect is needed for an app in your own workspace.",
    unit: "object",
    units: "objects",
    fields: [{ key: "access_token", label: "Access token", placeholder: "dG9r…" }],
  },
  github: {
    description: "Sync issues and pull requests from your repositories into datasets.",
    setup:
      "Create a personal access token at github.com → Settings → Developer settings. A " +
      "fine-grained token needs Read access to Issues and Metadata on the repositories you " +
      "want; a classic token needs the repo scope. One dataset is created per repository.",
    unit: "repository",
    units: "repositories",
    fields: [
      { key: "owner", label: "Organisation or user", placeholder: "acme-inc" },
      { key: "access_token", label: "Access token", placeholder: "github_pat_… or ghp_…" },
    ],
  },
  jira: {
    description: "Sync every issue in your Jira projects into datasets — one per project.",
    setup:
      "Create an API token at id.atlassian.com → Security → API tokens, and enter the email " +
      "of the Atlassian account it belongs to. The datasets contain exactly what that account " +
      "can browse; a read-only account gives read-only datasets.",
    unit: "project",
    units: "projects",
    fields: [
      { key: "site_url", label: "Site URL", placeholder: "https://acme.atlassian.net" },
      { key: "email", label: "Account email", placeholder: "you@company.com" },
      { key: "api_token", label: "API token", placeholder: "ATATT3x…" },
      {
        key: "project_keys",
        optional: true,
        label: "Project keys (optional, comma-separated)",
        placeholder: "ENG, OPS — empty for every visible project",
      },
    ],
  },
  zendesk: {
    description: "Sync tickets, users and organizations into datasets.",
    setup:
      "Create an API token in Admin Center → Apps and integrations → APIs → Zendesk API, and " +
      "enter the email of the agent account it belongs to. The token is sent as " +
      "email/token — the platform adds the suffix, so paste the token as issued.",
    unit: "object",
    units: "objects",
    fields: [
      { key: "subdomain", label: "Subdomain", placeholder: "acme (from https://acme.zendesk.com)" },
      { key: "email", label: "Agent email", placeholder: "you@company.com" },
      { key: "api_token", label: "API token", placeholder: "paste the token as issued" },
    ],
  },
  google_sheets: {
    description: "Sync worksheets from a Google spreadsheet into datasets.",
    setup:
      "Create a service account in Google Cloud, download its JSON key, then SHARE the " +
      "spreadsheet with the key's client_email address (Share → paste it → Viewer). " +
      "Without that share step Google returns 403 no matter how valid the key is.",
    unit: "worksheet",
    units: "worksheets",
    fields: [
      {
        key: "spreadsheet_id",
        label: "Spreadsheet URL or id",
        placeholder: "https://docs.google.com/spreadsheets/d/…",
      },
      {
        key: "service_account_json",
        label: "Service account key JSON",
        type: "textarea",
        placeholder: '{ "type": "service_account", … }',
      },
    ],
  },
  stripe: {
    description: "Sync charges, invoices, subscriptions and more into datasets.",
    setup:
      "Use a RESTRICTED key with read-only permissions (Developers → API keys → Create " +
      "restricted key). A full secret key works but grants far more than this needs — " +
      "nothing here ever writes to Stripe.",
    unit: "object type",
    units: "object types",
    fields: [
      {
        key: "api_key",
        label: "Secret or restricted key",
        type: "password",
        placeholder: "rk_live_… or sk_live_…",
        hint: "Not the publishable key (pk_…) — that cannot read these endpoints.",
      },
    ],
  },
  hubspot: {
    description: "Sync contacts, companies, deals and tickets into datasets.",
    setup:
      "Settings → Integrations → Private Apps → create an app, grant it the read scopes for " +
      "the objects you want (crm.objects.contacts.read and so on), then copy its access token. " +
      "A private app is used rather than OAuth because that needs a public redirect URL.",
    unit: "object type",
    units: "object types",
    fields: [
      {
        key: "access_token",
        label: "Private app access token",
        type: "password",
        placeholder: "pat-na1-…",
      },
    ],
  },
  salesforce: {
    description: "Sync accounts, contacts, leads, opportunities and cases into datasets.",
    setup:
      "Create a connected app with the Client Credentials flow enabled and a 'run as' user set " +
      "(Setup → App Manager → New Connected App → OAuth Settings). Copy its consumer key and " +
      "secret. No redirect URL is needed — this is a server-to-server flow.",
    unit: "object",
    units: "objects",
    fields: [
      {
        key: "instance_url",
        label: "Instance URL",
        placeholder: "https://acme.my.salesforce.com",
        hint: "Your My Domain address. A sandbox uses its own domain.",
      },
      { key: "client_id", label: "Consumer key", type: "password", placeholder: "3MVG9…" },
      { key: "client_secret", label: "Consumer secret", type: "password" },
    ],
  },
  shopify: {
    description: "Sync orders, customers and products into datasets.",
    setup:
      "In your Shopify admin: Settings → Apps and sales channels → Develop apps → create an " +
      "app, grant it read_orders, read_customers and read_products, then install it and copy " +
      "the Admin API access token.",
    unit: "resource",
    units: "resources",
    fields: [
      {
        key: "shop_domain",
        label: "Shop domain",
        placeholder: "acme.myshopify.com",
      },
      {
        key: "access_token",
        label: "Admin API access token",
        type: "password",
        placeholder: "shpat_…",
      },
    ],
  },
};
