// HubSpot connector (CRM v3).
//
// AUTH IS A PRIVATE APP TOKEN, NOT OAUTH. HubSpot supports both, but the OAuth
// flow needs a public redirect URL that a self-hosted deployment behind a
// firewall cannot provide — and registering a HubSpot app is work the operator
// has to do either way. A private app token is created in the portal, pasted
// once, and scoped to exactly the objects it may read.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://api.hubapi.com";

/** HubSpot's maximum for a CRM list page. */
const PAGE_SIZE = 100;

/**
 * How many properties to request.
 *
 * A mature portal defines hundreds of custom contact properties, and they are
 * requested as a comma-separated query parameter — enough of them and the URL
 * exceeds what HubSpot (and intermediaries) will accept, which surfaces as a
 * confusing 400 rather than "too many properties". Capping keeps the request
 * valid; the cap is above flatten's own column ceiling, so it is not the
 * binding constraint in practice.
 */
const MAX_PROPERTIES = 150;

type HubspotCfg = Extract<SaasConfig, { provider: "hubspot" }>;

const STREAMS: Record<string, { label: string; object: string }> = {
  contacts: { label: "Contacts", object: "contacts" },
  companies: { label: "Companies", object: "companies" },
  deals: { label: "Deals", object: "deals" },
  tickets: { label: "Tickets", object: "tickets" },
  line_items: { label: "Line items", object: "line_items" },
  products: { label: "Products", object: "products" },
};

async function hubspotFetch<T>(
  cfg: HubspotCfg,
  path: string,
  params: URLSearchParams,
  body?: unknown,
): Promise<T> {
  const url = `${API}${path}${params.toString() ? `?${params}` : ""}`;
  const res = await connectorFetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${cfg.access_token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error("HubSpot: that token was rejected. Check it is a private app access token.");
  }
  if (res.status === 403) {
    // The most common real failure: the token is valid but the private app was
    // never granted the scope for this object.
    throw new Error(
      "HubSpot: the private app lacks the scope for this object " +
        "(grant crm.objects.<object>.read in the app's settings, then re-copy the token).",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function listHubspotStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as HubspotCfg;
  // Cheapest authenticated call, so a bad token fails during setup.
  await hubspotFetch(c, "/crm/v3/objects/contacts", new URLSearchParams({ limit: "1" }));
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

type PropertyList = { results?: { name?: string }[] };

/**
 * Every property name defined for an object.
 *
 * Required because HubSpot returns only a handful of default properties unless
 * each one is named explicitly — a sync that omitted this would produce a
 * dataset with four columns from a CRM holding two hundred, and look like it
 * worked.
 */
async function propertyNames(cfg: HubspotCfg, object: string): Promise<string[]> {
  const list = await hubspotFetch<PropertyList>(
    cfg,
    `/crm/v3/properties/${object}`,
    new URLSearchParams(),
  );
  return (list.results ?? [])
    .map((p) => p.name)
    .filter((n): n is string => !!n)
    .slice(0, MAX_PROPERTIES);
}

type ObjectPage = {
  results?: {
    id?: string;
    properties?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
    archived?: boolean;
  }[];
  paging?: { next?: { after?: string } };
};

/**
 * HubSpot's search endpoint pages to 10,000 results and no further.
 *
 * Past that it stops returning a cursor, so a naive follower would silently
 * stop at ten thousand records. The way through is to re-issue the search
 * from the last timestamp seen rather than trying to page further, which is
 * what `fetchHubspotRows` does when it hits this.
 */
const SEARCH_WINDOW = 10_000;

/**
 * Every CRM object carries `hs_lastmodifieddate`, and the row it produces
 * carries `updated_at` from the record's own `updatedAt`.
 *
 * The two are the same instant; the FILTER uses HubSpot's property name and
 * the CURSOR uses the flattened column name, because that is where the runner
 * reads the high-water mark back from.
 */
export function hubspotIncremental(streamId: string): IncrementalSpec | null {
  if (!STREAMS[streamId]) return null;
  return { cursorField: "updated_at", primaryKey: "id", compare: "iso" };
}

export async function* fetchHubspotRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`HubSpot: unknown object "${streamId}"`);
  const c = cfg as HubspotCfg;

  const props = await propertyNames(c, stream.object);
  const at = since ? new Date(since) : null;
  if (at && !Number.isNaN(at.getTime())) {
    yield* searchHubspotRows(c, stream.object, props, at);
    return;
  }
  let after: string | undefined;

  for (;;) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (props.length > 0) params.set("properties", props.join(","));
    if (after) params.set("after", after);

    const page = await hubspotFetch<ObjectPage>(c, `/crm/v3/objects/${stream.object}`, params);
    const rows = page.results ?? [];
    if (rows.length === 0) return;

    for (const r of rows) {
      // The record's own fields sit BESIDE `properties`, not inside it, and the
      // id is the only stable join key — losing it would make the dataset
      // impossible to relate to anything else.
      yield flattenRecord({
        id: r.id ?? null,
        created_at: r.createdAt ?? null,
        updated_at: r.updatedAt ?? null,
        archived: r.archived ?? false,
        ...(r.properties ?? {}),
      });
    }

    // Absence of paging.next is the end. HubSpot omits it rather than
    // returning an empty cursor, so checking for a short page would make one
    // wasted request on every exact multiple of the page size.
    const next = page.paging?.next?.after;
    if (!next) return;
    after = next;
  }
}

/**
 * Follow one object type through the search endpoint.
 *
 * The list endpoint used above cannot filter by date at all, so following a
 * source means searching. Two things make that awkward and both are handled
 * here rather than left to bite later:
 *
 *  - Search returns at most 10,000 results per query. When one is exhausted
 *    the search is REISSUED from the last timestamp seen instead of paging on,
 *    because the cursor simply stops past that ceiling.
 *  - `GTE` is inclusive, so the record on the boundary comes back each time.
 *    That is deliberate — it is folded away by its id — but it also means a
 *    window that returns ONLY the boundary record has made no progress, and
 *    continuing would loop for ever. That case ends the stream.
 */
async function* searchHubspotRows(
  cfg: HubspotCfg,
  object: string,
  props: string[],
  from: Date,
): AsyncGenerator<Record<string, unknown>> {
  let windowStart = from.getTime();
  for (;;) {
    let after: string | undefined;
    let seen = 0;
    let newest = windowStart;
    for (;;) {
      const page = await hubspotFetch<ObjectPage>(
        cfg,
        `/crm/v3/objects/${object}/search`,
        new URLSearchParams(),
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "hs_lastmodifieddate",
                  operator: "GTE",
                  value: String(windowStart),
                },
              ],
            },
          ],
          // Ascending, so the window can be advanced from the last row.
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
          properties: props,
          limit: PAGE_SIZE,
          ...(after ? { after } : {}),
        },
      );
      const rows = page.results ?? [];
      if (rows.length === 0) return;

      for (const r of rows) {
        const updated = r.updatedAt ?? null;
        const t = updated ? Date.parse(updated) : NaN;
        if (Number.isFinite(t) && t > newest) newest = t;
        yield flattenRecord({
          id: r.id ?? null,
          created_at: r.createdAt ?? null,
          updated_at: updated,
          archived: r.archived ?? false,
          ...(r.properties ?? {}),
        });
      }
      seen += rows.length;

      const next = page.paging?.next?.after;
      if (!next || seen >= SEARCH_WINDOW) break;
      after = next;
    }

    // Nothing moved: every record in this window shares the boundary
    // timestamp, so reissuing would return the same page for ever.
    if (newest <= windowStart) return;
    // Under the ceiling means the window was exhausted, not truncated.
    if (seen < SEARCH_WINDOW) return;
    windowStart = newest;
  }
}
