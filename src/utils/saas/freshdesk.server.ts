// Freshdesk connector.
//
// Auth is an API key used as the basic-auth USERNAME with any password —
// Freshdesk's own documented scheme, and the reason the password below is the
// literal "X" rather than something the operator has to invent.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Freshdesk's maximum page. */
const PAGE_SIZE = 100;

/**
 * Freshdesk stops paginating a list at 300 pages.
 *
 * At 100 per page that is 30,000 records, after which it returns an error
 * rather than an empty page — so a full read of a large helpdesk cannot be
 * done by paging alone. Following `updated_since` is what keeps a sync inside
 * that ceiling on every run after the first.
 */
const MAX_PAGES = 300;

type FreshdeskCfg = Extract<SaasConfig, { provider: "freshdesk" }>;

/**
 * Which query parameter each list takes for "changed since", if any.
 *
 * They are NOT the same, and the difference is not a typo: tickets take
 * `updated_since` and contacts take `_updated_since`, with a leading
 * underscore. Getting it wrong is silent — Freshdesk ignores an unknown
 * parameter and returns everything, so the sync works and simply never
 * follows.
 */
const STREAMS: Record<string, { label: string; path: string; sinceParam: string | null }> = {
  tickets: { label: "Tickets", path: "/api/v2/tickets", sinceParam: "updated_since" },
  contacts: { label: "Contacts", path: "/api/v2/contacts", sinceParam: "_updated_since" },
  // Neither offers a changed-since filter. Both are small, so a full read is
  // cheap — stated here rather than left as an absence.
  companies: { label: "Companies", path: "/api/v2/companies", sinceParam: null },
  agents: { label: "Agents", path: "/api/v2/agents", sinceParam: null },
};

/** https://<domain>.freshdesk.com, accepting a pasted full URL too. */
export function freshdeskOrigin(domain: string): string {
  const s = domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.freshdesk\.com$/i, "");
  if (!s) throw new Error("Freshdesk: enter your domain, e.g. acme or acme.freshdesk.com");
  return `https://${s}.freshdesk.com`;
}

async function freshdeskFetch(
  cfg: FreshdeskCfg,
  path: string,
  params: URLSearchParams,
): Promise<Record<string, unknown>[]> {
  const url = `${freshdeskOrigin(cfg.domain)}${path}?${params}`;
  // The API key is the USERNAME and the password is ignored; "X" is what
  // Freshdesk's own documentation uses.
  const basic = Buffer.from(`${cfg.api_key}:X`).toString("base64");
  const res = await connectorFetch(url, {
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error("Freshdesk: that API key was rejected. Copy it from Profile settings.");
  }
  if (res.status === 403) {
    throw new Error(
      "Freshdesk: this key's agent cannot read that resource. Agents and companies need " +
        "an agent with admin rights.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Freshdesk: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
}

export async function listFreshdeskStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  // One cheap call so a bad key fails during setup rather than at the first
  // sync.
  await freshdeskFetch(
    cfg as FreshdeskCfg,
    "/api/v2/tickets",
    new URLSearchParams({ per_page: "1" }),
  );
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

/** Tickets and contacts can be followed; companies and agents cannot. */
export function freshdeskIncremental(streamId: string): IncrementalSpec | null {
  const stream = STREAMS[streamId];
  if (!stream?.sinceParam) return null;
  return { cursorField: "updated_at", primaryKey: "id", compare: "iso" };
}

export async function* fetchFreshdeskRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Freshdesk: unknown stream "${streamId}"`);
  const c = cfg as FreshdeskCfg;

  const at = since ? new Date(since) : null;
  const filter =
    stream.sinceParam && at && !Number.isNaN(at.getTime())
      ? { [stream.sinceParam]: at.toISOString() }
      : {};

  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await freshdeskFetch(
      c,
      stream.path,
      new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page), ...filter }),
    );
    if (rows.length === 0) return;
    for (const r of rows) yield flattenRecord(r);
    // A short page is the end: Freshdesk has no "has_more" flag and returns
    // an empty array past the last page, so this saves one wasted request.
    if (rows.length < PAGE_SIZE) return;
  }
  // Falling out of the loop means the ceiling was hit rather than the data
  // running out. Saying so beats a dataset that is quietly 30,000 rows short.
  throw new Error(
    `Freshdesk: ${streamId} has more than ${MAX_PAGES * PAGE_SIZE} records matching this window, ` +
      "which is as far as Freshdesk will paginate. Sync more often so each run covers less.",
  );
}
