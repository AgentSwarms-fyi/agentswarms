// SaaS data sources — the connectors that pull rows from an API into a dataset.
// Client-safe: no secrets, no server-only imports.
//
// These are a DIFFERENT shape from warehouse connections and deliberately not
// folded into them. A warehouse is queried live, in its own SQL dialect, and
// nothing is copied. A SaaS source has no query language: it is paged through
// an HTTP API and materialised into a dataset. Sharing one abstraction would
// mean a union type where half the fields are meaningless for either half.

export type SaasProvider =
  | "google_sheets"
  | "stripe"
  | "shopify"
  | "hubspot"
  | "salesforce"
  | "jira"
  | "zendesk"
  | "servicenow"
  | "intercom"
  | "github";

export const SAAS_PROVIDERS: SaasProvider[] = [
  "google_sheets",
  "stripe",
  "shopify",
  "hubspot",
  "salesforce",
  "jira",
  "zendesk",
  "servicenow",
  "intercom",
  "github",
];

export const SAAS_LABELS: Record<SaasProvider, string> = {
  google_sheets: "Google Sheets",
  stripe: "Stripe",
  shopify: "Shopify",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  jira: "Jira",
  zendesk: "Zendesk",
  servicenow: "ServiceNow",
  intercom: "Intercom",
  github: "GitHub",
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
    }
  | {
      provider: "jira";
      /** Jira Cloud site, e.g. https://acme.atlassian.net. */
      site_url: string;
      /** The Atlassian account the token belongs to. */
      email: string;
      /** API token from id.atlassian.com → Security → API tokens. */
      api_token: string;
      /** Optional comma-separated project keys; empty = every visible project. */
      project_keys?: string;
    }
  | {
      provider: "servicenow";
      /** Instance name, e.g. `acme` — a full URL is accepted and reduced. */
      instance: string;
      /** An INTEGRATION user, not a person: its roles decide what syncs. */
      username: string;
      password: string;
    }
  | {
      provider: "intercom";
      /**
       * Access token from an app in your own workspace. Not OAuth: a
       * self-hosted deployment cannot be assumed to have a public redirect.
       */
      access_token: string;
    }
  | {
      provider: "github";
      /** Organisation or user that owns the repositories. */
      owner: string;
      /** Classic or fine-grained PAT with read access to issues. */
      access_token: string;
    }
  | {
      provider: "zendesk";
      /** The <subdomain> in https://<subdomain>.zendesk.com; a full URL is accepted. */
      subdomain: string;
      /** The agent account the token belongs to. */
      email: string;
      /** API token from Admin Center → Apps and integrations → APIs. */
      api_token: string;
    };

/**
 * How a stream is kept up to date.
 *
 * `full_refresh` re-reads the source and REPLACES the dataset. It is the only
 * correct answer for a source with no cursor — a spreadsheet whose rows are
 * edited and deleted in place — and it stays the default.
 *
 * `incremental` asks the source for records changed since the last high-water
 * mark and folds them into the dataset by key. It exists because re-reading a
 * Salesforce org or a Stripe account every hour burns the customer's rate
 * limit for no new information, and eventually takes longer than the interval
 * it runs on.
 */
export const SYNC_MODES = ["full_refresh", "incremental"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

/**
 * What a connector needs to sync one stream incrementally.
 *
 * Both fields are required together and neither can be guessed. Without a
 * `primaryKey` an incremental pass can only append, so an edited record
 * arrives as a SECOND row and the dataset quietly grows duplicates. Without a
 * `cursorField` there is nothing to ask the API for.
 */
export type IncrementalSpec = {
  /**
   * The field the API filters and orders by — `SystemModstamp`, `updated_at`,
   * `created`. Named as it appears in the ROW after flattening, because that
   * is where the new high-water mark is read from.
   */
  cursorField: string;
  /** The field that identifies a record across syncs, so an edit replaces it. */
  primaryKey: string;
  /**
   * How the cursor compares, which decides what "the highest one seen" means.
   *
   * `iso` for a timestamp string, `number` for a Unix second or a sequence.
   * Comparing an ISO string numerically yields NaN and would pin the cursor at
   * its first value for ever; comparing a Unix second as a string makes
   * "9" > "10" and would walk the cursor BACKWARDS.
   */
  compare: "iso" | "number";
};

/**
 * The state a stream carries between syncs.
 *
 * `cursor` is null before the first incremental pass, which is what makes that
 * pass a full read — there is no "changed since" to ask about yet.
 */
export type StreamState = {
  stream: string;
  /** Whether this stream is followed or re-read each time. */
  mode: SyncMode;
  cursor: string | null;
  cursorField: string | null;
  lastRowsSeen: number;
  lastSyncedAt: string | null;
};

/**
 * Is `next` further along than `current`?
 *
 * Pure, and the single place the comparison lives. A cursor that moves
 * backwards re-reads rows already synced; one that moves when it should not
 * SKIPS rows for ever, which is the failure nobody notices until a month of
 * data is missing. Ties do not advance: an API that returns records with the
 * same timestamp across a page boundary would otherwise lose the ones after
 * the first.
 */
export function cursorAdvances(
  current: string | null | undefined,
  next: string | null | undefined,
  compare: IncrementalSpec["compare"],
): boolean {
  if (next === null || next === undefined || next === "") return false;
  if (current === null || current === undefined || current === "") return true;
  if (compare === "number") {
    const a = Number(current);
    const b = Number(next);
    // A non-numeric value on either side means the stored cursor and the row
    // disagree about what this field is; refusing to advance is the safe half
    // of that mistake, because it re-reads rather than skips.
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return b > a;
  }
  const a = Date.parse(current);
  const b = Date.parse(next);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return b > a;
}

/** The highest cursor in a batch, or the one we started with. */
export function advanceCursor(
  current: string | null,
  rows: Record<string, unknown>[],
  spec: IncrementalSpec,
): string | null {
  let best = current;
  for (const row of rows) {
    const raw = row[spec.cursorField];
    if (raw === null || raw === undefined) continue;
    const next = String(raw);
    if (cursorAdvances(best, next, spec.compare)) best = next;
  }
  return best;
}

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
  /** How often this syncs on its own. "manual" means only when asked. */
  sync_schedule: SyncSchedule;
  /**
   * When the scheduler will next claim it — null for a manual source.
   *
   * Reported rather than derived in the UI: it is the scheduler's own claim
   * token, so a source whose runs are stuck shows a due time in the past
   * instead of a comforting "next run in 4 hours" that no one will honour.
   */
  next_sync_at: string | null;
  /**
   * Datasets this connection currently owns.
   *
   * Counted so the disconnect warning can state what survives. "Datasets are
   * kept" is true but unhelpful when the reader cannot tell whether that means
   * one table or forty.
   */
  dataset_count?: number;
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
  /** How this stream was read. Reported so a small row count is explicable. */
  mode?: SyncMode;
  /** Present when the rows were folded into an existing dataset. */
  merged?: { updated: number; inserted: number };
};
