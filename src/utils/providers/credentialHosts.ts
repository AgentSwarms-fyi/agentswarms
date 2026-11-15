// Where an encrypted LLM provider's credentials go (R494).
//
// provider_credentials holds a credential typed in before or a
// `{{secret:NAME}}` picked from the owner's secrets. A secret shared with the
// owner resolves only when its owner allowed every host the call reaches: the
// endpoint the adapter calls (the same providerOrigin the adapters use), and
// for Vertex the OAuth token endpoint too. The form uses this to warn before
// saving; the chat call uses it to resolve.
import { providerEndpoint, providerOrigin, vertexTokenUrl } from "./privateEndpoint";

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/**
 * The hosts, as URLs. Empty when they cannot be worked out yet (no region, a
 * malformed endpoint): then only the owner's own secrets resolve, and the call
 * itself reports the bad setting.
 */
export function encryptedProviderHosts(
  provider: string,
  config: Record<string, unknown>,
): string[] {
  const str = (k: string) => (typeof config[k] === "string" ? (config[k] as string).trim() : "");
  const endpoint = str("endpoint") || null;
  try {
    switch (provider) {
      case "bedrock":
        return [providerOrigin("bedrock", { region: str("region") || "us-east-1", endpoint })];
      case "claude_aws":
        return [providerOrigin("claude_aws", { region: str("region"), endpoint })];
      case "oci_genai":
        return [providerOrigin("oci_genai", { region: str("region"), endpoint })];
      case "vertex":
      case "vertex_ai": {
        const location = str("location") || "us-central1";
        return [
          providerOrigin("vertex", { region: location, endpoint }),
          vertexTokenUrl(providerEndpoint("vertex", endpoint), GOOGLE_TOKEN_URI),
        ];
      }
      case "azure_openai":
        return endpoint ? [endpoint] : [];
      case "anthropic":
        return ["https://api.anthropic.com"];
      default:
        return [];
    }
  } catch {
    return [];
  }
}
