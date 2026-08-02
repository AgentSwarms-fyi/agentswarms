// HubSpot connector (CRM v3).
//
// AUTH IS A PRIVATE APP TOKEN, NOT OAUTH. HubSpot supports both, but the OAuth
// flow needs a public redirect URL that a self-hosted deployment behind a
// firewall cannot provide — and registering a HubSpot app is work the operator
// has to do either way. A private app token is created in the portal, pasted
// once, and scoped to exactly the objects it may read.

import { flattenRecord } from "./flatten";
import type { SaasConfig, SaasStream } from "./types";
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

async function hubspotFetch<T>(cfg: HubspotCfg, path: string, params: URLSearchParams): Promise<T> {
  const url = `${API}${path}${params.toString() ? `?${params}` : ""}`;
  const res = await connectorFetch(url, {
    headers: { Authorization: `Bearer ${cfg.access_token}`, Accept: "application/json" },
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

export async function* fetchHubspotRows(
  cfg: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`HubSpot: unknown object "${streamId}"`);
  const c = cfg as HubspotCfg;

  const props = await propertyNames(c, stream.object);
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
