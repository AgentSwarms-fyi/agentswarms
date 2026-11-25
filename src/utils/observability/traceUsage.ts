// The tokens and cost an execution_traces row records for one chat turn.
//
// Kept apart from the chat route so the rule can be tested on its own: every
// figure here ends up in a spend report, and budget_spend() adds up cost_usd
// from EVERY row (errors included) to decide whether to refuse the next call.
//
// The order of preference, per figure:
//   1. what the provider reported (it is the party doing the billing);
//   2. zero, when the turn was not billed at all (see `notBilled`) or its final
//      answer was replayed from a tool round whose own row carries the cost;
//   3. the chars/4 estimate and the price table.
import { approxTokens, estimateImageCost } from "@/utils/observability/pricing";
import { priceCall } from "@/utils/observability/priceResolver";

export type TraceUsageInput = {
  provider: string;
  model: string;
  /** An image model, or a response that carried generated images. */
  isImage: boolean;
  imageCount?: number;
  /** chars/4 of the prompt, worked out before the call. */
  promptTokensApprox: number;
  assistantText: string;
  upstreamTokensIn?: number;
  upstreamTokensOut?: number;
  upstreamCostUsd?: number;
  /** The final answer was replayed from the last tool round (its row is billed). */
  replayedFinal?: boolean;
  /**
   * The provider produced nothing for this turn and billed nothing: a
   * guardrail refused it before any call, or the provider answered with an
   * error before a single token (a 429 for exhausted credits, a 401, a 5xx,
   * a network failure). Without this the row recorded the chars/4 estimate of
   * a prompt nobody ran, and its price, as spend.
   */
  notBilled?: boolean;
};

export type TraceUsage = {
  tokensIn: number;
  tokensOut: number;
  /** True when a token figure is the chars/4 fallback rather than measured. */
  tokensEstimated: boolean;
  /** The provider-reported cost, or null when it reported none. */
  providerCost: number | null;
  costUsd: number;
};

export function traceUsage(i: TraceUsageInput): TraceUsage {
  const zero = i.replayedFinal === true || i.notBilled === true;
  const tokensIn = zero ? 0 : (i.upstreamTokensIn ?? i.promptTokensApprox);
  const tokensOut = i.isImage || zero ? 0 : (i.upstreamTokensOut ?? approxTokens(i.assistantText));
  const tokensEstimated = !zero && (i.upstreamTokensIn == null || i.upstreamTokensOut == null);
  // A provider-reported figure wins outright, including when it is 0 — the
  // free-model router really does charge nothing, and recording that as a
  // MEASURED zero is what stops it looking like a gap in the price table.
  const providerCost = zero ? null : (i.upstreamCostUsd ?? null);
  const costUsd =
    providerCost ??
    (zero
      ? 0
      : i.isImage
        ? estimateImageCost(i.model, Math.max(1, i.imageCount ?? 1))
        : priceCall({ provider: i.provider, model: i.model, kind: "text", tokensIn, tokensOut })
            .costUsd);
  return { tokensIn, tokensOut, tokensEstimated, providerCost, costUsd };
}
