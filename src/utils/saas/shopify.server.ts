// Shopify connector (Admin REST API).
//
// Auth is an Admin API access token from a custom app. REST rather than
// GraphQL: the list endpoints are uniform, the cursor is standard, and a
// GraphQL client would mean writing and versioning a query per object type for
// no benefit at this shape of use.

import { flattenRecord } from "./flatten";
import type { SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/**
 * Pinned API version.
 *
 * Shopify dates versions quarterly and REMOVES them after a year. Pinning
 * means a dataset's columns cannot change under an existing dashboard; the
 * cost is a scheduled bump, which is the right trade for analytics data.
 */
const API_VERSION = "2024-10";

/** Shopify's maximum for REST list endpoints. */
const PAGE_SIZE = 250;

type ShopifyCfg = Extract<SaasConfig, { provider: "shopify" }>;

const STREAMS: Record<string, { label: string; path: string; key: string }> = {
  orders: { label: "Orders", path: "orders", key: "orders" },
  customers: { label: "Customers", path: "customers", key: "customers" },
  products: { label: "Products", path: "products", key: "products" },
  draft_orders: { label: "Draft orders", path: "draft_orders", key: "draft_orders" },
  price_rules: { label: "Price rules", path: "price_rules", key: "price_rules" },
};

/**
 * Normalise whatever the user pasted into a bare shop domain.
 *
 * People paste "https://acme.myshopify.com/admin" or just "acme". Demanding
 * the exact form means a 404 that says nothing about what was wrong.
 */
export function normaliseShopDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) throw new Error("Shopify: enter your shop domain, e.g. acme.myshopify.com");
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) {
    throw new Error(
      `Shopify: "${input}" is not a myshopify.com domain. Use the admin address, e.g. acme.myshopify.com.`,
    );
  }
  return s;
}

/**
 * The next page's URL from the Link header.
 *
 * Shopify's REST cursor lives ONLY in that header — there is no field in the
 * body — and the page_info token must be passed back verbatim. Rebuilding the
 * URL from parts drops parameters Shopify expects to see returned unchanged.
 */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

async function shopifyFetch(cfg: ShopifyCfg, url: string): Promise<Response> {
  const res = await connectorFetch(url, {
    headers: {
      "X-Shopify-Access-Token": cfg.access_token,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Shopify: that access token was rejected, or the app lacks read scope for this resource " +
        "(needs read_orders, read_customers, read_products as appropriate).",
    );
  }
  if (res.status === 404) {
    throw new Error("Shopify: no such shop, or that resource is not available on this plan.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}

export async function listShopifyStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as ShopifyCfg;
  const shop = normaliseShopDomain(c.shop_domain);
  // shop.json is the cheapest authenticated call, so a bad token or a wrong
  // domain fails during setup rather than at the first sync.
  await shopifyFetch(c, `https://${shop}/admin/api/${API_VERSION}/shop.json`);
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

export async function* fetchShopifyRows(
  cfg: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Shopify: unknown resource "${streamId}"`);
  const c = cfg as ShopifyCfg;
  const shop = normaliseShopDomain(c.shop_domain);

  const first = new URL(`https://${shop}/admin/api/${API_VERSION}/${stream.path}.json`);
  first.searchParams.set("limit", String(PAGE_SIZE));
  // Orders default to open-only, which quietly excludes everything archived —
  // the majority of any real store's history.
  if (streamId === "orders" || streamId === "draft_orders") {
    first.searchParams.set("status", "any");
  }

  let url: string | null = first.toString();
  while (url) {
    const res: Response = await shopifyFetch(c, url);
    const body = (await res.json()) as Record<string, unknown>;
    const rows = body[stream.key];
    if (!Array.isArray(rows) || rows.length === 0) return;

    for (const raw of rows) {
      yield flattenRecord(raw as Record<string, unknown>);
    }

    // Shopify's dates are already ISO-8601 strings, so unlike Stripe there is
    // nothing to convert here.
    url = nextPageUrl(res.headers.get("link") ?? res.headers.get("Link"));
  }
}
