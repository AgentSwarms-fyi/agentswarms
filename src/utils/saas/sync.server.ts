// The SaaS sync runner: pull a stream from a connector, land it in a dataset.
//
// One registry, one runner. A connector supplies only two things — what streams
// exist, and an async iterator of rows for one of them — and everything after
// that (type inference, staging, snapshot-then-swap, the columnar mirror) is
// the SAME path a CSV upload takes, via ingestRows. That is what stops a synced
// dataset from behaving differently to an uploaded one.
//
// Adding a connector means adding an entry to CONNECTORS. It must not mean
// touching this file's logic.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { ingestRows } from "@/utils/data/ingest.server";
import { fetchSheetRows, listSheetStreams } from "./googleSheets.server";
import { fetchHubspotRows, listHubspotStreams } from "./hubspot.server";
import { fetchSalesforceRows, listSalesforceStreams } from "./salesforce.server";
import { fetchShopifyRows, listShopifyStreams } from "./shopify.server";
import { fetchStripeRows, listStripeStreams } from "./stripe.server";
import type { SaasConfig, SaasProvider, SaasStream, SaasSyncResult } from "./types";
import { SAAS_LABELS } from "./types";

/**
 * What a connector must provide.
 *
 * `fetchRows` returns an AsyncGenerator rather than an array on purpose: a
 * connector that buffered a whole source before returning would put every
 * sync's peak memory at the size of the largest customer's data.
 */
export type SaasConnector = {
  listStreams: (cfg: SaasConfig) => Promise<SaasStream[]>;
  fetchRows: (cfg: SaasConfig, streamId: string) => AsyncGenerator<Record<string, unknown>>;
};

const CONNECTORS: Record<SaasProvider, SaasConnector> = {
  google_sheets: { listStreams: listSheetStreams, fetchRows: fetchSheetRows },
  stripe: { listStreams: listStripeStreams, fetchRows: fetchStripeRows },
  shopify: { listStreams: listShopifyStreams, fetchRows: fetchShopifyRows },
  hubspot: { listStreams: listHubspotStreams, fetchRows: fetchHubspotRows },
  salesforce: { listStreams: listSalesforceStreams, fetchRows: fetchSalesforceRows },
};

export function connectorFor(provider: SaasProvider): SaasConnector {
  const c = CONNECTORS[provider];
  if (!c) throw new Error(`No connector for source "${provider}".`);
  return c;
}

export function listSaasStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  return connectorFor(cfg.provider).listStreams(cfg);
}

/** Dataset-name characters, matching what the rest of the app accepts. */
const SAFE_NAME_RE = /[^a-zA-Z0-9_]+/g;

/**
 * A dataset name derived from the connection and stream.
 *
 * Prefixed with the connection name so two spreadsheets that both have a
 * "Sheet1" do not overwrite each other — which they would, silently, since a
 * sync REPLACES the dataset it names.
 */
export function datasetNameFor(connectionName: string, streamId: string): string {
  const clean = (s: string) =>
    s
      .trim()
      .replace(SAFE_NAME_RE, "_")
      .replace(/^_+|_+$/g, "");
  const base = `${clean(connectionName)}_${clean(streamId)}`.toLowerCase();
  const trimmed = base.replace(/^_+/, "").slice(0, 60);
  // A name must start with a letter or underscore to be a valid SQL identifier
  // once it reaches the local engine.
  return /^[a-z_]/.test(trimmed) ? trimmed : `s_${trimmed}`;
}

/**
 * Sync one stream into its dataset.
 *
 * REPLACE, not append. The previous contents are snapshotted as a restorable
 * version by the shared ingest path first, so a sync that pulls a truncated
 * source is recoverable rather than destructive — and a full replace is the
 * only correct semantic for a source like a spreadsheet, where rows are edited
 * and deleted in place and there is no cursor to append from.
 */
export async function syncSaasStream(args: {
  userId: string;
  connectionName: string;
  config: SaasConfig;
  streamId: string;
}): Promise<SaasSyncResult> {
  const connector = connectorFor(args.config.provider);
  const tableName = datasetNameFor(args.connectionName, args.streamId);
  const label = `${SAAS_LABELS[args.config.provider]} · ${args.streamId}`;

  const result = await ingestRows({
    userId: args.userId,
    tableName,
    sourceLabel: label,
    rows: connector.fetchRows(args.config, args.streamId),
  });

  return {
    stream: args.streamId,
    tableName: result.tableName,
    rowCount: result.rowCount,
    skipped: result.skipped,
  };
}

/** When a schedule is next due, or null for a source that only syncs on demand. */
export function nextSyncAt(schedule: string, from = new Date()): string | null {
  const hours: Record<string, number> = { hourly: 1, daily: 24, weekly: 24 * 7 };
  const h = hours[schedule];
  return h ? new Date(from.getTime() + h * 3600_000).toISOString() : null;
}

/**
 * Sync a connection and record the outcome on its row.
 *
 * Shared by the manual button and the scheduler so the two cannot disagree
 * about what counts as success. `sb` is the caller's client — a user JWT from
 * the server function, the service role from the scheduler — and the row is
 * always scoped by user_id so the service-role path cannot touch another
 * tenant's connection through a stale id.
 */
export async function runConnectionSync(
  sb: SupabaseClient<Database>,
  conn: {
    id: string;
    userId: string;
    name: string;
    config: SaasConfig;
    streamIds: string[];
  },
): Promise<{ synced: SaasSyncResult[]; failed: { stream: string; error: string }[] }> {
  const result = await syncSaasStreams({
    userId: conn.userId,
    connectionName: conn.name,
    config: conn.config,
    streamIds: conn.streamIds,
  });

  // A PARTIAL SYNC IS NOT SUCCESS. One stream of six silently failing is how a
  // dashboard goes stale for a quarter with nobody noticing.
  await sb
    .from("saas_connections")
    .update({
      last_sync_status: result.failed.length === 0 ? "ok" : "partial",
      last_sync_error:
        result.failed.length > 0
          ? result.failed
              .map((f) => `${f.stream}: ${f.error}`)
              .join("; ")
              .slice(0, 2000)
          : null,
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", conn.id)
    .eq("user_id", conn.userId);

  return result;
}

/**
 * Sync several streams, reporting per-stream outcomes.
 *
 * One failing stream must not abandon the others: a spreadsheet with six tabs
 * where one has been renamed should still sync the other five, and say which
 * one failed. Sequential rather than parallel — these APIs rate-limit per
 * project, and a burst is the fastest way to get a 429 for everything.
 */
export async function syncSaasStreams(args: {
  userId: string;
  connectionName: string;
  config: SaasConfig;
  streamIds: string[];
}): Promise<{ synced: SaasSyncResult[]; failed: { stream: string; error: string }[] }> {
  const synced: SaasSyncResult[] = [];
  const failed: { stream: string; error: string }[] = [];
  for (const streamId of args.streamIds) {
    try {
      synced.push(
        await syncSaasStream({
          userId: args.userId,
          connectionName: args.connectionName,
          config: args.config,
          streamId,
        }),
      );
    } catch (e) {
      failed.push({ stream: streamId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { synced, failed };
}
