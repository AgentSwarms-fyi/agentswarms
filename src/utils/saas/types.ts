// SaaS data sources — the connectors that pull rows from an API into a dataset.
// Client-safe: no secrets, no server-only imports.
//
// These are a DIFFERENT shape from warehouse connections and deliberately not
// folded into them. A warehouse is queried live, in its own SQL dialect, and
// nothing is copied. A SaaS source has no query language: it is paged through
// an HTTP API and materialised into a dataset. Sharing one abstraction would
// mean a union type where half the fields are meaningless for either half.

export type SaasProvider = "google_sheets";

export const SAAS_PROVIDERS: SaasProvider[] = ["google_sheets"];

export const SAAS_LABELS: Record<SaasProvider, string> = {
  google_sheets: "Google Sheets",
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

export type SaasConfig = {
  provider: "google_sheets";
  /**
   * Full service-account key JSON. The sheet must be SHARED with the key's
   * client_email — Google returns 403 otherwise, and that is the single most
   * common setup mistake.
   */
  service_account_json: string;
  /** Spreadsheet id, or the full edit URL (the id is extracted from it). */
  spreadsheet_id: string;
};

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
};

export type SaasSyncResult = {
  stream: string;
  tableName: string;
  rowCount: number;
  skipped: number;
};
