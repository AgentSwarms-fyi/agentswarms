// SaaS data sources — the connectors that pull rows from an API into a dataset.
// Client-safe: no secrets, no server-only imports.
//
// These are a DIFFERENT shape from warehouse connections and deliberately not
// folded into them. A warehouse is queried live, in its own SQL dialect, and
// nothing is copied. A SaaS source has no query language: it is paged through
// an HTTP API and materialised into a dataset. Sharing one abstraction would
// mean a union type where half the fields are meaningless for either half.

export type SaasProvider = "google_sheets" | "stripe" | "shopify" | "hubspot" | "salesforce";

export const SAAS_PROVIDERS: SaasProvider[] = [
  "google_sheets",
  "stripe",
  "shopify",
  "hubspot",
  "salesforce",
];

export const SAAS_LABELS: Record<SaasProvider, string> = {
  google_sheets: "Google Sheets",
  stripe: "Stripe",
  shopify: "Shopify",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
};

/**
 * One syncable object within a connection — a worksheet, a Stripe object type,
 * a Salesforce sObject. Each becomes its own dataset.
 */
export type SaasStream = {
  /** Stable id used to request this stream. Opaque to the caller. */
  id: string;
  /** What the user sees when choosing what to sync. */
  label: string;
  /** Rough size where the API offers it cheaply; omitted rather than guessed. */
  rowCountHint?: number;
};

export type SaasConfig =
  | {
      provider: "google_sheets";
      /**
       * Full service-account key JSON. The sheet must be SHARED with the key's
       * client_email — Google returns 403 otherwise, and that is the single
       * most common setup mistake.
       */
      service_account_json: string;
      /** Spreadsheet id, or the full edit URL (the id is extracted from it). */
      spreadsheet_id: string;
    }
  | {
      provider: "stripe";
      /**
       * Secret key (sk_…) or, preferably, a RESTRICTED key with read-only
       * permissions on the objects being synced. Nothing here ever writes.
       */
      api_key: string;
    }
  | {
      provider: "shopify";
      /** Shop domain — a full admin URL is accepted and reduced to this. */
      shop_domain: string;
      /** Admin API access token (shpat_…) from a custom app. */
      access_token: string;
    }
  | {
      provider: "hubspot";
      /**
       * Private app access token (pat-…). Not OAuth: a self-hosted deployment
       * cannot be assumed to have a public redirect URL.
       */
      access_token: string;
    }
  | {
      provider: "salesforce";
      /** My Domain URL, e.g. https://acme.my.salesforce.com. */
      instance_url: string;
      /** Connected app consumer key + secret, used for client credentials. */
      client_id: string;
      client_secret: string;
    };

/** Cadences a connection can be synced on. Client-safe: the picker needs these. */
export const SYNC_SCHEDULES = ["manual", "hourly", "daily", "weekly"] as const;
export type SyncSchedule = (typeof SYNC_SCHEDULES)[number];

/** Row shape returned to clients when listing connections (no secrets). */
export type SaasConnectionSummary = {
  id: string;
  provider: SaasProvider;
  name: string;
  is_active: boolean;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  /**
   * Scheduled auth probe, kept separate from the SYNC result above.
   *
   * They answer different questions: a source can authenticate perfectly and
   * have no sync scheduled, and a sync can fail for reasons that have nothing
   * to do with the credential.
   */
  last_test_status?: string | null;
  last_test_error?: string | null;
  last_tested_at?: string | null;
  /** When the stored credential was last entered — see the warehouse summary. */
  credentials_rotated_at?: string | null;
  /**
   * Reached through an IAM grant rather than owned.
   *
   * A grantee may see the source's health and trigger a sync; the sync runs as
   * the OWNER, into the owner's datasets. They cannot edit or delete it, and
   * never see the credential.
   */
  shared?: boolean;
};

export type SaasSyncResult = {
  stream: string;
  tableName: string;
  rowCount: number;
  skipped: number;
};
