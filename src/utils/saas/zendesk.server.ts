// Zendesk connector: tickets, users and organizations, as datasets.
//
// AUTH IS EMAIL + API TOKEN. Zendesk's OAuth needs a registered client and a
// public redirect; an API token (Admin Center → Apps and integrations → APIs)
// is created once and pasted. Zendesk's Basic scheme for tokens is the
// slightly odd `email/token:<token>` — the "/token" suffix is not a typo, and
// omitting it is the single most common reason a valid token returns 401.
//
// Cursor pagination throughout (`page[size]`, `meta.has_more`,
// `meta.after_cursor`). Offset pagination is capped at 10,000 records by
// Zendesk, which is exactly the size of support desk that needs this
// connector most.
import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Zendesk's maximum cursor page. */
const PAGE_SIZE = 100;

type ZendeskCfg = Extract<SaasConfig, { provider: "zendesk" }>;

const STREAMS: Record<
  string,
  { label: string; path: string; key: string; incrementalPath?: string }
> = {
  tickets: {
    label: "Tickets",
    path: "/api/v2/tickets.json",
    key: "tickets",
    incrementalPath: "/api/v2/incremental/tickets/cursor.json",
  },
  users: {
    label: "Users",
    path: "/api/v2/users.json",
    key: "users",
    incrementalPath: "/api/v2/incremental/users/cursor.json",
  },
  organizations: {
    label: "Organizations",
    path: "/api/v2/organizations.json",
    key: "organizations",
    // Zendesk offers no incremental export for organizations, so this stream
    // is re-read in full. Stated here rather than left as an absence.
  },
};

/** https://<subdomain>.zendesk.com, accepting a pasted full URL too. */
export function zendeskOrigin(subdomain: string): string {
  const s = subdomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.zendesk\.com.*$/i, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+$/i.test(s)) throw new Error(`Zendesk: "${subdomain}" is not a subdomain`);
  return `https://${s.toLowerCase()}.zendesk.com`;
}

/** The token form Zendesk expects: `email/token:<api token>`, base64. */
export function zendeskAuthHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString("base64")}`;
}

async function zendeskFetch<T>(cfg: ZendeskCfg, path: string, params: URLSearchParams): Promise<T> {
  const url = `${zendeskOrigin(cfg.subdomain)}${path}${params.toString() ? `?${params}` : ""}`;
  const res = await connectorFetch(
    url,
    {
      headers: {
        Authorization: zendeskAuthHeader(cfg.email, cfg.api_token),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    },
    { label: "Zendesk" },
  );
  if (res.status === 401) {
    throw new Error(
      "Zendesk: the email or API token was rejected (Admin Center → Apps and integrations → APIs).",
    );
  }
  if (res.status === 403) {
    throw new Error(
      "Zendesk: that account cannot read this resource — an agent role or higher is needed.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zendesk: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function listZendeskStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as ZendeskCfg;
  // Cheapest authenticated call, so a bad token fails during setup.
  await zendeskFetch(c, "/api/v2/users/me.json", new URLSearchParams());
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

type Page = {
  meta?: { has_more?: boolean; after_cursor?: string | null };
} & Record<string, unknown>;

/**
 * Tickets and users have an incremental export; organizations do not.
 *
 * `updated_at` is the flattened column the runner reads the mark back from.
 * The export endpoint itself is driven by `start_time` in Unix seconds, which
 * is converted at the call rather than stored, so one cursor format serves
 * every connector.
 */
export function zendeskIncremental(streamId: string): IncrementalSpec | null {
  const stream = STREAMS[streamId];
  if (!stream?.incrementalPath) return null;
  return { cursorField: "updated_at", primaryKey: "id", compare: "iso" };
}

export async function* fetchZendeskRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Zendesk: unknown stream "${streamId}"`);
  const c = cfg as ZendeskCfg;

  const at = since ? new Date(since) : null;
  if (stream.incrementalPath && at && !Number.isNaN(at.getTime())) {
    yield* exportZendeskRows(c, stream.incrementalPath, stream.key, at);
    return;
  }

  let cursor: string | null | undefined;
  for (;;) {
    const params = new URLSearchParams({ "page[size]": String(PAGE_SIZE) });
    if (cursor) params.set("page[after]", cursor);
    const page = await zendeskFetch<Page>(c, stream.path, params);
    const rows = (page[stream.key] as Record<string, unknown>[] | undefined) ?? [];
    if (rows.length === 0) return;
    for (const r of rows) yield flattenRecord(r);
    if (!page.meta?.has_more || !page.meta.after_cursor) return;
    cursor = page.meta.after_cursor;
  }
}

/**
 * Follow a stream through Zendesk's incremental export.
 *
 * A different endpoint, a different envelope and a different end condition
 * from the cursor list above: `end_of_stream` is authoritative, and the
 * `after_cursor` must be followed even across pages that come back empty —
 * the export walks a time-ordered log and a quiet hour is a legitimate empty
 * page, not the end. Stopping on an empty page, which the list path does, is
 * exactly the bug this comment exists to prevent.
 *
 * `start_time` is INCLUSIVE and Zendesk requires it to be at least one minute
 * in the past, so the boundary record is re-read and folded away by its id.
 */
async function* exportZendeskRows(
  cfg: ZendeskCfg,
  path: string,
  key: string,
  from: Date,
): AsyncGenerator<Record<string, unknown>> {
  type ExportPage = {
    end_of_stream?: boolean;
    after_cursor?: string | null;
  } & Record<string, unknown>;

  // Zendesk rejects a start_time within the last minute.
  const startSeconds = Math.min(
    Math.floor(from.getTime() / 1000),
    Math.floor((Date.now() - 60_000) / 1000),
  );
  let params = new URLSearchParams({ start_time: String(startSeconds) });
  for (;;) {
    const page = await zendeskFetch<ExportPage>(cfg, path, params);
    const rows = (page[key] as Record<string, unknown>[] | undefined) ?? [];
    for (const r of rows) yield flattenRecord(r);

    if (page.end_of_stream || !page.after_cursor) return;
    params = new URLSearchParams({ cursor: page.after_cursor });
  }
}
