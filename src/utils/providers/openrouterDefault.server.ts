// Shared constants for server-side code that calls OpenRouter directly via
// `fetch` (background jobs — memory, KB ingestion, BI agent, skill/tool/exam
// generation, notebook AI proxies) rather than through the credentials.server
// per-user resolver. These always use the operator's shared OPENROUTER_API_KEY
// since they're internal utility calls, not a specific user's chat turn.
export const OPENROUTER_CHAT_URL = `${(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "")}/chat/completions`;

export function getOpenRouterApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY;
  return key && key.trim() ? key.trim() : null;
}
