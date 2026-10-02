// Intercom connector.
//
// Auth is an access token from an app in your own workspace — Intercom issues
// one without an OAuth round trip, which is what makes it usable from a
// self-hosted deployment behind a firewall.
//
// Contacts and conversations come from the SEARCH endpoints rather than the
// list ones, because only search can filter on `updated_at`. Admins come from
// the plain list: there are tens of them, they have no cursor, and re-reading
// them costs one request.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://api.intercom.io";

/** Intercom's maximum page for search. */
const PAGE_SIZE = 150;

/**
 * Pinned, so Intercom changing its default cannot silently change the shape
 * of a synced dataset underneath an existing dashboard.
 */
const API_VERSION = "2.11";

type IntercomCfg = Extract<SaasConfig, { provider: "intercom" }>;

const STREAMS: Record<string, { label: string; path: string; key: string; searchable: boolean }> = {
  contacts: { label: "Contacts", path: "/contacts", key: "data", searchable: true },
  conversations: {
    label: "Conversations",
    path: "/conversations",
    key: "conversations",
    searchable: true,
  },
  // No search endpoint and no cursor: a workspace has tens of admins, so a
  // full read is one request. Stated rather than left as an absence.
  admins: { label: "Admins", path: "/admins", key: "admins", searchable: false },
};

async function intercomFetch<T>(
  cfg: IntercomCfg,
  path: string,
  init?: { body?: unknown; params?: URLSearchParams },
): Promise<T> {
  const url = `${API}${path}${init?.params?.toString() ? `?${init.params}` : ""}`;
  const res = await connectorFetch(url, {
    method: init?.body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${cfg.access_token}`,
      Accept: "application/json",
      "Intercom-Version": API_VERSION,
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error("Intercom: that token was rejected. Check it is the app's access token.");
  }
  if (res.status === 403) {
    throw new Error(
      "Intercom: the app lacks permission for this resource. Grant it read access to " +
        "contacts and conversations in the app's settings, then re-copy the token.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Intercom: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function listIntercomStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  // `/me` is the cheapest call that proves the token: it returns the app the
  // token belongs to and touches no customer data.
  await intercomFetch<unknown>(cfg as IntercomCfg, "/me");
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

/**
 * Contacts and conversations can be followed; admins cannot.
 *
 * `updated_at` is Unix SECONDS on both, so the comparison is numeric. Comparing
 * those as text would make "9…" beat "10…" and walk the cursor backwards at
 * every digit boundary.
 */
export function intercomIncremental(streamId: string): IncrementalSpec | null {
  const stream = STREAMS[streamId];
  if (!stream?.searchable) return null;
  return { cursorField: "updated_at", primaryKey: "id", compare: "number" };
}

type SearchPage = {
  pages?: { next?: { starting_after?: string } | null };
} & Record<string, unknown>;

export async function* fetchIntercomRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Intercom: unknown stream "${streamId}"`);
  const c = cfg as IntercomCfg;

  if (!stream.searchable) {
    const page = await intercomFetch<Record<string, unknown>>(c, stream.path);
    const rows = (page[stream.key] as Record<string, unknown>[] | undefined) ?? [];
    for (const r of rows) yield flattenRecord(r);
    return;
  }

  // The cursor is stored as the Unix seconds the row carried, so it is used
  // directly rather than re-derived. `>` here, not `>=`: Intercom's search
  // treats the boundary strictly, and the record that set the mark has
  // already been synced — asking for it again would return the same single
  // record for ever when nothing else has changed.
  const after = since && /^\d+$/.test(since) ? Number(since) : null;
  let startingAfter: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = {
      pagination: {
        per_page: PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      // Ascending, so a run that dies halfway has still moved the mark past
      // everything it did commit.
      sort_field: "updated_at",
      sort_order: "ascending",
      ...(after !== null
        ? { query: { field: "updated_at", operator: ">", value: after } }
        : // Search requires a query. ">= 0" matches everything and is the
          // documented way to ask for the lot.
          { query: { field: "updated_at", operator: ">", value: 0 } }),
    };
    const page = await intercomFetch<SearchPage>(c, `${stream.path}/search`, { body });
    const rows = (page[stream.key] as Record<string, unknown>[] | undefined) ?? [];
    if (rows.length === 0) return;
    for (const r of rows) yield flattenRecord(r);

    const next = page.pages?.next?.starting_after;
    if (!next) return;
    startingAfter = next;
  }
}
