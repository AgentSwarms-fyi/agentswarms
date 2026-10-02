// Klaviyo connector.
//
// Auth is a private API key, sent as `Klaviyo-API-Key <key>` rather than a
// bearer token. Klaviyo also REQUIRES a `revision` header naming an API date:
// omit it and every request is rejected, which makes it the first thing to get
// wrong and the reason it is pinned rather than left to Klaviyo's default.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://a.klaviyo.com/api";

/**
 * Pinned, so Klaviyo shipping a new revision cannot change the shape of a
 * synced dataset underneath an existing dashboard.
 */
const REVISION = "2024-10-15";

const PAGE_SIZE = 100;

type KlaviyoCfg = Extract<SaasConfig, { provider: "klaviyo" }>;

/**
 * Klaviyo's filter grammar is its own: `greater-or-equal(field,value)` rather
 * than a query parameter per field.
 *
 * `cursorField` is the column the row carries after flattening; `filterField`
 * is what Klaviyo calls it. They differ on events, where the row's timestamp
 * is `datetime` and there is no `updated` at all.
 */
const STREAMS: Record<
  string,
  { label: string; path: string; filterField: string | null; cursorField: string; extra?: string }
> = {
  profiles: {
    label: "Profiles",
    path: "/profiles",
    filterField: "updated",
    cursorField: "updated",
  },
  events: {
    label: "Events",
    path: "/events",
    filterField: "datetime",
    cursorField: "datetime",
  },
  lists: { label: "Lists", path: "/lists", filterField: "updated", cursorField: "updated" },
  metrics: { label: "Metrics", path: "/metrics", filterField: "updated", cursorField: "updated" },
  campaigns: {
    label: "Campaigns (email)",
    path: "/campaigns",
    filterField: "updated_at",
    cursorField: "updated_at",
    // Klaviyo REFUSES /campaigns without a channel filter — it is not
    // optional, and the error says only "filter is required".
    extra: "equals(messages.channel,'email')",
  },
};

type JsonApiPage = {
  data?: { id?: string; type?: string; attributes?: Record<string, unknown> }[];
  links?: { next?: string | null };
  errors?: { detail?: string; title?: string }[];
};

async function klaviyoFetch(cfg: KlaviyoCfg, url: string): Promise<JsonApiPage> {
  const res = await connectorFetch(url, {
    headers: {
      Authorization: `Klaviyo-API-Key ${cfg.api_key}`,
      Accept: "application/json",
      revision: REVISION,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Klaviyo: that key was rejected. Use a PRIVATE API key from Settings → API keys, " +
        "not the public site id, and give it read scopes for the objects you want.",
    );
  }
  const body = (await res.json().catch(() => ({}))) as JsonApiPage;
  if (!res.ok) {
    const detail = body.errors
      ?.map((e) => e.detail ?? e.title)
      .filter(Boolean)
      .join("; ");
    throw new Error(`Klaviyo: ${detail || `HTTP ${res.status}`}`);
  }
  return body;
}

export async function listKlaviyoStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  // Metrics is the cheapest list that proves the key and holds no customer
  // data.
  await klaviyoFetch(cfg as KlaviyoCfg, `${API}/metrics?page[size]=1`);
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

/** Everything here carries a timestamp Klaviyo can filter on. */
export function klaviyoIncremental(streamId: string): IncrementalSpec | null {
  const stream = STREAMS[streamId];
  if (!stream?.filterField) return null;
  return { cursorField: stream.cursorField, primaryKey: "id", compare: "iso" };
}

export async function* fetchKlaviyoRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Klaviyo: unknown stream "${streamId}"`);
  const c = cfg as KlaviyoCfg;

  const at = since ? new Date(since) : null;
  const filters: string[] = [];
  if (stream.extra) filters.push(stream.extra);
  if (stream.filterField && at && !Number.isNaN(at.getTime())) {
    // `greater-or-equal`, so the record on the boundary returns and is folded
    // away by its id rather than dropped.
    filters.push(`greater-or-equal(${stream.filterField},${at.toISOString()})`);
  }

  const first = new URL(`${API}${stream.path}`);
  first.searchParams.set("page[size]", String(PAGE_SIZE));
  if (filters.length) first.searchParams.set("filter", filters.join(","));
  if (stream.filterField) first.searchParams.set("sort", stream.filterField);

  // Klaviyo hands back the whole next URL, cursor and filters included, so it
  // is followed rather than rebuilt — rebuilding is how a filter gets dropped
  // on page two and the sync quietly returns everything.
  let url: string | null = first.toString();
  while (url) {
    const page: JsonApiPage = await klaviyoFetch(c, url);
    const rows = page.data ?? [];
    if (rows.length === 0) return;
    for (const r of rows) {
      // JSON:API keeps the fields in `attributes` and the id beside it, so
      // the two are merged — otherwise every column would be prefixed
      // `attributes_` and the id would look like metadata.
      yield flattenRecord({ id: r.id ?? null, ...(r.attributes ?? {}) });
    }
    url = page.links?.next ?? null;
  }
}
