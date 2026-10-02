// The AI gateway's shared, dependency-free pieces: key format, the `model`
// field's grammar, allow-list matching, the fallback chain and the error
// shape OpenAI clients expect. Imported by the server module, the server
// functions, the UI and the tests, so nothing here may touch the database.

/** Prefix that makes a leaked key recognisable in logs and secret scanners. */
export const GATEWAY_KEY_PREFIX = "gw_";

/**
 * What a key may reach. `agents`: the owner's saved agents, addressed as
 * `agent:<id or name>`. `models`: a connected model called directly, addressed
 * as `<provider>/<model>`, within the owner's IAM model rules. `metrics`: the
 * semantic layer - the models the owner may read, listed and queried over
 * HTTP (GET /metrics, POST /metrics/query).
 */
export const GATEWAY_KEY_SCOPES = ["agents", "models", "metrics"] as const;
export type GatewayKeyScope = (typeof GATEWAY_KEY_SCOPES)[number];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a new plaintext key. Shown to the owner once and never stored. */
export function generateGatewayKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return GATEWAY_KEY_PREFIX + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** SHA-256 of the plaintext, hex encoded - what actually lives in the database. */
export async function hashGatewayKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Display stub for the UI - enough to tell two keys apart, not enough to use. */
export function gatewayKeyPrefix(key: string): string {
  return key.slice(0, GATEWAY_KEY_PREFIX.length + 6);
}

/** Shape check before we spend a database round trip on a lookup. */
export function looksLikeGatewayKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.startsWith(GATEWAY_KEY_PREFIX) &&
    key.length >= GATEWAY_KEY_PREFIX.length + 16 &&
    key.length <= 120
  );
}

/**
 * The `model` field of a request names what answers it.
 *
 *   agent:<id or name>     a saved agent, with its prompt, tools, knowledge and guardrails
 *   <provider>/<model>     a connected model called directly (openrouter/openai/gpt-4o-mini)
 *
 * Anything else is `null`, which the route reports as model_not_found rather
 * than guessing: a typo that silently ran a default model would be a wrong
 * answer with a plausible face.
 */
export type GatewayTarget =
  | { kind: "agent"; ref: string }
  | { kind: "model"; provider: string; model: string };

export function parseGatewayModel(
  model: unknown,
  providers: readonly string[],
): GatewayTarget | null {
  if (typeof model !== "string") return null;
  const m = model.trim();
  if (m.toLowerCase().startsWith("agent:")) {
    const ref = m.slice("agent:".length).trim();
    return ref ? { kind: "agent", ref } : null;
  }
  const slash = m.indexOf("/");
  if (slash <= 0) return null;
  const provider = m.slice(0, slash).trim().toLowerCase();
  const rest = m.slice(slash + 1).trim();
  if (!rest || !providers.includes(provider)) return null;
  return { kind: "model", provider, model: rest };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `provider/model` match one allow-list pattern? `*` matches any run of
 * characters, and matching is case-insensitive because model ids are quoted
 * both ways in the wild ("GPT-4o" and "gpt-4o" are the same model).
 */
export function modelMatches(pattern: string, provider: string, model: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const re = new RegExp("^" + p.split("*").map(escapeRegExp).join(".*") + "$");
  return re.test(`${provider}/${model}`.toLowerCase());
}

/** An empty allow-list means "anything the owner's IAM rules allow". */
export function modelAllowedByKey(
  patterns: readonly string[],
  provider: string,
  model: string,
): boolean {
  const live = patterns.map((p) => p.trim()).filter(Boolean);
  if (live.length === 0) return true;
  return live.some((p) => modelMatches(p, provider, model));
}

/**
 * The models tried after the requested one fails: the key's own chain first,
 * then the instance-wide chain, each entry once, never the primary again.
 * Entries that do not parse (unknown provider, missing model) are dropped
 * rather than tried, so a typo in a chain costs nothing at call time.
 */
export function fallbackCandidates(
  primary: { provider: string; model: string },
  chains: readonly (readonly string[])[],
  providers: readonly string[],
): { provider: string; model: string }[] {
  const seen = new Set([`${primary.provider}/${primary.model}`.toLowerCase()]);
  const out: { provider: string; model: string }[] = [];
  for (const chain of chains) {
    for (const entry of chain) {
      const t = parseGatewayModel(entry, providers);
      if (!t || t.kind !== "model") continue;
      const k = `${t.provider}/${t.model}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ provider: t.provider, model: t.model });
    }
  }
  return out;
}

/**
 * Which upstream failures are worth trying the next model for. A caller's
 * own mistakes (400, 401, 403, 404) are not: the same request would fail the
 * same way against any model, and retrying a policy refusal would be a way
 * around the policy. Provider outages, throttling and exhausted credits are.
 */
export function isRetryableFailure(status: number): boolean {
  return (
    status === 402 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 504)
  );
}

export type OpenAiErrorCode =
  | "invalid_api_key"
  | "insufficient_scope"
  | "model_not_found"
  | "model_not_allowed"
  | "rate_limit_exceeded"
  | "insufficient_quota"
  | "invalid_request_error"
  | "upstream_error";

const ERROR_TYPE: Record<OpenAiErrorCode, string> = {
  invalid_api_key: "authentication_error",
  insufficient_scope: "permission_error",
  model_not_found: "invalid_request_error",
  model_not_allowed: "permission_error",
  rate_limit_exceeded: "rate_limit_error",
  insufficient_quota: "insufficient_quota",
  invalid_request_error: "invalid_request_error",
  upstream_error: "server_error",
};

/** The error body OpenAI clients parse: `{ error: { message, type, code, param } }`. */
export function openAiError(
  message: string,
  code: OpenAiErrorCode,
  param: string | null = null,
): { error: { message: string; type: string; code: OpenAiErrorCode; param: string | null } } {
  return { error: { message, type: ERROR_TYPE[code], code, param } };
}

/** The OpenAI message shape the endpoint accepts; content may be text or parts. */
export type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string | { type: string; text?: string }[] | null;
};

/** Flatten a message's content to text; image and other parts are described, not passed. */
export function messageText(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Split an OpenAI conversation into the system instruction the platform
 * takes as `systemPrompt` and the turns it takes as `messages`. `developer`
 * is OpenAI's newer name for the same thing; `tool` results cannot be
 * replayed into an agent that runs its own tools, so they are dropped.
 */
export function splitConversation(messages: readonly OpenAiMessage[]): {
  system: string;
  turns: { role: "user" | "assistant"; content: string }[];
} {
  const system: string[] = [];
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const text = messageText(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text.trim()) system.push(text);
    } else if (m.role === "user" || m.role === "assistant") {
      turns.push({ role: m.role, content: text });
    }
  }
  return { system: system.join("\n\n"), turns };
}
