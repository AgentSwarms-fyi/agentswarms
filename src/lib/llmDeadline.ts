// How long to wait for a model, and why it is not one number.
//
// A flat deadline is wrong at both ends: a deck plan asking for ~16k tokens
// of JSON finishes in no fixed time, while a small insight call should not be
// allowed to hang for four minutes. So the deadline scales with the
// completion budget at an assumed generation rate.
//
// THAT RATE IS NOT ONE RATE. The original 8ms/token was measured against
// ordinary chat models. Reasoning models spend most of their wall-clock on
// hidden thinking that still counts against max_tokens, and they are much
// slower per token: a measured deepseek-r1 call through OpenRouter produced
// 1,785 tokens in 59.8 seconds — 33ms/token, four times the assumption. At
// the AI Analyst's 6,000-token planning budget that assumption yields a 108s
// deadline for work that needs roughly 200s, so the analyst's REQUIRED model
// class was the one class that reliably timed out.
//
// TWO DEADLINES, AND THE ORDER MATTERS. The browser has its own abort or a
// stalled provider would spin forever. It must outlast the server's, or the
// client gives up first and the server's specific, actionable message ("did
// not finish within Ns") never reaches anyone — the user sees a generic
// network failure instead. `clientDeadlineMs` is therefore always greater
// than `upstreamDeadlineMs` for the same inputs, and a test pins it across
// the whole range rather than trusting two constants to stay in step.

/**
 * Models whose wall-clock is dominated by thinking rather than output.
 *
 * Deliberately matched on the family markers that appear in gateway model
 * ids across providers (`deepseek-r1`, `o3`, `gpt-5`, `claude-opus-4`,
 * `gemini-2.5-pro`, `qwq`, anything self-labelled `thinking`/`reasoner`).
 * A miss is not a correctness bug — it only means the shorter deadline, the
 * behaviour every model had before.
 */
const REASONING_RE =
  /(^|[/\-_.])(o[1-4]|gpt-5|deepseek-?r1|r1|qwq|magistral)([-_.]|$)|reason|thinking|opus-4|opus-5|sonnet-4-5|gemini-[\d.]+-pro/i;

export function isSlowReasoningModel(modelId: string | undefined | null): boolean {
  return REASONING_RE.test(String(modelId ?? ""));
}

/** Assumed ms per completion token, by model class. Measured, not guessed. */
export const MS_PER_TOKEN_DEFAULT = 8;
export const MS_PER_TOKEN_REASONING = 30;

export const UPSTREAM_FLOOR_MS = 60_000;
/**
 * Floor for a reasoning model, and it carries most of the weight.
 *
 * Plenty of calls pass NO completion cap — SQL generation is the one that
 * matters here (biAgent.generateSql), plus chart choice and insights. Those
 * land on the floor exactly, so a 60s floor gave the analyst's SQL step 60
 * seconds of a model measured taking 55–80s per call: sometimes fine,
 * sometimes not, with nothing in the result to say which it would be. A
 * scaled per-token rate cannot help a request whose cap is zero.
 */
export const UPSTREAM_FLOOR_REASONING_MS = 150_000;
export const UPSTREAM_CEILING_MS = 300_000;
/** The client's head start over the server, so the server's error wins. */
export const CLIENT_HEADROOM_MS = 30_000;

function perToken(modelId: string | undefined | null): number {
  return isSlowReasoningModel(modelId) ? MS_PER_TOKEN_REASONING : MS_PER_TOKEN_DEFAULT;
}

function floorFor(modelId: string | undefined | null): number {
  return isSlowReasoningModel(modelId) ? UPSTREAM_FLOOR_REASONING_MS : UPSTREAM_FLOOR_MS;
}

/** Server-side deadline on the upstream provider call. */
export function upstreamDeadlineMs(maxTokens: number | undefined, modelId?: string | null): number {
  const cap = Math.min(Math.max(Math.trunc(maxTokens ?? 0), 0), 16000);
  return Math.min(UPSTREAM_CEILING_MS, floorFor(modelId) + cap * perToken(modelId));
}

/**
 * Browser-side abort. Always the server's deadline plus headroom, DERIVED
 * rather than re-derived: the two used to be independent expressions, which
 * is how a change to one silently inverted the ordering.
 */
export function clientDeadlineMs(maxTokens: number | undefined, modelId?: string | null): number {
  return upstreamDeadlineMs(maxTokens, modelId) + CLIENT_HEADROOM_MS;
}
