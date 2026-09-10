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
import { fetchHubspotRows, hubspotIncremental, listHubspotStreams } from "./hubspot.server";
import {
  fetchSalesforceRows,
  listSalesforceStreams,
  salesforceIncremental,
} from "./salesforce.server";
import { fetchShopifyRows, listShopifyStreams, shopifyIncremental } from "./shopify.server";
import { fetchJiraRows, jiraIncremental, listJiraStreams } from "./jira.server";
import { fetchStripeRows, listStripeStreams, stripeIncremental } from "./stripe.server";
import { fetchZendeskRows, listZendeskStreams, zendeskIncremental } from "./zendesk.server";
import {
  fetchServiceNowRows,
  listServiceNowStreams,
  serviceNowIncremental,
} from "./servicenow.server";
import { fetchIntercomRows, intercomIncremental, listIntercomStreams } from "./intercom.server";
import { fetchGithubRows, githubIncremental, listGithubStreams } from "./github.server";
import type {
  IncrementalSpec,
  SaasConfig,
  SaasProvider,
  SaasStream,
  SaasSyncResult,
} from "./types";
import { advanceCursor, SAAS_LABELS } from "./types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * What a connector must provide.
 *
 * `fetchRows` returns an AsyncGenerator rather than an array on purpose: a
 * connector that buffered a whole source before returning would put every
 * sync's peak memory at the size of the largest customer's data.
 */
export type SaasConnector = {
  listStreams: (cfg: SaasConfig) => Promise<SaasStream[]>;
  /**
   * Rows for one stream.
   *
   * `since` is the high-water mark from the last successful incremental sync,
   * or undefined for a full read. A connector that declares no incremental
   * support for the stream will never be given one.
   */
  fetchRows: (
    cfg: SaasConfig,
    streamId: string,
    since?: string,
  ) => AsyncGenerator<Record<string, unknown>>;
  /**
   * How this stream syncs incrementally, or null if it cannot.
   *
   * Per stream rather than per connector: a Stripe account's `events` are
   * append-only and cheap to follow, while its `prices` are few and change
   * shape, so re-reading them is simpler and no more expensive. Returning null
   * is a legitimate answer and keeps the full-refresh behaviour.
   */
  incremental?: (streamId: string) => IncrementalSpec | null;
};

const CONNECTORS: Record<SaasProvider, SaasConnector> = {
  google_sheets: { listStreams: listSheetStreams, fetchRows: fetchSheetRows },
  stripe: {
    listStreams: listStripeStreams,
    fetchRows: fetchStripeRows,
    incremental: stripeIncremental,
  },
  shopify: {
    listStreams: listShopifyStreams,
    fetchRows: fetchShopifyRows,
    incremental: shopifyIncremental,
  },
  hubspot: {
    listStreams: listHubspotStreams,
    fetchRows: fetchHubspotRows,
    incremental: hubspotIncremental,
  },
  salesforce: {
    listStreams: listSalesforceStreams,
    fetchRows: fetchSalesforceRows,
    incremental: salesforceIncremental,
  },
  jira: {
    listStreams: listJiraStreams,
    fetchRows: fetchJiraRows,
    incremental: jiraIncremental,
  },
  zendesk: {
    listStreams: listZendeskStreams,
    fetchRows: fetchZendeskRows,
    incremental: zendeskIncremental,
  },
  servicenow: {
    listStreams: listServiceNowStreams,
    fetchRows: fetchServiceNowRows,
    incremental: serviceNowIncremental,
  },
  intercom: {
    listStreams: listIntercomStreams,
    fetchRows: fetchIntercomRows,
    incremental: intercomIncremental,
  },
  github: {
    listStreams: listGithubStreams,
    fetchRows: fetchGithubRows,
    incremental: githubIncremental,
  },
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
  connectionId: string;
  connectionName: string;
  config: SaasConfig;
  streamId: string;
  /** Ignore the stored cursor and read the source from the beginning. */
  fullRefresh?: boolean;
}): Promise<SaasSyncResult> {
  const connector = connectorFor(args.config.provider);
  const tableName = datasetNameFor(args.connectionName, args.streamId);
  const label = `${SAAS_LABELS[args.config.provider]} · ${args.streamId}`;

  const spec = args.fullRefresh ? null : (connector.incremental?.(args.streamId) ?? null);
  const state = spec ? await readStreamState(args.connectionId, args.streamId) : null;
  // The FIRST incremental pass has no cursor, so it reads everything — and it
  // must therefore replace rather than merge. Merging into a dataset that does
  // not exist yet is the same thing, but merging into a STALE one would leave
  // rows the source has since deleted, for ever.
  const since = state?.cursor ?? undefined;
  const merging = Boolean(spec && since);

  // The highest cursor seen, tracked as rows stream past rather than after the
  // fact: the generator is consumed once by ingestRows and cannot be replayed.
  let cursor: string | null = since ?? null;
  const watched = spec
    ? (async function* () {
        for await (const row of connector.fetchRows(args.config, args.streamId, since)) {
          cursor = advanceCursor(cursor, [row], spec);
          yield row;
        }
      })()
    : connector.fetchRows(args.config, args.streamId);

  const result = await ingestRows({
    userId: args.userId,
    tableName,
    sourceLabel: label,
    // The fact the Data Catalog groups by. sourceLabel above is the same
    // provenance for a human to read; this is the one a query can filter on.
    saas: { connectionId: args.connectionId, stream: args.streamId },
    rows: watched,
    ...(merging && spec ? { mergeKey: spec.primaryKey } : {}),
  });

  // Written only after the rows are committed. A cursor advanced first and
  // then lost to a failed ingest would skip everything in that window on the
  // next run, and nothing would ever say so.
  if (spec) {
    await writeStreamState({
      connectionId: args.connectionId,
      userId: args.userId,
      stream: args.streamId,
      cursor,
      cursorField: spec.cursorField,
      rowsSeen: result.rowCount,
    });
  }

  return {
    stream: args.streamId,
    tableName: result.tableName,
    rowCount: result.rowCount,
    skipped: result.skipped,
    mode: spec ? "incremental" : "full_refresh",
    ...(result.merged ? { merged: result.merged } : {}),
  };
}

/** The high-water mark for one stream, or null before the first pass. */
export async function readStreamState(
  connectionId: string,
  stream: string,
): Promise<{ cursor: string | null } | null> {
  const { data } = await supabaseAdmin
    .from("saas_stream_state")
    .select("cursor_value")
    .eq("connection_id", connectionId)
    .eq("stream", stream)
    .maybeSingle();
  return data ? { cursor: data.cursor_value } : null;
}

async function writeStreamState(args: {
  connectionId: string;
  userId: string;
  stream: string;
  cursor: string | null;
  cursorField: string;
  rowsSeen: number;
}): Promise<void> {
  await supabaseAdmin.from("saas_stream_state").upsert(
    {
      connection_id: args.connectionId,
      user_id: args.userId,
      stream: args.stream,
      cursor_value: args.cursor,
      cursor_field: args.cursorField,
      last_rows_seen: args.rowsSeen,
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: "connection_id,stream" },
  );
}

/**
 * Forget where a stream got to, so the next sync reads it from the beginning.
 *
 * The escape hatch for the case incremental sync cannot see: records the API
 * changed without moving their cursor field, or a backfill that predates the
 * connection. It costs a full re-read of somebody's rate limit, which is why
 * it is a deliberate action rather than something the runner decides.
 */
export async function resetStreamCursor(
  userId: string,
  connectionId: string,
  stream: string,
): Promise<void> {
  await supabaseAdmin
    .from("saas_stream_state")
    .delete()
    .eq("connection_id", connectionId)
    .eq("stream", stream)
    .eq("user_id", userId);
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
    connectionId: conn.id,
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
  connectionId: string;
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
          connectionId: args.connectionId,
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
