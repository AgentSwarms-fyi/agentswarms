// The amount a provider says it charged for one call.
//
// WHY THIS OUTRANKS EVERY PRICE TABLE. priceResolver answers "what is the rate
// for this model", and every layer of it is an estimate of someone else's
// price list: a community JSON refreshed by hand, a bundled fallback, an
// operator's note of a negotiated rate. This module answers a different and
// strictly better question — "what did THIS call cost" — because the provider
// computed it against the account that will be billed.
//
// It is also the only approach that scales. OpenRouter alone fronts 413 models
// and adds more weekly; a table can only price what someone remembered to add.
// Measured on this instance: 116 calls to moonshotai/kimi-k3 carrying 75,767
// input and 56,350 output tokens all recorded $0.00, because the vendored
// catalog was built on 4 August and the model did not exist yet. OpenRouter
// would have reported the true figure on every one of those calls had anybody
// asked for it.
//
// ZERO IS A REAL ANSWER HERE, and that is the second reason to prefer this.
// `openrouter/free` routes to whichever free model is available and genuinely
// costs nothing — 122 traces of it. A table cannot tell that apart from a
// model nobody priced; a provider reporting `cost: 0` can, and does.
//
// Pure module, no imports: the streaming parser, the non-streaming path and
// the tests all read it, and it must never reach the network on a hot path.

/** Shape we accept. Deliberately loose — this is untrusted wire data. */
type UsageLike = Record<string, unknown> | null | undefined;

/**
 * Upper bound on a single call's reported cost, in USD.
 *
 * A provider is not supposed to hand back a nonsense number, but this value
 * flows straight into billing columns and budget caps without a human ever
 * seeing it, so an absurd figure must not be accepted silently. A single chat
 * completion costing more than this is far likelier to be a units error or a
 * malformed field than a real charge. Rejected values fall back to the table,
 * which is the behaviour that exists today.
 */
export const MAX_REPORTED_COST_USD = 100;

/**
 * Read a number that may have arrived as a JSON number or a string.
 *
 * OpenRouter sends `cost` as a number; several OpenAI-compatible gateways
 * stringify their numerics. Returns null for anything not finite, so NaN — the
 * value `Number(undefined)` and `Number("")` both produce — can never reach a
 * cost column, where it would poison every SUM downstream.
 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The cost a provider reported for one call, or null if it reported none.
 *
 * NULL AND ZERO MEAN DIFFERENT THINGS and the caller must keep them apart:
 * null is "nobody told us", which falls back to the price table and may end up
 * flagged as unpriced; 0 is "the provider says this call was free", which is a
 * measured fact and should be recorded as such.
 *
 * Negative values are refused rather than clamped. A refund or credit is not
 * the cost of this call, and silently turning it into 0 would record a
 * fabricated figure as though it had been measured.
 */
export function providerReportedCost(usage: UsageLike): number | null {
  if (!usage || typeof usage !== "object") return null;

  // OpenRouter puts the charged amount, in USD, on `usage.cost` when the
  // request asked for it. `cost_details.upstream_inference_cost` is what the
  // underlying provider charged BEFORE OpenRouter's margin, so it is not what
  // the account is billed and is deliberately not read here.
  const raw = finiteNumber((usage as Record<string, unknown>).cost);
  if (raw === null) return null;
  if (raw < 0) return null;
  if (raw > MAX_REPORTED_COST_USD) return null;
  return raw;
}

/**
 * Does this endpoint report per-call cost when asked?
 *
 * Kept as an explicit allow-list rather than "send the flag everywhere and see
 * what happens": `usage: { include: true }` is an OpenRouter extension, and
 * OpenAI's own API rejects unrecognised body arguments with a 400. Breaking
 * every call to a provider in order to ask it a question it does not
 * understand is a bad trade against a table lookup that already works.
 *
 * Matched on the resolved base URL, because a "provider" here may be any
 * OpenAI-compatible gateway the operator pointed at OpenRouter.
 */
export function reportsPerCallCost(baseUrl: string | null | undefined): boolean {
  const url = (baseUrl ?? "").toLowerCase();
  return url.includes("openrouter.ai");
}

/**
 * Extra body fields that make a provider report its cost.
 *
 * Returns an empty object for providers that do not, so the caller can spread
 * it unconditionally and no request body changes for anyone else.
 */
export function usageReportingBody(baseUrl: string | null | undefined): Record<string, unknown> {
  return reportsPerCallCost(baseUrl) ? { usage: { include: true } } : {};
}
