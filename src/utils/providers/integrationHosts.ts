// Where an integration's credential is sent (R420, VA-2026-10-25-30).
//
// A secret shared with the integration's owner resolves only toward hosts its
// owner allowed (R419), so a caller that resolves a saved integration config
// names those hosts. They are read from the config as resolved, by the same
// rules the requests use: a base URL when one is set, otherwise the
// provider's own API. A provider whose key can go to a host its base URL does
// not name lists both (Gemini's native streaming always calls Google).
//
// PURE: no server imports, so the drift test can hold the defaults to the
// transports in credentials.server.ts and the adapters.

/** Each provider's API when no base URL overrides it. */
export const PROVIDER_DEFAULT_BASE_URL: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  grok: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  ollama: "http://localhost:11434",
};

/** Firecrawl's API: every request with its key goes here. */
export const FIRECRAWL_API = "https://api.firecrawl.dev";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * The hosts a resolved integration config's credential goes to, for
 * `resolveIntegrationConfig`'s `sendTo`. Undefined (owner-only) when the
 * config names none, and always for a notification: its webhook URL is the
 * destination and the credential at once.
 */
export function integrationHosts(
  type: string,
  provider?: string | null,
): (cfg: Record<string, unknown>) => string[] | undefined {
  return (cfg) => {
    switch (type) {
      case "llm_provider": {
        const p = provider ?? "";
        // Ollama's address is its `endpoint`; every other provider's a base URL.
        const override = p === "ollama" ? str(cfg.endpoint) : str(cfg.base_url);
        const fallback = PROVIDER_DEFAULT_BASE_URL[p];
        const hosts = override ? [override] : fallback ? [fallback] : [];
        if (p === "gemini" && override && fallback) hosts.push(fallback);
        return hosts.length > 0 ? hosts : undefined;
      }
      case "llm_gateway":
        return str(cfg.base_url) ? [str(cfg.base_url)] : undefined;
      case "n8n":
        return str(cfg.instance_url) ? [str(cfg.instance_url)] : undefined;
      case "firecrawl":
        return [FIRECRAWL_API];
      default:
        return undefined;
    }
  };
}
