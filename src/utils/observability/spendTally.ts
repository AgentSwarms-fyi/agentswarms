// A running total of one job's model calls, recorded as a single trace when the
// job ends.
//
// A knowledge-graph build makes one extraction call per chunk — up to six
// hundred. One trace per call would bury the Traces page; no trace at all is
// what VA-2026-10-25-34 found: the build's cost never reached month-to-date
// spend, so a budget could not see it. The tally sums what each call reports
// and estimates what a call does not, so the one trace carries the whole cost.
import { approxTokens } from "./pricing";

export type SpendTally = {
  /** Calls made, answered or not — a refused call can still be billed. */
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** Sum of the provider-reported costs, when every answered call reported one. */
  costUsd: number;
  /** False once any answered call reported no cost: price the tokens instead. */
  allReported: boolean;
};

export function newSpendTally(): SpendTally {
  return { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, allReported: true };
}

/**
 * Add one answered call. `usage` is extractUsage()'s reading of the response;
 * when the provider reported no usage, the prompt and reply text stand in.
 */
export function addCallUsage(
  tally: SpendTally,
  usage: { tokensIn: number; tokensOut: number; costUsd: number | null } | null,
  text: { prompt: string; reply: string },
): void {
  tally.calls += 1;
  if (usage) {
    tally.tokensIn += usage.tokensIn;
    tally.tokensOut += usage.tokensOut;
  } else {
    tally.tokensIn += approxTokens(text.prompt);
    tally.tokensOut += approxTokens(text.reply);
  }
  if (usage?.costUsd == null) tally.allReported = false;
  else tally.costUsd += usage.costUsd;
}

/** Count a call that was made but not answered with a usable reply. */
export function addFailedCall(tally: SpendTally): void {
  tally.calls += 1;
}

/** What the provider says the job cost, or null to price the tokens instead. */
export function reportedCost(tally: SpendTally): number | null {
  return tally.allReported && tally.calls > 0 ? tally.costUsd : null;
}
