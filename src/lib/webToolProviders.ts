// The web tools' providers that take a key of their own, and the one host each
// sends it to (R494).
//
// The host is fixed by the provider, never by the config, so a key picked as a
// secret shared with the user resolves toward exactly that host, and the picker
// can say beforehand whether its owner allows it. The server's calls are in
// src/utils/tools/registry.server.ts; keep the two in step.

export const WEB_TOOL_KEY_HOSTS = {
  firecrawl_custom: "api.firecrawl.dev",
  brave: "api.search.brave.com",
  tavily: "api.tavily.com",
  serpapi: "serpapi.com",
  scrapingbee: "app.scrapingbee.com",
} as const;

export type WebToolKeyProvider = keyof typeof WEB_TOOL_KEY_HOSTS;

/** Where this provider sends its key, or null when it takes none (built-in Firecrawl). */
export function webToolKeyHost(provider: string | null | undefined): string | null {
  const p = (provider || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(WEB_TOOL_KEY_HOSTS, p)
    ? WEB_TOOL_KEY_HOSTS[p as WebToolKeyProvider]
    : null;
}

/** The name a new secret for this provider's key starts from. */
export function webToolKeySecretName(provider: string | null | undefined): string | undefined {
  switch ((provider || "").toLowerCase()) {
    case "firecrawl_custom":
      return "FIRECRAWL_API_KEY";
    case "brave":
      return "BRAVE_SEARCH_API_KEY";
    case "tavily":
      return "TAVILY_API_KEY";
    case "serpapi":
      return "SERPAPI_API_KEY";
    case "scrapingbee":
      return "SCRAPINGBEE_API_KEY";
    default:
      return undefined;
  }
}
