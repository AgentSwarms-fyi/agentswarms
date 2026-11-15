// Where each app source's API lives, and so where its credentials go (R494).
//
// The normalisers were in each connector's .server file. They are plain
// string work, and the credential pickers in the Connect form need the same
// answer to warn about a shared secret whose owner did not allow the host, so
// they live here, imported by both. A connector that adds a host adds it here.
import type { SaasConfig } from "./types";

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

/** https://<instance>.service-now.com, accepting a pasted full URL too. */
export function serviceNowOrigin(instance: string): string {
  const s = instance
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.service-now\.com$/i, "");
  if (!s)
    throw new Error("ServiceNow: enter your instance name, e.g. acme or acme.service-now.com");
  return `https://${s}.service-now.com`;
}

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
 * Normalise whatever was pasted into an instance origin.
 *
 * People paste the address bar, which includes a path and often the Lightning
 * host. Demanding the exact form produces a 404 that explains nothing.
 */
export function normaliseInstanceUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, "");
  if (!s)
    throw new Error("Salesforce: enter your instance URL, e.g. https://acme.my.salesforce.com");
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Salesforce: "${input}" is not a valid URL.`);
  }
  if (!/\.salesforce\.com$|\.force\.com$/i.test(url.hostname)) {
    throw new Error(
      `Salesforce: "${url.hostname}" is not a Salesforce domain. ` +
        "Use your My Domain address, e.g. acme.my.salesforce.com.",
    );
  }
  // Origin only — a path would be carried into every API call.
  return url.origin;
}

/** Jira's site, as the connector calls it. */
export function jiraSiteOrigin(siteUrl: string): string {
  return new URL(siteUrl.trim()).origin;
}

const GOOGLE_TOKEN = "https://oauth2.googleapis.com";

/**
 * Every host a source sends its credentials to, as URLs. A secret shared with
 * the source's owner resolves only when its owner allowed each of them. Empty
 * when a host cannot be worked out yet (no instance entered): then only the
 * owner's own secrets resolve.
 */
export function saasCredentialHosts(cfg: Partial<SaasConfig> & { provider: string }): string[] {
  const c = cfg as Record<string, unknown>;
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
  try {
    switch (cfg.provider) {
      case "ga4":
        return [GOOGLE_TOKEN, "https://analyticsdata.googleapis.com"];
      case "google_sheets":
        return [GOOGLE_TOKEN, "https://sheets.googleapis.com"];
      case "klaviyo":
        return ["https://a.klaviyo.com"];
      case "notion":
        return ["https://api.notion.com"];
      case "airtable":
        return ["https://api.airtable.com"];
      case "linear":
        return ["https://api.linear.app"];
      case "asana":
        return ["https://app.asana.com"];
      case "intercom":
        return ["https://api.intercom.io"];
      case "github":
        return ["https://api.github.com"];
      case "stripe":
        return ["https://api.stripe.com"];
      case "hubspot":
        return ["https://api.hubapi.com"];
      case "freshdesk":
        return [freshdeskOrigin(str("domain"))];
      case "servicenow":
        return [serviceNowOrigin(str("instance"))];
      case "zendesk":
        return [zendeskOrigin(str("subdomain"))];
      case "shopify":
        return [`https://${normaliseShopDomain(str("shop_domain"))}`];
      case "salesforce":
        return [normaliseInstanceUrl(str("instance_url"))];
      case "jira":
        return [jiraSiteOrigin(str("site_url"))];
      default:
        return [];
    }
  } catch {
    return [];
  }
}
